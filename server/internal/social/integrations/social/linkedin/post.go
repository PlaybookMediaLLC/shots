package linkedin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/mediadocument"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
	"net/http"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// pollInterval is the legacy Post loop's wait between checks (timer(20000)).
var pollInterval = 20 * time.Second

type pollMedia struct {
	URN      string `json:"urn"`
	Endpoint string `json:"endpoint"` // videos | images | documents
}

// pendingData travels through the workflow history between PostPending,
// CheckPostStatus and FinalizePost - keep it small JSON (media urns and the
// post content, never buffers).
type pendingData struct {
	AuthorID string   `json:"authorId"`
	PostType string   `json:"postType"`
	Message  string   `json:"message"`
	IsPdf    bool     `json:"isPdf"`
	PdfTitle string   `json:"pdfTitle,omitempty"`
	MediaIDs []string `json:"mediaIds"`
	// AltTexts describe MediaIDs' images, by index; empty for none.
	AltTexts []string `json:"altTexts,omitempty"`
	// Media whose processing status can be read via GET: videos for every
	// token, images/documents only for organization tokens.
	Poll []pollMedia `json:"poll"`
	// Check cycles to wait for unpollable media (personal images/documents).
	GraceChecks int `json:"graceChecks"`
	// Consecutive status reads that failed or answered without a status:
	// bounded so a broken media endpoint fails with an accurate error instead
	// of burning the whole check budget (nothing is ever published before the
	// media is ready).
	StatusStalls int `json:"statusStalls,omitempty"`
	// Arm -> confirm -> publish handshake: FinalizePost arms without mutating,
	// CheckPostStatus witnesses, and only a witnessed attempt runs the create -
	// so a create that dies with an unknown outcome is detected instead of run
	// again (LinkedIn has no idempotency key).
	Attempting bool `json:"attempting,omitempty"`
	Confirmed  bool `json:"confirmed,omitempty"`
	// Write (RFC 025): who sees the post, a poll, and a reshared post.
	Visibility    string                    `json:"visibility,omitempty"`
	Question      *integrations.PollDetails `json:"linkedinPoll,omitempty"`
	ReshareParent string                    `json:"reshareParent,omitempty"`
}

// linkedInPollDurations are the Poll API's lengths by whole days.
var linkedInPollDurations = map[int]string{1: "ONE_DAY", 3: "THREE_DAYS", 7: "SEVEN_DAYS", 14: "FOURTEEN_DAYS"}

// pollContent is a poll as the Posts API takes it: a question, 2 to 4
// options, and one of its durations.
func pollContent(poll *integrations.PollDetails, media int) (map[string]any, error) {
	minutes := poll.DurationMinutes
	if minutes == 0 {
		minutes = poll.Duration * 60
	}
	if err := socialidentity.CheckLinkedInPoll(poll.Question, poll.Options, minutes, media, poll.Multiple); err != nil {
		return nil, err
	}
	duration := linkedInPollDurations[minutes/(24*60)]
	options := make([]map[string]string, 0, len(poll.Options))
	for _, option := range poll.Options {
		options = append(options, map[string]string{"text": option})
	}
	return map[string]any{"poll": map[string]any{
		"question": poll.Question, "options": options, "settings": map[string]string{"duration": duration},
	}}, nil
}

func authorURN(postType, id string) string {
	if postType == Personal {
		return "urn:li:person:" + id
	}
	return "urn:li:organization:" + id
}

type uploaded struct {
	ID    string
	Poll  *pollMedia
	Grace bool
}

// uploadPicture uploads one media. data holds the bytes for images and
// converted PDFs; videos pass nil and are streamed chunk-by-chunk from
// fileName instead of being held in memory.
func (p *Provider) uploadPicture(ctx context.Context, fileName, accessToken, personID string, data []byte, postType string, isVideo bool) (*uploaded, error) {
	isPdf := helpers.HasExtension(fileName, "pdf")

	size := int64(len(data))
	if data == nil {
		var err error
		if size, err = p.MediaSize(ctx, fileName, p.identifier); err != nil {
			return nil, err
		}
	}

	endpoint := "images"
	if isVideo {
		endpoint = "videos"
	} else if isPdf {
		endpoint = "documents"
	}

	request := map[string]any{"owner": authorURN(postType, personID)}
	if isVideo {
		request["fileSizeBytes"] = size
		request["uploadCaptions"] = false
		request["uploadThumbnail"] = false
	}
	body, _ := json.Marshal(map[string]any{"initializeUploadRequest": request})
	// Uploads stay invisible until a post references them, so a resend is safe.
	res, err := p.Fetch(ctx, APIURL+"/rest/"+endpoint+"?action=initializeUpload", integrations.Request{
		Method: http.MethodPost, Headers: Headers(accessToken, "application/json"), Body: body, Retryable: true,
	})
	if err != nil {
		return nil, err
	}
	var initialized struct {
		Value struct {
			UploadURL          string `json:"uploadUrl"`
			Image              string `json:"image"`
			Video              string `json:"video"`
			Document           string `json:"document"`
			UploadInstructions []struct {
				UploadURL string `json:"uploadUrl"`
			} `json:"uploadInstructions"`
		} `json:"value"`
	}
	if err := res.JSON(&initialized); err != nil {
		return nil, err
	}
	value := initialized.Value
	sendURL := value.UploadURL
	if len(value.UploadInstructions) > 0 && value.UploadInstructions[0].UploadURL != "" {
		sendURL = value.UploadInstructions[0].UploadURL
	}
	finalOutput := value.Video
	if finalOutput == "" {
		finalOutput = value.Image
	}
	if finalOutput == "" {
		finalOutput = value.Document
	}

	etags := []any{}
	if isVideo {
		// Only the Videos API uses multipart chunked uploads. Each 2MB part is
		// PUT separately and the returned etags are passed to finalizeUpload.
		// Each part is read on demand so only one chunk is resident in memory.
		const chunkSize = 1024 * 1024 * 2
		for i := int64(0); i < size; i += chunkSize {
			end := min(i+chunkSize, size)
			var chunk []byte
			if data != nil {
				chunk = data[i:end]
			} else if chunk, err = p.MediaChunk(ctx, fileName, i, end-1, p.identifier); err != nil {
				return nil, err
			}
			upload, err := p.Fetch(ctx, sendURL, integrations.Request{
				Method: http.MethodPut, Headers: Headers(accessToken, "application/octet-stream"), Body: chunk, Retryable: true,
			})
			if err != nil {
				return nil, err
			}
			if etag := upload.Header.Get("etag"); etag != "" {
				etags = append(etags, etag)
			} else {
				etags = append(etags, nil)
			}
		}
	} else {
		// Images and documents (PDF carousels) use a single-shot upload URL and
		// must be sent as one PUT of the whole file. Chunking here would send
		// multiple overwriting PUTs to the same URL, leaving LinkedIn with only
		// the final chunk and corrupting anything larger than 2MB.
		contentType := ""
		if isPdf {
			contentType = "application/pdf"
		}
		if _, err := p.Fetch(ctx, sendURL, integrations.Request{
			Method: http.MethodPut, Headers: Headers(accessToken, contentType), Body: data, Retryable: true,
		}); err != nil {
			return nil, err
		}
	}

	if isVideo {
		body, _ := json.Marshal(map[string]any{"finalizeUploadRequest": map[string]any{
			"video": value.Video, "uploadToken": "", "uploadedPartIds": etags,
		}})
		if _, err := p.Fetch(ctx, APIURL+"/rest/videos?action=finalizeUpload", integrations.Request{
			Method: http.MethodPost, Headers: Headers(accessToken, "application/json"), Body: body, Retryable: true,
		}); err != nil {
			return nil, err
		}
	}

	// Every media type is processed asynchronously after the upload and must
	// reach AVAILABLE before it is attached to a post. The waiting happens in
	// CheckPostStatus: videos can be polled by any token, images and documents
	// only by organization tokens - a w_member_social (personal) token is
	// write-only for those endpoints, so the caller waits a grace period.
	if isVideo {
		return &uploaded{ID: finalOutput, Poll: &pollMedia{URN: finalOutput, Endpoint: "videos"}}, nil
	}
	if postType == Company {
		endpoint := "images"
		if isPdf {
			endpoint = "documents"
		}
		return &uploaded{ID: finalOutput, Poll: &pollMedia{URN: finalOutput, Endpoint: endpoint}}, nil
	}
	return &uploaded{ID: finalOutput, Grace: true}, nil
}

type mediaStatus struct {
	Status                  string `json:"status"`
	ProcessingFailureReason string `json:"processingFailureReason"`
}

// mediaProcessingStatus is a single read of the media processing status; the
// polling loop lives in the post workflow. The raw body is returned so a
// processing failure can attach LinkedIn's complete answer.
func (p *Provider) mediaProcessingStatus(ctx context.Context, accessToken, urn, endpoint string) (*mediaStatus, []byte, error) {
	res, err := p.Fetch(ctx, APIURL+"/rest/"+endpoint+"/"+EncodeURIComponent(urn), integrations.Request{
		Method: http.MethodGet, Headers: Headers(accessToken, "application/json"),
	})
	if err != nil {
		return nil, nil, err
	}
	var status mediaStatus
	if err := res.JSON(&status); err != nil {
		return nil, nil, err
	}
	return &status, res.Body, nil
}

type mediaItem struct {
	path string
	data []byte // set for the converted PDF carousel
	// video is the asset's stored type; a signed URL's name need not end in .mp4.
	video bool
}

// processMedia uploads sequentially on purpose: uploading in parallel holds
// every file in memory at the same time.
func (p *Provider) processMedia(ctx context.Context, media []mediaItem, accessToken, personID, postType string) (mediaIDs []string, poll []pollMedia, graceChecks int, err error) {
	mediaIDs, poll = []string{}, []pollMedia{}
	for _, m := range media {
		data := m.data
		// Videos are never buffered: uploadPicture streams them.
		if data == nil && !m.video {
			if helpers.HasExtension(m.path, "pdf") {
				// Native documents retain their bytes. Sending them through the image
				// decoder rejects every uploaded PDF before document initialization.
				data, err = p.ReadOrFetchBounded(ctx, m.path, int64(medialimits.Limits.PDFBytes))
				if err == nil {
					pages, valid := mediadocument.CountPages(bytes.NewReader(data))
					if !valid || pages > medialimits.Limits.PDFPages {
						err = errors.New("Choose a valid PDF document up to 100 MB and 300 pages.")
					}
				}
			} else {
				data, err = p.prepareMediaBuffer(ctx, m.path)
			}
			if err != nil {
				return nil, nil, 0, err
			}
		}
		up, err := p.uploadPicture(ctx, m.path, accessToken, personID, data, postType, m.video)
		if err != nil {
			return nil, nil, 0, err
		}
		if up.ID == "" {
			continue
		}
		mediaIDs = append(mediaIDs, up.ID)
		if up.Poll != nil {
			poll = append(poll, *up.Poll)
		}
		// Unpollable media (personal images/documents): wait one durable check
		// cycle before attaching it.
		if up.Grace {
			graceChecks = 1
		}
	}
	return mediaIDs, poll, graceChecks, nil
}

// buildPostContent is the post's media; alts describe images by index
// (LinkedIn's altText, at most 4,086 characters).
func buildPostContent(isPdf bool, mediaIDs []string, pdfTitle string, alts ...string) map[string]any {
	alt := func(index int) string {
		if index >= len(alts) {
			return ""
		}
		if runes := []rune(alts[index]); len(runes) > 4086 {
			return string(runes[:4086])
		}
		return alts[index]
	}
	switch len(mediaIDs) {
	case 0:
		return nil
	case 1:
		media := map[string]any{"id": mediaIDs[0]}
		if isPdf {
			if pdfTitle == "" {
				pdfTitle = "slides"
			}
			media["title"] = pdfTitle
		} else if text := alt(0); text != "" {
			media["altText"] = text
		}
		return map[string]any{"media": media}
	}
	images := make([]map[string]string, len(mediaIDs))
	for i, id := range mediaIDs {
		images[i] = map[string]string{"id": id}
		if text := alt(i); text != "" {
			images[i]["altText"] = text
		}
	}
	return map[string]any{"multiImage": map[string]any{"images": images}}
}

type distribution struct {
	FeedDistribution               string   `json:"feedDistribution"`
	TargetEntities                 []string `json:"targetEntities"`
	ThirdPartyDistributionChannels []string `json:"thirdPartyDistributionChannels"`
}

type postPayload struct {
	Author                    string            `json:"author"`
	Commentary                string            `json:"commentary"`
	Visibility                string            `json:"visibility"`
	Distribution              distribution      `json:"distribution"`
	Content                   map[string]any    `json:"content,omitempty"`
	LifecycleState            string            `json:"lifecycleState"`
	IsReshareDisabledByAuthor bool              `json:"isReshareDisabledByAuthor"`
	ReshareContext            map[string]string `json:"reshareContext,omitempty"`
}

func newPayload(author, commentary string) postPayload {
	return postPayload{
		Author: author, Commentary: commentary, Visibility: "PUBLIC",
		Distribution:   distribution{FeedDistribution: "MAIN_FEED", TargetEntities: []string{}, ThirdPartyDistributionChannels: []string{}},
		LifecycleState: "PUBLISHED",
	}
}

func (p *Provider) createMainPost(ctx context.Context, data *pendingData, accessToken string) (string, error) {
	payload := newPayload(authorURN(data.PostType, data.AuthorID), FixText(data.Message))
	if data.Visibility != "" {
		payload.Visibility = data.Visibility
	}
	var mediaIDs, alts []string
	for index, id := range data.MediaIDs {
		if id != "" {
			mediaIDs = append(mediaIDs, id)
			alt := ""
			if index < len(data.AltTexts) {
				alt = data.AltTexts[index]
			}
			alts = append(alts, alt)
		}
	}
	payload.Content = buildPostContent(data.IsPdf, mediaIDs, data.PdfTitle, alts...)
	if data.Question != nil {
		content, err := pollContent(data.Question, len(mediaIDs))
		if err != nil {
			return "", temporalx.BadBody(p.identifier, "{}", "{}", err.Error())
		}
		if data.ReshareParent != "" {
			return "", temporalx.BadBody(p.identifier, "{}", "{}", "A LinkedIn reshare cannot contain a poll.")
		}
		payload.Content = content
	}
	if data.ReshareParent != "" {
		payload.ReshareContext = map[string]string{"parent": data.ReshareParent}
	}
	body, _ := json.Marshal(payload)
	// Post creation must not use the generic retrying fetch helper.
	res, err := p.mutate(ctx, "/rest/posts", accessToken, body)
	if err != nil {
		return "", err
	}
	return p.postReceipt(res)
}

// Repost reshares parent as author (urn:li:person:... or urn:li:organization:...).
func (p *Provider) Repost(ctx context.Context, accessToken, author, parent string) error {
	payload := newPayload(author, "")
	payload.ReshareContext = map[string]string{"parent": parent}
	body, _ := json.Marshal(payload)
	res, err := p.mutate(ctx, "/rest/posts", accessToken, body)
	if err != nil {
		return err
	}
	_, err = p.postReceipt(res)
	return err
}

func (p *Provider) createCommentPost(ctx context.Context, id, accessToken string, post integrations.PostDetails, parentPostID, postType string) (string, error) {
	if !postURN.MatchString(parentPostID) {
		return "", temporalx.BadBody(p.identifier, "{}", "{}", "Choose a confirmed LinkedIn post for the first comment.")
	}
	body, _ := json.Marshal(map[string]any{
		"actor":   authorURN(postType, id),
		"object":  parentPostID,
		"message": map[string]string{"text": post.Message},
	})
	res, err := p.mutate(ctx, "/rest/socialActions/"+EncodeURIComponent(parentPostID)+"/comments", accessToken, body)
	if err != nil {
		return "", err
	}
	var out struct {
		Object     string `json:"object"`
		ID         string `json:"id"`
		CommentURN string `json:"commentUrn"`
	}
	if err := res.JSON(&out); err != nil {
		return "", temporalx.UnknownDelivery(p.identifier, "LinkedIn returned an unreadable comment receipt. Check the post before retrying.")
	}
	if commentURN.MatchString(out.CommentURN) {
		return out.CommentURN, nil
	}
	commentID := res.Header.Get("x-restli-id")
	if commentID == "" {
		commentID = out.ID
	}
	if organizationID.MatchString(commentID) && commentObject.MatchString(out.Object) {
		return "urn:li:comment:(" + out.Object + "," + commentID + ")", nil
	}
	return "", temporalx.UnknownDelivery(p.identifier, "LinkedIn did not return a valid comment receipt. Check the post before retrying.")
}

func createPostResponse(postID, originalPostID string, isMainPost bool) integrations.PostResponse {
	link := "https://www.linkedin.com/feed/update/" + postID
	if !isMainPost && commentURN.MatchString(postID) {
		parent, _, _ := strings.Cut(strings.TrimPrefix(postID, "urn:li:comment:("), ",")
		link = "https://www.linkedin.com/feed/update/" + parent + "?commentUrn=" + EncodeURIComponent(postID)
	}
	return integrations.PostResponse{Status: "posted", PostID: postID, ID: originalPostID, ReleaseURL: link}
}

func (p *Provider) PostPending(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	return p.PostPendingAs(ctx, id, accessToken, posts, Personal)
}

// PostPendingAs uploads the media now; the asynchronous processing wait moves
// to CheckPostStatus and the post itself is only created by FinalizePost, so
// nothing here is irreversible - a failure leaves only orphaned media.
func (p *Provider) PostPendingAs(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, postType string) ([]integrations.PostResponse, error) {
	if len(posts) == 0 {
		return nil, errors.New("no post to publish")
	}
	first := posts[0]
	settings := decodeSettings(first.Settings)
	if first.Poll != nil {
		if _, err := pollContent(first.Poll, len(first.Media)); err != nil {
			return nil, temporalx.BadBody(p.identifier, "{}", "{}", err.Error())
		}
		if parent, _ := settings.ReshareParent.(string); parent != "" {
			return nil, temporalx.BadBody(p.identifier, "{}", "{}", "A LinkedIn reshare cannot contain a poll.")
		}
	}
	isPdf := integrations.AssetBoolean(settings.PostAsImagesCarousel)

	var media []mediaItem
	var alts []string
	if isPdf && len(first.Media) > 0 {
		// The first post's media is replaced with a single PDF carousel.
		pdf, err := p.convertImagesToPDFCarousel(ctx, first.Media)
		if err != nil {
			return nil, err
		}
		media = []mediaItem{{path: "carousel.pdf", data: pdf}}
		alts = nil
	} else {
		for _, m := range first.Media {
			media = append(media, mediaItem{path: m.Path, video: m.Type == "video" || helpers.HasExtension(m.Path, "mp4")})
			alts = append(alts, m.Alt)
		}
	}

	mediaIDs, poll, graceChecks, err := p.processMedia(ctx, media, accessToken, id, postType)
	if err != nil {
		return nil, err
	}
	data := pendingData{
		AuthorID: id, PostType: postType, Message: first.Message, IsPdf: isPdf,
		MediaIDs: mediaIDs, AltTexts: alts, Poll: poll, GraceChecks: graceChecks,
	}
	data.Visibility, _ = settings.Visibility.(string)
	data.ReshareParent, _ = settings.ReshareParent.(string)
	if first.Poll != nil && len(first.Poll.Options) >= 2 {
		data.Question = first.Poll
	}
	if isPdf {
		data.PdfTitle, _ = settings.CarouselName.(string)
		if data.PdfTitle == "" {
			data.PdfTitle = "slides"
		}
	}
	// An uploaded PDF goes out as a document post with its own title.
	if !isPdf && len(first.Media) == 1 && helpers.HasExtension(first.Media[0].Path, "pdf") {
		data.IsPdf = true
		data.PdfTitle, _ = settings.DocumentTitle.(string)
		if data.PdfTitle == "" {
			data.PdfTitle = "Document"
		}
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{ID: first.ID, Status: "pending", PendingData: raw}}, nil
}

func pending(status string, data pendingData) (*integrations.PendingCheckResponse, error) {
	if data.Poll == nil {
		data.Poll = []pollMedia{}
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return &integrations.PendingCheckResponse{Status: status, PendingData: raw}, nil
}

func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, raw json.RawMessage, _ *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var data pendingData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	// A confirmed create attempt died without reporting its result: LinkedIn
	// gives no way to ask whether that post was created, so never run the
	// create again - stop with an explicit warning instead.
	if data.Attempting && data.Confirmed {
		return nil, temporalx.BadBody(p.identifier, "{}", "{}", "LinkedIn may have already published this post, please check your account before posting again to avoid duplicates")
	}

	// Check every media that is still processing; keep the ones that have not
	// reached AVAILABLE yet for the next cycle.
	stillProcessing := []pollMedia{}
	for _, media := range data.Poll {
		status, body, err := p.mediaProcessingStatus(ctx, accessToken, media.URN, media.Endpoint)
		// A 200 without a status field can never reach AVAILABLE: count it
		// like a failed read instead of polling it forever.
		if err == nil && status.Status == "" {
			err = errors.New("LinkedIn answered without a media status")
		}
		if err != nil {
			if temporalx.FailureType(err) == temporalx.TypeRefreshToken || ctx.Err() != nil {
				return nil, err
			}
			// Persistent failures mean the media will never be confirmed
			// ready: nothing was published, fail with an accurate message.
			if data.StatusStalls >= 10 {
				return nil, temporalx.BadBody(p.identifier, "{}", "{}", "LinkedIn kept failing the media status check, nothing was published, please try again")
			}
			// Transient status-check error: keep polling.
			data.StatusStalls++
			return pending("pending", data)
		}

		if status.Status == "PROCESSING_FAILED" {
			label := "image"
			switch media.Endpoint {
			case "videos":
				label = "video"
			case "documents":
				label = "document"
			}
			message := "LinkedIn " + label + " processing failed"
			if status.ProcessingFailureReason != "" {
				message += ": " + status.ProcessingFailureReason
			}
			return nil, temporalx.BadBody(p.identifier, string(body), "{}", message)
		}
		if status.Status != "AVAILABLE" {
			stillProcessing = append(stillProcessing, media)
		}
	}

	if len(stillProcessing) > 0 {
		// every media answered with a real status: reset the stall counter
		data.Poll, data.StatusStalls = stillProcessing, 0
		return pending("pending", data)
	}

	data.Poll = []pollMedia{}
	// Unpollable media (personal images/documents are write-only endpoints):
	// wait the remaining grace cycles before attaching them to the post.
	if data.GraceChecks > 0 {
		data.GraceChecks--
		return pending("pending", data)
	}

	// witness the armed create so FinalizePost knows the attempt is uniquely
	// accounted for before it mutates anything
	if data.Attempting && !data.Confirmed {
		data.Confirmed = true
	}
	return pending("ready", data)
}

func (p *Provider) FinalizePost(ctx context.Context, accessToken string, raw json.RawMessage, _ *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var data pendingData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	// The create only runs after CheckPostStatus witnessed the intent, so a run
	// that dies mid-create is detectable and the post is never published twice.
	if !data.Attempting || !data.Confirmed {
		data.Attempting, data.Confirmed = true, false
		return pending("pending", data)
	}
	mainPostID, err := p.createMainPost(ctx, &data, accessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.PendingCheckResponse{
		Status: "completed", PostID: mainPostID, ReleaseURL: "https://www.linkedin.com/feed/update/" + mainPostID,
	}, nil
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	return p.PostAs(ctx, id, accessToken, posts, integration, Personal)
}

// PostAs is the old blocking behavior, kept for workflow versions before
// v1.0.6 that don't know how to resolve a `pending` response - they wait for
// the media processing and create the post inside the activity.
func (p *Provider) PostAs(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration, postType string) ([]integrations.PostResponse, error) {
	responses, err := p.PostPendingAs(ctx, id, accessToken, posts, postType)
	if err != nil {
		return nil, err
	}
	response := responses[0]
	data := response.PendingData
	started := time.Now()
	for {
		// Cap below the 10-minute activity timeout of the old workflows:
		// failing here is safe (the post is only created once all the media is
		// ready), timing the activity out is not - a retried activity would
		// upload and publish again.
		if time.Since(started) > 8*time.Minute {
			return nil, temporalx.BadBody(p.identifier, "{}", "{}", "LinkedIn took too long to process the media, please try again")
		}
		check, err := p.CheckPostStatus(ctx, accessToken, data, integration)
		if err != nil {
			return nil, err
		}
		if check.Status == "pending" {
			data = check.PendingData
			if err := p.Sleep(ctx, pollInterval); err != nil {
				return nil, err
			}
			continue
		}
		result := check
		if check.Status == "ready" {
			if result, err = p.FinalizePost(ctx, accessToken, check.PendingData, integration); err != nil {
				return nil, err
			}
		}
		if result.Status == "completed" {
			return []integrations.PostResponse{createPostResponse(result.PostID, response.ID, true)}, nil
		}
		// finalize only armed the handshake, loop straight into the
		// witnessing check
		data = result.PendingData
	}
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	return p.CommentAs(ctx, id, postID, accessToken, posts, Personal)
}

func (p *Provider) CommentAs(ctx context.Context, id, postID, accessToken string, posts []integrations.PostDetails, postType string) ([]integrations.PostResponse, error) {
	if len(posts) == 0 {
		return nil, errors.New("no comment to publish")
	}
	commentID, err := p.createCommentPost(ctx, id, accessToken, posts[0], postID, postType)
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{createPostResponse(commentID, posts[0].ID, false)}, nil
}

// AddComment is the linkedin-add-comment @PostPlug: integration comments on
// the post published by originalIntegration.
func (p *Provider) AddComment(ctx context.Context, integration, _ *ent.Integration, postID string, information json.RawMessage, isPersonal bool) error {
	var info struct {
		Comment string `json:"comment"`
	}
	if err := json.Unmarshal(information, &info); err != nil {
		return err
	}
	postType := Company
	if isPersonal {
		postType = Personal
	}
	settings, _ := json.Marshal(map[string]bool{"post_as_images_carousel": false})
	_, err := p.CommentAs(ctx, integration.InternalID, postID, integration.Token, []integrations.PostDetails{{
		ID: ids.Make(10), Message: info.Comment, Media: []integrations.MediaContent{}, Settings: settings,
	}}, postType)
	return err
}

// RepostPostUsers is the linkedin-repost-post-users @PostPlug.
func (p *Provider) RepostPostUsers(ctx context.Context, integration, _ *ent.Integration, postID string, _ json.RawMessage, isPersonal bool) error {
	author := "urn:li:organization:"
	if isPersonal {
		author = "urn:li:person:"
	}
	return p.Repost(ctx, integration.Token, author+integration.InternalID, postID)
}

// PostPlugs are the @PostPlug entries; isPersonal is false for linkedin-page,
// whose overrides comment and repost as the organization.
func (p *Provider) PostPlugs(isPersonal bool) []integrations.InternalPlug {
	pick := []string{"linkedin", "linkedin-page"}
	return []integrations.InternalPlug{
		{
			MethodName:      "addComment",
			Identifier:      "linkedin-add-comment",
			Title:           "Add comments by a different account",
			Description:     "Add accounts to comment on your post",
			PickIntegration: pick,
			Fields: []integrations.PlugField{{
				Name: "comment", Description: "The comment to add to the post", Type: "textarea", Placeholder: "Enter your comment here",
			}},
			Run: func(ctx context.Context, integration, original *ent.Integration, postID string, information json.RawMessage) error {
				return p.AddComment(ctx, integration, original, postID, information, isPersonal)
			},
		},
		{
			MethodName:      "repostPostUsers",
			Identifier:      "linkedin-repost-post-users",
			Title:           "Add Re-posters",
			Description:     "Add accounts to repost your post",
			PickIntegration: pick,
			Fields:          []integrations.PlugField{},
			Run: func(ctx context.Context, integration, original *ent.Integration, postID string, information json.RawMessage) error {
				return p.RepostPostUsers(ctx, integration, original, postID, information, isPersonal)
			},
		},
	}
}

func (p *Provider) InternalPlugs() []integrations.InternalPlug { return p.PostPlugs(true) }

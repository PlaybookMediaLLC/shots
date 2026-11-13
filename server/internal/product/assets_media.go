package product

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"regexp"
	"strings"
	"time"

	_ "golang.org/x/image/webp"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/media"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/aws/smithy-go"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

var (
	ErrStorageUnavailable = errors.New("media storage is unavailable")
	ErrObjectMissing      = errors.New("the signed upload was not found in storage")
	ErrStorageQuota       = errors.New("workspace storage quota exceeded")
	assetSegmentPattern   = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	assetHashPattern      = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
)

type AssetObjectStore interface {
	SignUpload(context.Context, string, string) (string, error)
	SignDownload(context.Context, string) (string, error)
	Exists(context.Context, string) (bool, error)
	Put(context.Context, string, string, io.Reader) error
	Read(context.Context, string) ([]byte, error)
	Delete(context.Context, string) error
	// Copy duplicates an object under a new key on the storage side.
	Copy(ctx context.Context, from, to string) error
}

type GeneratedAssetInput struct {
	Body           []byte
	Classification string
	ContentType    string
	FileName       string
	Height         int
	ParentAssetID  string
	Width          int
	// Only the provider conversion pipeline may create trusted cache entries.
	// Unexported so HTTP inputs cannot claim this provenance.
	providerDerivative bool
}

type GeneratedAssetRecord struct {
	ID        string `json:"id"`
	MediaType string `json:"mediaType"`
	ObjectKey string `json:"objectKey"`
}

type AssetUploadInput struct {
	ParentAssetID  string  `json:"parentAssetId"`
	ProjectID      string  `json:"projectId"`
	Bytes          int     `json:"bytes"`
	Classification string  `json:"classification"`
	ContentType    string  `json:"contentType"`
	FileName       string  `json:"fileName"`
	SHA256         *string `json:"sha256"`
	// Multipart asks to send a file larger than one part in parts, when
	// storage can take it so.
	Multipart bool `json:"multipart"`
}

type AssetRecord struct {
	ID        string `json:"id"`
	ObjectKey string `json:"objectKey"`
	Status    string `json:"status"`
}

type AssetUploadResult struct {
	Asset     AssetRecord `json:"asset"`
	UploadURL string      `json:"uploadUrl"`
	// Multipart is set, and UploadURL empty, when the file goes in parts.
	Multipart *AssetMultipart `json:"multipart,omitempty"`
}

// uploadPartBytes is a multipart upload's part size: above storage's 5 MiB
// minimum, so a 512 MiB video is 32 parts and a browser holds one at a time.
const uploadPartBytes = 16 << 20

// AssetMultipart says how a large file is sent: Parts parts of PartBytes
// each, the last one shorter, each signed by SignAssetUploadParts.
type AssetMultipart struct {
	PartBytes int `json:"partBytes"`
	Parts     int `json:"parts"`
}

func assetMultipart(bytes int) AssetMultipart {
	return AssetMultipart{PartBytes: uploadPartBytes, Parts: (bytes + uploadPartBytes - 1) / uploadPartBytes}
}

// partBytes is the exact size of part number n of a file of this many bytes.
func (m AssetMultipart) partBytes(total, n int) int {
	if n < m.Parts {
		return m.PartBytes
	}
	return total - (m.Parts-1)*m.PartBytes
}

// multipartObjectStore is storage that takes a large file in parts, so a
// dropped connection resends one part instead of the file. Only the server
// lists and completes the parts; the browser never reads an ETag.
type multipartObjectStore interface {
	CreateMultipartUpload(ctx context.Context, key, mediaType string) (string, error)
	SignUploadPart(ctx context.Context, key, uploadID string, number int, bytes int64) (string, error)
	ListUploadedParts(ctx context.Context, key, uploadID string) ([]media.UploadedPart, error)
	CompleteMultipartUpload(ctx context.Context, key, uploadID string, parts []media.UploadedPart) error
	AbortMultipartUpload(ctx context.Context, key, uploadID string) error
}

func recordAsset(row *ent.Asset) AssetRecord {
	return AssetRecord{ID: row.ID, ObjectKey: row.ObjectKey, Status: string(row.Status)}
}

func validAssetSegment(value string) bool {
	return value != "" && value != "." && value != ".." && assetSegmentPattern.MatchString(value)
}

func validAssetUpload(input AssetUploadInput) bool {
	limit := medialimits.UploadBytes(input.ContentType, "pro")
	if input.ContentType == "application/pdf" {
		// LinkedIn documents (RFC 025): up to 100 MB, named .pdf so the
		// publisher sends them as documents.
		if !strings.HasSuffix(strings.ToLower(input.FileName), ".pdf") {
			return false
		}
	}
	if input.Bytes < 1 || input.Bytes > limit || len(input.FileName) > 128 || !validAssetSegment(input.FileName) ||
		(input.SHA256 != nil && !assetHashPattern.MatchString(*input.SHA256)) {
		return false
	}
	switch input.Classification {
	case "capture", "derived", "export", "input":
	case assetClassificationPoster:
		// A poster only ever illustrates the video it belongs to.
		if input.ParentAssetID == "" || !strings.HasPrefix(input.ContentType, "image/") {
			return false
		}
	default:
		return false
	}
	switch input.ContentType {
	case "image/gif", "image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm", "application/pdf",
		// Audio for design timelines (music, voice-over).
		"audio/aac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm",
		"font/woff", "font/woff2", "font/ttf", "font/otf":
		return true
	default:
		return false
	}
}

func (c *Configuration) SignAssetUpload(ctx context.Context, actor Actor, input AssetUploadInput) (*AssetUploadResult, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return nil, err
	}
	if input.Classification == "" {
		input.Classification = "input"
	}
	input.FileName = strings.TrimSpace(input.FileName)
	if !validAssetUpload(input) || !validAssetSegment(actor.OrganizationID) {
		return nil, ErrInvalidInput
	}
	if c.objects == nil {
		return nil, ErrStorageUnavailable
	}
	entitlement, err := c.client.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	plan, _, features := evaluateBootstrapEntitlement(entitlement, time.Now().UTC())
	if err := requireFeature(features, plan, "asset:create"); err != nil {
		return nil, err
	}
	if input.Bytes > medialimits.UploadBytes(input.ContentType, plan) {
		return nil, invalid("The file exceeds this plan’s media upload limit.")
	}
	var parent *ent.Asset
	if input.ParentAssetID != "" {
		parent, err = c.client.Asset.Query().Where(asset.ID(input.ParentAssetID), asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
	}
	id := uuid.NewString()
	key := fmt.Sprintf("org/%s/%s/%s/1/%s", actor.OrganizationID, input.Classification, id, input.FileName)
	parts, split := c.objects.(multipartObjectStore)
	split = split && input.Multipart && input.Bytes > uploadPartBytes
	url := ""
	if !split {
		if url, err = c.objects.SignUpload(ctx, key, input.ContentType); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := reserveStorage(ctx, tx, actor.OrganizationID, plan, input.Bytes); err != nil {
		return nil, err
	}
	create := tx.Asset.Create().SetID(id).SetOrganizationID(actor.OrganizationID).
		SetObjectKey(key).SetMediaType(input.ContentType).SetBytes(input.Bytes)
	if input.SHA256 != nil {
		create.SetSha256(*input.SHA256)
	}
	if parent != nil {
		create.SetParentAssetID(parent.ID).SetNillableAltText(parent.AltText)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	metadata := map[string]any{"fileName": input.FileName, "classification": input.Classification}
	if input.ProjectID != "" {
		project, err := c.GetProject(ctx, actor, input.ProjectID)
		if err != nil {
			return nil, err
		}
		metadata["projectId"], metadata["projectName"] = project.ID, project.Name
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.asset_upload_signed", "asset", row.ID, metadata); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := &AssetUploadResult{Asset: recordAsset(row.Unwrap()), UploadURL: url}
	if split {
		// Started after the reservation commits; a reservation whose upload
		// never starts is failed and its bytes released by cleanup.
		uploadID, err := parts.CreateMultipartUpload(ctx, key, input.ContentType)
		if err == nil {
			_, err = c.client.Asset.UpdateOneID(row.ID).SetUploadID(uploadID).Save(ctx)
		}
		if err != nil {
			_, _ = c.client.Asset.UpdateOneID(row.ID).SetStatus(asset.StatusFAILED).Save(ctx)
			return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
		}
		multipart := assetMultipart(input.Bytes)
		result.Multipart = &multipart
	}
	return result, nil
}

// AssetUploadParts is a multipart upload's state: the parts storage holds
// whole, and signed URLs for the parts asked for.
type AssetUploadParts struct {
	AssetMultipart
	Uploaded []int          `json:"uploaded"`
	URLs     []AssetPartURL `json:"urls"`
}

// AssetPartURL is a signed PUT of one part, valid for 15 minutes.
type AssetPartURL struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
}

// SignAssetUploadParts reports which parts of a pending multipart upload
// storage holds and signs the numbered parts, at most 20 at a time. A
// browser resumes an interrupted upload by sending only the parts missing.
func (c *Configuration) SignAssetUploadParts(ctx context.Context, actor Actor, assetID string, numbers []int) (*AssetUploadParts, error) {
	if err := c.authorizeRoles(ctx, actor, "owner", "admin", "creator"); err != nil {
		return nil, err
	}
	if len(numbers) > 20 {
		return nil, invalid("Ask for at most 20 parts at a time.")
	}
	row, err := c.client.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusEQ(asset.StatusPENDING)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	store, ok := c.objects.(multipartObjectStore)
	if row.UploadID == nil || !ok {
		return nil, conflict("This upload is not sent in parts. Upload the file again.")
	}
	stored, err := store.ListUploadedParts(ctx, row.ObjectKey, *row.UploadID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	result := &AssetUploadParts{AssetMultipart: assetMultipart(row.Bytes), Uploaded: []int{}, URLs: []AssetPartURL{}}
	for _, part := range stored {
		if part.Number >= 1 && part.Number <= result.Parts && part.Bytes == int64(result.partBytes(row.Bytes, part.Number)) {
			result.Uploaded = append(result.Uploaded, part.Number)
		}
	}
	for _, number := range numbers {
		if number < 1 || number > result.Parts {
			return nil, invalid(fmt.Sprintf("This upload has parts 1 to %d.", result.Parts))
		}
		url, err := store.SignUploadPart(ctx, row.ObjectKey, *row.UploadID, number, int64(result.partBytes(row.Bytes, number)))
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
		}
		result.URLs = append(result.URLs, AssetPartURL{Number: number, URL: url})
	}
	return result, nil
}

// completeMultipart joins a pending upload's parts once storage holds each
// one whole. Storage that no longer knows the upload was completed before
// the asset row was updated; the object's own checks follow either way.
func (c *Configuration) completeMultipart(ctx context.Context, row *ent.Asset) error {
	store, ok := c.objects.(multipartObjectStore)
	if !ok {
		return ErrStorageUnavailable
	}
	plan := assetMultipart(row.Bytes)
	stored, err := store.ListUploadedParts(ctx, row.ObjectKey, *row.UploadID)
	var apiError smithy.APIError
	if errors.As(err, &apiError) && apiError.ErrorCode() == "NoSuchUpload" {
		return c.clearUploadID(ctx, row)
	}
	if err != nil {
		return fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	byNumber := map[int]media.UploadedPart{}
	for _, part := range stored {
		byNumber[part.Number] = part
	}
	parts := make([]media.UploadedPart, 0, plan.Parts)
	missing := 0
	for number := 1; number <= plan.Parts; number++ {
		part, ok := byNumber[number]
		if !ok || part.Bytes != int64(plan.partBytes(row.Bytes, number)) {
			missing++
			continue
		}
		parts = append(parts, part)
	}
	if missing > 0 {
		return conflict(fmt.Sprintf("%d of %d parts of this upload are missing. Send them again to finish it.", missing, plan.Parts))
	}
	if err := store.CompleteMultipartUpload(ctx, row.ObjectKey, *row.UploadID, parts); err != nil {
		return fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	return c.clearUploadID(ctx, row)
}

func (c *Configuration) clearUploadID(ctx context.Context, row *ent.Asset) error {
	if _, err := c.client.Asset.Update().Where(asset.ID(row.ID), asset.StatusEQ(asset.StatusPENDING)).ClearUploadID().Save(ctx); err != nil {
		return err
	}
	row.UploadID = nil
	return nil
}

// storageLimits are each plan's stored bytes, counting reserved and failed
// uploads until maintenance removes them. They mirror storage:bytes in
// lib/billing/plans.ts.
var storageLimits = map[string]int64{"free": 0, "pro": 50 << 30, "business": 250 << 30, "enterprise": 5 << 40}

func storageUsed(ctx context.Context, client *ent.Client, organizationID string) (int64, error) {
	used, err := client.Asset.Query().Where(asset.OrganizationID(organizationID),
		asset.StatusNEQ(asset.StatusDELETED)).Aggregate(func(s *entsql.Selector) string {
		return fmt.Sprintf("COALESCE(SUM(%s), 0)", s.C(asset.FieldBytes))
	}).Int(ctx)
	return int64(used), err
}

// reserveStorage counts the workspace's bytes and admits this many more under
// a per-workspace lock held until the transaction ends, so concurrent uploads
// cannot each see room that only one of them has.
func reserveStorage(ctx context.Context, tx *ent.Tx, organizationID, plan string, bytes int) error {
	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext('asset-storage:' || $1))`, organizationID); err != nil {
		return err
	}
	used, err := storageUsed(ctx, tx.Client(), organizationID)
	if err != nil {
		return err
	}
	if used+int64(bytes) > storageLimits[plan] {
		return ErrStorageQuota
	}
	return nil
}

// CompleteAssetUpload checks a pending upload's stored bytes and makes the
// asset usable. A file sent in parts is joined first, and partSHA256, the
// hex digest of each part as the browser read it, is checked against the
// stored object part by part, since a browser cannot hash a large file whole.
func (c *Configuration) CompleteAssetUpload(ctx context.Context, actor Actor, assetID string, sha256 *string, partSHA256 ...string) (*AssetRecord, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return nil, err
	}
	if sha256 != nil && !assetHashPattern.MatchString(*sha256) {
		return nil, ErrInvalidInput
	}
	for _, digest := range partSHA256 {
		if !assetHashPattern.MatchString(digest) {
			return nil, ErrInvalidInput
		}
	}
	row, err := c.client.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusNEQ(asset.StatusDELETED)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if row.Status == asset.StatusUPLOADED {
		result := recordAsset(row)
		return &result, nil
	}
	if row.Status != asset.StatusPENDING {
		return nil, publishing.ErrInvalidState
	}
	if c.objects == nil {
		return nil, ErrStorageUnavailable
	}
	if partSHA256 != nil && len(partSHA256) != assetMultipart(row.Bytes).Parts {
		return nil, invalid(fmt.Sprintf("Send one checksum for each of the upload's %d parts.", assetMultipart(row.Bytes).Parts))
	}
	if row.UploadID != nil {
		if partSHA256 == nil {
			return nil, conflict("Send the checksum of each part to finish an upload sent in parts.")
		}
		if err := c.completeMultipart(ctx, row); err != nil {
			return nil, err
		}
	}
	exists, err := c.objects.Exists(ctx, row.ObjectKey)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	if !exists {
		return nil, ErrObjectMissing
	}
	if sha256 != nil && row.Sha256 != nil && !strings.EqualFold(*sha256, *row.Sha256) {
		return nil, invalid("The completion checksum differs from the reserved upload.")
	}
	if sha256 != nil && row.Sha256 == nil {
		row.Sha256 = sha256
	}
	content, err := c.checkUploadedBytes(ctx, actor, row, partSHA256)
	if err != nil {
		return nil, err
	}
	video := content.video
	if sha256 == nil && row.Sha256 == nil {
		// A large file's digest is the server's own reading of it.
		sha256 = &content.sha256
	}
	dimensions, err := c.uploadedImageDimensions(ctx, row)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			_, _ = c.client.Asset.Update().Where(asset.ID(row.ID), asset.StatusEQ(asset.StatusPENDING)).SetStatus(asset.StatusFAILED).Save(ctx)
		}
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	update := tx.Asset.Update().Where(asset.ID(row.ID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusEQ(asset.StatusPENDING)).SetStatus(asset.StatusUPLOADED)
	if dimensions != nil {
		update.SetWidth(dimensions.Width).SetHeight(dimensions.Height)
	}
	if video != nil {
		update.SetWidth(video.Width).SetHeight(video.Height).SetDurationMs(video.DurationMs).SetCodecs(strings.Join(video.Codecs, ","))
	}
	if sha256 != nil {
		update.SetSha256(*sha256)
	}
	count, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	// A poster is part of its video, not news to webhooks and activity feeds.
	if count == 1 && !isVideoPoster(row.ObjectKey) {
		if _, err := tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetType("asset.uploaded").SetAggregateType("asset").SetAggregateID(row.ID).
			SetPayload(map[string]any{"assetId": row.ID, "actorUserId": actor.UserID, "ownerUserId": actor.UserID}).SetIdempotencyKey("asset.uploaded:" + row.ID).Save(ctx); err != nil {
			return nil, err
		}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.asset_uploaded", "asset", row.ID); err != nil {
			return nil, err
		}
	}
	current, err := tx.Asset.Query().Where(asset.ID(row.ID), asset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := recordAsset(current)
	return &result, nil
}

// checkUploadedBytes verifies the actual length, digest and media signature.
// A store without streaming still verifies bytes through its Read contract.
func (c *Configuration) checkUploadedBytes(ctx context.Context, actor Actor, row *ent.Asset, partSHA256 []string) (uploadedContent, error) {
	object, err := c.openObject(ctx, row.ObjectKey)
	if err != nil {
		return uploadedContent{}, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	defer object.Close()
	content, err := verifyUploadedContent(object, row.MediaType, row.Bytes, row.Sha256, partSHA256...)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			if _, failErr := c.client.Asset.Update().Where(asset.ID(row.ID), asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusPENDING)).SetStatus(asset.StatusFAILED).Save(ctx); failErr != nil {
				return uploadedContent{}, failErr
			}
		}
		return uploadedContent{}, err
	}
	return content, nil
}

func (c *Configuration) SignAssetDownload(ctx context.Context, actor Actor, assetID string) (string, error) {
	if err := c.authorizeAssetRead(ctx, actor); err != nil {
		return "", err
	}
	row, err := c.client.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
	if ent.IsNotFound(err) {
		return "", publishing.ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if c.objects == nil {
		return "", ErrStorageUnavailable
	}
	return c.assetDownloadURL(actor, row.ID)
}

func (c *Configuration) ReadAsset(ctx context.Context, actor Actor, assetID string) ([]byte, string, error) {
	if err := c.authorizeAssetRead(ctx, actor); err != nil {
		return nil, "", err
	}
	row, err := c.client.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, "", publishing.ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	if c.objects == nil {
		return nil, "", ErrStorageUnavailable
	}
	body, err := c.objects.Read(ctx, row.ObjectKey)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	// Storage may be slow. Do not release its result after authority or the
	// asset has been revoked while the read was in flight.
	if err := c.authorizeAssetRead(ctx, actor); err != nil {
		return nil, "", err
	}
	current, err := c.client.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusEQ(asset.StatusUPLOADED), asset.ObjectKey(row.ObjectKey)).Exist(ctx)
	if err != nil {
		return nil, "", err
	}
	if !current {
		return nil, "", publishing.ErrNotFound
	}
	// Repair legacy image records as they are viewed, using the authorized bytes.
	if strings.HasPrefix(row.MediaType, "image/") && (row.Width == nil || row.Height == nil) {
		if dimensions, err := decodeAssetDimensions(bytes.NewReader(body)); err == nil {
			if _, err := c.client.Asset.Update().Where(asset.ID(row.ID), asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED)).
				SetWidth(dimensions.Width).SetHeight(dimensions.Height).Save(ctx); err != nil {
				return nil, "", err
			}
		}
	}
	return body, row.MediaType, nil
}

func (c *Configuration) StoreGeneratedAsset(ctx context.Context, actor Actor, input GeneratedAssetInput) (*GeneratedAssetRecord, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return nil, err
	}
	if c.objects == nil {
		return nil, ErrStorageUnavailable
	}
	if input.ContentType != "image/png" && input.ContentType != "image/jpeg" && input.ContentType != "image/webp" {
		return nil, ErrInvalidInput
	}
	return c.storeGeneratedAsset(ctx, actor, input)
}

func (c *Configuration) storeGeneratedAsset(ctx context.Context, actor Actor, input GeneratedAssetInput) (*GeneratedAssetRecord, error) {
	if input.Classification != "capture" && input.Classification != "derived" &&
		input.Classification != "export" && input.Classification != "input" {
		return nil, ErrInvalidInput
	}
	if len(input.Body) == 0 || len(input.Body) > medialimits.Limits.PaidImageBytes || !validAssetSegment(input.FileName) ||
		!validAssetSegment(actor.OrganizationID) || input.Width <= 0 || input.Height <= 0 {
		return nil, ErrInvalidInput
	}
	if err := verifyAssetBytes(input.ContentType, bytes.NewReader(input.Body)); err != nil {
		return nil, err
	}
	dimensions, err := decodeAssetDimensions(bytes.NewReader(input.Body))
	if err != nil || dimensions.Width != input.Width || dimensions.Height != input.Height {
		return nil, ErrInvalidInput
	}
	if input.ParentAssetID != "" {
		exists, err := c.client.Asset.Query().Where(asset.ID(input.ParentAssetID),
			asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !exists {
			return nil, publishing.ErrNotFound
		}
	}
	entitlement, err := c.client.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	plan, _, features := evaluateBootstrapEntitlement(entitlement, time.Now().UTC())
	if err := requireFeature(features, plan, "asset:create"); err != nil {
		return nil, err
	}
	if len(input.Body) > medialimits.UploadBytes(input.ContentType, plan) {
		return nil, invalid("The file exceeds this plan’s media upload limit.")
	}
	// Refuse early without a lock; reserveStorage decides under it.
	if used, err := storageUsed(ctx, c.client, actor.OrganizationID); err != nil {
		return nil, err
	} else if used+int64(len(input.Body)) > storageLimits[plan] {
		return nil, ErrStorageQuota
	}
	id := uuid.NewString()
	key := fmt.Sprintf("org/%s/%s/%s/1/%s", actor.OrganizationID, input.Classification, id, input.FileName)
	if input.providerDerivative {
		key = providerImagePrefix(actor.OrganizationID) + id + "/1/" + input.FileName
	}
	if err := c.objects.Put(ctx, key, input.ContentType, bytes.NewReader(input.Body)); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	committed := false
	defer func() {
		if !committed {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = c.objects.Delete(cleanupCtx, key)
		}
	}()
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := reserveStorage(ctx, tx, actor.OrganizationID, plan, len(input.Body)); err != nil {
		return nil, err
	}
	create := tx.Asset.Create().SetID(id).SetOrganizationID(actor.OrganizationID).
		SetObjectKey(key).SetMediaType(input.ContentType).SetBytes(len(input.Body)).
		SetSha256(fmt.Sprintf("%x", sha256.Sum256(input.Body))).SetStatus(asset.StatusUPLOADED).
		SetWidth(input.Width).SetHeight(input.Height)
	if input.ParentAssetID != "" {
		create.SetParentAssetID(input.ParentAssetID)
		parent, err := tx.Asset.Get(ctx, input.ParentAssetID)
		if err != nil {
			return nil, err
		}
		create.SetNillableAltText(parent.AltText)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetType("asset.uploaded").SetAggregateType("asset").SetAggregateID(row.ID).
		SetPayload(map[string]any{"activityKind": "asset.generated", "assetId": row.ID, "ownerUserId": actor.UserID, "background": true}).SetIdempotencyKey("asset.uploaded:" + row.ID).Save(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.asset_generated", "asset", row.ID,
		map[string]any{"classification": input.Classification, "parentAssetId": input.ParentAssetID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true
	return &GeneratedAssetRecord{ID: row.ID, MediaType: row.MediaType, ObjectKey: row.ObjectKey}, nil
}

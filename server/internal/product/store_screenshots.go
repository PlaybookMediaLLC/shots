package product

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/storepublishingcredential"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/storereview"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/storereviewcomment"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

// Store screenshot reviews and publishing credentials.
//
// A review is a snapshot: rendered slide images already stored as tenant
// assets, plus comments keyed by the editor's stable slide ids. Link access
// arrives as a service actor carrying the share token id; the web verified
// the signed link, and this layer checks the id and revocation again.

const (
	maxReviewSlides       = 30
	maxReviewComments     = 500
	maxCommentBody        = 2000
	maxCommentAuthor      = 80
	maxCredentialSecret   = 16 << 10
	maxCredentialMetadata = 200
)

var (
	storeProjectIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)
	storeSlideIDPattern   = regexp.MustCompile(`^[A-Za-z0-9:_-]{1,80}$`)
	encryptedSecretFormat = regexp.MustCompile(`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`)
	credentialMetadata    = map[string]map[string]bool{
		"APP_STORE_CONNECT": {"issuerId": true, "keyId": true},
		"GOOGLE_PLAY":       {"clientEmail": true, "projectId": true},
	}
)

// StoreReviewSlide is one rendered slide in a review.
type StoreReviewSlide struct {
	SlideID string `json:"slideId"`
	Name    string `json:"name"`
	AssetID string `json:"assetId"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
}

// CreateStoreReviewInput creates a review snapshot.
type CreateStoreReviewInput struct {
	ProjectID       string             `json:"projectId"`
	Name            string             `json:"name"`
	VersionLabel    string             `json:"versionLabel"`
	ProjectRevision int                `json:"projectRevision"`
	Slides          []StoreReviewSlide `json:"slides"`
}

// StoreReviewComment is a comment as returned to callers.
type StoreReviewComment struct {
	ID         string     `json:"id"`
	SlideID    string     `json:"slideId"`
	X          *float64   `json:"x"`
	Y          *float64   `json:"y"`
	AuthorName string     `json:"authorName"`
	Body       string     `json:"body"`
	FromLink   bool       `json:"fromLink"`
	ResolvedAt *time.Time `json:"resolvedAt"`
	CreatedAt  time.Time  `json:"createdAt"`
}

// StoreReviewRecord is a review with its comments.
type StoreReviewRecord struct {
	ID              string               `json:"id"`
	ProjectID       string               `json:"projectId"`
	Name            string               `json:"name"`
	VersionLabel    string               `json:"versionLabel"`
	ProjectRevision int                  `json:"projectRevision"`
	ShareTokenID    string               `json:"shareTokenId"`
	Slides          []StoreReviewSlide   `json:"slides"`
	RevokedAt       *time.Time           `json:"revokedAt"`
	CreatedAt       time.Time            `json:"createdAt"`
	UpdatedAt       time.Time            `json:"updatedAt"`
	Comments        []StoreReviewComment `json:"comments"`
}

// AddStoreReviewCommentInput adds a comment. ShareTokenID is required when
// the comment arrives through a review link.
type AddStoreReviewCommentInput struct {
	SlideID      string   `json:"slideId"`
	X            *float64 `json:"x"`
	Y            *float64 `json:"y"`
	AuthorName   string   `json:"authorName"`
	Body         string   `json:"body"`
	ShareTokenID string   `json:"shareTokenId"`
}

func randomToken() (string, error) {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

// slidesFromJSON decodes stored slides. A round trip through JSON accepts
// both the float64 numbers a database read yields and the ints a freshly
// saved row still holds.
func slidesFromJSON(raw []map[string]any) []StoreReviewSlide {
	slides := []StoreReviewSlide{}
	if encoded, err := json.Marshal(raw); err == nil {
		_ = json.Unmarshal(encoded, &slides)
	}
	return slides
}

func reviewRecord(row *ent.StoreReview, comments []*ent.StoreReviewComment) StoreReviewRecord {
	record := StoreReviewRecord{ID: row.ID, ProjectID: row.ProjectID, Name: row.Name, VersionLabel: row.VersionLabel,
		ProjectRevision: row.ProjectRevision, ShareTokenID: row.ShareTokenID, Slides: slidesFromJSON(row.Slides),
		RevokedAt: row.RevokedAt, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Comments: []StoreReviewComment{}}
	for _, comment := range comments {
		record.Comments = append(record.Comments, StoreReviewComment{ID: comment.ID, SlideID: comment.SlideID, X: comment.X, Y: comment.Y,
			AuthorName: comment.AuthorName, Body: comment.Body, FromLink: comment.FromLink, ResolvedAt: comment.ResolvedAt, CreatedAt: comment.CreatedAt})
	}
	return record
}

func validReviewInput(input *CreateStoreReviewInput) bool {
	input.Name = strings.TrimSpace(input.Name)
	input.VersionLabel = strings.TrimSpace(input.VersionLabel)
	if !storeProjectIDPattern.MatchString(input.ProjectID) || input.Name == "" || utf8.RuneCountInString(input.Name) > 120 ||
		utf8.RuneCountInString(input.VersionLabel) > 80 || input.ProjectRevision < 0 || len(input.Slides) == 0 || len(input.Slides) > maxReviewSlides {
		return false
	}
	seen := map[string]bool{}
	for _, slide := range input.Slides {
		if _, err := uuid.Parse(slide.AssetID); err != nil || !storeSlideIDPattern.MatchString(slide.SlideID) || seen[slide.SlideID] ||
			utf8.RuneCountInString(slide.Name) > 80 || slide.Width < 1 || slide.Width > 8192 || slide.Height < 1 || slide.Height > 8192 {
			return false
		}
		seen[slide.SlideID] = true
	}
	return true
}

// CreateStoreReview stores a review snapshot of rendered slides.
func (c *Configuration) CreateStoreReview(ctx context.Context, actor Actor, input CreateStoreReviewInput) (*StoreReviewRecord, error) {
	if err := c.authorizeRoles(ctx, actor, "owner", "admin", "creator"); err != nil {
		return nil, err
	}
	if !validReviewInput(&input) {
		return nil, ErrInvalidInput
	}
	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	ids := make([]string, 0, len(input.Slides))
	slides := make([]map[string]any, 0, len(input.Slides))
	for _, slide := range input.Slides {
		ids = append(ids, slide.AssetID)
		slides = append(slides, map[string]any{"slideId": slide.SlideID, "name": slide.Name, "assetId": slide.AssetID, "width": slide.Width, "height": slide.Height})
	}
	owned, err := tx.Asset.Query().Where(asset.IDIn(ids...), asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if owned != len(ids) {
		return nil, publishing.ErrNotFound
	}
	create := tx.StoreReview.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetProjectID(input.ProjectID).
		SetName(input.Name).SetVersionLabel(input.VersionLabel).SetProjectRevision(input.ProjectRevision).SetShareTokenID(token).SetSlides(slides)
	if actor.UserID != "" {
		create.SetCreatedByUserID(actor.UserID)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.store_review_created", "store_review", row.ID,
		map[string]any{"projectId": input.ProjectID, "slides": len(input.Slides)}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := reviewRecord(row.Unwrap(), nil)
	return &record, nil
}

// ListStoreReviews returns a project's reviews, newest first, with comments.
func (c *Configuration) ListStoreReviews(ctx context.Context, actor Actor, projectID string) ([]StoreReviewRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if !storeProjectIDPattern.MatchString(projectID) {
		return nil, ErrInvalidInput
	}
	rows, err := c.client.StoreReview.Query().Where(storereview.OrganizationID(actor.OrganizationID), storereview.ProjectID(projectID)).
		Order(ent.Desc(storereview.FieldCreatedAt)).Limit(50).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []StoreReviewRecord{}, nil
	}
	reviewIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		reviewIDs = append(reviewIDs, row.ID)
	}
	allComments, err := c.client.StoreReviewComment.Query().
		Where(storereviewcomment.OrganizationID(actor.OrganizationID), storereviewcomment.ReviewIDIn(reviewIDs...)).
		Order(ent.Asc(storereviewcomment.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	commentsByReview := make(map[string][]*ent.StoreReviewComment, len(rows))
	for _, comment := range allComments {
		if len(commentsByReview[comment.ReviewID]) < maxReviewComments {
			commentsByReview[comment.ReviewID] = append(commentsByReview[comment.ReviewID], comment)
		}
	}
	records := make([]StoreReviewRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, reviewRecord(row, commentsByReview[row.ID]))
	}
	return records, nil
}

func (c *Configuration) loadReview(ctx context.Context, organizationID, id string) (*ent.StoreReview, []*ent.StoreReviewComment, error) {
	row, err := c.client.StoreReview.Query().Where(storereview.ID(id), storereview.OrganizationID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	comments, err := c.client.StoreReviewComment.Query().Where(storereviewcomment.OrganizationID(organizationID), storereviewcomment.ReviewID(id)).
		Order(ent.Asc(storereviewcomment.FieldCreatedAt)).Limit(maxReviewComments).All(ctx)
	return row, comments, err
}

// GetStoreReview returns one review to a workspace member.
func (c *Configuration) GetStoreReview(ctx context.Context, actor Actor, id string) (*StoreReviewRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, comments, err := c.loadReview(ctx, actor.OrganizationID, id)
	if err != nil {
		return nil, err
	}
	record := reviewRecord(row, comments)
	return &record, nil
}

func linkAllowed(row *ent.StoreReview, tokenID string) bool {
	return row.RevokedAt == nil && tokenID != "" && subtle.ConstantTimeCompare([]byte(row.ShareTokenID), []byte(tokenID)) == 1
}

// GetSharedStoreReview returns a review opened through its link. Only the
// web's service principal may call it, and only with the current token id.
func (c *Configuration) GetSharedStoreReview(ctx context.Context, actor Actor, id, tokenID string) (*StoreReviewRecord, error) {
	if actor.Kind != "service" {
		return nil, publishing.ErrForbidden
	}
	if err := c.authorizeRoles(ctx, actor); err != nil {
		return nil, err
	}
	row, comments, err := c.loadReview(ctx, actor.OrganizationID, id)
	if err != nil {
		return nil, err
	}
	if !linkAllowed(row, tokenID) {
		return nil, publishing.ErrNotFound
	}
	record := reviewRecord(row, comments)
	return &record, nil
}

// AddStoreReviewComment adds a comment from a member or through the link.
func (c *Configuration) AddStoreReviewComment(ctx context.Context, actor Actor, reviewID string, input AddStoreReviewCommentInput) (*StoreReviewComment, error) {
	fromLink := actor.Kind == "service"
	if fromLink {
		if err := c.authorizeRoles(ctx, actor); err != nil {
			return nil, err
		}
	} else if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if !fromLink {
		if !actor.IsSession() {
			return nil, publishing.ErrForbidden
		}
		person, err := c.client.User.Get(ctx, actor.UserID)
		if err != nil {
			return nil, err
		}
		input.AuthorName = person.Name
	}
	input.Body = strings.TrimSpace(input.Body)
	input.AuthorName = strings.TrimSpace(input.AuthorName)
	if input.Body == "" || utf8.RuneCountInString(input.Body) > maxCommentBody || input.AuthorName == "" ||
		utf8.RuneCountInString(input.AuthorName) > maxCommentAuthor || !storeSlideIDPattern.MatchString(input.SlideID) {
		return nil, ErrInvalidInput
	}
	for _, value := range []*float64{input.X, input.Y} {
		if value != nil && (*value < 0 || *value > 100) {
			return nil, ErrInvalidInput
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := tx.StoreReview.Query().Where(storereview.ID(reviewID), storereview.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if fromLink && !linkAllowed(row, input.ShareTokenID) {
		return nil, publishing.ErrNotFound
	}
	slideKnown := false
	for _, slide := range slidesFromJSON(row.Slides) {
		slideKnown = slideKnown || slide.SlideID == input.SlideID
	}
	if !slideKnown {
		return nil, ErrInvalidInput
	}
	count, err := tx.StoreReviewComment.Query().Where(storereviewcomment.ReviewID(reviewID)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if count >= maxReviewComments {
		return nil, ErrRateLimited
	}
	create := tx.StoreReviewComment.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReviewID(reviewID).
		SetSlideID(input.SlideID).SetAuthorName(input.AuthorName).SetNillablePlatformAuthorUserID(projectActor(actor)).SetBody(input.Body).SetFromLink(fromLink).SetNillableX(input.X).SetNillableY(input.Y)
	comment, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	participants, err := storeReviewParticipants(ctx, tx, actor.OrganizationID, reviewID)
	if err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, "comment.created", "product.store_review_commented", "store_review", reviewID,
		map[string]any{"commentId": comment.ID, "fromLink": fromLink, "participantUserIds": participants}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &StoreReviewComment{ID: comment.ID, SlideID: comment.SlideID, X: comment.X, Y: comment.Y, AuthorName: comment.AuthorName,
		Body: comment.Body, FromLink: comment.FromLink, CreatedAt: comment.CreatedAt}, nil
}

// ResolveStoreReviewComment marks a comment resolved or reopens it.
func (c *Configuration) ResolveStoreReviewComment(ctx context.Context, actor Actor, reviewID, commentID string, resolved bool) error {
	if err := c.authorizeRoles(ctx, actor, "owner", "admin", "creator"); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM store_review_comment WHERE id=$1 AND "reviewId"=$2 AND "organizationId"=$3 FOR UPDATE`, commentID, reviewID, actor.OrganizationID); err != nil {
		return err
	}
	row, err := tx.StoreReviewComment.Query().Where(storereviewcomment.ID(commentID), storereviewcomment.ReviewID(reviewID), storereviewcomment.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	if (row.ResolvedAt != nil) == resolved {
		return nil
	}
	update := row.Update()
	if resolved {
		update.SetResolvedAt(time.Now()).SetResolvedByUserID(actor.UserID)
	} else {
		update.ClearResolvedAt().ClearResolvedByUserID()
	}
	if err = update.Exec(ctx); err != nil {
		return err
	}
	participants, err := storeReviewParticipants(ctx, tx, actor.OrganizationID, reviewID)
	if err != nil {
		return err
	}
	if resolved {
		if err = recordProductActivity(ctx, tx, actor, "comment.resolved", "product.store_review_comment_resolved", "store_review", reviewID, map[string]any{"commentId": commentID, "participantUserIds": participants}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func storeReviewParticipants(ctx context.Context, tx *ent.Tx, org, id string) ([]string, error) {
	rows, err := tx.StoreReviewComment.Query().Where(storereviewcomment.OrganizationID(org), storereviewcomment.ReviewID(id)).All(ctx)
	if err != nil {
		return nil, err
	}
	result := []string{}
	for _, row := range rows {
		if row.PlatformAuthorUserID != nil {
			result = append(result, *row.PlatformAuthorUserID)
		}
	}
	return result, nil
}

// RevokeStoreReview turns off link access. Idempotent.
func (c *Configuration) RevokeStoreReview(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeRoles(ctx, actor, "owner", "admin", "creator"); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	changed, err := tx.StoreReview.Update().Where(storereview.ID(id), storereview.OrganizationID(actor.OrganizationID), storereview.RevokedAtIsNil()).
		SetRevokedAt(time.Now()).Save(ctx)
	if err != nil {
		return err
	}
	if changed == 0 {
		exists, err := tx.StoreReview.Query().Where(storereview.ID(id), storereview.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil {
			return err
		}
		if !exists {
			return publishing.ErrNotFound
		}
		return tx.Commit()
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.store_review_revoked", "store_review", id); err != nil {
		return err
	}
	return tx.Commit()
}

// CreateStorePublishingCredentialInput stores an encrypted store credential.
type CreateStorePublishingCredentialInput struct {
	Provider        string            `json:"provider"`
	Label           string            `json:"label"`
	Metadata        map[string]string `json:"metadata"`
	EncryptedSecret string            `json:"encryptedSecret"`
}

// StorePublishingCredential is a credential without its secret.
type StorePublishingCredential struct {
	ID         string            `json:"id"`
	Provider   string            `json:"provider"`
	Label      string            `json:"label"`
	Metadata   map[string]string `json:"metadata"`
	LastUsedAt *time.Time        `json:"lastUsedAt"`
	CreatedAt  time.Time         `json:"createdAt"`
}

// StorePublishingCredentialSecret is a credential with its ciphertext.
type StorePublishingCredentialSecret struct {
	StorePublishingCredential
	EncryptedSecret string `json:"encryptedSecret"`
}

func credentialRecord(row *ent.StorePublishingCredential) StorePublishingCredential {
	return StorePublishingCredential{ID: row.ID, Provider: string(row.Provider), Label: row.Label, Metadata: row.Metadata, LastUsedAt: row.LastUsedAt, CreatedAt: row.CreatedAt}
}

// CreateStorePublishingCredential saves a credential. Only owners and admins may.
func (c *Configuration) CreateStorePublishingCredential(ctx context.Context, actor Actor, input CreateStorePublishingCredentialInput) (*StorePublishingCredential, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.authorizeRoles(ctx, actor, "owner", "admin"); err != nil {
		return nil, err
	}
	allowed, ok := credentialMetadata[input.Provider]
	input.Label = strings.TrimSpace(input.Label)
	if !ok || input.Label == "" || utf8.RuneCountInString(input.Label) > 80 || len(input.EncryptedSecret) > maxCredentialSecret ||
		!encryptedSecretFormat.MatchString(input.EncryptedSecret) || len(input.Metadata) > len(allowed) {
		return nil, ErrInvalidInput
	}
	for key, value := range input.Metadata {
		if !allowed[key] || utf8.RuneCountInString(value) > maxCredentialMetadata {
			return nil, ErrInvalidInput
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	create := tx.StorePublishingCredential.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetProvider(storepublishingcredential.Provider(input.Provider)).SetLabel(input.Label).SetMetadata(input.Metadata).SetEncryptedSecret(input.EncryptedSecret)
	if actor.UserID != "" {
		create.SetCreatedByUserID(actor.UserID)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.store_credential_created", "store_publishing_credential", row.ID,
		map[string]any{"provider": input.Provider}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := credentialRecord(row.Unwrap())
	return &record, nil
}

// ListStorePublishingCredentials lists credentials without secrets.
func (c *Configuration) ListStorePublishingCredentials(ctx context.Context, actor Actor) ([]StorePublishingCredential, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.StorePublishingCredential.Query().Where(storepublishingcredential.OrganizationID(actor.OrganizationID)).
		Order(ent.Desc(storepublishingcredential.FieldCreatedAt)).Limit(50).All(ctx)
	if err != nil {
		return nil, err
	}
	records := make([]StorePublishingCredential, 0, len(rows))
	for _, row := range rows {
		records = append(records, credentialRecord(row))
	}
	return records, nil
}

// GetStorePublishingCredentialSecret returns the ciphertext for an upload
// a publisher is about to run, and records the use.
func (c *Configuration) GetStorePublishingCredentialSecret(ctx context.Context, actor Actor, id string) (*StorePublishingCredentialSecret, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.authorizeRoles(ctx, actor, "owner", "admin", "publisher"); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := tx.StorePublishingCredential.Query().Where(storepublishingcredential.ID(id), storepublishingcredential.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.StorePublishingCredential.UpdateOneID(row.ID).SetLastUsedAt(time.Now()).Save(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.store_credential_used", "store_publishing_credential", row.ID,
		map[string]any{"provider": string(row.Provider)}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &StorePublishingCredentialSecret{StorePublishingCredential: credentialRecord(row), EncryptedSecret: row.EncryptedSecret}, nil
}

// DeleteStorePublishingCredential removes a credential. Only owners and admins may.
func (c *Configuration) DeleteStorePublishingCredential(ctx context.Context, actor Actor, id string) error {
	if !actor.IsSession() {
		return publishing.ErrForbidden
	}
	if err := c.authorizeRoles(ctx, actor, "owner", "admin"); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	deleted, err := tx.StorePublishingCredential.Delete().Where(storepublishingcredential.ID(id), storepublishingcredential.OrganizationID(actor.OrganizationID)).Exec(ctx)
	if err != nil {
		return err
	}
	if deleted == 0 {
		return publishing.ErrNotFound
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.store_credential_deleted", "store_publishing_credential", id); err != nil {
		return err
	}
	return tx.Commit()
}

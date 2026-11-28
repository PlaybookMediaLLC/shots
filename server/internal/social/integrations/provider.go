// Package integrations is the social provider contract:
// the Provider interface every
// social network implements, the optional capabilities generic code checks
// for, the SocialAbstract base (Base), and the IntegrationManager (Manager).
//
// Generic code never names a provider: it calls the interface and type-asserts
// optional capabilities, the Go form of TypeScript's `provider.analytics?.()`.
package integrations

import (
	"context"
	"encoding/json"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

type ClientInformation struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	InstanceURL  string `json:"instanceUrl"`
}

type GenerateAuthURLResponse struct {
	URL          string `json:"url"`
	CodeVerifier string `json:"codeVerifier"`
	State        string `json:"state"`
}

type AuthenticateParams struct {
	Code         string `json:"code"`
	CodeVerifier string `json:"codeVerifier"`
	Refresh      string `json:"refresh,omitempty"`
}

type AdditionalSetting struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Type        string `json:"type"` // checkbox | text | textarea
	Value       any    `json:"value"`
	Regex       string `json:"regex,omitempty"`
}

type AuthTokenDetails struct {
	// CredentialDetails stays in memory until the callback encrypts it. It must
	// never enter JSON responses or workflow payloads.
	CredentialDetails  *string                      `json:"-"`
	Verification       *socialidentity.Verification `json:"-"`
	ID                 string                       `json:"id"`
	Name               string                       `json:"name"`
	Error              string                       `json:"error,omitempty"`
	AccessToken        string                       `json:"accessToken"`
	RefreshToken       string                       `json:"refreshToken,omitempty"`
	ExpiresIn          int64                        `json:"expiresIn,omitempty"`   // seconds
	NonExpiring        bool                         `json:"nonExpiring,omitempty"` // verified provider contract; clears any previous expiry
	Picture            string                       `json:"picture,omitempty"`
	Username           string                       `json:"username"`
	AdditionalSettings []AdditionalSetting          `json:"additionalSettings,omitempty"`
}

// AuthMessage is returned by Authenticate when TypeScript returned a string:
// a user-facing message instead of token details.
type AuthMessage string

func (m AuthMessage) Error() string { return string(m) }

type MediaContent struct {
	Type               string `json:"type"` // image | video
	Path               string `json:"path"`
	Alt                string `json:"alt,omitempty"`
	Thumbnail          string `json:"thumbnail,omitempty"`
	ThumbnailTimestamp *int64 `json:"thumbnailTimestamp,omitempty"`
}

type PollDetails struct {
	Multiple bool     `json:"multiple,omitempty"`
	Options  []string `json:"options"`
	Duration int      `json:"duration"` // hours
	// DurationMinutes, when set, is the exact length (X takes minutes).
	DurationMinutes int `json:"durationMinutes,omitempty"`
	// Question is asked by platforms whose polls have their own (LinkedIn).
	Question string `json:"question,omitempty"`
}

// PostDetails is one entry to publish: the post or a comment. Settings is the
// provider's raw settings JSON; decode it into the provider's settings DTO.
type PostDetails struct {
	ID        string          `json:"id"`
	Message   string          `json:"message"`
	PlainText bool            `json:"plainText,omitempty"`
	Settings  json.RawMessage `json:"settings"`
	Media     []MediaContent  `json:"media,omitempty"`
	Poll      *PollDetails    `json:"poll,omitempty"`
}

// PostResponse: Status "pending" means the workflow must poll
// CheckPostStatus/FinalizePost with PendingData, which only the provider reads.
type PostResponse struct {
	QuoteState  string          `json:"quoteState,omitempty"`
	ID          string          `json:"id"`
	PostID      string          `json:"postId"`
	ReleaseURL  string          `json:"releaseURL"`
	Status      string          `json:"status"`
	PendingData json.RawMessage `json:"pendingData,omitempty"`
}

// PendingCheckResponse statuses: pending (poll again), ready (call
// FinalizePost), completed (PostID/ReleaseURL are final). Once finalize's
// mutations went through, CheckPostStatus must answer completed, never ready.
type PendingCheckResponse struct {
	QuoteState  string          `json:"quoteState,omitempty"`
	Status      string          `json:"status"`
	PendingData json.RawMessage `json:"pendingData,omitempty"`
	PostID      string          `json:"postId,omitempty"`
	ReleaseURL  string          `json:"releaseURL,omitempty"`
}

type ValidityMedia struct {
	Path      string `json:"path"`
	Thumbnail string `json:"thumbnail,omitempty"`
}

type AnalyticsData struct {
	Label            string          `json:"label"`
	Data             []AnalyticsItem `json:"data"`
	PercentageChange float64         `json:"percentageChange"`
	// Average marks series the frontend averages instead of summing.
	Average bool `json:"average,omitempty"`
}

type AnalyticsItem struct {
	Total string `json:"total"`
	Date  string `json:"date"`
}

type FetchPageInformationResult struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	AccessToken string `json:"access_token"`
	Picture     string `json:"picture"`
	Username    string `json:"username"`
}

type CustomField struct {
	Key          string `json:"key"`
	Label        string `json:"label"`
	DefaultValue string `json:"defaultValue,omitempty"`
	Validation   string `json:"validation"`
	Type         string `json:"type"` // text | password
	Hint         string `json:"hint,omitempty"`
}

type ExtensionCookie struct {
	Name   string `json:"name"`
	Domain string `json:"domain"`
}

type MentionResult struct {
	NativeID   string `json:"nativeId,omitempty"`
	ID         string `json:"id"`
	Label      string `json:"label"`
	Image      string `json:"image"`
	DoNotCache bool   `json:"doNotCache,omitempty"`
}

// Info is a provider's static metadata (the class fields of a TS provider).
type Info struct {
	Identifier        string
	Name              string
	Editor            string // none | normal | markdown | html
	Scopes            []string
	IsBetweenSteps    bool
	RefreshWait       bool
	ConvertToJPEG     bool
	RefreshCron       bool
	IsWeb3            bool
	IsChromeExtension bool
	ExtensionCookies  []ExtensionCookie
	ToolTip           string
	OneTimeToken      bool
	// MaxConcurrentJob caps the provider's Temporal activity concurrency
	// (SocialAbstract.maxConcurrentJob, default 1).
	MaxConcurrentJob int
	// Rules is the @Rules description shown to the AI agent.
	Rules string
}

// Provider is SocialProvider & SocialAbstract. Embed *Base for the defaults of
// CheckValidity, CheckPostStatus, FinalizePost, MigrationMatch and Mention.
type Provider interface {
	Info() Info
	// MaxLength receives the integration's additionalSettings and the post settings.
	MaxLength(additionalSettings []AdditionalSetting, settings json.RawMessage) int
	GenerateAuthURL(ctx context.Context, client *ClientInformation) (*GenerateAuthURLResponse, error)
	// Authenticate returns AuthMessage as the error where TypeScript returned a string.
	Authenticate(ctx context.Context, params AuthenticateParams, client *ClientInformation) (*AuthTokenDetails, error)
	RefreshToken(ctx context.Context, refreshToken string) (*AuthTokenDetails, error)
	Post(ctx context.Context, id, accessToken string, posts []PostDetails, integration *ent.Integration) ([]PostResponse, error)

	// CheckValidity returns "" when the media is valid, otherwise the message.
	CheckValidity(ctx context.Context, posts [][]ValidityMedia, settings json.RawMessage, additionalSettings []AdditionalSetting) (string, error)
	CheckPostStatus(ctx context.Context, accessToken string, pendingData json.RawMessage, integration *ent.Integration) (*PendingCheckResponse, error)
	FinalizePost(ctx context.Context, accessToken string, pendingData json.RawMessage, integration *ent.Integration) (*PendingCheckResponse, error)
	MigrationMatch(auth AuthTokenDetails, integration *ent.Integration) bool
	// Mention returns none=true when the provider has no mention lookup.
	Mention(ctx context.Context, token, query, id string, integration *ent.Integration) (results []MentionResult, none bool, err error)

	// SettingsDTO returns a new pointer to the provider's settings DTO, or nil.
	SettingsDTO() any
	// Functions are the provider methods callable by name through
	// /integrations/function, the public API and the AI tools.
	Functions() map[string]Function
	// Tools are the @Tool-decorated functions, exposed to the AI agent.
	Tools() []Tool
	// Plugs are the @Plug global automations; InternalPlugs the @PostPlug ones.
	Plugs() []Plug
	InternalPlugs() []InternalPlug
}

// IntegrationRefresher renews credentials that require the saved account/server
// context. The shared refresh service still owns authorization and atomic writes.
type IntegrationRefresher interface {
	RefreshIntegration(context.Context, *ent.Integration) (*AuthTokenDetails, error)
}

// Function is a provider method invoked by name with
// (token, data, internalId, integration).
type Function func(ctx context.Context, accessToken string, data json.RawMessage, internalID string, integration *ent.Integration) (any, error)

type ToolField struct {
	Key         string `json:"key"`
	Type        string `json:"type"`
	Description string `json:"description"`
}

type Tool struct {
	MethodName  string      `json:"methodName"`
	Description string      `json:"description"`
	DataSchema  []ToolField `json:"dataSchema"`
}

type PlugField struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Type        string `json:"type"`
	Placeholder string `json:"placeholder"`
	// Validation is the JavaScript regex literal, e.g. "/^\\d+$/".
	Validation string `json:"validation,omitempty"`
}

// Plug is a global plug: Run is called every RunEveryMilliseconds up to
// TotalRuns times and returns true once it fired.
type Plug struct {
	MethodName           string                                                                                                         `json:"methodName"`
	Identifier           string                                                                                                         `json:"identifier"`
	Title                string                                                                                                         `json:"title"`
	Description          string                                                                                                         `json:"description"`
	RunEveryMilliseconds int64                                                                                                          `json:"runEveryMilliseconds"`
	TotalRuns            int                                                                                                            `json:"totalRuns"`
	Disabled             bool                                                                                                           `json:"disabled,omitempty"`
	Fields               []PlugField                                                                                                    `json:"fields"`
	Run                  func(ctx context.Context, integration *ent.Integration, postID string, fields map[string]string) (bool, error) `json:"-"`
}

// InternalPlug is a @PostPlug, run once after publishing with another channel.
type InternalPlug struct {
	MethodName      string                                                                                                                         `json:"methodName"`
	Identifier      string                                                                                                                         `json:"identifier"`
	Title           string                                                                                                                         `json:"title"`
	Description     string                                                                                                                         `json:"description"`
	PickIntegration []string                                                                                                                       `json:"pickIntegration"`
	Disabled        bool                                                                                                                           `json:"disabled,omitempty"`
	Fields          []PlugField                                                                                                                    `json:"fields"`
	Run             func(ctx context.Context, integration, originalIntegration *ent.Integration, postID string, information json.RawMessage) error `json:"-"`
}

// Optional capabilities. Generic code type-asserts these.

type Commenter interface {
	Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []PostDetails, integration *ent.Integration) ([]PostResponse, error)
}

type PendingPoster interface {
	PostPending(ctx context.Context, id, accessToken string, posts []PostDetails, integration *ent.Integration) ([]PostResponse, error)
}

type Reconnector interface {
	ReConnect(ctx context.Context, id, requiredID, accessToken string) (*AuthTokenDetails, error)
}

type Analytics interface {
	Analytics(ctx context.Context, id, accessToken string, days int) ([]AnalyticsData, error)
}

type PostAnalytics interface {
	PostAnalytics(ctx context.Context, integrationID, accessToken, postID string, fromDate int64) ([]AnalyticsData, error)
}

// ReleaseIDResolution: exactly one of Resolved, Pending, Unavailable is set,
// or the pointer is nil when there is nothing to resolve.
type ReleaseIDResolution struct {
	PostID      string
	ReleaseURL  string
	Pending     bool
	Unavailable bool
}

type ReleaseIDResolver interface {
	ResolveReleaseID(ctx context.Context, accessToken, releaseID string, integration *ent.Integration, settings json.RawMessage, releaseURL string) (*ReleaseIDResolution, error)
}

type ReleaseURLer interface {
	ReleaseURL(ctx context.Context, accessToken, releaseID string, integration *ent.Integration) (string, error)
}

type NicknameChanger interface {
	ChangeNickname(ctx context.Context, id, accessToken, name string) (string, error)
}

type ProfilePictureChanger interface {
	ChangeProfilePicture(ctx context.Context, id, accessToken, url string) (string, error)
}

type MissingFinder interface {
	Missing(ctx context.Context, id, accessToken string) ([]MissingPost, error)
}

type MissingPost struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

type MentionFormatter interface {
	MentionFormat(idOrHandle, name string) string
}

type PageInformationFetcher interface {
	FetchPageInformation(ctx context.Context, accessToken string, data json.RawMessage) (*FetchPageInformationResult, error)
}

type CustomFielder interface {
	CustomFields() []CustomField
}

// ExternalURLer marks providers connected to a user-supplied instance
// (isExternal), returning the app credentials for that instance.
type ExternalURLer interface {
	ExternalURL(ctx context.Context, url string) (*ClientInformation, error)
}

type RefreshErrorMessager interface {
	RefreshErrorMessage(err error) string
}

type LinkStripper interface {
	StripLinks() bool
}

type InlineImager interface {
	InlineImages(settings json.RawMessage) bool
}

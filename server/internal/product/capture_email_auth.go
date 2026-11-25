package product

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureauthattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureauthrecipeversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureemailauthconfig"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureinboundreceipt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformappconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/emailauth"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// RFC 007A: unattended first-factor email sign-in. A person still owns every
// grant of authority: an owner creates the test address, approves the typed
// login recipe, runs a test, and opts in to automatic reconnects. The worker
// then only renews a session a person authorized less than 30 days ago.

const (
	// EventCaptureAuthDispatch starts one email sign-in attempt's workflow.
	EventCaptureAuthDispatch = "capture_auth.dispatch"
	// EventCaptureAuthEmail wakes a waiting attempt: a matching email arrived.
	EventCaptureAuthEmail = "capture_auth.email"

	// captureAuthSetupAllowance covers allocating a browser and loading the
	// sign-in page before the email wait starts.
	captureAuthSetupAllowance = 2 * time.Minute
	// captureAuthClockSkew tolerates provider and database clocks disagreeing.
	captureAuthClockSkew = 30 * time.Second
	// captureAuthReceiptRetention keeps receipt metadata for a week.
	captureAuthReceiptRetention = 7 * 24 * time.Hour
	captureAuthMaxSenders       = 10
	// captureAuthApplyAllowance is how long a matched attempt has to read the
	// email, sign in, prove the state in a fresh browser, and commit.
	captureAuthApplyAllowance = 5 * time.Minute
)

// Safe email sign-in failure codes, beyond the browser codes.
const (
	authFeatureDisabled     = "feature_disabled"
	authConfigIncomplete    = "config_incomplete"
	authPolicyReview        = "auth_policy_review_required"
	authRateLimited         = "rate_limited"
	authDeliveryTimeout     = "email_delivery_timeout"
	authEmailUnmatched      = "email_unmatched"
	authChallengeNotFound   = "challenge_not_found"
	authChallengeAmbiguous  = "challenge_ambiguous"
	authGenerationStale     = "generation_stale"
	authProviderReadFailed  = "provider_read_failed"
	authCancelled           = "cancelled"
	authRevoked             = "revoked"
	authHumanReconnect      = "human_reconnect"
	authReceiptIgnoredLate  = "ignored_late"
	authReceiptNoAttempt    = "no_attempt"
	authReceiptUnknownRoute = "unknown_recipient"
)

// ErrCaptureEmailAuthUnavailable means unattended email sign-in is not
// configured on this deployment.
var ErrCaptureEmailAuthUnavailable = errors.New("unattended email sign-in is not configured")

var activeAuthStates = []captureauthattempt.State{
	captureauthattempt.StateADMITTED, captureauthattempt.StateBROWSER_STARTING, captureauthattempt.StateCHALLENGE_REQUESTED,
	captureauthattempt.StateWAITING_FOR_EMAIL, captureauthattempt.StateEMAIL_MATCHED, captureauthattempt.StateAPPLYING_CHALLENGE,
	captureauthattempt.StateVERIFYING, captureauthattempt.StateCOMMITTING,
}

// captureAuthDispatcher is the optional half of CaptureDispatcher that runs
// email sign-in. A dispatcher without it leaves attempts to fail on deadline.
type captureAuthDispatcher interface {
	StartCaptureAuth(ctx context.Context, org, attemptID string) error
	SignalCaptureAuth(ctx context.Context, org, attemptID string) error
}

// captureEmailAuthRunner is the browser half. browser.Runner implements it.
type captureEmailAuthRunner interface {
	RequestEmailChallenge(ctx context.Context, sessionID string, target browser.Target, hosts []string, recipe browser.LoginRecipe, recipient string, beforeSubmit func() error) error
	ApplyMagicLink(ctx context.Context, sessionID string, target browser.Target, hosts []string, recipe browser.LoginRecipe, link browser.SecretURL) error
	ApplyEmailCode(ctx context.Context, sessionID string, target browser.Target, hosts []string, recipe browser.LoginRecipe, code browser.SecretCode) error
}

// WithEmailAuth enables unattended email sign-in on this process.
func (c *Configuration) WithEmailAuth(settings *emailauth.Settings) *Configuration {
	c.emailAuth = settings
	return c
}

// EmailAuthAvailable reports whether this process can admit email sign-ins.
func (c *Configuration) EmailAuthAvailable() bool {
	if c.emailAuth == nil || !c.CaptureAvailable() {
		return false
	}
	_, ok := c.captureRunner.(captureEmailAuthRunner)
	return ok
}

func (c *Configuration) testAddress(row *ent.CaptureEmailAuthConfig) string {
	return row.RecipientLocalPart + "@" + row.RecipientDomain
}

// CaptureEmailAuthRecord is a connection's email sign-in setup. The test
// address is shown to the owner on purpose: they create that account.
type CaptureEmailAuthRecord struct {
	ID                     string                    `json:"id"`
	ConnectionID           string                    `json:"connectionId"`
	Method                 string                    `json:"method"`
	Status                 string                    `json:"status"`
	TestEmail              string                    `json:"testEmail"`
	ExpectedSenders        []string                  `json:"expectedSenders"`
	AutoReconnect          bool                      `json:"autoReconnect"`
	Revision               int                       `json:"revision"`
	TestedRevision         *int                      `json:"testedRevision"`
	RecipeVersion          *int                      `json:"recipeVersion"`
	Recipe                 *browser.LoginRecipe      `json:"recipe"`
	LastTestedAt           *time.Time                `json:"lastTestedAt"`
	LastSuccessAt          *time.Time                `json:"lastSuccessAt"`
	LastFailureCode        *string                   `json:"lastFailureCode"`
	ApprovedByUserID       *string                   `json:"approvedByUserId"`
	ApprovedAt             *time.Time                `json:"approvedAt"`
	AutoReconnectAvailable bool                      `json:"autoReconnectAvailable"`
	LatestAttempt          *CaptureAuthAttemptRecord `json:"latestAttempt"`
	CreatedAt              time.Time                 `json:"createdAt"`
	UpdatedAt              time.Time                 `json:"updatedAt"`
}

// CaptureAuthAttemptRecord is an attempt's safe progress: states, times, and
// a stable code. It never holds a session ID, email, link, or code.
type CaptureAuthAttemptRecord struct {
	ID               string     `json:"id"`
	ConnectionID     string     `json:"connectionId"`
	Mode             string     `json:"mode"`
	State            string     `json:"state"`
	StartedAt        time.Time  `json:"startedAt"`
	DeadlineAt       time.Time  `json:"deadlineAt"`
	EmailRequestedAt *time.Time `json:"emailRequestedAt"`
	EmailReceivedAt  *time.Time `json:"emailReceivedAt"`
	CompletedAt      *time.Time `json:"completedAt"`
	FailureCode      *string    `json:"failureCode"`
	SafeMessage      string     `json:"safeMessage"`
}

var authStateMessages = map[captureauthattempt.State]string{
	captureauthattempt.StateADMITTED:            "Waiting to start a browser.",
	captureauthattempt.StateBROWSER_STARTING:    "Starting a browser.",
	captureauthattempt.StateCHALLENGE_REQUESTED: "Requesting the sign-in email.",
	captureauthattempt.StateWAITING_FOR_EMAIL:   "Sign-in email requested. Waiting for it to arrive.",
	captureauthattempt.StateEMAIL_MATCHED:       "Sign-in email received.",
	captureauthattempt.StateAPPLYING_CHALLENGE:  "Signing in.",
	captureauthattempt.StateVERIFYING:           "Checking the account in a new browser.",
	captureauthattempt.StateCOMMITTING:          "Saving the session.",
	captureauthattempt.StateSUCCEEDED:           "Signed in. The session is saved.",
	captureauthattempt.StateFAILED:              "The sign-in failed. Reconnect manually or fix the setup.",
	captureauthattempt.StateEXPIRED:             "No sign-in email arrived in time.",
	captureauthattempt.StateCANCELLED:           "The sign-in was stopped.",
	captureauthattempt.StateHUMAN_REQUIRED:      "This app needs a person to sign in. Reconnect manually.",
}

func captureAuthAttemptRecord(row *ent.CaptureAuthAttempt) CaptureAuthAttemptRecord {
	return CaptureAuthAttemptRecord{ID: row.ID, ConnectionID: row.ConnectionID, Mode: string(row.Mode), State: string(row.State), StartedAt: row.CreatedAt,
		DeadlineAt: row.DeadlineAt, EmailRequestedAt: row.EmailRequestedAt, EmailReceivedAt: row.EmailReceivedAt, CompletedAt: row.CompletedAt,
		FailureCode: row.FailureCode, SafeMessage: authStateMessages[row.State]}
}

func (c *Configuration) captureEmailAuthRecord(ctx context.Context, row *ent.CaptureEmailAuthConfig) (*CaptureEmailAuthRecord, error) {
	record := &CaptureEmailAuthRecord{ID: row.ID, ConnectionID: row.ConnectionID, Method: string(row.Method), Status: string(row.Status), TestEmail: c.testAddress(row),
		ExpectedSenders: row.ExpectedSenders, AutoReconnect: row.AutoReconnect, Revision: row.Revision, TestedRevision: row.TestedRevision,
		LastTestedAt: row.LastTestedAt, LastSuccessAt: row.LastSuccessAt, LastFailureCode: row.LastFailureCode, ApprovedByUserID: row.ApprovedByUserID,
		ApprovedAt: row.ApprovedAt, AutoReconnectAvailable: c.emailAuth != nil && c.emailAuth.AutoReconnect, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
	if record.ExpectedSenders == nil {
		record.ExpectedSenders = []string{}
	}
	if row.RecipeVersionID != nil {
		version, err := c.client.CaptureAuthRecipeVersion.Query().Where(captureauthrecipeversion.ID(*row.RecipeVersionID), captureauthrecipeversion.OrganizationID(row.OrganizationID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		recipe, err := loginRecipeFrom(version.Definition)
		if err != nil {
			return nil, err
		}
		record.RecipeVersion, record.Recipe = &version.Version, recipe
	}
	latest, err := c.client.CaptureAuthAttempt.Query().Where(captureauthattempt.OrganizationID(row.OrganizationID), captureauthattempt.ConnectionID(row.ConnectionID)).
		Order(ent.Desc(captureauthattempt.FieldCreatedAt)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if latest != nil {
		attempt := captureAuthAttemptRecord(latest)
		record.LatestAttempt = &attempt
	}
	return record, nil
}

func loginRecipeFrom(definition map[string]any) (*browser.LoginRecipe, error) {
	body, err := json.Marshal(definition)
	if err != nil {
		return nil, err
	}
	var recipe browser.LoginRecipe
	if err := json.Unmarshal(body, &recipe); err != nil {
		return nil, err
	}
	return &recipe, nil
}

func (c *Configuration) emailAuthConnection(ctx context.Context, actor Actor, connectionID string) (*ent.PlatformAppConnection, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	if c.emailAuth == nil {
		return nil, ErrCaptureEmailAuthUnavailable
	}
	row, err := c.client.PlatformAppConnection.Query().Where(platformappconnection.ID(connectionID), platformappconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	return row, err
}

func (c *Configuration) emailAuthConfig(ctx context.Context, org, connectionID string) (*ent.CaptureEmailAuthConfig, error) {
	row, err := c.client.CaptureEmailAuthConfig.Query().Where(captureemailauthconfig.OrganizationID(org), captureemailauthconfig.ConnectionID(connectionID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("This connection has no email sign-in set up.")
	}
	return row, err
}

// GetCaptureEmailAuth shows a connection's email sign-in setup to an owner or admin.
func (c *Configuration) GetCaptureEmailAuth(ctx context.Context, actor Actor, connectionID string) (*CaptureEmailAuthRecord, error) {
	if _, err := c.emailAuthConnection(ctx, actor, connectionID); err != nil {
		return nil, err
	}
	row, err := c.emailAuthConfig(ctx, actor.OrganizationID, connectionID)
	if err != nil {
		return nil, err
	}
	return c.captureEmailAuthRecord(ctx, row)
}

// createEmailAuthConfig assigns a new random test address to a connection.
func (c *Configuration) createEmailAuthConfig(ctx context.Context, tx *ent.Tx, actor Actor, connection *ent.PlatformAppConnection, localPart string) (*ent.CaptureEmailAuthConfig, error) {
	row, err := tx.CaptureEmailAuthConfig.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetConnectionID(connection.ID).SetEnvironment(connection.Environment).
		SetRecipientLocalPart(localPart).SetRecipientDomain(c.emailAuth.Domain).SetMethod(captureemailauthconfig.MethodMAGIC_LINK).SetExpectedSenders([]string{}).
		SetCreatedByUserID(actor.UserID).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, conflict("This connection already has email sign-in set up.")
	}
	if err != nil {
		return nil, err
	}
	return row, appendConfigurationAudit(ctx, tx, actor, "product.capture_email_auth_created", "capture_email_auth_config", row.ID, map[string]any{"connectionId": connection.ID})
}

// CreateCaptureEmailAuth sets up email sign-in on an existing connection. The
// connection's expected account cannot change, so it must prove identity with
// an account element, not an email address: otherwise the owner creates a new
// connection with a Shots-assigned test address instead.
func (c *Configuration) CreateCaptureEmailAuth(ctx context.Context, actor Actor, connectionID string) (*CaptureEmailAuthRecord, error) {
	connection, err := c.emailAuthConnection(ctx, actor, connectionID)
	if err != nil {
		return nil, err
	}
	if connection.Status == platformappconnection.StatusREVOKED {
		return nil, publishing.ErrInvalidState
	}
	if strings.Contains(connection.ExpectedAccount, "@") || connection.IdentitySelector == "" {
		return nil, conflict("This connection expects another account. Create a new connection with a Shots test email address.")
	}
	localPart, err := emailauth.NewLocalPart()
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := c.createEmailAuthConfig(ctx, tx, actor, connection, localPart)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.captureEmailAuthRecord(ctx, row)
}

// SaveCaptureEmailAuthRecipeInput is a new login recipe version and sender list.
type SaveCaptureEmailAuthRecipeInput struct {
	ExpectedRevision int                 `json:"expectedRevision"`
	Recipe           browser.LoginRecipe `json:"recipe"`
	ExpectedSenders  []string            `json:"expectedSenders"`
}

// SaveCaptureEmailAuthRecipe stores an immutable new recipe version. Any change
// returns the setup to DRAFT and turns automatic reconnects off until a new
// test passes and the owner opts in again.
func (c *Configuration) SaveCaptureEmailAuthRecipe(ctx context.Context, actor Actor, connectionID string, input SaveCaptureEmailAuthRecipeInput) (*CaptureEmailAuthRecord, error) {
	connection, err := c.emailAuthConnection(ctx, actor, connectionID)
	if err != nil {
		return nil, err
	}
	if err := input.Recipe.Validate(); err != nil {
		return nil, invalid(err.Error())
	}
	approved := append(slices.Clone(connection.Hosts), connection.LoginHosts...)
	for _, host := range input.Recipe.LinkHosts {
		if !browser.HostApproved(host, approved) {
			return nil, invalid("Sign-in link hosts must be among the connection's approved app or sign-in hosts.")
		}
	}
	if len(input.ExpectedSenders) == 0 || len(input.ExpectedSenders) > captureAuthMaxSenders {
		return nil, invalid("List 1–10 sender addresses or @domains the sign-in email comes from.")
	}
	senders := make([]string, 0, len(input.ExpectedSenders))
	for _, sender := range input.ExpectedSenders {
		if !emailauth.ValidSenderRule(sender) {
			return nil, invalid("Senders must be exact addresses, such as login@example.com, or @example.com.")
		}
		senders = append(senders, strings.ToLower(strings.TrimSpace(sender)))
	}
	hash, err := input.Recipe.Hash()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(input.Recipe)
	if err != nil {
		return nil, err
	}
	var definition map[string]any
	if err := json.Unmarshal(body, &definition); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	config, err := lockEmailAuthConfig(ctx, tx, actor.OrganizationID, connectionID)
	if err != nil {
		return nil, err
	}
	if config.Status == captureemailauthconfig.StatusREVOKED {
		return nil, publishing.ErrInvalidState
	}
	if config.Revision != input.ExpectedRevision {
		return nil, conflict("The setup changed since you opened it. Reload and try again.")
	}
	latest, err := tx.CaptureAuthRecipeVersion.Query().Where(captureauthrecipeversion.ConfigID(config.ID)).Order(ent.Desc(captureauthrecipeversion.FieldVersion)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	next := 1
	if latest != nil {
		next = latest.Version + 1
	}
	version, err := tx.CaptureAuthRecipeVersion.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetConnectionID(connectionID).SetConfigID(config.ID).
		SetVersion(next).SetDefinition(definition).SetDefinitionHash(hash).SetCreatedByUserID(actor.UserID).Save(ctx)
	if err != nil {
		return nil, err
	}
	status := captureemailauthconfig.StatusDRAFT
	if config.Status == captureemailauthconfig.StatusPAUSED {
		status = captureemailauthconfig.StatusPAUSED
	}
	updated, err := config.Update().SetRecipeVersionID(version.ID).SetMethod(captureemailauthconfig.Method(input.Recipe.Method)).SetExpectedSenders(senders).
		AddRevision(1).SetStatus(status).SetAutoReconnect(false).ClearTestedRevision().ClearApprovedAt().ClearApprovedByUserID().Save(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := cancelAuthAttempts(ctx, tx, actor.OrganizationID, connectionID, authGenerationStale); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_email_auth_recipe_saved", "capture_email_auth_config", config.ID, map[string]any{"version": next, "revision": updated.Revision, "hash": hash}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.captureEmailAuthRecord(ctx, updated)
}

func lockEmailAuthConfig(ctx context.Context, tx *ent.Tx, org, connectionID string) (*ent.CaptureEmailAuthConfig, error) {
	n, err := tx.CaptureEmailAuthConfig.Update().Where(captureemailauthconfig.OrganizationID(org), captureemailauthconfig.ConnectionID(connectionID)).SetUpdatedAt(time.Now()).Save(ctx)
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, notFound("This connection has no email sign-in set up.")
	}
	return tx.CaptureEmailAuthConfig.Query().Where(captureemailauthconfig.OrganizationID(org), captureemailauthconfig.ConnectionID(connectionID)).Only(ctx)
}

// TestCaptureEmailAuth starts one sign-in an owner watches. A passing test is
// what lets the owner turn on automatic reconnects for this exact revision.
func (c *Configuration) TestCaptureEmailAuth(ctx context.Context, actor Actor, connectionID string) (*CaptureAuthAttemptRecord, error) {
	if _, err := c.emailAuthConnection(ctx, actor, connectionID); err != nil {
		return nil, err
	}
	if !c.EmailAuthAvailable() {
		return nil, ErrCaptureEmailAuthUnavailable
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	connection, err := lockCaptureConnection(ctx, tx, actor.OrganizationID, connectionID)
	if err != nil {
		return nil, err
	}
	config, err := lockEmailAuthConfig(ctx, tx, actor.OrganizationID, connectionID)
	if err != nil {
		return nil, err
	}
	userID := actor.UserID
	attempt, code, err := c.admitAuthAttempt(ctx, tx, connection, config, captureauthattempt.ModeTEST, &userID, nil)
	if err != nil {
		return nil, err
	}
	if code != "" {
		return nil, authAdmissionError(code)
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_email_auth_test_started", "capture_auth_attempt", attempt.ID, map[string]any{"connectionId": connectionID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := captureAuthAttemptRecord(attempt)
	return &record, nil
}

func authAdmissionError(code string) error {
	switch code {
	case authRateLimited:
		return conflict("This connection reached its sign-in attempts for today. Try again tomorrow or reconnect manually.")
	case authConfigIncomplete:
		return invalid("Save a login recipe and sender list first.")
	case authPolicyReview:
		return conflict("A person must reconnect this app before automatic sign-in can renew it.")
	case authHumanReconnect:
		return conflict("A person is signing in to this connection now.")
	case authRevoked:
		return publishing.ErrInvalidState
	case authFeatureDisabled:
		return ErrCaptureEmailAuthUnavailable
	default:
		return conflict("Another sign-in is running. Wait for it to finish.")
	}
}

// admitAuthAttempt applies every admission rule under the connection and
// config row locks, and a workspace lock for the one-per-workspace limit. It
// returns a code instead of an error for a refusal, so automatic recovery can
// leave a job parked without failing the transaction that parked it.
func (c *Configuration) admitAuthAttempt(ctx context.Context, tx *ent.Tx, connection *ent.PlatformAppConnection, config *ent.CaptureEmailAuthConfig, mode captureauthattempt.Mode, userID, jobID *string) (*ent.CaptureAuthAttempt, string, error) {
	now := time.Now().UTC()
	settings := c.emailAuth
	if settings == nil {
		return nil, authFeatureDisabled, nil
	}
	switch {
	case connection.Status == platformappconnection.StatusREVOKED || config.Status == captureemailauthconfig.StatusREVOKED:
		return nil, authRevoked, nil
	case config.RecipeVersionID == nil || len(config.ExpectedSenders) == 0:
		return nil, authConfigIncomplete, nil
	case config.Environment != connection.Environment:
		return nil, authPolicyReview, nil
	case connection.ConnectPhase != nil && connection.ConnectExpiresAt != nil && connection.ConnectExpiresAt.After(now):
		return nil, authHumanReconnect, nil
	}
	if mode == captureauthattempt.ModeAUTO_RECOVER {
		// Automatic work renews a person's recent authorization; it never starts one.
		if !settings.AutoReconnect || !config.AutoReconnect || config.Status != captureemailauthconfig.StatusVERIFIED || config.TestedRevision == nil || *config.TestedRevision != config.Revision {
			return nil, authFeatureDisabled, nil
		}
		if connection.ValidatedAt == nil || !connection.ValidatedAt.Add(captureStateAbsoluteAge).After(now) {
			return nil, authPolicyReview, nil
		}
		if owner, err := approverIsOwner(ctx, tx.Client(), config); err != nil || !owner {
			return nil, authPolicyReview, err
		}
	}
	recipe, err := tx.CaptureAuthRecipeVersion.Query().Where(captureauthrecipeversion.ID(*config.RecipeVersionID), captureauthrecipeversion.OrganizationID(connection.OrganizationID)).Only(ctx)
	if err != nil {
		return nil, "", err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext('capture-auth:' || $1))`, connection.OrganizationID); err != nil {
		return nil, "", err
	}
	active, err := tx.CaptureAuthAttempt.Query().Where(captureauthattempt.OrganizationID(connection.OrganizationID), captureauthattempt.StateIn(activeAuthStates...)).Count(ctx)
	if err != nil {
		return nil, "", err
	}
	if active >= emailauth.MaxActivePerOrganization {
		return nil, "busy", nil
	}
	global, err := tx.CaptureAuthAttempt.Query().Where(captureauthattempt.StateIn(activeAuthStates...)).Count(ctx)
	if err != nil {
		return nil, "", err
	}
	if global >= settings.MaxActive {
		return nil, "busy", nil
	}
	today, err := tx.CaptureAuthAttempt.Query().Where(captureauthattempt.OrganizationID(connection.OrganizationID), captureauthattempt.ConnectionID(connection.ID), captureauthattempt.CreatedAtGT(now.Add(-24*time.Hour))).Count(ctx)
	if err != nil {
		return nil, "", err
	}
	if today >= settings.DailyAttempts {
		return nil, authRateLimited, nil
	}
	attempt, err := tx.CaptureAuthAttempt.Create().SetID(cuid.New()).SetOrganizationID(connection.OrganizationID).SetConnectionID(connection.ID).SetConfigID(config.ID).
		SetConfigRevision(config.Revision).SetRecipeVersionID(recipe.ID).SetRecipeHash(recipe.DefinitionHash).SetConnectionGeneration(connection.Generation).SetMode(mode).
		SetDeadlineAt(now.Add(captureAuthSetupAllowance + settings.AttemptTTL)).SetNillableCreatedByUserID(userID).SetNillableTriggerCaptureJobID(jobID).Save(ctx)
	if err != nil {
		return nil, "", err
	}
	if err := captureOutbox(ctx, tx, connection.OrganizationID, EventCaptureAuthDispatch, "capture_auth_attempt", attempt.ID, "0"); err != nil {
		return nil, "", err
	}
	return attempt, "", nil
}

// admitEmailAuthRecovery starts one automatic sign-in for a job parked on
// needs_auth, when its owner opted in. Any refusal leaves the job parked for a
// person, exactly as without this feature; one attempt serves every parked job.
func (c *Configuration) admitEmailAuthRecovery(ctx context.Context, tx *ent.Tx, job *ent.CaptureJob) error {
	// The outbox starts the attempt, on whichever process dispatches it.
	if c.emailAuth == nil || !c.emailAuth.AutoReconnect || job.AppConnectionID == nil {
		return nil
	}
	config, err := tx.CaptureEmailAuthConfig.Query().Where(captureemailauthconfig.OrganizationID(job.OrganizationID), captureemailauthconfig.ConnectionID(*job.AppConnectionID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !config.AutoReconnect || config.Status != captureemailauthconfig.StatusVERIFIED {
		return nil
	}
	connection, err := tx.PlatformAppConnection.Query().Where(platformappconnection.ID(*job.AppConnectionID), platformappconnection.OrganizationID(job.OrganizationID)).Only(ctx)
	if err != nil {
		return err
	}
	attempt, code, err := c.admitAuthAttempt(ctx, tx, connection, config, captureauthattempt.ModeAUTO_RECOVER, nil, &job.ID)
	if err != nil {
		return err
	}
	if code != "" {
		return nil
	}
	return appendConfigurationAudit(ctx, tx, Actor{OrganizationID: job.OrganizationID, Kind: "service", Display: "capture", RequestID: attempt.ID},
		"product.capture_email_auth_recovery_started", "capture_auth_attempt", attempt.ID, map[string]any{"connectionId": connection.ID, "captureJobId": job.ID})
}

// EnableCaptureEmailAuthInput confirms the revision the owner approves.
type EnableCaptureEmailAuthInput struct {
	ExpectedRevision int `json:"expectedRevision"`
}

// EnableCaptureEmailAuth is the owner's opt-in to automatic reconnects. It
// needs a passing test of this exact revision.
func (c *Configuration) EnableCaptureEmailAuth(ctx context.Context, actor Actor, connectionID string, input EnableCaptureEmailAuthInput) (*CaptureEmailAuthRecord, error) {
	if _, err := c.emailAuthConnection(ctx, actor, connectionID); err != nil {
		return nil, err
	}
	if err := c.authorizeRoles(ctx, actor, "owner"); err != nil {
		return nil, forbidden("Only a workspace owner can turn on automatic sign-in.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	config, err := lockEmailAuthConfig(ctx, tx, actor.OrganizationID, connectionID)
	if err != nil {
		return nil, err
	}
	if config.Status == captureemailauthconfig.StatusREVOKED {
		return nil, publishing.ErrInvalidState
	}
	if config.Revision != input.ExpectedRevision {
		return nil, conflict("The setup changed since you opened it. Reload and try again.")
	}
	if config.TestedRevision == nil || *config.TestedRevision != config.Revision {
		return nil, conflict("Run a passing test of this setup first.")
	}
	now := time.Now().UTC()
	updated, err := config.Update().SetAutoReconnect(true).SetStatus(captureemailauthconfig.StatusVERIFIED).SetApprovedByUserID(actor.UserID).SetApprovedAt(now).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_email_auth_enabled", "capture_email_auth_config", config.ID, map[string]any{"revision": config.Revision}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.captureEmailAuthRecord(ctx, updated)
}

// PauseCaptureEmailAuth stops automatic reconnects and any running attempt.
func (c *Configuration) PauseCaptureEmailAuth(ctx context.Context, actor Actor, connectionID string) (*CaptureEmailAuthRecord, error) {
	return c.stopCaptureEmailAuth(ctx, actor, connectionID, captureemailauthconfig.StatusPAUSED, "product.capture_email_auth_paused")
}

// RevokeCaptureEmailAuth ends the setup: the address stops routing, running
// attempts stop, and only an audit record remains.
func (c *Configuration) RevokeCaptureEmailAuth(ctx context.Context, actor Actor, connectionID string) error {
	_, err := c.stopCaptureEmailAuth(ctx, actor, connectionID, captureemailauthconfig.StatusREVOKED, "product.capture_email_auth_revoked")
	return err
}

func (c *Configuration) stopCaptureEmailAuth(ctx context.Context, actor Actor, connectionID string, status captureemailauthconfig.Status, action string) (*CaptureEmailAuthRecord, error) {
	if _, err := c.emailAuthConnection(ctx, actor, connectionID); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	config, err := lockEmailAuthConfig(ctx, tx, actor.OrganizationID, connectionID)
	if err != nil {
		return nil, err
	}
	if config.Status == captureemailauthconfig.StatusREVOKED {
		if status == captureemailauthconfig.StatusREVOKED {
			return nil, tx.Commit()
		}
		return nil, publishing.ErrInvalidState
	}
	update := config.Update().SetStatus(status).SetAutoReconnect(false)
	if status == captureemailauthconfig.StatusREVOKED {
		update.SetRevokedAt(time.Now().UTC()).AddRevision(1)
	}
	updated, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	code := authCancelled
	if status == captureemailauthconfig.StatusREVOKED {
		code = authRevoked
	}
	sessions, err := cancelAuthAttempts(ctx, tx, actor.OrganizationID, connectionID, code)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, action, "capture_email_auth_config", config.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	c.closeAuthSessions(ctx, sessions)
	if status == captureemailauthconfig.StatusREVOKED {
		return nil, nil
	}
	return c.captureEmailAuthRecord(ctx, updated)
}

// GetCaptureAuthAttempt shows one attempt's safe progress.
func (c *Configuration) GetCaptureAuthAttempt(ctx context.Context, actor Actor, attemptID string) (*CaptureAuthAttemptRecord, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.CaptureAuthAttempt.Query().Where(captureauthattempt.ID(attemptID), captureauthattempt.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	record := captureAuthAttemptRecord(row)
	return &record, nil
}

// CancelCaptureAuthAttempt stops one attempt; cancelling a finished one is a no-op.
func (c *Configuration) CancelCaptureAuthAttempt(ctx context.Context, actor Actor, attemptID string) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	row, err := c.client.CaptureAuthAttempt.Query().Where(captureauthattempt.ID(attemptID), captureauthattempt.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	n, err := tx.CaptureAuthAttempt.Update().Where(captureauthattempt.ID(row.ID), captureauthattempt.OrganizationID(actor.OrganizationID), captureauthattempt.StateIn(activeAuthStates...)).
		SetState(captureauthattempt.StateCANCELLED).SetFailureCode(authCancelled).SetCompletedAt(time.Now().UTC()).AddFenceToken(1).Save(ctx)
	if err != nil {
		return err
	}
	if n == 1 {
		if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_email_auth_attempt_cancelled", "capture_auth_attempt", row.ID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if n == 1 && row.BrowserSessionID != nil {
		c.closeAuthSessions(ctx, []string{*row.BrowserSessionID})
	}
	return nil
}

// cancelAuthAttempts ends every active attempt on a connection and returns the
// browsers to close after commit. A worker holding one fails its next fence.
func cancelAuthAttempts(ctx context.Context, tx *ent.Tx, org, connectionID, code string) ([]string, error) {
	active, err := tx.CaptureAuthAttempt.Query().Where(captureauthattempt.OrganizationID(org), captureauthattempt.ConnectionID(connectionID), captureauthattempt.StateIn(activeAuthStates...)).All(ctx)
	if err != nil {
		return nil, err
	}
	sessions := []string{}
	for _, attempt := range active {
		if err := attempt.Update().SetState(captureauthattempt.StateCANCELLED).SetFailureCode(code).SetCompletedAt(time.Now().UTC()).AddFenceToken(1).Exec(ctx); err != nil {
			return nil, err
		}
		if attempt.BrowserSessionID != nil {
			sessions = append(sessions, *attempt.BrowserSessionID)
		}
	}
	return sessions, nil
}

func (c *Configuration) closeAuthSessions(ctx context.Context, sessions []string) {
	if c.captureRunner == nil {
		return
	}
	for _, session := range sessions {
		// The cleanup sweep retries a close that fails here.
		_ = c.captureRunner.Close(context.WithoutCancel(ctx), session)
	}
}

// InboundEmailResult says what an email.received delivery did, without content.
type InboundEmailResult struct {
	Outcome string `json:"outcome"`
}

// ErrInboundSignature is a webhook delivery that did not verify.
var ErrInboundSignature = errors.New("inbound email signature did not verify")

// InboundEmailHeaders are the Svix headers a Resend webhook carries.
type InboundEmailHeaders struct {
	ID        string
	Timestamp string
	Signature string
}

// ReceiveCaptureAuthEmail records a verified email.received delivery. It runs
// on raw bytes: the signature is checked before any parsing. It stores IDs
// and a recipient hash only, matches the email to at most one waiting
// attempt, and commits before acknowledging, so Resend retries a failure and
// a retry is a no-op. It never fetches the email or touches a browser.
func (c *Configuration) ReceiveCaptureAuthEmail(ctx context.Context, headers InboundEmailHeaders, body []byte) (*InboundEmailResult, error) {
	if c.emailAuth == nil {
		return nil, ErrCaptureEmailAuthUnavailable
	}
	if emailauth.VerifySignature(c.emailAuth.WebhookSecret, headers.ID, headers.Timestamp, headers.Signature, body, time.Now()) != nil {
		return nil, ErrInboundSignature
	}
	var event struct {
		Type      string `json:"type"`
		CreatedAt string `json:"created_at"`
		Data      struct {
			EmailID   string   `json:"email_id"`
			From      string   `json:"from"`
			To        []string `json:"to"`
			CreatedAt string   `json:"created_at"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &event); err != nil {
		return nil, invalid("The delivery is not JSON.")
	}
	if event.Type != "email.received" {
		return &InboundEmailResult{Outcome: "ignored"}, nil
	}
	if event.Data.EmailID == "" || len(event.Data.EmailID) > 255 || len(event.Data.To) == 0 || len(event.Data.To) > 50 {
		return nil, invalid("The delivery has no email ID or recipient.")
	}
	receivedAt := time.Now().UTC()
	for _, raw := range []string{event.Data.CreatedAt, event.CreatedAt} {
		if at, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			receivedAt = at.UTC()
			break
		}
	}
	return c.recordInboundEmail(ctx, headers.ID, event.Data.EmailID, event.Data.From, event.Data.To, receivedAt)
}

// recordInboundEmail stores one received email's metadata and matches it to
// at most one waiting attempt. The webhook and the reconciling list both use
// it, so a message seen both ways is recorded once.
func (c *Configuration) recordInboundEmail(ctx context.Context, eventID, emailID, from string, to []string, receivedAt time.Time) (*InboundEmailResult, error) {
	now := time.Now().UTC()
	// Exactly one configured address may match; mail to several of our test
	// addresses at once is not a sign-in email.
	var route *ent.CaptureEmailAuthConfig
	routeHash := ""
	for _, raw := range to {
		address, ok := emailauth.Canonical(raw)
		if !ok {
			continue
		}
		local, domain, _ := strings.Cut(address, "@")
		if routeHash == "" {
			routeHash = emailauth.RecipientHash(c.emailAuth.WebhookSecret, address)
		}
		if domain != c.emailAuth.Domain {
			continue
		}
		row, err := c.client.CaptureEmailAuthConfig.Query().Where(captureemailauthconfig.RecipientLocalPart(local), captureemailauthconfig.RecipientDomain(domain),
			captureemailauthconfig.StatusNEQ(captureemailauthconfig.StatusREVOKED)).Only(ctx)
		if ent.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if route != nil && route.ID != row.ID {
			route = nil
			break
		}
		route = row
		routeHash = emailauth.RecipientHash(c.emailAuth.WebhookSecret, address)
	}
	if routeHash == "" {
		routeHash = "none"
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	seen, err := tx.CaptureInboundReceipt.Query().Where(captureinboundreceipt.Provider("resend"),
		captureinboundreceipt.Or(captureinboundreceipt.ProviderEventID(eventID), captureinboundreceipt.ProviderEmailID(emailID))).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if seen {
		return &InboundEmailResult{Outcome: "duplicate"}, tx.Commit()
	}
	receipt := tx.CaptureInboundReceipt.Create().SetID(cuid.New()).SetProvider("resend").SetProviderEventID(eventID).SetProviderEmailID(emailID).
		SetRecipientHash(routeHash).SetReceivedAt(receivedAt).SetExpiresAt(now.Add(captureAuthReceiptRetention))
	ignore := func(code string) (*InboundEmailResult, error) {
		if err := receipt.SetState(captureinboundreceipt.StateIGNORED).SetFailureCode(code).SetProcessedAt(now).Exec(ctx); err != nil {
			if ent.IsConstraintError(err) {
				return &InboundEmailResult{Outcome: "duplicate"}, nil
			}
			return nil, err
		}
		return &InboundEmailResult{Outcome: "ignored"}, tx.Commit()
	}
	if route == nil {
		return ignore(authReceiptUnknownRoute)
	}
	receipt.SetOrganizationID(route.OrganizationID).SetConfigID(route.ID)
	// The connection lock orders this match against admission and cancellation.
	if _, err := lockCaptureConnection(ctx, tx, route.OrganizationID, route.ConnectionID); err != nil {
		return nil, err
	}
	attempt, err := tx.CaptureAuthAttempt.Query().Where(captureauthattempt.OrganizationID(route.OrganizationID), captureauthattempt.ConnectionID(route.ConnectionID),
		captureauthattempt.StateIn(activeAuthStates...)).Only(ctx)
	if ent.IsNotFound(err) {
		return ignore(authReceiptNoAttempt)
	}
	if err != nil {
		return nil, err
	}
	// The From header is spoofable, so a mismatch is ignored without failing
	// the attempt: a stranger cannot stop a sign-in by mailing the address.
	if !emailauth.SenderAllowed(from, route.ExpectedSenders) {
		return ignore(authEmailUnmatched)
	}
	// An email older than the request, or past the wait, belongs to no attempt.
	if attempt.EmailRequestedAt == nil || receivedAt.Before(attempt.EmailRequestedAt.Add(-captureAuthClockSkew)) {
		return ignore(authReceiptIgnoredLate)
	}
	switch attempt.State {
	case captureauthattempt.StateCHALLENGE_REQUESTED, captureauthattempt.StateWAITING_FOR_EMAIL:
		if now.After(attempt.DeadlineAt) {
			return ignore(authReceiptIgnoredLate)
		}
	case captureauthattempt.StateEMAIL_MATCHED:
		// A second plausible email before the first was used: choose neither.
		if err := receipt.SetState(captureinboundreceipt.StateIGNORED).SetFailureCode(authChallengeAmbiguous).SetProcessedAt(now).SetAttemptID(attempt.ID).Exec(ctx); err != nil {
			return nil, err
		}
		n, err := tx.CaptureAuthAttempt.Update().Where(captureauthattempt.ID(attempt.ID), captureauthattempt.StateEQ(captureauthattempt.StateEMAIL_MATCHED)).
			SetState(captureauthattempt.StateFAILED).SetFailureCode(authChallengeAmbiguous).SetCompletedAt(now).AddFenceToken(1).Save(ctx)
		if err != nil {
			return nil, err
		}
		if n == 1 {
			if err := captureOutbox(ctx, tx, route.OrganizationID, EventCaptureAuthEmail, "capture_auth_attempt", attempt.ID, emailID); err != nil {
				return nil, err
			}
		}
		return &InboundEmailResult{Outcome: "ambiguous"}, tx.Commit()
	default:
		return ignore(authReceiptIgnoredLate)
	}
	saved, err := receipt.SetState(captureinboundreceipt.StateASSIGNED).SetAttemptID(attempt.ID).SetProcessedAt(now).Save(ctx)
	if ent.IsConstraintError(err) {
		return &InboundEmailResult{Outcome: "duplicate"}, nil
	}
	if err != nil {
		return nil, err
	}
	// A matched attempt gets its own time to apply, so neither the deadline
	// check nor the cleanup sweep ends a sign-in that is still running.
	if err := attempt.Update().SetState(captureauthattempt.StateEMAIL_MATCHED).SetEmailReceivedAt(now).SetReceiptID(saved.ID).SetDeadlineAt(now.Add(captureAuthApplyAllowance)).Exec(ctx); err != nil {
		return nil, err
	}
	if err := captureOutbox(ctx, tx, route.OrganizationID, EventCaptureAuthEmail, "capture_auth_attempt", attempt.ID, emailID); err != nil {
		return nil, err
	}
	return &InboundEmailResult{Outcome: "matched"}, tx.Commit()
}

// CaptureAuthStep is what a workflow learns from an activity: whether the
// attempt ended and whether an email is waiting. It is safe in history.
type CaptureAuthStep struct {
	Done    bool `json:"done"`
	Matched bool `json:"matched"`
}

// authFence is an attempt's pinned authority, read before each external step.
type authFence struct {
	attempt    *ent.CaptureAuthAttempt
	config     *ent.CaptureEmailAuthConfig
	connection *ent.PlatformAppConnection
	recipe     browser.LoginRecipe
}

// loadAuthFence re-reads the attempt and checks nothing replaced its
// authority. A non-empty code means the attempt must stop.
func (c *Configuration) loadAuthFence(ctx context.Context, org, attemptID string) (*authFence, string, error) {
	attempt, err := c.client.CaptureAuthAttempt.Query().Where(captureauthattempt.ID(attemptID), captureauthattempt.OrganizationID(org)).Only(ctx)
	if err != nil {
		return nil, "", err
	}
	fence := &authFence{attempt: attempt}
	if !slices.Contains(activeAuthStates, attempt.State) {
		return fence, "done", nil
	}
	if c.emailAuth == nil {
		return fence, authFeatureDisabled, nil
	}
	if fence.config, err = c.client.CaptureEmailAuthConfig.Query().Where(captureemailauthconfig.ID(attempt.ConfigID), captureemailauthconfig.OrganizationID(org)).Only(ctx); err != nil {
		return nil, "", err
	}
	if fence.connection, err = c.client.PlatformAppConnection.Query().Where(platformappconnection.ID(attempt.ConnectionID), platformappconnection.OrganizationID(org)).Only(ctx); err != nil {
		return nil, "", err
	}
	version, err := c.client.CaptureAuthRecipeVersion.Query().Where(captureauthrecipeversion.ID(attempt.RecipeVersionID), captureauthrecipeversion.OrganizationID(org)).Only(ctx)
	if err != nil {
		return nil, "", err
	}
	recipe, err := loginRecipeFrom(version.Definition)
	if err != nil {
		return nil, "", err
	}
	fence.recipe = *recipe
	if hash, err := recipe.Hash(); err != nil || hash != attempt.RecipeHash || recipe.Validate() != nil {
		return fence, string(browser.RecipeInvalid), nil
	}
	now := time.Now().UTC()
	switch {
	case fence.connection.Status == platformappconnection.StatusREVOKED || fence.config.Status == captureemailauthconfig.StatusREVOKED:
		return fence, authRevoked, nil
	case fence.config.Revision != attempt.ConfigRevision || fence.connection.Generation != attempt.ConnectionGeneration:
		return fence, authGenerationStale, nil
	case fence.connection.ConnectPhase != nil && fence.connection.ConnectExpiresAt != nil && fence.connection.ConnectExpiresAt.After(now):
		return fence, authHumanReconnect, nil
	case attempt.Mode == captureauthattempt.ModeAUTO_RECOVER && (fence.connection.ValidatedAt == nil || !fence.connection.ValidatedAt.Add(captureStateAbsoluteAge).After(now)):
		return fence, authPolicyReview, nil
	case attempt.Mode == captureauthattempt.ModeAUTO_RECOVER && (!fence.config.AutoReconnect || fence.config.Status != captureemailauthconfig.StatusVERIFIED):
		return fence, authCancelled, nil
	}
	if attempt.Mode == captureauthattempt.ModeAUTO_RECOVER {
		if owner, err := approverIsOwner(ctx, c.client, fence.config); err != nil {
			return nil, "", err
		} else if !owner {
			return fence, authPolicyReview, nil
		}
	}
	switch {
	case now.After(attempt.DeadlineAt):
		return fence, authDeliveryTimeout, nil
	}
	return fence, "", nil
}

// approverIsOwner reports whether the person who turned on automatic sign-in
// is still an owner. An opt-in does not outlive its author's authority.
func approverIsOwner(ctx context.Context, client *ent.Client, config *ent.CaptureEmailAuthConfig) (bool, error) {
	if config.ApprovedByUserID == nil {
		return false, nil
	}
	return client.Member.Query().Where(member.OrganizationID(config.OrganizationID), member.UserID(*config.ApprovedByUserID), member.Role("owner")).Exist(ctx)
}

func (f *authFence) target() browser.Target { return captureTarget(f.connection) }

func (f *authFence) loginHosts() []string {
	return browser.LoginHosts(f.target(), f.connection.LoginHosts, f.recipe)
}

// advanceAuth moves an attempt from one state to the next only if no one else
// moved it, and returns whether it did.
func (c *Configuration) advanceAuth(ctx context.Context, attempt *ent.CaptureAuthAttempt, from, to captureauthattempt.State, update func(*ent.CaptureAuthAttemptUpdate)) (bool, error) {
	query := c.client.CaptureAuthAttempt.Update().Where(captureauthattempt.ID(attempt.ID), captureauthattempt.OrganizationID(attempt.OrganizationID), captureauthattempt.StateEQ(from), captureauthattempt.FenceToken(attempt.FenceToken)).
		SetState(to).AddFenceToken(1)
	if update != nil {
		update(query)
	}
	n, err := query.Save(ctx)
	if err == nil && n == 1 {
		attempt.State, attempt.FenceToken = to, attempt.FenceToken+1
	}
	return n == 1, err
}

// finishAuthAttempt ends an active attempt with a safe code and closes its
// browser. A code a person must answer ends as HUMAN_REQUIRED.
func (c *Configuration) finishAuthAttempt(ctx context.Context, org, attemptID, code string) error {
	ctx = context.WithoutCancel(ctx)
	state := captureauthattempt.StateFAILED
	switch code {
	case authDeliveryTimeout:
		state = captureauthattempt.StateEXPIRED
	case authCancelled, authRevoked, authGenerationStale, authHumanReconnect, authFeatureDisabled:
		state = captureauthattempt.StateCANCELLED
	case string(browser.UnsupportedFactor), string(browser.LoginPageChanged), string(browser.WrongAccount), string(browser.SessionRestoreUnsupported), authPolicyReview:
		state = captureauthattempt.StateHUMAN_REQUIRED
	}
	now := time.Now().UTC()
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	attempt, err := tx.CaptureAuthAttempt.Query().Where(captureauthattempt.ID(attemptID), captureauthattempt.OrganizationID(org)).Only(ctx)
	if err != nil {
		return err
	}
	if slices.Contains(activeAuthStates, attempt.State) {
		if err := attempt.Update().SetState(state).SetFailureCode(code).SetCompletedAt(now).AddFenceToken(1).Exec(ctx); err != nil {
			return err
		}
		update := tx.CaptureEmailAuthConfig.Update().Where(captureemailauthconfig.ID(attempt.ConfigID), captureemailauthconfig.OrganizationID(org)).SetLastFailureCode(code)
		if attempt.Mode == captureauthattempt.ModeTEST {
			update.SetLastTestedAt(now)
		}
		if err := update.Exec(ctx); err != nil {
			return err
		}
		if attempt.ReceiptID != nil {
			if err := tx.CaptureInboundReceipt.Update().Where(captureinboundreceipt.ID(*attempt.ReceiptID), captureinboundreceipt.StateEQ(captureinboundreceipt.StateASSIGNED)).
				SetState(captureinboundreceipt.StateFAILED).SetFailureCode(code).Exec(ctx); err != nil {
				return err
			}
		}
		slog.Info("capture email sign-in ended", "attempt", attempt.ID, "mode", attempt.Mode, "state", state, "code", code)
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return c.closeAuthBrowser(ctx, attempt)
}

func (c *Configuration) closeAuthBrowser(ctx context.Context, attempt *ent.CaptureAuthAttempt) error {
	if attempt.BrowserSessionID == nil || attempt.BrowserClosedAt != nil || c.captureRunner == nil {
		return nil
	}
	if err := c.captureRunner.Close(context.WithoutCancel(ctx), *attempt.BrowserSessionID); err != nil {
		return nil // the cleanup sweep retries
	}
	return c.client.CaptureAuthAttempt.Update().Where(captureauthattempt.ID(attempt.ID)).SetBrowserClosedAt(time.Now().UTC()).Exec(context.WithoutCancel(ctx))
}

func failureCode(err error) string {
	var failure *browser.Failure
	if errors.As(err, &failure) {
		if failure.Code == browser.NeedsAuth {
			return string(browser.SignInIncomplete)
		}
		return string(failure.Code)
	}
	return string(browser.ProviderUnavailable)
}

// RequestCaptureAuthChallenge is the first activity: start a guarded browser,
// open the sign-in page, and ask for one email. Allocation may be retried
// because nothing was sent yet; the send itself never is.
func (c *Configuration) RequestCaptureAuthChallenge(ctx context.Context, org, attemptID string) (*CaptureAuthStep, error) {
	runner, ok := c.captureRunner.(captureEmailAuthRunner)
	if !ok || !c.CaptureAvailable() {
		return &CaptureAuthStep{Done: true}, c.finishAuthAttempt(ctx, org, attemptID, authFeatureDisabled)
	}
	fence, code, err := c.loadAuthFence(ctx, org, attemptID)
	if err != nil {
		return nil, err
	}
	if code == "done" {
		return &CaptureAuthStep{Done: true}, nil
	}
	if code != "" {
		return &CaptureAuthStep{Done: true}, c.finishAuthAttempt(ctx, org, attemptID, code)
	}
	attempt := fence.attempt
	if attempt.State != captureauthattempt.StateADMITTED {
		// A crash after the browser started is never retried: an email may be out.
		return &CaptureAuthStep{Done: true}, c.finishAuthAttempt(ctx, org, attemptID, string(browser.ChallengeConsumedUnknown))
	}
	if moved, err := c.advanceAuth(ctx, attempt, captureauthattempt.StateADMITTED, captureauthattempt.StateBROWSER_STARTING, nil); err != nil || !moved {
		return &CaptureAuthStep{Done: true}, err
	}
	keepAlive := min(c.emailAuth.AttemptTTL+captureAuthSetupAllowance, 5*time.Minute)
	var session string
	for try, wait := range []time.Duration{0, 5 * time.Second, 15 * time.Second} {
		if wait > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
		}
		if session, err = c.captureRunner.Allocate(ctx, fence.loginHosts(), keepAlive); err == nil {
			break
		}
		slog.Warn("capture email sign-in browser not allocated", "attempt", attemptID, "try", try+1)
	}
	if err != nil {
		return &CaptureAuthStep{Done: true}, c.finishAuthAttempt(ctx, org, attemptID, string(browser.ProviderUnavailable))
	}
	if moved, err := c.advanceAuth(ctx, attempt, captureauthattempt.StateBROWSER_STARTING, captureauthattempt.StateBROWSER_STARTING, func(u *ent.CaptureAuthAttemptUpdate) { u.SetBrowserSessionID(session) }); err != nil || !moved {
		_ = c.captureRunner.Close(context.WithoutCancel(ctx), session)
		return &CaptureAuthStep{Done: true}, err
	}
	attempt.BrowserSessionID = &session
	recipient := c.testAddress(fence.config)
	err = runner.RequestEmailChallenge(ctx, session, fence.target(), fence.loginHosts(), fence.recipe, recipient, func() error {
		// Durably waiting before the click: an email that beats this activity
		// back finds its attempt.
		now := time.Now().UTC()
		if _, stale, err := c.loadAuthFence(ctx, org, attemptID); err != nil || (stale != "" && stale != authDeliveryTimeout) {
			return &browser.Failure{Code: browser.Code(authGenerationStale)}
		}
		moved, err := c.advanceAuth(ctx, attempt, captureauthattempt.StateBROWSER_STARTING, captureauthattempt.StateCHALLENGE_REQUESTED, func(u *ent.CaptureAuthAttemptUpdate) {
			u.SetEmailRequestedAt(now).SetDeadlineAt(now.Add(c.emailAuth.AttemptTTL))
		})
		if err != nil || !moved {
			return &browser.Failure{Code: browser.Code(authGenerationStale)}
		}
		return nil
	})
	if err != nil {
		return &CaptureAuthStep{Done: true}, c.finishAuthAttempt(ctx, org, attemptID, failureCode(err))
	}
	if _, err := c.advanceAuth(ctx, attempt, captureauthattempt.StateCHALLENGE_REQUESTED, captureauthattempt.StateWAITING_FOR_EMAIL, nil); err != nil {
		return nil, err
	}
	return c.CheckCaptureAuthAttempt(ctx, org, attemptID)
}

// CheckCaptureAuthAttempt is the durable source of truth for the wait: the
// email signal only wakes the workflow sooner. A passed deadline ends it.
func (c *Configuration) CheckCaptureAuthAttempt(ctx context.Context, org, attemptID string) (*CaptureAuthStep, error) {
	attempt, err := c.client.CaptureAuthAttempt.Query().Where(captureauthattempt.ID(attemptID), captureauthattempt.OrganizationID(org)).Only(ctx)
	if err != nil {
		return nil, err
	}
	if !slices.Contains(activeAuthStates, attempt.State) {
		return &CaptureAuthStep{Done: true}, c.closeAuthBrowser(ctx, attempt)
	}
	if attempt.State == captureauthattempt.StateEMAIL_MATCHED {
		return &CaptureAuthStep{Matched: true}, nil
	}
	fence, code, err := c.loadAuthFence(ctx, org, attemptID)
	if err != nil {
		return nil, err
	}
	if code != "" && code != "done" {
		return &CaptureAuthStep{Done: true}, c.finishAuthAttempt(ctx, org, attemptID, code)
	}
	if matched := c.reconcileAuthEmail(ctx, fence); matched {
		return &CaptureAuthStep{Matched: true}, nil
	}
	return &CaptureAuthStep{}, nil
}

// captureAuthReconcileAfter is how long a webhook has before the check lists
// received emails itself.
const captureAuthReconcileAfter = 30 * time.Second

// reconcileAuthEmail backs up a late or lost webhook: it lists the newest
// received emails and records any addressed to this attempt's test address
// through the same intake, fences, and dedupe. A listing failure is ignored;
// the webhook or the deadline still decides.
func (c *Configuration) reconcileAuthEmail(ctx context.Context, fence *authFence) bool {
	lister, ok := c.emailAuth.Reader.(emailauth.Lister)
	attempt := fence.attempt
	if !ok || attempt.State != captureauthattempt.StateWAITING_FOR_EMAIL || attempt.EmailRequestedAt == nil || time.Since(*attempt.EmailRequestedAt) < captureAuthReconcileAfter {
		return false
	}
	recent, err := lister.RecentEmails(ctx, 25)
	if err != nil {
		return false
	}
	address := c.testAddress(fence.config)
	for _, email := range recent {
		addressed := false
		for _, raw := range email.To {
			if canonical, ok := emailauth.Canonical(raw); ok && canonical == address {
				addressed = true
			}
		}
		if !addressed || email.CreatedAt.Before(attempt.EmailRequestedAt.Add(-captureAuthClockSkew)) {
			continue
		}
		result, err := c.recordInboundEmail(ctx, "reconcile:"+email.ID, email.ID, email.From, email.To, email.CreatedAt)
		if err == nil && result.Outcome == "matched" {
			return true
		}
	}
	return false
}

// ApplyCaptureAuthChallenge is the one activity that holds a secret. It
// claims the receipt, reads the email into memory, applies its link or code
// once in the browser that asked, proves the account, exports the app's
// state, closes that browser, proves the state again in a fresh one, and
// commits under every fence. It returns nothing but an error code, and is
// never retried: a spent link cannot be replayed.
func (c *Configuration) ApplyCaptureAuthChallenge(ctx context.Context, org, attemptID string) error {
	err := c.applyCaptureAuthChallenge(ctx, org, attemptID)
	if err != nil {
		// The activity is never retried, so an infrastructure error ends the
		// attempt now instead of leaving it to the sweep. A finished attempt
		// is left as it is.
		_ = c.finishAuthAttempt(ctx, org, attemptID, string(browser.ProviderUnavailable))
	}
	return err
}

func (c *Configuration) applyCaptureAuthChallenge(ctx context.Context, org, attemptID string) error {
	runner, ok := c.captureRunner.(captureEmailAuthRunner)
	if !ok {
		return c.finishAuthAttempt(ctx, org, attemptID, authFeatureDisabled)
	}
	fence, code, err := c.loadAuthFence(ctx, org, attemptID)
	if err != nil {
		return err
	}
	if code == "done" {
		return nil
	}
	if code != "" {
		return c.finishAuthAttempt(ctx, org, attemptID, code)
	}
	attempt := fence.attempt
	if attempt.State != captureauthattempt.StateEMAIL_MATCHED || attempt.ReceiptID == nil || attempt.BrowserSessionID == nil {
		return c.finishAuthAttempt(ctx, org, attemptID, string(browser.ChallengeConsumedUnknown))
	}
	if moved, err := c.advanceAuth(ctx, attempt, captureauthattempt.StateEMAIL_MATCHED, captureauthattempt.StateAPPLYING_CHALLENGE, nil); err != nil || !moved {
		return err
	}
	n, err := c.client.CaptureInboundReceipt.Update().Where(captureinboundreceipt.ID(*attempt.ReceiptID), captureinboundreceipt.AttemptID(attempt.ID), captureinboundreceipt.StateEQ(captureinboundreceipt.StateASSIGNED)).
		SetState(captureinboundreceipt.StateCONSUMED).Save(ctx)
	if err != nil {
		return err
	}
	if n != 1 {
		return c.finishAuthAttempt(ctx, org, attemptID, string(browser.ChallengeConsumedUnknown))
	}
	receipt, err := c.client.CaptureInboundReceipt.Get(ctx, *attempt.ReceiptID)
	if err != nil {
		return err
	}
	email, readCode := c.readAuthEmail(ctx, attempt, receipt.ProviderEmailID)
	if readCode != "" {
		return c.finishAuthAttempt(ctx, org, attemptID, readCode)
	}
	// Check the retrieved message, not only the webhook's claims about it.
	if !c.emailMatchesAttempt(email, fence) {
		return c.finishAuthAttempt(ctx, org, attemptID, authEmailUnmatched)
	}
	target, hosts, session := fence.target(), fence.loginHosts(), *attempt.BrowserSessionID
	if _, stale, err := c.loadAuthFence(ctx, org, attemptID); err != nil || stale != "" {
		if err != nil {
			return err
		}
		return c.finishAuthAttempt(ctx, org, attemptID, stale)
	}
	switch fence.recipe.Method {
	case browser.MagicLink:
		link, parseErr := emailauth.ExtractMagicLink(email, fence.recipe)
		email = nil
		if parseErr != nil {
			return c.finishAuthAttempt(ctx, org, attemptID, parseErr.Error())
		}
		err = runner.ApplyMagicLink(ctx, session, target, hosts, fence.recipe, link)
	case browser.EmailCode:
		secret, parseErr := emailauth.ExtractCode(email, fence.recipe)
		email = nil
		if parseErr != nil {
			return c.finishAuthAttempt(ctx, org, attemptID, parseErr.Error())
		}
		err = runner.ApplyEmailCode(ctx, session, target, hosts, fence.recipe, secret)
	default:
		return c.finishAuthAttempt(ctx, org, attemptID, string(browser.RecipeInvalid))
	}
	if err != nil {
		return c.finishAuthAttempt(ctx, org, attemptID, failureCode(err))
	}
	if moved, err := c.advanceAuth(ctx, attempt, captureauthattempt.StateAPPLYING_CHALLENGE, captureauthattempt.StateVERIFYING, nil); err != nil || !moved {
		return c.finishAuthAttempt(ctx, org, attemptID, authGenerationStale)
	}
	// Export only the app's own cookies and storage, then close the browser
	// that signed in before anything is saved.
	state, discovered, err := c.captureRunner.ExportWithRoutes(ctx, session, target)
	_ = c.captureRunner.Close(context.WithoutCancel(ctx), session)
	_ = c.client.CaptureAuthAttempt.Update().Where(captureauthattempt.ID(attempt.ID)).SetBrowserClosedAt(time.Now().UTC()).Exec(context.WithoutCancel(ctx))
	if err != nil {
		code := failureCode(err)
		if code == string(browser.SessionRestoreFailed) {
			code = string(browser.SessionRestoreUnsupported)
		}
		return c.finishAuthAttempt(ctx, org, attemptID, code)
	}
	fresh, err := c.captureRunner.Allocate(ctx, fence.connection.Hosts, 2*time.Minute)
	if err != nil {
		return c.finishAuthAttempt(ctx, org, attemptID, string(browser.ProviderUnavailable))
	}
	err = c.captureRunner.Verify(ctx, fresh, target, state)
	_ = c.captureRunner.Close(context.WithoutCancel(ctx), fresh)
	if err != nil {
		code := failureCode(err)
		if code == string(browser.SignInIncomplete) {
			code = string(browser.SessionRestoreFailed)
		}
		return c.finishAuthAttempt(ctx, org, attemptID, code)
	}
	if moved, err := c.advanceAuth(ctx, attempt, captureauthattempt.StateVERIFYING, captureauthattempt.StateCOMMITTING, nil); err != nil || !moved {
		return c.finishAuthAttempt(ctx, org, attemptID, authGenerationStale)
	}
	actor := Actor{OrganizationID: org, Kind: "service", Display: "capture email sign-in", RequestID: attempt.ID}
	if attempt.CreatedByUserID != nil {
		actor.UserID = *attempt.CreatedByUserID
	}
	committed, _, err := c.commitVerifiedConnectionState(ctx, actor, org, attempt.ConnectionID, state, commitConnectionOptions{
		auditAction: "product.capture_connection_email_authenticated",
		discovered:  discovered,
		emailAuth:   &emailAuthCommit{attempt: attempt, mode: attempt.Mode},
	})
	if err != nil {
		var failure *browser.Failure
		if errors.As(err, &failure) {
			return c.finishAuthAttempt(ctx, org, attemptID, string(failure.Code))
		}
		return err
	}
	if committed == nil {
		return c.finishAuthAttempt(ctx, org, attemptID, authGenerationStale)
	}
	return nil
}

// readAuthEmail fetches the matched email, retrying a transient read while
// the attempt's deadline allows. It returns a safe code, never provider text.
func (c *Configuration) readAuthEmail(ctx context.Context, attempt *ent.CaptureAuthAttempt, emailID string) (*emailauth.Email, string) {
	if c.emailAuth.Reader == nil {
		return nil, authProviderReadFailed
	}
	for _, wait := range []time.Duration{0, 2 * time.Second, 5 * time.Second} {
		if wait > 0 {
			if time.Now().Add(wait).After(attempt.DeadlineAt) {
				break
			}
			select {
			case <-ctx.Done():
				return nil, authProviderReadFailed
			case <-time.After(wait):
			}
		}
		email, err := c.emailAuth.Reader.ReceivedEmail(ctx, emailID)
		if err == nil {
			return email, ""
		}
		if errors.Is(err, emailauth.ErrTooLarge) {
			return nil, authChallengeNotFound
		}
	}
	return nil, authProviderReadFailed
}

func (c *Configuration) emailMatchesAttempt(email *emailauth.Email, fence *authFence) bool {
	address := c.testAddress(fence.config)
	addressed := false
	for _, raw := range email.To {
		if canonical, ok := emailauth.Canonical(raw); ok && canonical == address {
			addressed = true
		}
	}
	if !addressed || !emailauth.SenderAllowed(email.From, fence.config.ExpectedSenders) {
		return false
	}
	requested := fence.attempt.EmailRequestedAt
	// A message with no readable time cannot prove it followed the request.
	return requested != nil && !email.CreatedAt.IsZero() && !email.CreatedAt.Before(requested.Add(-captureAuthClockSkew))
}

// emailAuthCommit fences a commit to the attempt that verified the state.
type emailAuthCommit struct {
	attempt *ent.CaptureAuthAttempt
	mode    captureauthattempt.Mode
}

// checkEmailAuthCommit runs inside the commit transaction after the
// connection lock. It refuses a commit whose attempt or authority moved, and
// marks the attempt and setup successful in the same transaction.
func (c *Configuration) checkEmailAuthCommit(ctx context.Context, tx *ent.Tx, locked *ent.PlatformAppConnection, commit *emailAuthCommit, now time.Time) (bool, error) {
	attempt := commit.attempt
	config, err := tx.CaptureEmailAuthConfig.Query().Where(captureemailauthconfig.ID(attempt.ConfigID), captureemailauthconfig.OrganizationID(attempt.OrganizationID)).Only(ctx)
	if err != nil {
		return false, err
	}
	switch {
	case locked.Status == platformappconnection.StatusREVOKED, config.Status == captureemailauthconfig.StatusREVOKED,
		locked.Generation != attempt.ConnectionGeneration, config.Revision != attempt.ConfigRevision,
		locked.ConnectPhase != nil && locked.ConnectExpiresAt != nil && locked.ConnectExpiresAt.After(now):
		return false, nil
	case commit.mode == captureauthattempt.ModeAUTO_RECOVER && (locked.ValidatedAt == nil || !locked.ValidatedAt.Add(captureStateAbsoluteAge).After(now)):
		return false, &browser.Failure{Code: browser.Code(authPolicyReview)}
	}
	n, err := tx.CaptureAuthAttempt.Update().Where(captureauthattempt.ID(attempt.ID), captureauthattempt.StateEQ(captureauthattempt.StateCOMMITTING), captureauthattempt.FenceToken(attempt.FenceToken)).
		SetState(captureauthattempt.StateSUCCEEDED).SetCompletedAt(now).ClearFailureCode().AddFenceToken(1).Save(ctx)
	if err != nil || n != 1 {
		return false, err
	}
	update := config.Update().SetLastSuccessAt(now).ClearLastFailureCode()
	if commit.mode == captureauthattempt.ModeTEST {
		update.SetLastTestedAt(now).SetTestedRevision(config.Revision)
	}
	return true, update.Exec(ctx)
}

// ReclaimCaptureAuthResources is the second line of defense behind the
// workflow: it ends attempts past their deadline, closes their browsers, and
// deletes receipt metadata past retention.
func (c *Configuration) ReclaimCaptureAuthResources(ctx context.Context) error {
	now := time.Now().UTC()
	stale, err := c.client.CaptureAuthAttempt.Query().Where(captureauthattempt.StateIn(activeAuthStates...), captureauthattempt.DeadlineAtLT(now.Add(-time.Minute))).Limit(50).All(ctx)
	if err != nil {
		return err
	}
	for _, attempt := range stale {
		code := authDeliveryTimeout
		if attempt.State != captureauthattempt.StateWAITING_FOR_EMAIL && attempt.State != captureauthattempt.StateCHALLENGE_REQUESTED {
			code = string(browser.ChallengeConsumedUnknown)
		}
		if err := c.finishAuthAttempt(ctx, attempt.OrganizationID, attempt.ID, code); err != nil {
			// One bad row must not stop the sweep for every other attempt.
			slog.Warn("capture email sign-in not ended", "attempt", attempt.ID)
		}
	}
	open, err := c.client.CaptureAuthAttempt.Query().Where(captureauthattempt.StateNotIn(activeAuthStates...), captureauthattempt.BrowserSessionIDNotNil(), captureauthattempt.BrowserClosedAtIsNil()).Limit(50).All(ctx)
	if err != nil {
		return err
	}
	for _, attempt := range open {
		if err := c.closeAuthBrowser(ctx, attempt); err != nil {
			slog.Warn("capture email sign-in browser not closed", "attempt", attempt.ID)
		}
	}
	_, err = c.client.CaptureInboundReceipt.Delete().Where(captureinboundreceipt.ExpiresAtLT(now)).Exec(ctx)
	return err
}

// dispatchCaptureAuth starts an attempt's workflow from the outbox.
func (c *Configuration) dispatchCaptureAuth(ctx context.Context, org, attemptID string, signal bool) error {
	dispatcher, ok := c.captureDispatcher.(captureAuthDispatcher)
	if !ok {
		return ErrCaptureEmailAuthUnavailable
	}
	if signal {
		return dispatcher.SignalCaptureAuth(ctx, org, attemptID)
	}
	return dispatcher.StartCaptureAuth(ctx, org, attemptID)
}

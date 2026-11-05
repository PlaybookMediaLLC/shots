package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	integrationsdto "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/dtos/integrations"
	plugsdto "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/dtos/plugs"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/httpx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/redis"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"go.temporal.io/sdk/client"
)

// Notifications is the part of notifications.Service this package uses.
type Notifications interface {
	InAppNotification(ctx context.Context, orgID, subject, message string, sendEmail, digest bool, notificationType string) error
}

// AutopostRepository is the part of autopost.Repository this package uses.
type AutopostRepository interface {
	GetAutoposts(ctx context.Context, orgID string) ([]*ent.AutoPost, error)
}

// refreshWait is the pause after a refresh for providers with refreshWait
// (timer(10000)); tests shorten it.
var refreshWait = 10 * time.Second

type Service struct {
	repo          *Repository
	autoposts     AutopostRepository
	manager       *integrations.Manager
	notifications Notifications
	refresh       *RefreshIntegrationService
	temporal      client.Client
	store         redis.Store
	storage       Uploader
}

// NewService also builds the RefreshIntegrationService both depend on; get it
// with RefreshIntegrationService(). temporal may be nil when Temporal is not
// connected.
func NewService(repo *Repository, autoposts AutopostRepository, manager *integrations.Manager, notifications Notifications,
	temporal client.Client, store redis.Store, storage Uploader) *Service {
	s := &Service{repo: repo, autoposts: autoposts, manager: manager, notifications: notifications,
		temporal: temporal, store: store, storage: storage}
	s.refresh = NewRefreshIntegrationService(manager, s, temporal)
	return s
}

func (s *Service) RefreshIntegrationService() *RefreshIntegrationService { return s.refresh }

func (s *Service) ChangeActiveCron(ctx context.Context, orgID string) (bool, error) {
	data, err := s.autoposts.GetAutoposts(ctx, orgID)
	if err != nil {
		return false, err
	}
	for _, item := range data {
		if !item.Active || s.temporal == nil {
			continue
		}
		_ = s.temporal.TerminateWorkflow(ctx, "autopost-"+item.ID, "", "")
	}
	return true, nil
}

func (s *Service) GetMentions(ctx context.Context, platform, q string) ([]Mention, error) {
	return s.repo.GetMentions(ctx, platform, q)
}

func (s *Service) InsertMentions(ctx context.Context, platform string, mentions []Mention) error {
	return s.repo.InsertMentions(ctx, platform, mentions)
}

func (s *Service) SetTimes(ctx context.Context, orgID, integrationID string, times integrationsdto.IntegrationTimeDto) (*IDResult, error) {
	return s.repo.SetTimes(ctx, orgID, integrationID, times)
}

func (s *Service) UpdateProviderSettings(ctx context.Context, org, id, additionalSettings string) (*ent.Integration, error) {
	return s.repo.UpdateProviderSettings(ctx, org, id, additionalSettings)
}

func (s *Service) CheckPreviousConnections(ctx context.Context, org, id string) (bool, error) {
	return s.repo.CheckPreviousConnections(ctx, org, id)
}

// keptPicture reports whether a provider's picture is stored as it is. Only a
// Cloudflare Images link is. Any other picture is copied into storage with a
// new name, so a stored picture never names a file that the copy did not make
// (a provider could otherwise name another workspace's file in the bucket).
func keptPicture(picture string) bool {
	u, err := url.Parse(picture)
	return err == nil && u.Scheme == "https" && u.User == nil && strings.EqualFold(u.Host, "imagedelivery.net")
}

// CreateOrUpdateIntegration uploads the picture to storage first (Cloudflare
// Images URLs are kept as they are); a failed upload drops the picture.
func (s *Service) CreateOrUpdateIntegration(ctx context.Context, p CreateOrUpdateIntegrationParams) (*ent.Integration, error) {
	if p.Picture != "" && !keptPicture(p.Picture) {
		uploaded, err := s.storage.UploadSimple(ctx, p.Picture)
		if err != nil {
			slog.Warn("Failed to upload profile picture:", "picture", p.Picture, "error", err)
			uploaded = ""
		}
		p.Picture = uploaded
	}
	return s.repo.CreateOrUpdateIntegration(ctx, p)
}

func (s *Service) UpdateIntegrationGroup(ctx context.Context, org, id, group string) (*ent.Integration, error) {
	return s.repo.UpdateIntegrationGroup(ctx, org, id, group)
}

func (s *Service) UpdateOnCustomerName(ctx context.Context, org, id, name string) (*ent.Integration, error) {
	return s.repo.UpdateOnCustomerName(ctx, org, id, name)
}

func (s *Service) GetIntegrationsList(ctx context.Context, org string) ([]*ent.Integration, error) {
	return s.repo.GetIntegrationsList(ctx, org)
}

func (s *Service) GetChannelHealth(ctx context.Context, org string, includeDeleted bool) ([]ChannelHealth, error) {
	return s.repo.GetChannelHealth(ctx, org, includeDeleted)
}

func (s *Service) GetIntegrationForOrder(ctx context.Context, id, order, user, org string) (*OrderIntegration, error) {
	return s.repo.GetIntegrationForOrder(ctx, id, order, user, org)
}

func (s *Service) UpdateCustomName(ctx context.Context, org, id, name string) (*IDResult, error) {
	return s.repo.UpdateCustomName(ctx, org, id, name)
}

func (s *Service) UpdateNameAndURL(ctx context.Context, id, name, url string) (*ent.Integration, error) {
	return s.repo.UpdateNameAndURL(ctx, id, name, url)
}

func (s *Service) GetIntegrationByID(ctx context.Context, org, id string) (*ent.Integration, error) {
	return s.repo.GetIntegrationByID(ctx, org, id)
}

func (s *Service) GetIntegrationByInternalID(ctx context.Context, org, internalID string) (*ent.Integration, error) {
	return s.repo.GetIntegrationByInternalID(ctx, org, internalID)
}

// RefreshToken returns nil (TypeScript's false) when the refresh failed or
// any of refreshToken, accessToken, expiresIn is missing.
func (s *Service) RefreshToken(ctx context.Context, provider integrations.Provider, refresh string) *integrations.AuthTokenDetails {
	data, err := provider.RefreshToken(ctx, refresh)
	if err != nil || data == nil || data.RefreshToken == "" || data.AccessToken == "" || data.ExpiresIn == 0 {
		return nil
	}
	return &integrations.AuthTokenDetails{RefreshToken: data.RefreshToken, AccessToken: data.AccessToken, ExpiresIn: data.ExpiresIn}
}

func (s *Service) DisconnectChannel(ctx context.Context, orgID string, integration *ent.Integration, cause string) error {
	if _, err := s.repo.DisconnectChannel(ctx, orgID, integration.ID); err != nil {
		return err
	}
	return s.InformAboutRefreshError(ctx, orgID, integration, cause)
}

func rootOrAuth(existing *ent.Integration, authID string) *string {
	if existing.RootInternalID != nil && *existing.RootInternalID == existing.InternalID {
		return &authID
	}
	return existing.RootInternalID
}

// MigrateIntegration handles a reconnect that came back from a different
// provider (MIGRATE_PROVIDERS): match the disconnected channel by profile and
// move it to the new provider in place, so scheduled posts, settings and
// customers survive. Fails with the same error as a mismatched reconnect when
// the migration is not configured or the user connected a different account.
func (s *Service) MigrateIntegration(ctx context.Context, org, oldInternalID, newProvider string, auth integrations.AuthTokenDetails) (*ent.Integration, error) {
	existing, err := s.repo.GetIntegrationByInternalID(ctx, org, oldInternalID)
	if err != nil {
		return nil, err
	}
	if existing == nil || s.manager.GetMigrationTarget(existing.ProviderIdentifier) != newProvider {
		return nil, &integrations.NotEnoughScopes{Message: "Please refresh the channel that needs to be refreshed"}
	}

	oldProvider := s.manager.GetSocialIntegration(existing.ProviderIdentifier)
	if oldProvider == nil || !oldProvider.MigrationMatch(auth, existing) {
		profile := "null"
		if existing.Profile != nil {
			profile = *existing.Profile
		}
		return nil, &integrations.NotEnoughScopes{Message: fmt.Sprintf("Please connect the same account (@%s) that needs to be refreshed", profile)}
	}

	already, err := s.repo.GetIntegrationByInternalID(ctx, org, auth.ID)
	if err != nil {
		return nil, err
	}
	if already != nil {
		return nil, &integrations.NotEnoughScopes{Message: "This account is already connected as another channel, please delete one of them first"}
	}

	return s.repo.MigrateIntegration(ctx, org, existing.ID, auth.ID, newProvider, rootOrAuth(existing, auth.ID))
}

// MigrateIntegrationOnConnect: a fresh connect of a migration target
// (MIGRATE_PROVIDERS) for an account the org already has on the source
// provider adopts that channel instead of creating a confusing duplicate - the
// channel is migrated in place exactly like a reconnect, and the follow-up
// upsert stores the fresh tokens. Returns nil when nothing matches, so a
// genuinely new account still creates a channel.
func (s *Service) MigrateIntegrationOnConnect(ctx context.Context, org, newProvider string, auth integrations.AuthTokenDetails) (*ent.Integration, error) {
	sources := s.manager.GetMigrationSources(newProvider)
	if len(sources) == 0 {
		return nil, nil
	}
	provider := s.manager.GetSocialIntegration(newProvider)
	if provider == nil {
		return nil, fmt.Errorf("unknown provider %s", newProvider)
	}
	if provider.Info().IsBetweenSteps {
		return nil, nil
	}

	// the account already exists on the new provider: the normal upsert
	// updates it, nothing to adopt
	already, err := s.repo.GetIntegrationByInternalID(ctx, org, auth.ID)
	if err != nil || already != nil {
		return nil, err
	}

	list, err := s.repo.GetIntegrationsList(ctx, org)
	if err != nil {
		return nil, err
	}
	var existing *ent.Integration
	for _, p := range list {
		if !slices.Contains(sources, p.ProviderIdentifier) {
			continue
		}
		if source := s.manager.GetSocialIntegration(p.ProviderIdentifier); source != nil && source.MigrationMatch(auth, p) {
			existing = p
			break
		}
	}
	if existing == nil {
		return nil, nil
	}

	return s.repo.MigrateIntegration(ctx, org, existing.ID, auth.ID, newProvider, rootOrAuth(existing, auth.ID))
}

func (s *Service) InformAboutRefreshError(ctx context.Context, orgID string, integration *ent.Integration, cause string) error {
	// The product worker has no social inbox; its Integration trigger raises
	// integration.reconnect_required when refreshNeeded is set.
	if s.notifications == nil {
		return nil
	}
	return s.notifications.InAppNotification(ctx, orgID,
		fmt.Sprintf("Could not refresh your %s channel", integration.ProviderIdentifier),
		fmt.Sprintf("Could not refresh your %s channel %s. Please go back to the system and connect it again %s/launches",
			integration.ProviderIdentifier, cause, envOrUndefined("FRONTEND_URL")),
		true, false, "info")
}

func (s *Service) RefreshNeeded(ctx context.Context, org, id string) (*ent.Integration, error) {
	return s.repo.RefreshNeeded(ctx, org, id)
}

func (s *Service) SetBetweenRefreshSteps(ctx context.Context, id string) (*ent.Integration, error) {
	return s.repo.SetBetweenRefreshSteps(ctx, id)
}

// RefreshTokens isolates failures so one account cannot starve the remaining sweep.
func (s *Service) RefreshTokens(ctx context.Context) error {
	list, err := s.repo.NeedsToBeRefreshed(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, integration := range list {
		_, err := s.refresh.Refresh(ctx, integration, "")
		if errors.Is(err, ErrRefreshChanged) {
			continue
		}
		if err != nil {
			errs = append(errs, err)
		}
	}

	return errors.Join(errs...)
}

func (s *Service) DisableChannel(ctx context.Context, org, id string) error {
	return s.repo.DisableChannel(ctx, org, id)
}

func (s *Service) EnableChannel(ctx context.Context, org string, totalChannels int, id string) error {
	list, err := s.repo.GetIntegrationsList(ctx, org)
	if err != nil {
		return err
	}
	enabled := 0
	for _, i := range list {
		if !i.Disabled {
			enabled++
		}
	}
	if os.Getenv("STRIPE_PUBLISHABLE_KEY") != "" && enabled >= totalChannels {
		return errors.New("You have reached the maximum number of channels")
	}
	return s.repo.EnableChannel(ctx, org, id)
}

func (s *Service) GetPostsForChannel(ctx context.Context, org, id string) ([]PostGroup, error) {
	return s.repo.GetPostsForChannel(ctx, org, id)
}

func (s *Service) DeleteChannel(ctx context.Context, org, id string) (*IDResult, error) {
	return s.repo.DeleteChannel(ctx, org, id)
}

func (s *Service) DisableIntegrations(ctx context.Context, org string, totalChannels int) error {
	return s.repo.DisableIntegrations(ctx, org, totalChannels)
}

func (s *Service) EnableAllIntegrations(ctx context.Context, org string) (int, error) {
	return s.repo.EnableAllIntegrations(ctx, org)
}

func (s *Service) CheckForDeletedOnceAndUpdate(ctx context.Context, org, page string) (int, error) {
	return s.repo.CheckForDeletedOnceAndUpdate(ctx, org, page)
}

type SuccessResult struct {
	Success bool `json:"success"`
}

func (s *Service) SaveProviderPage(ctx context.Context, org, id string, data json.RawMessage) (*SuccessResult, error) {
	getIntegration, err := s.repo.GetIntegrationByID(ctx, org, id)
	if err != nil {
		return nil, err
	}
	if getIntegration == nil {
		return nil, httpx.HTTPException("Integration not found", http.StatusNotFound)
	}
	if !getIntegration.InBetweenSteps {
		return nil, httpx.HTTPException("Invalid request", http.StatusBadRequest)
	}

	fetcher, ok := s.manager.GetSocialIntegration(getIntegration.ProviderIdentifier).(integrations.PageInformationFetcher)
	if !ok {
		return nil, httpx.HTTPException("Provider does not support page selection", http.StatusBadRequest)
	}

	info, err := fetcher.FetchPageInformation(ctx, getIntegration.Token, data)
	if err != nil {
		return nil, err
	}

	if _, err := s.CheckForDeletedOnceAndUpdate(ctx, org, info.ID); err != nil {
		return nil, err
	}
	if _, err := s.repo.UpdateIntegration(ctx, id, UpdateIntegrationParams{
		Picture:        info.Picture,
		InternalID:     info.ID,
		OrganizationID: org,
		Name:           info.Name,
		InBetweenSteps: false,
		Token:          info.AccessToken,
		Profile:        info.Username,
	}); err != nil {
		return nil, err
	}

	return &SuccessResult{Success: true}, nil
}

func analyticsTTL() time.Duration {
	if env := os.Getenv("NODE_ENV"); env == "" || env == "development" {
		return time.Second
	}
	return time.Hour
}

func (s *Service) CheckAnalytics(ctx context.Context, org *ent.Organization, integrationID, date string, forceRefresh bool) ([]integrations.AnalyticsData, error) {
	// Days to load, missing or invalid on some public API calls (same default as the app)
	days := 7.0
	if n, err := strconv.ParseFloat(strings.TrimSpace(date), 64); err == nil && n > 0 {
		days = n
	}
	getIntegration, err := s.GetIntegrationByID(ctx, org.ID, integrationID)
	if err != nil {
		return nil, err
	}
	if getIntegration == nil {
		return nil, errors.New("Invalid integration")
	}
	if getIntegration.Type != "social" {
		return []integrations.AnalyticsData{}, nil
	}

	provider := s.manager.GetSocialIntegration(getIntegration.ProviderIdentifier)
	if provider == nil {
		return nil, fmt.Errorf("unknown provider %s", getIntegration.ProviderIdentifier)
	}

	if (getIntegration.TokenExpiration != nil && getIntegration.TokenExpiration.Before(time.Now())) || forceRefresh {
		data, err := s.refresh.Refresh(ctx, getIntegration, "")
		if err != nil {
			return nil, err
		}
		if data == nil {
			return []integrations.AnalyticsData{}, nil
		}
		if data.AccessToken == "" {
			if err := s.DisconnectChannel(ctx, org.ID, getIntegration, ""); err != nil {
				return nil, err
			}
			return []integrations.AnalyticsData{}, nil
		}
		getIntegration.Token = data.AccessToken
		if provider.Info().RefreshWait {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(refreshWait):
			}
		}
	}

	key := fmt.Sprintf("integration:%s:%s:%s", org.ID, integrationID, strconv.FormatFloat(days, 'f', -1, 64))
	cached, ok, err := s.store.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	if ok && cached != "" {
		var out []integrations.AnalyticsData
		if err := json.Unmarshal([]byte(cached), &out); err != nil {
			return nil, err
		}
		return out, nil
	}

	if analytics, ok := provider.(integrations.Analytics); ok {
		loaded, err := analytics.Analytics(ctx, getIntegration.InternalID, getIntegration.Token, int(days))
		if err == nil {
			if loaded == nil {
				loaded = []integrations.AnalyticsData{}
			}
			data, _ := json.Marshal(loaded)
			if err := s.store.Set(ctx, key, string(data), analyticsTTL()); err != nil {
				return nil, err
			}
			return loaded, nil
		}
		if temporalx.FailureType(err) == temporalx.TypeRefreshToken {
			return s.CheckAnalytics(ctx, org, integrationID, date, true)
		}
	}

	return []integrations.AnalyticsData{}, nil
}

func (s *Service) Customers(ctx context.Context, orgID string) ([]*ent.Customer, error) {
	return s.repo.Customers(ctx, orgID)
}

func (s *Service) UpdateCustomerName(ctx context.Context, orgID, id, name string) (*ent.Customer, error) {
	exists, err := s.repo.GetCustomerByName(ctx, orgID, name)
	if err != nil {
		return nil, err
	}
	if exists != nil && exists.ID != id {
		return nil, httpx.HTTPException("A group with this name already exists", http.StatusBadRequest)
	}
	return s.repo.UpdateCustomerName(ctx, orgID, id, name)
}

func (s *Service) GetPlugsByIntegrationID(ctx context.Context, org, integrationID string) ([]*ent.Plugs, error) {
	return s.repo.GetPlugsByIntegrationID(ctx, org, integrationID)
}

// InternalPlugData is processInternalPlug's argument (the internal plug
// workflow input).
type InternalPlugData struct {
	Post                string          `json:"post"`
	OriginalIntegration string          `json:"originalIntegration"`
	Integration         string          `json:"integration"`
	PlugName            string          `json:"plugName"`
	OrgID               string          `json:"orgId"`
	Delay               int64           `json:"delay"`
	Information         json.RawMessage `json:"information"`
}

func (s *Service) ProcessInternalPlug(ctx context.Context, data InternalPlugData, forceRefresh bool) error {
	originalIntegration, err := s.repo.GetIntegrationByID(ctx, data.OrgID, data.OriginalIntegration)
	if err != nil {
		return err
	}
	getIntegration, err := s.repo.GetIntegrationByID(ctx, data.OrgID, data.Integration)
	if err != nil {
		return err
	}
	if getIntegration == nil || originalIntegration == nil {
		return nil
	}

	for _, plug := range s.manager.GetInternalPlugs(getIntegration.ProviderIdentifier) {
		if plug.Identifier != data.PlugName {
			continue
		}
		if plug.Run == nil {
			return nil
		}
		return plug.Run(ctx, getIntegration, originalIntegration, data.Post, data.Information)
	}
	return nil
}

// PlugsData is processPlugs' argument (the plug workflow input).
type PlugsData struct {
	PlugID     string `json:"plugId"`
	PostID     string `json:"postId"`
	Delay      int64  `json:"delay"`
	TotalRuns  int    `json:"totalRuns"`
	CurrentRun int    `json:"currentRun"`
}

// ProcessPlugs runs a global plug once and reports whether it is done (it
// fired, or this was its last run).
func (s *Service) ProcessPlugs(ctx context.Context, data PlugsData) (bool, error) {
	getPlugByID, err := s.repo.GetPlug(ctx, data.PlugID)
	if err != nil {
		return false, err
	}
	if getPlugByID == nil {
		return true, nil
	}

	integration := getPlugByID.Edges.Integration
	provider := s.manager.GetSocialIntegration(integration.ProviderIdentifier)
	if provider == nil {
		return false, fmt.Errorf("unknown provider %s", integration.ProviderIdentifier)
	}
	var run func(context.Context, *ent.Integration, string, map[string]string) (bool, error)
	for _, plug := range provider.Plugs() {
		if plug.MethodName == getPlugByID.PlugFunction {
			run = plug.Run
		}
	}
	if run == nil {
		return false, fmt.Errorf("integration[%s] is not a function", getPlugByID.PlugFunction)
	}

	var fields []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}
	if err := json.Unmarshal([]byte(getPlugByID.Data), &fields); err != nil {
		return false, err
	}
	values := map[string]string{}
	for _, f := range fields {
		values[f.Name] = f.Value
	}

	processed, err := run(ctx, integration, data.PostID, values)
	if err != nil {
		return false, err
	}
	if processed {
		return true, nil
	}
	return data.TotalRuns == data.CurrentRun, nil
}

type PlugActivation struct {
	Activated bool `json:"activated"`
}

func (s *Service) CreateOrUpdatePlug(ctx context.Context, orgID, integrationID string, body plugsdto.PlugDto) (*PlugActivation, error) {
	activated, err := s.repo.CreateOrUpdatePlug(ctx, orgID, integrationID, body)
	if err != nil {
		return nil, err
	}
	return &PlugActivation{Activated: activated}, nil
}

func (s *Service) ChangePlugActivation(ctx context.Context, orgID, plugID string, status bool) (*IDResult, error) {
	plug, err := s.repo.ChangePlugActivation(ctx, orgID, plugID, status)
	if err != nil {
		return nil, err
	}
	return &IDResult{ID: plug.ID}, nil
}

func (s *Service) GetPlugs(ctx context.Context, orgID, integrationID string) ([]PlugWithIntegration, error) {
	return s.repo.GetPlugs(ctx, orgID, integrationID)
}

// LoadExisingData returns the ids that were not seen before (lodash difference).
func (s *Service) LoadExisingData(ctx context.Context, methodName, integrationID string, id []string) ([]string, error) {
	existing, err := s.repo.LoadExisingData(ctx, methodName, integrationID, id)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, p := range existing {
		seen[p.PlugValue] = true
	}
	out := []string{}
	for _, v := range id {
		if !seen[v] {
			out = append(out, v)
		}
	}
	return out, nil
}

// FindFreeDateTime returns the unique posting times (minutes from midnight UTC)
// of the matching channels, in first-seen order.
func (s *Service) FindFreeDateTime(ctx context.Context, orgID, integrationID string) ([]int, error) {
	list, err := s.repo.GetPostingTimes(ctx, orgID, integrationID)
	if err != nil {
		return nil, err
	}
	out := []int{}
	for _, postingTimes := range list {
		var times []struct {
			Time float64 `json:"time"`
		}
		if err := json.Unmarshal([]byte(postingTimes), &times); err != nil {
			return nil, err
		}
		for _, t := range times {
			if !slices.Contains(out, int(t.Time)) {
				out = append(out, int(t.Time))
			}
		}
	}
	return out, nil
}

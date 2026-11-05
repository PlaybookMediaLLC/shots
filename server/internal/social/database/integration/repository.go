// Package integration is the integration repository and service
// (IntegrationRepository, IntegrationService) and the token refresh service
// (RefreshIntegrationService), which reference each other.
package integration

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"

	integrationsdto "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/dtos/integrations"
	plugsdto "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/dtos/plugs"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/customer"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/exisingplugdata"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/integration"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/messagesgroup"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/orders"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/organization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/plugs"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/post"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// Uploader is the part of the upload storage (UploadFactory.createStorage())
// this package uses.
type Uploader interface {
	UploadSimple(ctx context.Context, path string) (string, error)
}

// JSTime marshals like JavaScript's Date#toJSON, the way Prisma rows reach
// clients, for the shaped (select) results below.
type JSTime time.Time

func (t JSTime) MarshalJSON() ([]byte, error) {
	return []byte(`"` + time.Time(t).UTC().Format(ent.JSTime) + `"`), nil
}

func jsTime(t *time.Time) *JSTime {
	if t == nil {
		return nil
	}
	v := JSTime(*t)
	return &v
}

// Mention is a row of the Mentions cache (select name, username, image).
type Mention struct {
	Name     string `json:"name"`
	Username string `json:"username"`
	Image    string `json:"image"`
}

// IDResult is a `select: {id: true}` result.
type IDResult struct {
	ID string `json:"id"`
}

// OrderIntegration is getIntegrationForOrder's integration select.
type OrderIntegration struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Picture            *string `json:"picture"`
	InBetweenSteps     bool    `json:"inBetweenSteps"`
	ProviderIdentifier string  `json:"providerIdentifier"`
}

type CustomerRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ChannelHealth is one entry of getChannelHealth.
type ChannelHealth struct {
	ID                  string       `json:"id"`
	InternalID          string       `json:"internalId"`
	Name                string       `json:"name"`
	ProviderIdentifier  string       `json:"providerIdentifier"`
	Type                string       `json:"type"`
	Disabled            bool         `json:"disabled"`
	RefreshNeeded       bool         `json:"refreshNeeded"`
	InBetweenSteps      bool         `json:"inBetweenSteps"`
	TokenExpiration     *JSTime      `json:"tokenExpiration"`
	DeletedAt           *JSTime      `json:"deletedAt"`
	CreatedAt           JSTime       `json:"createdAt"`
	UpdatedAt           *JSTime      `json:"updatedAt"`
	Customer            *CustomerRef `json:"customer"`
	LastPublishedAt     *JSTime      `json:"lastPublishedAt"`
	LastPublishedPostID *string      `json:"lastPublishedPostId"`
	LastPublishedURL    *string      `json:"lastPublishedUrl"`
	LastErrorAt         *JSTime      `json:"lastErrorAt"`
	LastErrorPostID     *string      `json:"lastErrorPostId"`
	LastError           *string      `json:"lastError"`
}

// PostGroup is a getPostsForChannel groupBy row.
type PostGroup struct {
	Group string `json:"group"`
}

type PlugIntegration struct {
	ID                 string `json:"id"`
	ProviderIdentifier string `json:"providerIdentifier"`
}

// PlugWithIntegration is a getPlugs row (integration: {id, providerIdentifier}).
type PlugWithIntegration struct {
	ID             string          `json:"id"`
	OrganizationID string          `json:"organizationId"`
	PlugFunction   string          `json:"plugFunction"`
	Data           string          `json:"data"`
	IntegrationID  string          `json:"integrationId"`
	Activated      bool            `json:"activated"`
	Integration    PlugIntegration `json:"integration"`
}

// UpdateIntegrationParams is the Partial<Integration> saveProviderPage sends
// to updateIntegration.
type UpdateIntegrationParams struct {
	Picture        string
	InternalID     string
	OrganizationID string
	Name           string
	InBetweenSteps bool
	Token          string
	Profile        string
}

// CreateOrUpdateIntegrationParams are createOrUpdateIntegration's positional
// arguments. Zero values are TypeScript's undefined/defaults: ExpiresIn nil
// is the 999999999 default, Username nil leaves the profile untouched on
// update, AdditionalSettings nil keeps the stored settings.
type CreateOrUpdateIntegrationParams struct {
	Verification          *socialidentity.Verification
	AdditionalSettings    []integrations.AdditionalSetting
	OneTimeToken          bool
	Org                   string
	Name                  string
	Picture               string
	Type                  string // article | social
	InternalID            string
	Provider              string
	Token                 string
	RefreshToken          string
	ExpiresIn             *int64
	Username              *string
	IsBetweenSteps        bool
	Refresh               string
	Timezone              int
	CustomInstanceDetails string
}

type Repository struct {
	client  *ent.Client
	storage Uploader
}

func NewRepository(client *ent.Client, storage Uploader) *Repository {
	return &Repository{client: client, storage: storage}
}

func notFoundNil[T any](v *T, err error) (*T, error) {
	if ent.IsNotFound(err) {
		return nil, nil
	}
	return v, err
}

func (r *Repository) GetMentions(ctx context.Context, platform, q string) ([]Mention, error) {
	rows, err := r.client.QueryContext(ctx, `SELECT "name", "username", "image" FROM "Mentions"
WHERE "platform" = $1 AND ("name" ILIKE $2 OR "username" ILIKE $2)
ORDER BY "name" ASC LIMIT 100`, platform, "%"+q+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Mention{}
	for rows.Next() {
		var m Mention
		if err := rows.Scan(&m.Name, &m.Username, &m.Image); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// InsertMentions is createMany with skipDuplicates.
func (r *Repository) InsertMentions(ctx context.Context, platform string, mentions []Mention) error {
	if len(mentions) == 0 {
		return nil
	}
	var sb strings.Builder
	sb.WriteString(`INSERT INTO "Mentions" ("platform", "name", "username", "image", "updatedAt") VALUES `)
	args := []any{}
	for i, m := range mentions {
		if i > 0 {
			sb.WriteString(", ")
		}
		n := len(args)
		sb.WriteString("(" + placeholders(n+1, 4) + ", CURRENT_TIMESTAMP)")
		args = append(args, platform, m.Name, m.Username, m.Image)
	}
	sb.WriteString(" ON CONFLICT DO NOTHING")
	_, err := r.client.ExecContext(ctx, sb.String(), args...)
	return err
}

func placeholders(start, n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = "$" + strconv.Itoa(start+i)
	}
	return strings.Join(parts, ", ")
}

func md5hex(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

func (r *Repository) CheckPreviousConnections(ctx context.Context, org, id string) (bool, error) {
	// Deleted accounts keep their integrations with an md5 hashed
	// rootInternalId, so match both the raw id and its hash to still catch
	// channels that were connected by a deleted account.
	found, err := r.client.Integration.Query().
		Where(integration.RootInternalIDIn(id, md5hex(id))).
		Select(integration.FieldOrganizationID, integration.FieldID).All(ctx)
	if err != nil {
		return false, err
	}
	for _, f := range found {
		if f.OrganizationID == org {
			return false, nil
		}
	}
	return len(found) > 0, nil
}

func (r *Repository) updateOne(org, id string) *ent.IntegrationUpdateOne {
	return r.client.Integration.UpdateOneID(id).Where(integration.OrganizationID(org))
}

func (r *Repository) UpdateProviderSettings(ctx context.Context, org, id, settings string) (*ent.Integration, error) {
	return r.updateOne(org, id).SetAdditionalSettings(settings).Save(ctx)
}

func (r *Repository) UpdateCustomName(ctx context.Context, org, id, name string) (*IDResult, error) {
	u := r.updateOne(org, id)
	if trimmed := strings.TrimSpace(name); trimmed != "" {
		u.SetCustomName(trimmed)
	} else {
		u.ClearCustomName()
	}
	saved, err := u.Save(ctx)
	if err != nil {
		return nil, err
	}
	return &IDResult{ID: saved.ID}, nil
}

func (r *Repository) SetTimes(ctx context.Context, org, id string, times integrationsdto.IntegrationTimeDto) (*IDResult, error) {
	list := times.Time
	if list == nil {
		list = []integrationsdto.IntegrationValidateTimeDto{}
	}
	data, err := json.Marshal(list)
	if err != nil {
		return nil, err
	}
	saved, err := r.updateOne(org, id).SetPostingTimes(string(data)).Save(ctx)
	if err != nil {
		return nil, err
	}
	return &IDResult{ID: saved.ID}, nil
}

// GetPlug returns the plug with its integration, or nil.
func (r *Repository) GetPlug(ctx context.Context, plugID string) (*ent.Plugs, error) {
	return notFoundNil(r.client.Plugs.Query().Where(plugs.ID(plugID)).WithIntegration().First(ctx))
}

func (r *Repository) GetPlugs(ctx context.Context, orgID, integrationID string) ([]PlugWithIntegration, error) {
	list, err := r.client.Plugs.Query().
		Where(plugs.IntegrationID(integrationID), plugs.OrganizationID(orgID), plugs.Activated(true)).
		WithIntegration(func(q *ent.IntegrationQuery) {
			q.Select(integration.FieldID, integration.FieldProviderIdentifier)
		}).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]PlugWithIntegration, 0, len(list))
	for _, p := range list {
		item := PlugWithIntegration{
			ID: p.ID, OrganizationID: p.OrganizationID, PlugFunction: p.PlugFunction, Data: p.Data,
			IntegrationID: p.IntegrationID, Activated: p.Activated,
		}
		if p.Edges.Integration != nil {
			item.Integration = PlugIntegration{ID: p.Edges.Integration.ID, ProviderIdentifier: p.Edges.Integration.ProviderIdentifier}
		}
		out = append(out, item)
	}
	return out, nil
}

// envOrUndefined is how `process.env.X!` reads inside a string method: an
// unset variable is the string "undefined".
func envOrUndefined(name string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return "undefined"
}

func (r *Repository) UpdateIntegration(ctx context.Context, id string, params UpdateIntegrationParams) (*ent.Integration, error) {
	if params.Picture != "" && !keptPicture(params.Picture) {
		uploaded, err := r.storage.UploadSimple(ctx, params.Picture)
		if err != nil {
			return nil, err
		}
		params.Picture = uploaded
	}

	existing, err := notFoundNil(r.client.Integration.Query().
		Where(integration.OrganizationID(params.OrganizationID), integration.InternalID(params.InternalID)).Only(ctx))
	if err != nil {
		return nil, err
	}

	if existing != nil {
		if err := r.client.Post.Update().Where(post.IntegrationID(id)).SetDeletedAt(time.Now()).Exec(ctx); err != nil {
			return nil, err
		}
		if err := r.client.Integration.UpdateOneID(id).
			SetInternalID("deleted_" + params.InternalID + "_" + ids.Make(10)).
			SetDeletedAt(time.Now()).Exec(ctx); err != nil {
			return nil, err
		}
	}

	target := id
	if existing != nil {
		target = existing.ID
	}
	u := r.client.Integration.UpdateOneID(target).
		SetInternalID(params.InternalID).
		SetOrganizationID(params.OrganizationID).
		SetName(params.Name).
		SetInBetweenSteps(params.InBetweenSteps).
		SetToken(params.Token).
		ClearVerifiedAccountKey().ClearVerifiedAccountKind().ClearVerifiedScopes().ClearVerifiedCapabilities().ClearIdentityVerifiedAt().
		SetDisabled(false).
		ClearDeletedAt()
	if params.Profile != "" {
		u.SetProfile(params.Profile)
	}
	if params.Picture != "" {
		u.SetPicture(params.Picture)
	}
	return u.Save(ctx)
}

func (r *Repository) DisconnectChannel(ctx context.Context, org, id string) (*ent.Integration, error) {
	return r.updateOne(org, id).SetRefreshNeeded(true).Save(ctx)
}

func (r *Repository) GetIntegrationByInternalID(ctx context.Context, org, internalID string) (*ent.Integration, error) {
	return notFoundNil(r.client.Integration.Query().
		Where(integration.OrganizationID(org), integration.InternalID(internalID), integration.DeletedAtIsNil()).
		First(ctx))
}

// MigrateIntegration moves a channel to another provider in place
// (MIGRATE_PROVIDERS): only the provider and the app-scoped ids change, so the
// integration id - and with it scheduled posts, settings and customers -
// survives the migration. The follow-up createOrUpdateIntegration upsert
// matches the new internalId and stores the fresh tokens.
func (r *Repository) MigrateIntegration(ctx context.Context, org, id, internalID, providerIdentifier string, rootInternalID *string) (*ent.Integration, error) {
	// A soft-deleted channel can still hold the target internalId
	// (deleteChannel keeps it): rename it out of the way like updateIntegration
	// does, otherwise the organizationId_internalId unique constraint rejects
	// the migration. Live channels are rejected by the service before this.
	existing, err := notFoundNil(r.client.Integration.Query().
		Where(integration.OrganizationID(org), integration.InternalID(internalID)).Only(ctx))
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.DeletedAt != nil {
		if err := r.client.Integration.UpdateOneID(existing.ID).
			SetInternalID("deleted_" + internalID + "_" + ids.Make(10)).Exec(ctx); err != nil {
			return nil, err
		}
	}
	u := r.updateOne(org, id).SetInternalID(internalID).SetProviderIdentifier(providerIdentifier).
		ClearVerifiedAccountKey().ClearVerifiedAccountKind().ClearVerifiedScopes().ClearVerifiedCapabilities().ClearIdentityVerifiedAt()
	if rootInternalID == nil {
		u.ClearRootInternalID()
	} else {
		u.SetRootInternalID(*rootInternalID)
	}
	return u.Save(ctx)
}

func (r *Repository) CreateOrUpdateIntegration(ctx context.Context, p CreateOrUpdateIntegrationParams) (*ent.Integration, error) {
	if p.Verification != nil {
		if err := p.Verification.Validate(p.Provider, p.InternalID); err != nil {
			return nil, err
		}
	}
	verifiedAt := time.Now().UTC()
	expiresIn := int64(999999999)
	if p.ExpiresIn != nil {
		expiresIn = *p.ExpiresIn
	}
	var postingTimes string
	if p.Timezone != 0 {
		data, _ := json.Marshal([]map[string]int{
			{"time": 560 - p.Timezone}, {"time": 850 - p.Timezone}, {"time": 1140 - p.Timezone},
		})
		postingTimes = string(data)
	}
	var additionalSettings string
	if p.AdditionalSettings != nil {
		data, err := json.Marshal(p.AdditionalSettings)
		if err != nil {
			return nil, err
		}
		additionalSettings = string(data)
	}

	create := r.client.Integration.Create().
		SetType(p.Type).
		SetName(p.Name).
		SetProviderIdentifier(p.Provider).
		SetToken(p.Token).
		SetNillableProfile(p.Username).
		SetInBetweenSteps(p.IsBetweenSteps).
		SetInternalID(p.InternalID).
		SetOrganizationID(p.Org).
		SetRefreshNeeded(false).
		SetRootInternalID(p.InternalID).
		SetAdditionalSettings("[]")
	if p.RefreshToken != "" {
		create.SetRefreshToken(&p.RefreshToken)
	}
	if p.Picture != "" {
		create.SetPicture(p.Picture)
	}
	if expiresIn != 0 {
		create.SetTokenExpiration(time.Now().Add(time.Duration(expiresIn) * time.Second))
	}
	if postingTimes != "" {
		create.SetPostingTimes(postingTimes)
	}
	if p.CustomInstanceDetails != "" {
		create.SetCustomInstanceDetails(p.CustomInstanceDetails)
	}
	if additionalSettings != "" {
		create.SetAdditionalSettings(additionalSettings)
	}

	if p.Verification != nil {
		create.SetVerifiedAccountKey(p.Verification.AccountKey).SetVerifiedAccountKind(p.Verification.AccountKind).
			SetVerifiedScopes(p.Verification.GrantedScopes).SetVerifiedCapabilities(&p.Verification.Capabilities).SetIdentityVerifiedAt(verifiedAt)
	}
	id, err := create.OnConflictColumns(integration.FieldOrganizationID, integration.FieldInternalID).
		Update(func(u *ent.IntegrationUpsert) {
			// New authorization must carry new verification. Never retain old grants for a replacement token.
			if p.Verification != nil {
				u.SetVerifiedAccountKey(p.Verification.AccountKey).SetVerifiedAccountKind(p.Verification.AccountKind).
					SetVerifiedScopes(p.Verification.GrantedScopes).SetVerifiedCapabilities(&p.Verification.Capabilities).SetIdentityVerifiedAt(verifiedAt)
			} else {
				u.ClearVerifiedAccountKey().ClearVerifiedAccountKind().ClearVerifiedScopes().ClearVerifiedCapabilities().ClearIdentityVerifiedAt()
			}
			if additionalSettings != "" {
				u.SetAdditionalSettings(additionalSettings)
			}
			if p.CustomInstanceDetails != "" {
				u.SetCustomInstanceDetails(p.CustomInstanceDetails)
			}
			u.SetType(p.Type)
			if p.Refresh == "" {
				u.SetInBetweenSteps(p.IsBetweenSteps)
			}
			if p.Picture != "" {
				u.SetPicture(p.Picture)
			}
			if p.Username != nil {
				u.SetProfile(*p.Username)
			}
			u.SetProviderIdentifier(p.Provider)
			// Ent upsert setters bypass ValueScanner; use the sealed insert values.
			u.UpdateToken()
			// never wipe a stored refresh token with an empty one
			if p.RefreshToken != "" {
				u.UpdateRefreshToken()
			}
			if expiresIn != 0 {
				u.SetTokenExpiration(time.Now().Add(time.Duration(expiresIn) * time.Second))
			} else {
				u.ClearTokenExpiration()
			}
			u.SetInternalID(p.InternalID)
			u.SetOrganizationID(p.Org)
			u.ClearDeletedAt()
			u.SetRefreshNeeded(false)
			u.SetUpdatedAt(time.Now())
		}).ID(ctx)
	if err != nil {
		return nil, err
	}
	upsert, err := r.client.Integration.Get(ctx, id)
	if err != nil {
		return nil, err
	}

	if p.OneTimeToken {
		rootID := p.InternalID
		found, err := notFoundNil(r.client.Integration.Query().
			Where(integration.OrganizationID(p.Org), integration.InternalID(p.InternalID)).First(ctx))
		if err != nil {
			return nil, err
		}
		if found != nil && found.RootInternalID != nil && *found.RootInternalID != "" {
			rootID = *found.RootInternalID
		}
		u := r.client.Integration.Update().
			Where(integration.OrganizationID(p.Org), integration.ProviderIdentifier(p.Provider), integration.IDNEQ(upsert.ID), integration.RootInternalID(rootID)).
			SetToken(p.Token).
			ClearVerifiedAccountKey().ClearVerifiedAccountKind().ClearVerifiedScopes().ClearVerifiedCapabilities().ClearIdentityVerifiedAt().
			SetRefreshNeeded(false)
		if p.RefreshToken != "" {
			u.SetRefreshToken(&p.RefreshToken)
		}
		if expiresIn != 0 {
			u.SetTokenExpiration(time.Now().Add(time.Duration(expiresIn) * time.Second))
		} else {
			u.ClearTokenExpiration()
		}
		if err := u.Exec(ctx); err != nil {
			return nil, err
		}
	}

	return upsert, nil
}

func (r *Repository) NeedsToBeRefreshed(ctx context.Context) ([]*ent.Integration, error) {
	return r.client.Integration.Query().Where(
		integration.TokenExpirationLTE(time.Now().AddDate(0, 0, 1)),
		integration.InBetweenSteps(false),
		integration.DeletedAtIsNil(),
		integration.RefreshNeeded(false),
		integration.Disabled(false),
		integration.HasOrganizationWith(organization.DeletedAtIsNil()),
	).All(ctx)
}

func (r *Repository) SetBetweenRefreshSteps(ctx context.Context, id string) (*ent.Integration, error) {
	return r.client.Integration.UpdateOneID(id).SetInBetweenSteps(true).Save(ctx)
}

func (r *Repository) RefreshNeeded(ctx context.Context, org, id string) (*ent.Integration, error) {
	return r.updateOne(org, id).SetRefreshNeeded(true).Save(ctx)
}

func (r *Repository) UpdateNameAndURL(ctx context.Context, id, name, url string) (*ent.Integration, error) {
	u := r.client.Integration.UpdateOneID(id)
	if name != "" {
		u.SetName(name)
	}
	if url != "" {
		u.SetPicture(url)
	}
	return u.Save(ctx)
}

// GetIntegrationByID returns nil when the integration does not exist. Like
// the original app it does not filter deleted integrations.
func (r *Repository) GetIntegrationByID(ctx context.Context, org, id string) (*ent.Integration, error) {
	return notFoundNil(r.client.Integration.Query().
		Where(integration.OrganizationID(org), integration.ID(id)).First(ctx))
}

func (r *Repository) GetIntegrationForOrder(ctx context.Context, id, order, user, org string) (*OrderIntegration, error) {
	p, err := notFoundNil(r.client.Post.Query().
		Where(
			post.IntegrationID(id),
			post.HasSubmittedForOrderWith(
				orders.ID(order),
				orders.HasMessageGroupWith(messagesgroup.Or(
					messagesgroup.SellerID(user),
					messagesgroup.BuyerID(user),
					messagesgroup.BuyerOrganizationID(org),
				)),
			),
		).
		WithIntegration(func(q *ent.IntegrationQuery) {
			q.Select(integration.FieldID, integration.FieldName, integration.FieldPicture,
				integration.FieldInBetweenSteps, integration.FieldProviderIdentifier)
		}).First(ctx))
	if err != nil || p == nil || p.Edges.Integration == nil {
		return nil, err
	}
	i := p.Edges.Integration
	return &OrderIntegration{ID: i.ID, Name: i.Name, Picture: i.Picture, InBetweenSteps: i.InBetweenSteps, ProviderIdentifier: i.ProviderIdentifier}, nil
}

func (r *Repository) UpdateOnCustomerName(ctx context.Context, org, id, name string) (*ent.Integration, error) {
	var c *ent.Customer
	if name != "" {
		found, err := notFoundNil(r.client.Customer.Query().Where(customer.OrgID(org), customer.Name(name)).First(ctx))
		if err != nil {
			return nil, err
		}
		c = found
		if c == nil {
			if c, err = r.client.Customer.Create().SetName(name).SetOrgID(org).Save(ctx); err != nil {
				return nil, err
			}
		}
	}
	u := r.updateOne(org, id)
	if c == nil {
		u.ClearCustomer()
	} else {
		u.SetCustomerID(c.ID)
	}
	return u.Save(ctx)
}

func (r *Repository) UpdateIntegrationGroup(ctx context.Context, org, id, group string) (*ent.Integration, error) {
	u := r.updateOne(org, id)
	if group == "" {
		u.ClearCustomer()
	} else {
		u.SetCustomerID(group)
	}
	return u.Save(ctx)
}

func (r *Repository) GetCustomerByName(ctx context.Context, orgID, name string) (*ent.Customer, error) {
	return notFoundNil(r.client.Customer.Query().
		Where(customer.OrgID(orgID), customer.Name(name), customer.DeletedAtIsNil()).First(ctx))
}

func (r *Repository) UpdateCustomerName(ctx context.Context, orgID, id, name string) (*ent.Customer, error) {
	return r.client.Customer.UpdateOneID(id).Where(customer.OrgID(orgID)).SetName(name).Save(ctx)
}

func (r *Repository) Customers(ctx context.Context, orgID string) ([]*ent.Customer, error) {
	return r.client.Customer.Query().Where(customer.OrgID(orgID), customer.DeletedAtIsNil()).All(ctx)
}

// GetIntegrationsList has no orderBy in the original app either: rows come back in the
// database's order.
func (r *Repository) GetIntegrationsList(ctx context.Context, org string) ([]*ent.Integration, error) {
	return r.client.Integration.Query().
		Where(integration.OrganizationID(org), integration.DeletedAtIsNil()).
		WithCustomer().All(ctx)
}

type latestPost struct {
	id            string
	integrationID string
	publishDate   time.Time
	updatedAt     time.Time
	releaseURL    *string
	errorText     *string
}

type dateGroup struct {
	integrationID string
	date          *time.Time
}

func (r *Repository) maxPerIntegration(ctx context.Context, org, state, field string, topLevelOnly, includeDeleted bool) ([]dateGroup, error) {
	query := `SELECT "integrationId", MAX("` + field + `") FROM "Post" WHERE "organizationId" = $1 AND "state" = $2`
	if !includeDeleted {
		query += ` AND "deletedAt" IS NULL`
	}
	if topLevelOnly {
		query += ` AND "parentPostId" IS NULL`
	}
	rows, err := r.client.QueryContext(ctx, query+` GROUP BY "integrationId"`, org, state)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []dateGroup
	for rows.Next() {
		var g dateGroup
		if err := rows.Scan(&g.integrationID, &g.date); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (r *Repository) latestPostsFor(ctx context.Context, org string, state post.State, field string, topLevelOnly, includeDeleted bool, groups []dateGroup) ([]latestPost, error) {
	var or []predicate.Post
	for _, g := range groups {
		if g.date == nil {
			continue
		}
		pred := post.PublishDate(*g.date)
		if field == post.FieldUpdatedAt {
			pred = post.UpdatedAt(*g.date)
		}
		or = append(or, post.And(post.IntegrationID(g.integrationID), pred))
	}
	if len(or) == 0 {
		return nil, nil
	}
	q := r.client.Post.Query().Where(post.OrganizationID(org), post.StateEQ(state))
	if !includeDeleted {
		q.Where(post.DeletedAtIsNil())
	}
	if topLevelOnly {
		q.Where(post.ParentPostIDIsNil())
	}
	list, err := q.Where(post.Or(or...)).
		Order(post.ByID()).
		Select(post.FieldID, post.FieldIntegrationID, post.FieldPublishDate, post.FieldUpdatedAt, post.FieldReleaseURL, post.FieldError).
		All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]latestPost, 0, len(list))
	for _, p := range list {
		out = append(out, latestPost{id: p.ID, integrationID: p.IntegrationID, publishDate: p.PublishDate, updatedAt: p.UpdatedAt, releaseURL: p.ReleaseURL, errorText: p.Error})
	}
	return out, nil
}

func firstPerIntegration(posts []latestPost) map[string]latestPost {
	out := map[string]latestPost{}
	for _, p := range posts {
		if _, ok := out[p.integrationID]; !ok {
			out[p.integrationID] = p
		}
	}
	return out
}

func nonEmpty(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

func (r *Repository) GetChannelHealth(ctx context.Context, org string, includeDeleted bool) ([]ChannelHealth, error) {
	list, err := r.client.Integration.Query().
		Where(integration.OrganizationID(org)).
		Order(integration.ByCreatedAt()).
		WithCustomer(func(q *ent.CustomerQuery) { q.Select(customer.FieldID, customer.FieldName) }).
		All(ctx)
	if err != nil {
		return nil, err
	}
	lastPublished, err := r.maxPerIntegration(ctx, org, "PUBLISHED", "publishDate", true, includeDeleted)
	if err != nil {
		return nil, err
	}
	lastErrored, err := r.maxPerIntegration(ctx, org, "ERROR", "updatedAt", false, includeDeleted)
	if err != nil {
		return nil, err
	}
	publishedPosts, err := r.latestPostsFor(ctx, org, post.StatePUBLISHED, post.FieldPublishDate, true, includeDeleted, lastPublished)
	if err != nil {
		return nil, err
	}
	erroredPosts, err := r.latestPostsFor(ctx, org, post.StateERROR, post.FieldUpdatedAt, false, includeDeleted, lastErrored)
	if err != nil {
		return nil, err
	}
	publishedBy := firstPerIntegration(publishedPosts)
	erroredBy := firstPerIntegration(erroredPosts)

	out := make([]ChannelHealth, 0, len(list))
	for _, i := range list {
		item := ChannelHealth{
			ID: i.ID, InternalID: i.InternalID, Name: i.Name, ProviderIdentifier: i.ProviderIdentifier, Type: i.Type,
			Disabled: i.Disabled, RefreshNeeded: i.RefreshNeeded, InBetweenSteps: i.InBetweenSteps,
			TokenExpiration: jsTime(i.TokenExpiration), DeletedAt: jsTime(i.DeletedAt), CreatedAt: JSTime(i.CreatedAt),
			UpdatedAt: jsTime(i.UpdatedAt),
		}
		if c := i.Edges.Customer; c != nil {
			item.Customer = &CustomerRef{ID: c.ID, Name: c.Name}
		}
		if p, ok := publishedBy[i.ID]; ok {
			id := p.id
			item.LastPublishedAt = jsTime(&p.publishDate)
			item.LastPublishedPostID = &id
			item.LastPublishedURL = nonEmpty(p.releaseURL)
		}
		if p, ok := erroredBy[i.ID]; ok {
			id := p.id
			item.LastErrorAt = jsTime(&p.updatedAt)
			item.LastErrorPostID = &id
			item.LastError = nonEmpty(p.errorText)
		}
		out = append(out, item)
	}
	return out, nil
}

func (r *Repository) DisableChannel(ctx context.Context, org, id string) error {
	return r.updateOne(org, id).SetDisabled(true).Exec(ctx)
}

func (r *Repository) EnableChannel(ctx context.Context, org, id string) error {
	return r.updateOne(org, id).SetDisabled(false).Exec(ctx)
}

func (r *Repository) GetPostsForChannel(ctx context.Context, org, id string) ([]PostGroup, error) {
	groups, err := r.client.Post.Query().
		Where(post.OrganizationID(org), post.IntegrationID(id), post.DeletedAtIsNil()).
		GroupBy(post.FieldGroup).Strings(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]PostGroup, 0, len(groups))
	for _, g := range groups {
		out = append(out, PostGroup{Group: g})
	}
	return out, nil
}

func (r *Repository) DeleteChannel(ctx context.Context, org, id string) (*IDResult, error) {
	saved, err := r.updateOne(org, id).SetDeletedAt(time.Now()).Save(ctx)
	if err != nil {
		return nil, err
	}
	return &IDResult{ID: saved.ID}, nil
}

func hashOrNil(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	h := md5hex(*s)
	return &h
}

func (r *Repository) DeleteIntegrationsForAccount(ctx context.Context, org string) error {
	if err := r.client.Post.Update().
		Where(post.OrganizationID(org), post.DeletedAtIsNil()).
		SetDeletedAt(time.Now()).Exec(ctx); err != nil {
		return err
	}
	list, err := r.client.Integration.Query().Where(integration.OrganizationID(org)).All(ctx)
	if err != nil {
		return err
	}
	// md5 is deterministic, so a hashed rootInternalId can still be matched
	// by checkPreviousConnections when the same channel is connected again
	// from a new account.
	for _, i := range list {
		if err := r.anonymize(ctx, i); err != nil {
			return err
		}
	}
	return nil
}

// anonymize overwrites an integration's credentials and profile with hashes,
// keeping the row for the records that refer to it.
func (r *Repository) anonymize(ctx context.Context, i *ent.Integration) error {
	deletedAt := time.Now()
	if i.DeletedAt != nil {
		deletedAt = *i.DeletedAt
	}
	u := r.client.Integration.UpdateOneID(i.ID).
		SetName(md5hex(i.Name)).
		SetInternalID(md5hex(i.InternalID)).
		SetToken(md5hex(i.Token)).
		ClearPicture().
		SetDeletedAt(deletedAt)
	setOrClear(hashOrNil(i.RootInternalID), u.SetRootInternalID, u.ClearRootInternalID)
	setOrClear(hashOrNil(i.RefreshToken), func(value string) *ent.IntegrationUpdateOne {
		return u.SetRefreshToken(&value)
	}, u.ClearRefreshToken)
	setOrClear(hashOrNil(i.Profile), u.SetProfile, u.ClearProfile)
	setOrClear(hashOrNil(i.CustomInstanceDetails), u.SetCustomInstanceDetails, u.ClearCustomInstanceDetails)
	return u.Exec(ctx)
}

// ProviderAccountIntegrationIDs finds one provider account's integrations in
// every organization. Removed rows count: they still hold its tokens.
func (r *Repository) ProviderAccountIntegrationIDs(ctx context.Context, provider, internalID string) ([]string, error) {
	return r.client.Integration.Query().
		Where(integration.ProviderIdentifier(provider), integration.InternalID(internalID)).
		IDs(ctx)
}

// ForgetProviderAccount anonymizes those integrations. A later call finds none.
func (r *Repository) ForgetProviderAccount(ctx context.Context, provider, internalID string) error {
	list, err := r.client.Integration.Query().
		Where(integration.ProviderIdentifier(provider), integration.InternalID(internalID)).All(ctx)
	if err != nil {
		return err
	}
	for _, i := range list {
		if err := r.anonymize(ctx, i); err != nil {
			return err
		}
	}
	return nil
}

func setOrClear(v *string, set func(string) *ent.IntegrationUpdateOne, clear func() *ent.IntegrationUpdateOne) {
	if v == nil {
		clear()
		return
	}
	set(*v)
}

func (r *Repository) CheckForDeletedOnceAndUpdate(ctx context.Context, org, page string) (int, error) {
	return r.client.Integration.Update().
		Where(integration.OrganizationID(org), integration.InternalID(page), integration.DeletedAtNotNil()).
		SetInternalID(ids.Make(10)).Save(ctx)
}

func (r *Repository) DisableIntegrations(ctx context.Context, org string, totalChannels int) error {
	channels, err := r.client.Integration.Query().
		Where(integration.OrganizationID(org), integration.Disabled(false), integration.DeletedAtIsNil()).
		Limit(totalChannels).IDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range channels {
		if err := r.client.Integration.UpdateOneID(id).SetDisabled(true).Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (r *Repository) EnableAllIntegrations(ctx context.Context, org string) (int, error) {
	return r.client.Integration.Update().
		Where(integration.OrganizationID(org), integration.Disabled(true), integration.DeletedAtIsNil()).
		SetDisabled(false).Save(ctx)
}

func (r *Repository) GetPlugsByIntegrationID(ctx context.Context, org, id string) ([]*ent.Plugs, error) {
	return r.client.Plugs.Query().Where(plugs.OrganizationID(org), plugs.IntegrationID(id)).All(ctx)
}

// CreateOrUpdatePlug is Prisma's upsert on plugFunction_integrationId with the
// extra organizationId filter: look the row up with all three, then update or
// create. Returns the stored `activated`.
func (r *Repository) CreateOrUpdatePlug(ctx context.Context, org, integrationID string, body plugsdto.PlugDto) (bool, error) {
	fields := body.Fields
	if fields == nil {
		fields = []plugsdto.FieldsDto{}
	}
	data, err := json.Marshal(fields)
	if err != nil {
		return false, err
	}
	existing, err := notFoundNil(r.client.Plugs.Query().Where(
		plugs.OrganizationID(org), plugs.PlugFunction(body.Func), plugs.IntegrationID(integrationID),
	).Only(ctx))
	if err != nil {
		return false, err
	}
	if existing != nil {
		saved, err := r.client.Plugs.UpdateOneID(existing.ID).SetData(string(data)).Save(ctx)
		if err != nil {
			return false, err
		}
		return saved.Activated, nil
	}
	saved, err := r.client.Plugs.Create().
		SetIntegrationID(integrationID).
		SetOrganizationID(org).
		SetPlugFunction(body.Func).
		SetData(string(data)).
		SetActivated(true).Save(ctx)
	if err != nil {
		return false, err
	}
	return saved.Activated, nil
}

func (r *Repository) ChangePlugActivation(ctx context.Context, orgID, plugID string, status bool) (*ent.Plugs, error) {
	return r.client.Plugs.UpdateOneID(plugID).Where(plugs.OrganizationID(orgID)).SetActivated(status).Save(ctx)
}

func (r *Repository) LoadExisingData(ctx context.Context, methodName, integrationID string, id []string) ([]*ent.ExisingPlugData, error) {
	return r.client.ExisingPlugData.Query().Where(
		exisingplugdata.IntegrationID(integrationID),
		exisingplugdata.MethodName(methodName),
		exisingplugdata.PlugValueIn(id...),
	).All(ctx)
}

func (r *Repository) SaveExisingData(ctx context.Context, methodName, integrationID string, value []string) error {
	builders := make([]*ent.ExisingPlugDataCreate, 0, len(value))
	for _, v := range value {
		builders = append(builders, r.client.ExisingPlugData.Create().
			SetIntegrationID(integrationID).SetMethodName(methodName).SetPlugValue(v))
	}
	return r.client.ExisingPlugData.CreateBulk(builders...).Exec(ctx)
}

// GetPostingTimes returns the postingTimes column of the matching channels.
func (r *Repository) GetPostingTimes(ctx context.Context, orgID, integrationID string) ([]string, error) {
	q := r.client.Integration.Query()
	if integrationID != "" {
		q.Where(integration.ID(integrationID))
	}
	return q.Where(integration.OrganizationID(orgID), integration.Disabled(false), integration.DeletedAtIsNil()).
		Select(integration.FieldPostingTimes).Strings(ctx)
}

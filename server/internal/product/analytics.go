package product

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"entgo.io/ent/dialect/sql"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticsaccount"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticspost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticssnapshot"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// AnalyticsCapabilities reflects the adapter that is actually installed.
type AnalyticsCapabilities struct {
	Account bool `json:"account"`
	Posts   bool `json:"posts"`
	Import  bool `json:"import"`
}

// AccountObservation is a provider counter observation, never synthetic history.
type AccountObservation struct {
	At       time.Time
	Counters map[string]float64
}

// ImportedAnalyticsPost is a confirmed provider publication, distinct from a draft or job.
type ImportedAnalyticsPost struct {
	ID, Text, URL, ThreadRootID string
	At                          time.Time
	IsReply                     bool
	Position                    int
	Counters                    map[string]float64
}

// AnalyticsReader extends the existing provider seam with read-only observations.
type AnalyticsReader interface {
	AnalyticsCapabilities(string) AnalyticsCapabilities
	AccountObservations(context.Context, string, string, string, string) ([]AccountObservation, error)
	ImportAnalyticsPosts(context.Context, string, string, string, string, time.Time) ([]ImportedAnalyticsPost, error)
}

// WithAnalytics uses the same social adapters as publishing.
func (c *Configuration) WithAnalytics(reader AnalyticsReader) *Configuration {
	c.analytics = reader
	return c
}

// AnalyticsQuery scopes every metric, row and export to one account and local date interval.
type AnalyticsQuery struct {
	From      string     `json:"from"`
	To        string     `json:"to"`
	TimeZone  string     `json:"timeZone"`
	Grouping  string     `json:"grouping"`
	Scope     string     `json:"scope"`
	Sort      string     `json:"sort"`
	Direction string     `json:"direction"`
	Cursor    string     `json:"cursor"`
	Limit     int        `json:"limit"`
	AsOf      *time.Time `json:"asOf,omitempty"`
}

// AnalyticsPoint retains missing values as null and sample sizes independently.
type AnalyticsPoint struct {
	At      string   `json:"at"`
	Value   *float64 `json:"value"`
	Samples int      `json:"samples"`
}

// AnalyticsMetric carries its own availability and recovery state.
type AnalyticsMetric struct {
	Status     string           `json:"status"`
	Value      *float64         `json:"value"`
	Previous   *float64         `json:"previous"`
	Change     *float64         `json:"change"`
	Points     []AnalyticsPoint `json:"points"`
	Definition string           `json:"definition"`
	Samples    int              `json:"samples"`
	Missing    int              `json:"missing"`
}

// AnalyticsRow is precisely one provider post; continuation posts have their own identity.
type AnalyticsRow struct {
	ID             string             `json:"id"`
	RemoteID       string             `json:"remoteId"`
	Excerpt        string             `json:"excerpt"`
	URL            string             `json:"url"`
	PublishedAt    time.Time          `json:"publishedAt"`
	ObservedAt     *time.Time         `json:"observedAt"`
	Status         string             `json:"status"`
	ThreadRootID   *string            `json:"threadRootId"`
	ThreadPosition int                `json:"threadPosition"`
	IsReply        bool               `json:"isReply"`
	Metrics        map[string]float64 `json:"metrics"`
}

// HourlyCell describes lifetime engagements by publication hour, with explicit samples.
type HourlyCell struct {
	Day     int      `json:"day"`
	Hour    int      `json:"hour"`
	Samples int      `json:"samples"`
	Total   float64  `json:"total"`
	Average *float64 `json:"average"`
	PostIDs []string `json:"postIds"`
}

// PostingGoal is configuration only. Saving it is the sole operation that changes it.
type PostingGoal struct {
	Cadence         string `json:"cadence"`
	ExcludeWeekends bool   `json:"excludeWeekends"`
	TimeZone        string `json:"timeZone"`
	EffectiveDate   string `json:"effectiveDate"`
}

// GoalProgress counts confirmed root publications since the goal's effective date.
type GoalProgress struct {
	Streak   int    `json:"streak"`
	Current  int    `json:"current"`
	Required int    `json:"required"`
	Period   string `json:"period"`
}

// AnalyticsSettings combines two explicit, independent account-scoped settings.
type AnalyticsSettings struct {
	Version     int          `json:"version"`
	Goal        *PostingGoal `json:"goal"`
	PublicToken *string      `json:"publicToken"`
}

// AnalyticsReport is the account/date snapshot shared by all private views.
type AnalyticsReport struct {
	AccountID     string                     `json:"accountId"`
	Name          string                     `json:"name"`
	Platform      string                     `json:"platform"`
	ProfileURL    string                     `json:"profileUrl"`
	Query         AnalyticsQuery             `json:"query"`
	Status        string                     `json:"status"`
	Capabilities  AnalyticsCapabilities      `json:"capabilities"`
	CheckedAt     *time.Time                 `json:"checkedAt"`
	CoverageStart *time.Time                 `json:"coverageStart"`
	AsOf          time.Time                  `json:"asOf"`
	Metrics       map[string]AnalyticsMetric `json:"metrics"`
	Posts         []AnalyticsRow             `json:"posts"`
	TotalPosts    int                        `json:"totalPosts"`
	NextCursor    *string                    `json:"nextCursor"`
	Hourly        []HourlyCell               `json:"hourly"`
	Settings      AnalyticsSettings          `json:"settings"`
	Progress      GoalProgress               `json:"progress"`
}

func analyticsBounds(q *AnalyticsQuery) (time.Time, time.Time, *time.Location, error) {
	if q.TimeZone == "" {
		q.TimeZone = "UTC"
	}
	zone, e := time.LoadLocation(q.TimeZone)
	if e != nil {
		return time.Time{}, time.Time{}, nil, invalid("Choose an IANA timezone.")
	}
	from, e := time.ParseInLocation("2006-01-02", q.From, zone)
	if e != nil {
		return time.Time{}, time.Time{}, nil, invalid("From must be a valid calendar date.")
	}
	to, e := time.ParseInLocation("2006-01-02", q.To, zone)
	if e != nil || to.Before(from) || to.Sub(from) > 731*24*time.Hour {
		return time.Time{}, time.Time{}, nil, invalid("Choose an ordered range of up to two years.")
	}
	if q.Grouping == "" {
		q.Grouping = "daily"
	}
	if !oneOf(q.Grouping, "daily", "weekly", "monthly") {
		return time.Time{}, time.Time{}, nil, invalid("Choose daily, weekly or monthly grouping.")
	}
	if q.Scope == "" {
		q.Scope = "all"
	}
	if !oneOf(q.Scope, "all", "replies") {
		return time.Time{}, time.Time{}, nil, invalid("Choose All or Replies.")
	}
	if q.Sort == "" {
		q.Sort = "latest"
	}
	if !oneOf(q.Sort, "latest", "impressions", "likes", "replies", "reposts", "bookmarks", "engagementRate", "engagements", "quotes", "profileClicks", "linkClicks") {
		return time.Time{}, time.Time{}, nil, invalid("Unknown post sort.")
	}
	if q.Direction == "" {
		q.Direction = "desc"
	}
	if !oneOf(q.Direction, "asc", "desc") {
		return time.Time{}, time.Time{}, nil, invalid("Unknown sort direction.")
	}
	if q.Limit == 0 {
		q.Limit = 25
	}
	if q.Limit < 1 || q.Limit > 10000 {
		return time.Time{}, time.Time{}, nil, invalid("Invalid page size.")
	}
	return from, to.AddDate(0, 0, 1), zone, nil
}
func (c *Configuration) analyticsConnection(ctx context.Context, actor Actor, id string) (*ent.ChannelConnection, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	row, err := c.client.ChannelConnection.Query().Where(channelconnection.ID(id), channelconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if row.SocialSetID != nil {
		if _, err = c.visibleSet(ctx, actor, *row.SocialSetID); err != nil {
			return nil, err
		}
	}
	return row, nil
}
func (c *Configuration) analyticsState(ctx context.Context, connection *ent.ChannelConnection) (*ent.AnalyticsAccount, error) {
	row, err := c.client.AnalyticsAccount.Get(ctx, connection.ID)
	if !ent.IsNotFound(err) {
		return row, err
	}
	row, err = c.client.AnalyticsAccount.Create().SetID(connection.ID).SetOrganizationID(connection.OrganizationID).Save(ctx)
	if ent.IsConstraintError(err) {
		return c.client.AnalyticsAccount.Get(ctx, connection.ID)
	}
	return row, err
}
func analyticsSettings(row *ent.AnalyticsAccount) AnalyticsSettings {
	result := AnalyticsSettings{Version: row.Version, PublicToken: row.PublicToken}
	if len(row.Goal) > 0 {
		b, _ := json.Marshal(row.Goal)
		var goal PostingGoal
		if json.Unmarshal(b, &goal) == nil {
			result.Goal = &goal
		}
	}
	return result
}

// AnalyticsSettingsInput changes a goal or public sharing, never both implicitly.
type AnalyticsSettingsInput struct {
	Version int          `json:"version"`
	Action  string       `json:"action"`
	Goal    *PostingGoal `json:"goal"`
}

func (c *Configuration) UpdateAnalyticsSettings(ctx context.Context, actor Actor, id string, input AnalyticsSettingsInput) (*AnalyticsSettings, error) {
	if err := c.authorizeDecision(ctx, actor, "owner", "admin", "publisher"); err != nil {
		return nil, err
	}
	connection, err := c.analyticsConnection(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	row, err := c.analyticsState(ctx, connection)
	if err != nil {
		return nil, err
	}
	if input.Version != row.Version {
		return nil, publishing.ErrConflict
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	update := tx.AnalyticsAccount.Update().Where(analyticsaccount.ID(id), analyticsaccount.OrganizationID(actor.OrganizationID), analyticsaccount.Version(input.Version)).AddVersion(1)
	switch input.Action {
	case "enable":
		token := make([]byte, 24)
		if _, err = rand.Read(token); err != nil {
			return nil, err
		}
		update.SetPublicToken(base64.RawURLEncoding.EncodeToString(token))
	case "revoke":
		update.ClearPublicToken()
	case "goal":
		if input.Goal == nil || !oneOf(input.Goal.Cadence, "daily", "weekly") {
			return nil, invalid("Choose a daily or weekly goal.")
		}
		zone, e := time.LoadLocation(input.Goal.TimeZone)
		if input.Goal.TimeZone == "" || e != nil {
			return nil, invalid("Choose the goal's IANA timezone.")
		}
		input.Goal.EffectiveDate = time.Now().In(zone).Format("2006-01-02")
		data := map[string]any{}
		b, _ := json.Marshal(input.Goal)
		_ = json.Unmarshal(b, &data)
		update.SetGoal(data)
	default:
		return nil, invalid("Choose goal, enable or revoke.")
	}
	count, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, publishing.ErrConflict
	}
	if err = appendConfigurationAudit(ctx, tx, actor, "product.analytics_"+input.Action, "channel_connection", id, map[string]any{"version": input.Version + 1}); err != nil {
		return nil, err
	}
	saved, err := tx.AnalyticsAccount.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	result := analyticsSettings(saved)
	return &result, nil
}

// RecordAnalyticsSnapshot deduplicates retries, preserves corrections and separates raw counters from rates.
func (c *Configuration) RecordAnalyticsSnapshot(ctx context.Context, organizationID, connectionID, kind, subjectID string, at, collected time.Time, counters map[string]float64, age int) error {
	if !oneOf(kind, "account", "post") || at.IsZero() || at.After(collected.Add(time.Minute)) {
		return invalid("Invalid analytics observation.")
	}
	exists, err := c.client.ChannelConnection.Query().Where(channelconnection.ID(connectionID), channelconnection.OrganizationID(organizationID), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return publishing.ErrNotFound
	}
	clean := map[string]float64{}
	for key, value := range counters {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return invalid("Provider counters must be finite non-negative numbers.")
		}
		clean[key] = value
	}
	if len(clean) == 0 {
		return nil
	}
	data, _ := json.Marshal(clean)
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	_, err = c.client.AnalyticsSnapshot.Create().SetID(cuid.New()).SetOrganizationID(organizationID).SetConnectionID(connectionID).SetKind(analyticssnapshot.Kind(kind)).SetSubjectID(subjectID).SetObservedAt(at.UTC()).SetCollectedAt(collected.UTC()).SetCounters(clean).SetPayloadHash(hash).SetAgeMinutes(max(0, age)).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil
	}
	return err
}

func bucket(at time.Time, zone *time.Location, group string) string {
	local := at.In(zone)
	if group == "monthly" {
		return local.Format("2006-01") + "-01"
	}
	if group == "weekly" {
		local = local.AddDate(0, 0, -(int(local.Weekday())+6)%7)
	}
	return local.Format("2006-01-02")
}
func metricNumber(v float64) *float64 { return &v }

// deriveMetrics sums only returned engagement components; the definition says exactly which ones.
func deriveMetrics(raw map[string]float64) map[string]float64 {
	out := map[string]float64{}
	for k, v := range raw {
		out[k] = v
	}
	total := 0.0
	count := 0
	for _, key := range []string{"likes", "replies", "reposts", "profileClicks", "linkClicks"} {
		if v, ok := raw[key]; ok {
			total += v
			count++
		}
	}
	if count > 0 {
		out["engagements"] = total
		if impressions, ok := raw["impressions"]; ok && impressions > 0 {
			out["engagementRate"] = total / impressions
		}
	}
	return out
}
func metricForPosts(rows []AnalyticsRow, key, group string, from, to time.Time, zone *time.Location) AnalyticsMetric {
	result := AnalyticsMetric{Status: "insufficient", Points: []AnalyticsPoint{}, Definition: "Latest observed lifetime " + key + " for posts published in this range; not engagement received during the range."}
	if key == "engagements" {
		result.Definition += " Sum of returned likes, replies, reposts, profile clicks and link clicks only; missing components make this a partial total."
	}
	if key == "publishedPosts" {
		result.Definition = "Confirmed individual provider publications known to Shots in the selected range, including thread continuations. External history may be incomplete; counts before connection are not proof of zero activity."
		result.Value = metricNumber(0)
		result.Status = "available"
	}
	values := map[string]*AnalyticsPoint{}
	for _, row := range rows {
		if row.PublishedAt.Before(from) || !row.PublishedAt.Before(to) {
			continue
		}
		b := bucket(row.PublishedAt, zone, group)
		p := values[b]
		if p == nil {
			p = &AnalyticsPoint{At: b}
			values[b] = p
		}
		value, ok := row.Metrics[key]
		if key == "publishedPosts" {
			value, ok = 1, true
		}
		if !ok {
			result.Missing++
			continue
		}
		result.Samples++
		p.Samples++
		if p.Value == nil {
			p.Value = metricNumber(0)
		}
		*p.Value += value
		if result.Value == nil {
			result.Value = metricNumber(0)
		}
		*result.Value += value
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		result.Points = append(result.Points, *values[k])
	}
	if result.Value != nil {
		result.Status = "available"
	}
	return result
}
func followerMetric(snaps []*ent.AnalyticsSnapshot, from, to time.Time, zone *time.Location, group string) AnalyticsMetric {
	result := AnalyticsMetric{Status: "insufficient", Points: []AnalyticsPoint{}, Definition: "Last observed follower count in each interval. Gaps remain missing. Growth is the difference between consecutive observed intervals."}
	byBucket := map[string]AnalyticsPoint{}
	for _, s := range snaps {
		value, ok := s.Counters["followers"]
		if !ok || s.ObservedAt.Before(from) || !s.ObservedAt.Before(to) {
			continue
		}
		key := bucket(s.ObservedAt, zone, group)
		byBucket[key] = AnalyticsPoint{At: key, Value: metricNumber(value), Samples: byBucket[key].Samples + 1}
		result.Value = metricNumber(value)
		result.Samples++
	}
	keys := []string{}
	for k := range byBucket {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		result.Points = append(result.Points, byBucket[k])
	}
	if result.Value != nil {
		result.Status = "available"
	}
	return result
}

// GetAnalytics reads one authoritative query snapshot. Account switches cannot share a cache key.
func (c *Configuration) GetAnalytics(ctx context.Context, actor Actor, id string, q AnalyticsQuery) (*AnalyticsReport, error) {
	connection, err := c.analyticsConnection(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	// Analyze counts what Posted shows: a post Shots published is in the report
	// at once, not after the next provider read, which some platforms never get.
	// A later page of a report keeps reading the snapshot its first page saw, and
	// a public share link only reads what is stored.
	if q.AsOf == nil {
		if err := c.importCanonicalAnalyticsPosts(ctx, connection); err != nil {
			return nil, err
		}
	}
	return c.analyticsReport(ctx, connection, q)
}
func (c *Configuration) analyticsReport(ctx context.Context, connection *ent.ChannelConnection, q AnalyticsQuery) (*AnalyticsReport, error) {
	from, to, zone, err := analyticsBounds(&q)
	if err != nil {
		return nil, err
	}
	asOf := time.Now().UTC()
	if q.AsOf != nil {
		if q.AsOf.After(asOf) {
			return nil, invalid("Observation cutoff cannot be in the future.")
		}
		asOf = *q.AsOf
	}
	q.AsOf = &asOf
	state, err := c.analyticsState(ctx, connection)
	if err != nil {
		return nil, err
	}
	cap := AnalyticsCapabilities{}
	if c.analytics != nil {
		cap = c.analytics.AnalyticsCapabilities(connection.Platform)
	}
	result := &AnalyticsReport{AccountID: connection.ID, Platform: connection.Platform, Query: q, Status: string(state.Availability), Capabilities: cap, CheckedAt: state.CheckedAt, AsOf: asOf, Metrics: map[string]AnalyticsMetric{}, Posts: []AnalyticsRow{}, Hourly: []HourlyCell{}, Settings: analyticsSettings(state)}
	if connection.DisplayName != nil {
		result.Name = *connection.DisplayName
	}
	if connection.Handle != nil {
		handle := strings.TrimPrefix(*connection.Handle, "@")
		switch connection.Platform {
		case "x", "twitter":
			result.ProfileURL = "https://x.com/" + handle
		case "bluesky":
			result.ProfileURL = "https://bsky.app/profile/" + handle
		case "linkedin":
			result.ProfileURL = "https://www.linkedin.com/in/" + handle
		case "linkedin-page":
			result.ProfileURL = "https://www.linkedin.com/company/" + handle
		case "threads":
			result.ProfileURL = "https://www.threads.net/@" + handle
		case "instagram", "instagram-standalone":
			result.ProfileURL = "https://www.instagram.com/" + handle
		}
	}
	if !cap.Account && !cap.Posts {
		result.Status = "unsupported"
	}
	if connection.Status != channelconnection.StatusACTIVE {
		result.Status = "forbidden"
	}
	if result.Status == "available" && state.CheckedAt != nil && time.Since(*state.CheckedAt) > 2*time.Hour {
		result.Status = "stale"
	}
	startDate, _ := time.Parse("2006-01-02", q.From)
	endDate, _ := time.Parse("2006-01-02", q.To)
	previousFrom := from.AddDate(0, 0, -(int(endDate.Sub(startDate).Hours()/24) + 1))
	posts, err := c.client.AnalyticsPost.Query().Where(analyticspost.OrganizationID(connection.OrganizationID), analyticspost.ConnectionID(connection.ID), analyticspost.PublishedAtGTE(previousFrom), analyticspost.PublishedAtLT(to), analyticspost.DiscoveredAtLTE(asOf)).Order(ent.Asc(analyticspost.FieldPublishedAt), ent.Asc(analyticspost.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	// Restrict account observations to this comparison window. Select one latest
	// immutable snapshot per eligible post in SQL rather than loading its entire history.
	account, err := c.client.AnalyticsSnapshot.Query().Where(
		analyticssnapshot.OrganizationID(connection.OrganizationID), analyticssnapshot.ConnectionID(connection.ID),
		analyticssnapshot.KindEQ(analyticssnapshot.KindAccount), analyticssnapshot.CollectedAtLTE(asOf),
		analyticssnapshot.ObservedAtGTE(previousFrom), analyticssnapshot.ObservedAtLT(to),
	).Order(ent.Asc(analyticssnapshot.FieldObservedAt), ent.Asc(analyticssnapshot.FieldCollectedAt), ent.Asc(analyticssnapshot.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	coverage, err := c.client.AnalyticsSnapshot.Query().Where(analyticssnapshot.OrganizationID(connection.OrganizationID), analyticssnapshot.ConnectionID(connection.ID), analyticssnapshot.CollectedAtLTE(asOf)).Order(ent.Asc(analyticssnapshot.FieldObservedAt)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if coverage != nil {
		result.CoverageStart = &coverage.ObservedAt
	}
	latest := map[string]*ent.AnalyticsSnapshot{}
	subjects := make([]string, 0, len(posts))
	for _, post := range posts {
		subjects = append(subjects, post.RemoteID)
	}
	if len(subjects) > 0 {
		snaps, e := c.client.AnalyticsSnapshot.Query().Where(
			analyticssnapshot.OrganizationID(connection.OrganizationID), analyticssnapshot.ConnectionID(connection.ID),
			analyticssnapshot.KindEQ(analyticssnapshot.KindPost), analyticssnapshot.CollectedAtLTE(asOf),
			analyticssnapshot.SubjectIDIn(subjects...), func(s *sql.Selector) {
				newer := sql.Table(analyticssnapshot.Table).As("newer")
				s.Where(sql.NotExists(sql.Select(newer.C(analyticssnapshot.FieldID)).From(newer).Where(sql.And(
					sql.ColumnsEQ(newer.C(analyticssnapshot.FieldConnectionID), s.C(analyticssnapshot.FieldConnectionID)),
					sql.ColumnsEQ(newer.C(analyticssnapshot.FieldKind), s.C(analyticssnapshot.FieldKind)),
					sql.ColumnsEQ(newer.C(analyticssnapshot.FieldSubjectID), s.C(analyticssnapshot.FieldSubjectID)),
					sql.LTE(newer.C(analyticssnapshot.FieldCollectedAt), asOf),
					sql.Or(
						sql.ColumnsGT(newer.C(analyticssnapshot.FieldObservedAt), s.C(analyticssnapshot.FieldObservedAt)),
						sql.And(sql.ColumnsEQ(newer.C(analyticssnapshot.FieldObservedAt), s.C(analyticssnapshot.FieldObservedAt)), sql.ColumnsGT(newer.C(analyticssnapshot.FieldCollectedAt), s.C(analyticssnapshot.FieldCollectedAt))),
						sql.And(sql.ColumnsEQ(newer.C(analyticssnapshot.FieldObservedAt), s.C(analyticssnapshot.FieldObservedAt)), sql.ColumnsEQ(newer.C(analyticssnapshot.FieldCollectedAt), s.C(analyticssnapshot.FieldCollectedAt)), sql.ColumnsGT(newer.C(analyticssnapshot.FieldID), s.C(analyticssnapshot.FieldID))),
					),
				))))
			},
		).All(ctx)
		if e != nil {
			return nil, e
		}
		for _, snap := range snaps {
			latest[snap.SubjectID] = snap
		}
	}
	all := []AnalyticsRow{}
	selected := []AnalyticsRow{}
	for _, p := range posts {
		row := AnalyticsRow{ID: p.ID, RemoteID: p.RemoteID, Excerpt: p.Excerpt, URL: p.URL, PublishedAt: p.PublishedAt, Status: string(p.Availability), ThreadRootID: p.ThreadRootID, ThreadPosition: p.ThreadPosition, IsReply: p.IsReply, Metrics: map[string]float64{}}
		if s := latest[p.RemoteID]; s != nil {
			row.Metrics = deriveMetrics(s.Counters)
			at := s.ObservedAt
			row.ObservedAt = &at
		}
		if q.Scope == "all" || row.IsReply {
			all = append(all, row)
		}
		if !row.PublishedAt.Before(from) && (q.Scope == "all" || row.IsReply) {
			selected = append(selected, row)
		}
	}
	for _, key := range []string{"followers", "impressions", "publishedPosts", "profileClicks", "engagements"} {
		current := metricForPosts(all, key, q.Grouping, from, to, zone)
		previous := metricForPosts(all, key, q.Grouping, previousFrom, from, zone)
		if key == "followers" {
			current = followerMetric(account, from, to, zone, q.Grouping)
			previous = followerMetric(account, previousFrom, from, zone, q.Grouping)
		}
		current.Points = completeIntervals(current.Points, from, to, zone, q.Grouping, key == "publishedPosts")
		current.Previous = previous.Value
		if current.Value != nil && previous.Value != nil && *previous.Value != 0 {
			current.Change = metricNumber((*current.Value - *previous.Value) / math.Abs(*previous.Value) * 100)
		}
		if current.Status != "available" && (result.Status == "unsupported" || result.Status == "forbidden" || result.Status == "failed") {
			current.Status = result.Status
		}
		if current.Value == nil && (key == "followers" && !cap.Account || key != "followers" && !cap.Posts) {
			current.Status = "unsupported"
		}
		result.Metrics[key] = current
	}
	result.Hourly = hourlyCells(selected, zone)
	// Progress is independent of analytics range and uses the goal's own timezone.
	if result.Settings.Goal != nil {
		g := result.Settings.Goal
		goalZone, _ := time.LoadLocation(g.TimeZone)
		if goalZone != nil {
			start, e := time.ParseInLocation("2006-01-02", g.EffectiveDate, goalZone)
			if e == nil {
				qualifying, e := c.client.AnalyticsPost.Query().Where(analyticspost.OrganizationID(connection.OrganizationID), analyticspost.ConnectionID(connection.ID), analyticspost.PublishedAtGTE(start), analyticspost.PublishedAtLTE(time.Now()), analyticspost.IsReply(false), analyticspost.ThreadPosition(0)).All(ctx)
				if e != nil {
					return nil, e
				}
				times := []time.Time{}
				for _, p := range qualifying {
					times = append(times, p.PublishedAt)
				}
				result.Progress = calculateGoal(*g, times, time.Now())
			}
		}
	}
	sort.SliceStable(selected, func(i, j int) bool {
		a, b := selected[i], selected[j]
		if q.Sort == "latest" {
			if !a.PublishedAt.Equal(b.PublishedAt) {
				if q.Direction == "asc" {
					return a.PublishedAt.Before(b.PublishedAt)
				}
				return a.PublishedAt.After(b.PublishedAt)
			}
		} else {
			av, aok := a.Metrics[q.Sort]
			bv, bok := b.Metrics[q.Sort]
			if aok != bok {
				return aok
			}
			if av != bv {
				if q.Direction == "asc" {
					return av < bv
				}
				return av > bv
			}
		}
		return a.ID < b.ID
	})
	result.TotalPosts = len(selected)
	start := 0
	if q.Cursor != "" {
		found := false
		for i, row := range selected {
			if row.ID == q.Cursor {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			return nil, conflict("The result changed. Reload the first page.")
		}
	}
	end := min(len(selected), start+q.Limit)
	result.Posts = selected[start:end]
	if end < len(selected) {
		cursor := selected[end-1].ID
		result.NextCursor = &cursor
	}
	return result, nil
}

func hourlyCells(rows []AnalyticsRow, zone *time.Location) []HourlyCell {
	cells := make([]HourlyCell, 168)
	for i := range cells {
		cells[i] = HourlyCell{Day: i / 24, Hour: i % 24, PostIDs: []string{}}
	}
	for _, row := range rows {
		value, ok := row.Metrics["engagements"]
		if !ok {
			continue
		}
		at := row.PublishedAt.In(zone)
		cell := &cells[int(at.Weekday())*24+at.Hour()]
		cell.Samples++
		cell.Total += value
		cell.PostIDs = append(cell.PostIDs, row.ID)
	}
	for i := range cells {
		if cells[i].Samples > 0 {
			cells[i].Average = metricNumber(cells[i].Total / float64(cells[i].Samples))
		}
	}
	return cells
}

func calculateGoal(goal PostingGoal, posts []time.Time, now time.Time) GoalProgress {
	zone, err := time.LoadLocation(goal.TimeZone)
	if err != nil {
		return GoalProgress{}
	}
	today := now.In(zone)
	day := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, zone)
	period := func(t time.Time) string {
		if goal.Cadence == "weekly" {
			return bucket(t, zone, "weekly")
		}
		return t.In(zone).Format("2006-01-02")
	}
	counts := map[string]int{}
	for _, at := range posts {
		local := at.In(zone)
		if local.Format("2006-01-02") < goal.EffectiveDate || at.After(now) {
			continue
		}
		if goal.ExcludeWeekends && (local.Weekday() == time.Saturday || local.Weekday() == time.Sunday) {
			continue
		}
		counts[period(at)]++
	}
	result := GoalProgress{Required: 1, Period: period(day), Current: counts[period(day)]}
	if goal.Cadence == "weekly" {
		day = day.AddDate(0, 0, -(int(day.Weekday())+6)%7)
	}
	for n := 0; n < 3660; n++ {
		key := period(day)
		if day.Format("2006-01-02") < goal.EffectiveDate && key != period(mustDate(goal.EffectiveDate, zone)) {
			break
		}
		excluded := goal.Cadence == "daily" && goal.ExcludeWeekends && (day.Weekday() == time.Saturday || day.Weekday() == time.Sunday)
		if !excluded {
			if counts[key] > 0 {
				result.Streak++
			} else if n > 0 {
				break
			}
		}
		step := -1
		if goal.Cadence == "weekly" {
			step = -7
		}
		day = day.AddDate(0, 0, step)
	}
	return result
}
func mustDate(value string, zone *time.Location) time.Time {
	at, _ := time.ParseInLocation("2006-01-02", value, zone)
	return at
}

// GetPublicAnalytics checks revocation on every request; callers must send no-store.
func (c *Configuration) GetPublicAnalytics(ctx context.Context, token string, q AnalyticsQuery) (*AnalyticsReport, error) {
	if len(token) != 32 {
		return nil, publishing.ErrNotFound
	}
	state, err := c.client.AnalyticsAccount.Query().Where(analyticsaccount.PublicToken(token)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	connection, err := c.client.ChannelConnection.Get(ctx, state.ID)
	if err != nil {
		return nil, err
	}
	if err = c.requireWorkspaceFeature(ctx, connection.OrganizationID, contentDraftFeature); err != nil {
		return nil, publishing.ErrNotFound
	}
	if connection.Status != channelconnection.StatusACTIVE {
		return nil, publishing.ErrNotFound
	}
	// Public cursors use provider IDs; only this service maps them to internal IDs.
	if q.Cursor != "" {
		p, e := c.client.AnalyticsPost.Query().Where(analyticspost.ConnectionID(connection.ID), analyticspost.OrganizationID(connection.OrganizationID), analyticspost.RemoteID(q.Cursor)).Only(ctx)
		if e != nil {
			return nil, publishing.ErrNotFound
		}
		q.Cursor = p.ID
	}
	report, err := c.analyticsReport(ctx, connection, q)
	if err != nil {
		return nil, err
	}
	report.AccountID = ""
	report.Settings = AnalyticsSettings{}
	report.Hourly = []HourlyCell{}
	report.Progress = GoalProgress{}
	for i := range report.Posts {
		report.Posts[i].ID = report.Posts[i].RemoteID
	}
	if report.NextCursor != nil && len(report.Posts) > 0 {
		cursor := report.Posts[len(report.Posts)-1].RemoteID
		report.NextCursor = &cursor
	}
	report.Query.Cursor = ""
	return report, nil
}

// completeIntervals keeps unavailable days explicit, so growth never bridges a missing interval.
func completeIntervals(points []AnalyticsPoint, from, to time.Time, zone *time.Location, grouping string, knownZero bool) []AnalyticsPoint {
	byDate := map[string]AnalyticsPoint{}
	for _, point := range points {
		byDate[point.At] = point
	}
	out := []AnalyticsPoint{}
	previous := ""
	for day := from; day.Before(to); day = day.AddDate(0, 0, 1) {
		key := bucket(day, zone, grouping)
		if key == previous {
			continue
		}
		previous = key
		point, ok := byDate[key]
		if !ok {
			point = AnalyticsPoint{At: key}
			if knownZero {
				point.Value = metricNumber(0)
			}
		}
		out = append(out, point)
	}
	return out
}

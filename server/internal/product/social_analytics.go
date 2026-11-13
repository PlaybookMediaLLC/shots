package product

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	observation "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformsocialobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacedeletion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
)

// AccountMetricsReader reads provider-defined, dated account series.
type AccountMetricsReader interface {
	AccountMetrics(context.Context, string, string, string, string) ([]schema.SocialMetricSeries, error)
}

// SocialObservation is an attributed provider observation. Absent metrics are
// unknown; account series retain their own provider dates and metric names.
type SocialObservation struct {
	DraftID      string                      `json:"draftId,omitempty"`
	Caption      string                      `json:"caption,omitempty"`
	Title        string                      `json:"title,omitempty"`
	URL          *string                     `json:"url,omitempty"`
	ID           string                      `json:"id"`
	ConnectionID string                      `json:"connectionId"`
	SubjectID    string                      `json:"subjectId"`
	Kind         string                      `json:"kind"`
	Platform     string                      `json:"platform"`
	ObservedAt   time.Time                   `json:"observedAt"`
	Metrics      postoptions.Metrics         `json:"metrics"`
	Series       []schema.SocialMetricSeries `json:"series"`
	Status       string                      `json:"status"`
}

// ListSocialObservations reads at most a year for one visible set. A hard
// limit refuses oversized reports instead of silently truncating totals.
func (c *Configuration) ListSocialObservations(ctx context.Context, actor Actor, setID string, from, to time.Time) ([]SocialObservation, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if _, err := visibleSocialSet(ctx, c.client, actor, setID); err != nil {
		return nil, err
	}
	if !to.After(from) || to.Sub(from) > 366*24*time.Hour {
		return nil, invalid("Select a range of at most 366 days.")
	}
	connections, err := c.client.ChannelConnection.Query().Where(channelconnection.OrganizationID(actor.OrganizationID), channelconnection.SocialSetID(setID)).IDs(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := c.client.PlatformSocialObservation.Query().Where(observation.ConnectionIDIn(connections...), observation.OrganizationID(actor.OrganizationID), observation.SocialSetID(setID), observation.ObservedAtGTE(from), observation.ObservedAtLT(to)).Order(ent.Asc(observation.FieldObservedAt), ent.Asc(observation.FieldID)).Limit(10001).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(rows) > 10000 {
		return nil, invalid("Narrow the analytics date range.")
	}
	subjects := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.Kind == observation.KindPost {
			subjects = append(subjects, row.SubjectID)
		}
	}
	posts, err := c.client.ScheduledPost.Query().Where(scheduledpost.IDIn(subjects...), scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.SocialSetID(setID)).All(ctx)
	if err != nil {
		return nil, err
	}
	draftIDs := []string{}
	for _, post := range posts {
		if post.ContentDraftID != nil {
			draftIDs = append(draftIDs, *post.ContentDraftID)
		}
	}
	drafts, err := c.client.ContentDraft.Query().Where(contentdraft.IDIn(draftIDs...), contentdraft.OrganizationID(actor.OrganizationID), contentdraft.SocialSetID(setID)).All(ctx)
	if err != nil {
		return nil, err
	}
	draftTitles := map[string]string{}
	for _, draft := range drafts {
		draftTitles[draft.ID] = draft.Title
	}
	metadata := map[string]*ent.ScheduledPost{}
	for _, post := range posts {
		if post.ContentDraftID != nil {
			if _, visible := draftTitles[*post.ContentDraftID]; visible {
				metadata[post.ID] = post
			}
		}
	}
	result := make([]SocialObservation, 0, len(rows))
	for _, row := range rows {
		metrics := row.Metrics
		if metrics == nil {
			metrics = postoptions.Metrics{}
		}
		series := row.Series
		if series == nil {
			series = []schema.SocialMetricSeries{}
		}
		item := SocialObservation{ID: row.ID, ConnectionID: row.ConnectionID, SubjectID: row.SubjectID, Kind: string(row.Kind), Platform: row.Platform, ObservedAt: row.ObservedAt, Metrics: metrics, Series: series, Status: string(row.Status)}
		if row.ExternalPost != nil && row.Kind == observation.KindPost {
			item.Caption = row.ExternalPost.Caption
			item.Title = "Published outside Shots"
			item.URL = &row.ExternalPost.URL
		}
		if post := metadata[row.SubjectID]; post != nil {
			item.DraftID = *post.ContentDraftID
			item.Title = draftTitles[*post.ContentDraftID]
			item.Caption = post.Caption
			item.URL = postoptions.LivePostURL(row.Platform, post.RemotePostID)
		}
		result = append(result, item)
	}
	return result, nil
}

func validMetrics(metrics postoptions.Metrics) bool {
	for _, v := range metrics {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return false
		}
	}
	return true
}

func observationID(org, kind, subject string, at time.Time) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(org+"/"+kind+"/"+subject+"/"+at.UTC().Format("2006-01-02"))))
}

func saveSocialObservation(ctx context.Context, client *ent.Client, connection *ent.ChannelConnection, kind, subject string, at time.Time, metrics postoptions.Metrics, series []schema.SocialMetricSeries, readErr error, external ...*postoptions.ObservedPost) error {
	if connection.SocialSetID == nil {
		return nil
	}
	status := observation.StatusAvailable
	if readErr != nil {
		status = observation.StatusFailed
		metrics = nil
		series = nil
	}
	if errors.Is(readErr, postoptions.ErrMetricsUnavailable) || (readErr == nil && kind != "feed" && len(metrics) == 0 && len(series) == 0) {
		status = observation.StatusUnavailable
	}
	if !validMetrics(metrics) {
		return invalid("Provider returned invalid metrics.")
	}
	tx, err := client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	metricJSON, err := json.Marshal(metrics)
	if err != nil {
		return err
	}
	seriesJSON, err := json.Marshal(series)
	if err != nil {
		return err
	}
	var detail *postoptions.ObservedPost
	if len(external) > 0 {
		detail = external[0]
	}
	detailJSON, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	id := observationID(connection.OrganizationID, kind, subject, at)
	result, err := tx.PlatformExec(ctx, `INSERT INTO platform_social_observation
 (id,"organizationId","socialSetId","connectionId","subjectId",kind,platform,day,"observedAt",metrics,series,status,"externalPost")
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb)
 ON CONFLICT (id) DO UPDATE SET "observedAt"=EXCLUDED."observedAt",metrics=EXCLUDED.metrics,series=EXCLUDED.series,status=EXCLUDED.status,"externalPost"=EXCLUDED."externalPost"
 WHERE platform_social_observation."observedAt" <= EXCLUDED."observedAt"`,
		id, connection.OrganizationID, *connection.SocialSetID, connection.ID, subject, kind, connection.Platform, at.UTC().Truncate(24*time.Hour), at, string(metricJSON), string(seriesJSON), status, string(detailJSON))
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed > 0 && kind == "post" && status == observation.StatusAvailable && len(metrics) > 0 {
		_, err = tx.ScheduledPost.Update().Where(scheduledpost.ID(subject), scheduledpost.OrganizationID(connection.OrganizationID), scheduledpost.Or(scheduledpost.MetricsAtIsNil(), scheduledpost.MetricsAtLTE(at))).SetMetrics(metrics).SetMetricsAt(at).Save(ctx)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// CollectSocialAnalytics is called by the existing, serialized maintenance job.
// It drains bounded batches hourly, collecting once per UTC day. Failed reads
// retry on the next hour; unavailable reads remain distinct from zero metrics.
func (c *Configuration) CollectSocialAnalytics(ctx context.Context) (int, error) {
	if c.postMetrics == nil {
		return 0, nil
	}
	now := time.Now().UTC()
	count := 0
	eligible := func(connection *ent.ChannelConnection) bool {
		if connection.SocialSetID == nil || connection.Status != channelconnection.StatusACTIVE {
			return false
		}
		if c.requireWorkspaceFeature(ctx, connection.OrganizationID, contentDraftFeature) != nil {
			return false
		}
		deleting, err := c.client.WorkspaceDeletion.Query().Where(workspacedeletion.OrganizationID(connection.OrganizationID), workspacedeletion.StatusNEQ(workspacedeletion.StatusCANCELLED)).Exist(ctx)
		return err == nil && !deleting
	}
	due := func(org, kind, id string) (bool, error) {
		row, err := c.client.PlatformSocialObservation.Get(ctx, observationID(org, kind, id, now))
		if ent.IsNotFound(err) {
			return true, nil
		}
		if err != nil {
			return false, err
		}
		return row.Status == observation.StatusFailed && now.Sub(row.ObservedAt) >= time.Hour, nil
	}
	for after := ""; count < 25; {
		posts, err := c.client.ScheduledPost.Query().Where(scheduledpost.IDGT(after), scheduledpost.StatusEQ(scheduledpost.StatusPUBLISHED), scheduledpost.ContentDraftIDNotNil(), scheduledpost.RemotePostIDNotNil(), scheduledpost.DeletedAtIsNil(), scheduledpost.PublishedAtGTE(now.AddDate(0, 0, -30))).WithChannelConnection().Order(ent.Asc(scheduledpost.FieldID)).Limit(100).All(ctx)
		if err != nil {
			return count, err
		}
		if len(posts) == 0 {
			break
		}
		for _, post := range posts {
			after = post.ID
			connection := post.Edges.ChannelConnection
			if !eligible(connection) {
				continue
			}
			ready, err := due(post.OrganizationID, "post", post.ID)
			if err != nil {
				return count, err
			}
			if !ready {
				continue
			}
			readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			metrics, readErr := c.postMetrics.PostMetrics(readCtx, post.OrganizationID, connection.ExternalAccountID, connection.Platform, connection.SecretReference, *post.RemotePostID)
			cancel()
			if readErr == nil && !validMetrics(metrics) {
				readErr = errors.New("invalid metrics")
			}
			if err := saveSocialObservation(ctx, c.client, connection, "post", post.ID, time.Now().UTC(), metrics, nil, readErr); err != nil {
				return count, err
			}
			count++
			if count >= 25 {
				break
			}
		}
	}
	reader, ok := c.postMetrics.(AccountMetricsReader)
	if !ok {
		return count, nil
	}
	accountCount, feedCount := 0, 0
	for after := ""; accountCount < 25; {
		connections, err := c.client.ChannelConnection.Query().Where(channelconnection.IDGT(after), channelconnection.StatusEQ(channelconnection.StatusACTIVE), channelconnection.SocialSetIDNotNil()).Order(ent.Asc(channelconnection.FieldID)).Limit(100).All(ctx)
		if err != nil {
			return count, err
		}
		if len(connections) == 0 {
			break
		}
		for _, connection := range connections {
			after = connection.ID
			if !eligible(connection) {
				continue
			}
			if feed, ok := c.postMetrics.(RecentPostMetricsReader); ok && feedCount < 25 {
				ready, err := due(connection.OrganizationID, "feed", connection.ID)
				if err != nil {
					return count, err
				}
				if ready {
					feedCount++
					if err := c.collectObservedPosts(ctx, connection, feed); err != nil {
						return count, err
					}
				}
			}
			ready, err := due(connection.OrganizationID, "account", connection.ID)
			if err != nil {
				return count, err
			}
			if !ready {
				continue
			}
			readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			series, readErr := reader.AccountMetrics(readCtx, connection.OrganizationID, connection.ExternalAccountID, connection.Platform, connection.SecretReference)
			cancel()
			if err := saveSocialObservation(ctx, c.client, connection, "account", connection.ID, time.Now().UTC(), nil, series, readErr); err != nil {
				return count, err
			}
			count++
			accountCount++
			if accountCount >= 25 {
				break
			}
		}
	}
	return count, nil
}

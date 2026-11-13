package product

import (
	"context"
	"entgo.io/ent/dialect/sql"
	"errors"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"log/slog"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticsaccount"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticspost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticssnapshot"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/publicationattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/lucsky/cuid"
)

// RefreshAnalytics is a rate-bounded read from the provider. Publishing permission is
// required because these calls consume provider quota. It never creates publishing jobs.
func (c *Configuration) RefreshAnalytics(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeDecision(ctx, actor, "owner", "admin", "publisher"); err != nil {
		return err
	}
	connection, err := c.analyticsConnection(ctx, actor, id)
	if err != nil {
		return err
	}
	return c.collectAnalytics(ctx, connection, false)
}

// CollectDueAnalytics is run by the existing Temporal maintenance worker. A database
// lease bounds concurrency across replicas, retries, and manual refreshes.
func (c *Configuration) CollectDueAnalytics(ctx context.Context) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	if c.analytics == nil || c.postMetrics == nil {
		return 0, nil
	}
	connections, err := c.client.ChannelConnection.Query().Where(channelconnection.StatusEQ(channelconnection.StatusACTIVE), channelconnection.Provider("social"), func(s *sql.Selector) {
		a := sql.Table(analyticsaccount.Table)
		s.Where(sql.Or(sql.NotIn(s.C(channelconnection.FieldID), sql.Select(a.C(analyticsaccount.FieldID)).From(a)), sql.In(s.C(channelconnection.FieldID), sql.Select(a.C(analyticsaccount.FieldID)).From(a).Where(sql.LTE(a.C(analyticsaccount.FieldNextCheckAt), time.Now())))))
	}).Order(ent.Asc(channelconnection.FieldID)).Limit(100).All(ctx)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, connection := range connections {
		if ctx.Err() != nil {
			return count, ctx.Err()
		}
		if count >= 20 {
			break
		}
		if err = c.requireWorkspaceFeature(ctx, connection.OrganizationID, contentDraftFeature); err != nil {
			// Defer ineligible connections so a stable ordered batch cannot starve paid workspaces.
			if _, e := c.analyticsState(ctx, connection); e == nil {
				_, _ = c.client.AnalyticsAccount.UpdateOneID(connection.ID).SetNextCheckAt(time.Now().Add(24 * time.Hour)).Save(ctx)
			}
			continue
		}
		state, e := c.analyticsState(ctx, connection)
		if e != nil {
			return count, e
		}
		if state.NextCheckAt.After(time.Now()) {
			continue
		}
		if e = c.collectAnalytics(ctx, connection, true); e != nil {
			slog.Warn("analytics collection deferred", "connectionId", connection.ID)
		}
		count++
	}
	return count, nil
}
func (c *Configuration) collectAnalytics(ctx context.Context, connection *ent.ChannelConnection, automatic bool) (resultErr error) {
	if c.analytics == nil || c.postMetrics == nil {
		return conflict("Analytics collection is unavailable on this server.")
	}
	if connection.Status != channelconnection.StatusACTIVE {
		return conflict("Reconnect this account before refreshing analytics.")
	}
	state, err := c.analyticsState(ctx, connection)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if !automatic && state.CheckedAt != nil && now.Sub(*state.CheckedAt) < time.Minute {
		return conflict("This account was refreshed recently. Try again in a minute.")
	}
	changed, err := c.client.AnalyticsAccount.Update().Where(analyticsaccount.ID(connection.ID), analyticsaccount.Or(analyticsaccount.LeaseUntilIsNil(), analyticsaccount.LeaseUntilLT(now))).SetLeaseUntil(now.Add(8 * time.Minute)).Save(ctx)
	if err != nil {
		return err
	}
	if changed != 1 {
		return conflict("Analytics is already refreshing.")
	}
	defer func() {
		release, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer stop()
		update := c.client.AnalyticsAccount.Update().Where(analyticsaccount.ID(connection.ID), analyticsaccount.LeaseUntilEQ(now.Add(8*time.Minute))).ClearLeaseUntil()
		if resultErr != nil {
			update.SetAvailability(analyticsaccount.AvailabilityFailed).SetCheckedAt(now).SetNextCheckAt(now.Add(time.Hour))
		}
		_, _ = update.Save(release)
	}()
	budget := 7 * time.Minute
	if !automatic {
		budget = 25 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	cap := c.analytics.AnalyticsCapabilities(connection.Platform)
	status := analyticsaccount.AvailabilityAvailable
	next := now.Add(45 * time.Minute)
	stopped := false
	recordError := func(e error) string {
		availability, retry, halt := analyticsFailure(e, now)
		if retry.After(next) {
			next = retry
		}
		if halt {
			stopped = true
		}
		if availability == "forbidden" {
			status = analyticsaccount.AvailabilityForbidden
		} else {
			status = analyticsaccount.AvailabilityFailed
		}
		return availability
	}
	if !cap.Account && !cap.Posts {
		status = analyticsaccount.AvailabilityUnsupported
		next = now.Add(24 * time.Hour)
	}
	if err = c.importCanonicalAnalyticsPosts(ctx, connection); err != nil {
		return err
	}
	if cap.Account {
		observations, e := c.analytics.AccountObservations(ctx, connection.OrganizationID, connection.ExternalAccountID, connection.Platform, connection.SecretReference)
		if e != nil {
			recordError(e)
		} else {
			for _, o := range observations {
				if err = c.RecordAnalyticsSnapshot(ctx, connection.OrganizationID, connection.ID, "account", connection.ID, o.At, time.Now().UTC(), o.Counters, 0); err != nil {
					return err
				}
			}
		}
	}
	if cap.Import && !stopped {
		imported, e := c.analytics.ImportAnalyticsPosts(ctx, connection.OrganizationID, connection.ExternalAccountID, connection.Platform, connection.SecretReference, now.AddDate(0, 0, -30))
		if e != nil {
			recordError(e)
		} else {
			for _, post := range imported {
				if post.ID == "" || post.At.IsZero() || post.At.After(now) {
					continue
				}
				row, e := c.importAnalyticsPost(ctx, connection, post, nil)
				if e != nil {
					return e
				}
				if len(post.Counters) > 0 {
					if e = c.recordImportedObservation(ctx, connection, row, post.Counters, time.Now().UTC()); e != nil {
						return e
					}
				}
			}
		}
	}
	if cap.Posts && !stopped {
		posts, e := c.client.AnalyticsPost.Query().Where(analyticspost.OrganizationID(connection.OrganizationID), analyticspost.ConnectionID(connection.ID), analyticspost.NextCheckAtLTE(time.Now()), analyticspost.AvailabilityNEQ(analyticspost.AvailabilityDeleted), analyticspost.PublishedAtGTE(now.AddDate(0, 0, -30))).Order(ent.Asc(analyticspost.FieldNextCheckAt)).Limit(100).All(ctx)
		if e != nil {
			return e
		}
		for _, post := range posts {
			metrics, e := c.postMetrics.PostMetrics(ctx, connection.OrganizationID, connection.ExternalAccountID, connection.Platform, connection.SecretReference, post.RemoteID)
			if e != nil {
				availability, retry, _ := analyticsFailure(e, now)
				// A missing post is terminal for that post, not a failure of the
				// account's follower, discovery, or other post collection.
				if availability != "deleted" {
					recordError(e)
				}
				_, _ = c.client.AnalyticsPost.UpdateOneID(post.ID).SetAvailability(analyticspost.Availability(availability)).SetNextCheckAt(retry).Save(ctx)
				if stopped {
					break
				}
				continue
			}
			if e = c.recordPostObservation(ctx, connection, post, metrics, time.Now().UTC()); e != nil {
				return e
			}
		}
	}
	active, err := c.client.ChannelConnection.Query().Where(channelconnection.ID(connection.ID), channelconnection.OrganizationID(connection.OrganizationID), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Exist(ctx)
	if err != nil {
		return err
	}
	if !active {
		status = analyticsaccount.AvailabilityForbidden
	}
	_, err = c.client.AnalyticsAccount.UpdateOneID(connection.ID).SetAvailability(status).SetCheckedAt(now).SetNextCheckAt(next).Save(ctx)
	slog.Info("analytics collection completed", "connectionId", connection.ID, "status", status)
	return err
}
func (c *Configuration) recordPostObservation(ctx context.Context, connection *ent.ChannelConnection, post *ent.AnalyticsPost, metrics postoptions.Metrics, now time.Time) error {
	latest, err := c.client.AnalyticsSnapshot.Query().Where(analyticssnapshot.OrganizationID(connection.OrganizationID), analyticssnapshot.ConnectionID(connection.ID), analyticssnapshot.KindEQ(analyticssnapshot.KindPost), analyticssnapshot.SubjectID(post.RemoteID)).Order(ent.Desc(analyticssnapshot.FieldObservedAt)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	// An unchanged counter bundle does not invent another historical measurement.
	if latest == nil || !sameJSON(latest.Counters, metrics) {
		if err = c.RecordAnalyticsSnapshot(ctx, connection.OrganizationID, connection.ID, "post", post.RemoteID, now, time.Now().UTC(), metrics, int(now.Sub(post.PublishedAt).Minutes())); err != nil {
			return err
		}
	}
	availability := analyticspost.AvailabilityAvailable
	if len(metrics) == 0 {
		availability = analyticspost.AvailabilityInsufficient
	}
	_, err = c.client.AnalyticsPost.UpdateOneID(post.ID).SetCheckedAt(now).SetNextCheckAt(now.Add(analyticsPollInterval(now.Sub(post.PublishedAt)))).SetAvailability(availability).Save(ctx)
	return err
}

// Timeline counters can lack private clicks. They must not postpone a richer per-post poll.
func (c *Configuration) recordImportedObservation(ctx context.Context, connection *ent.ChannelConnection, post *ent.AnalyticsPost, metrics postoptions.Metrics, now time.Time) error {
	// A partial timeline response must not replace a richer existing post observation.
	if post.CheckedAt != nil {
		return nil
	}
	return c.RecordAnalyticsSnapshot(ctx, connection.OrganizationID, connection.ID, "post", post.RemoteID, now, time.Now().UTC(), metrics, int(now.Sub(post.PublishedAt).Minutes()))
}

func analyticsPollInterval(age time.Duration) time.Duration {
	switch {
	case age < 2*time.Hour:
		return 15 * time.Minute
	case age < 24*time.Hour:
		return time.Hour
	case age < 7*24*time.Hour:
		return 6 * time.Hour
	default:
		return 24 * time.Hour
	}
}

func (c *Configuration) importAnalyticsPost(ctx context.Context, connection *ent.ChannelConnection, post ImportedAnalyticsPost, source *string) (*ent.AnalyticsPost, error) {
	row, err := c.client.AnalyticsPost.Query().Where(analyticspost.ConnectionID(connection.ID), analyticspost.RemoteID(post.ID), analyticspost.OrganizationID(connection.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if row != nil {
		update := c.client.AnalyticsPost.UpdateOneID(row.ID)
		if post.Text != "" {
			update.SetExcerpt(post.Text)
		}
		if post.URL != "" {
			update.SetURL(post.URL)
		}
		if post.ThreadRootID != "" {
			update.SetThreadRootID(post.ThreadRootID)
		}
		if post.IsReply {
			update.SetIsReply(true)
		}
		if post.Position != 0 && (source != nil || row.ThreadPosition == 0) {
			update.SetThreadPosition(post.Position)
		}
		if source != nil && row.ScheduledPostID == nil {
			update.SetScheduledPostID(*source)
		}
		return update.Save(ctx)
	}
	create := c.client.AnalyticsPost.Create().SetID(cuid.New()).SetOrganizationID(connection.OrganizationID).SetConnectionID(connection.ID).SetRemoteID(post.ID).SetExcerpt(post.Text).SetURL(post.URL).SetPublishedAt(post.At.UTC()).SetIsReply(post.IsReply).SetThreadPosition(post.Position).SetNillableScheduledPostID(source)
	if post.ThreadRootID != "" {
		create.SetThreadRootID(post.ThreadRootID)
	}
	row, err = create.Save(ctx)
	if ent.IsConstraintError(err) {
		return c.client.AnalyticsPost.Query().Where(analyticspost.ConnectionID(connection.ID), analyticspost.RemoteID(post.ID)).Only(ctx)
	}
	return row, err
}
func (c *Configuration) importCanonicalAnalyticsPosts(ctx context.Context, connection *ent.ChannelConnection) error {
	posts, err := c.client.ScheduledPost.Query().Where(scheduledpost.OrganizationID(connection.OrganizationID), scheduledpost.ChannelConnectionID(connection.ID), scheduledpost.RemotePostIDNEQ(""), scheduledpost.StatusIn(scheduledpost.StatusPUBLISHED, scheduledpost.StatusFAILED), func(s *sql.Selector) {
		// A post needs a date: its publisher's receipt, or the moment a person
		// confirmed it live. Rows with neither are excluded before the limit so
		// they cannot starve importable posts.
		r := sql.Table(publicationattempt.Table)
		s.Where(sql.Or(sql.NotNull(s.C(scheduledpost.FieldPublishedAt)), sql.Exists(sql.Select(r.C(publicationattempt.FieldID)).From(r).Where(sql.And(
			sql.ColumnsEQ(r.C(publicationattempt.FieldScheduledPostID), s.C(scheduledpost.FieldID)),
			sql.ColumnsEQ(r.C(publicationattempt.FieldOrganizationID), s.C(scheduledpost.FieldOrganizationID)),
			sql.ColumnsEQ(r.C(publicationattempt.FieldProviderPostID), s.C(scheduledpost.FieldRemotePostID)),
			sql.NotNull(r.C(publicationattempt.FieldCompletedAt)),
		)))))
		// A story has no per-post insights Shots reads, and they vanish after a
		// day: importing one would fail its reads and mark the account failed.
		s.Where(sql.ExprP("coalesce(" + s.C(scheduledpost.FieldPublishOptions) + "->'instagram'->>'placement', '') <> 'story'"))
		a := sql.Table(analyticspost.Table)
		s.Where(sql.NotExists(sql.Select(a.C(analyticspost.FieldID)).From(a).Where(sql.And(
			sql.ColumnsEQ(a.C(analyticspost.FieldConnectionID), s.C(scheduledpost.FieldChannelConnectionID)),
			sql.ColumnsEQ(a.C(analyticspost.FieldRemoteID), s.C(scheduledpost.FieldRemotePostID)),
			sql.ColumnsGTE(a.C(analyticspost.FieldCanonicalUpdatedAt), s.C(scheduledpost.FieldUpdatedAt)),
		))))
	}).Order(ent.Asc(scheduledpost.FieldUpdatedAt), ent.Asc(scheduledpost.FieldID)).Limit(200).WithAttempts().All(ctx)
	if err != nil {
		return err
	}
	for _, post := range posts {
		if post.RemotePostID == nil || *post.RemotePostID == "" {
			continue
		}
		// Receipt completion is the confirmed timestamp available from the publisher,
		// then the moment a person confirmed it live; never use the planned/scheduled
		// date as proof of publication.
		var at *time.Time
		for _, a := range post.Edges.Attempts {
			if a.ProviderPostID != nil && *a.ProviderPostID == *post.RemotePostID && a.CompletedAt != nil && (at == nil || a.CompletedAt.Before(*at)) {
				at = a.CompletedAt
			}
		}
		if at == nil {
			at = post.PublishedAt
		}
		if at == nil {
			continue
		}
		url := ""
		if u := livePostURL(connection.Platform, post.RemotePostID); u != nil {
			url = *u
		}
		remote := ImportedAnalyticsPost{ID: *post.RemotePostID, Text: post.Caption, URL: url, At: *at, IsReply: post.ReplyTo != nil}
		if post.ReplyTo != nil {
			remote.ThreadRootID = *post.ReplyTo
		}
		if len(post.Replies) > 0 {
			remote.ThreadRootID = *post.RemotePostID
		}
		row, e := c.importAnalyticsPost(ctx, connection, remote, &post.ID)
		if e != nil {
			return e
		}
		for _, receipt := range post.ThreadProgress.Receipts {
			if receipt.RemoteID == "" || receipt.PublishedAt.IsZero() || receipt.Position < 1 || receipt.Position > len(post.Replies) {
				continue
			}
			reply := ImportedAnalyticsPost{ID: receipt.RemoteID, Text: post.Replies[receipt.Position-1].Caption, At: receipt.PublishedAt, IsReply: true, Position: receipt.Position, ThreadRootID: *post.RemotePostID}
			if link := livePostURL(connection.Platform, &receipt.RemoteID); link != nil {
				reply.URL = *link
			}
			if _, e := c.importAnalyticsPost(ctx, connection, reply, &post.ID); e != nil {
				return e
			}
		}
		if post.MetricsAt != nil && len(post.Metrics) > 0 {
			if e = c.RecordAnalyticsSnapshot(ctx, connection.OrganizationID, connection.ID, "post", row.RemoteID, *post.MetricsAt, time.Now().UTC(), post.Metrics, int(post.MetricsAt.Sub(*at).Minutes())); e != nil {
				return e
			}
		}
		if _, e := c.client.AnalyticsPost.UpdateOneID(row.ID).SetCanonicalUpdatedAt(post.UpdatedAt).Save(ctx); e != nil {
			return e
		}
	}
	return nil
}

// analyticsFailure classifies only typed provider statuses; error prose never becomes a decision.
func analyticsFailure(err error, now time.Time) (string, time.Time, bool) {
	status := 0
	var typed interface{ HTTPStatus() int }
	if errors.As(err, &typed) {
		status = typed.HTTPStatus()
	}
	var remote *socialapi.Error
	if errors.As(err, &remote) {
		status = remote.Status
	}
	switch status {
	case 401, 403:
		return "forbidden", now.Add(24 * time.Hour), true
	case 404, 410:
		return "deleted", now.Add(30 * 24 * time.Hour), false
	case 420, 429:
		retry := now.Add(15 * time.Minute)
		var reset interface{ RetryAt() time.Time }
		if errors.As(err, &reset) && reset.RetryAt().After(retry) {
			retry = reset.RetryAt()
		}
		if retry.After(now.Add(24 * time.Hour)) {
			retry = now.Add(24 * time.Hour)
		}
		return "failed", retry, true
	default:
		return "failed", now.Add(time.Hour), false
	}
}

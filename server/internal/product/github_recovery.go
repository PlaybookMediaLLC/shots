package product

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubdeliveryrecovery"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubrecoveryscan"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/lucsky/cuid"
)

type GitHubRecoveryReader interface {
	Deliveries(context.Context, string) (githubapp.DeliveryPage, error)
	Redeliver(context.Context, string) error
}
type GitHubRecoveryDelivery struct {
	ID            string     `json:"id"`
	GUID          string     `json:"guid"`
	EventName     string     `json:"eventName"`
	Status        string     `json:"status"`
	Attempts      int        `json:"attempts"`
	DeliveredAt   time.Time  `json:"deliveredAt"`
	NextAttemptAt *time.Time `json:"nextAttemptAt"`
}
type GitHubRecoveryStatus struct {
	Status         string                   `json:"status"`
	Reason         string                   `json:"reason"`
	Gap            bool                     `json:"gap"`
	HasMore        bool                     `json:"hasMore"`
	WindowStart    *time.Time               `json:"windowStart"`
	LastCompleteAt *time.Time               `json:"lastCompleteAt"`
	NextAttemptAt  *time.Time               `json:"nextAttemptAt"`
	Deliveries     []GitHubRecoveryDelivery `json:"deliveries"`
}

func (c *Configuration) GetGitHubRecovery(ctx context.Context, actor Actor, sourceID string) (*GitHubRecoveryStatus, error) {
	source, err := c.productionSource(ctx, actor, sourceID)
	if err != nil {
		return nil, err
	}
	result := &GitHubRecoveryStatus{Status: "unknown", Reason: "Not checked yet. A missing event does not prove that nothing was deployed.", Gap: true, Deliveries: []GitHubRecoveryDelivery{}}
	scan, err := c.client.GitHubRecoveryScan.Query().Where(githubrecoveryscan.OrganizationID(actor.OrganizationID), githubrecoveryscan.SourceAppID(sourceID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if scan != nil {
		result.Status, result.Reason, result.Gap, result.HasMore, result.WindowStart, result.LastCompleteAt, result.NextAttemptAt = scan.Status, scan.Reason, scan.Gap, scan.Cursor != "", scan.WindowStart, scan.LastCompleteAt, scan.NextAttemptAt
	}
	if source.GithubInstallationID == nil || source.ExternalID == nil {
		return result, nil
	}
	installation, err := c.client.GitHubInstallation.Get(ctx, *source.GithubInstallationID)
	if err != nil {
		return nil, err
	}
	rows, err := c.client.GitHubDeliveryRecovery.Query().Where(githubdeliveryrecovery.InstallationID(installation.InstallationID), githubdeliveryrecovery.RepositoryID(*source.ExternalID)).Order(ent.Desc(githubdeliveryrecovery.FieldDeliveredAt)).Limit(50).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		result.Deliveries = append(result.Deliveries, GitHubRecoveryDelivery{r.ID, r.GUID, r.EventName, r.Status, r.Attempts, r.DeliveredAt, r.NextAttemptAt})
	}
	return result, nil
}

// InspectGitHubRecovery processes one provider page per invocation. It can be
// called repeatedly by an administrator; durable leases, cursors,
// attempt limits and exponential backoff survive restarts. Redelivery is opt-in.
func (c *Configuration) InspectGitHubRecovery(ctx context.Context, actor Actor, sourceID string, redeliver bool) (*GitHubRecoveryStatus, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	source, err := c.productionSource(ctx, actor, sourceID)
	if err != nil {
		return nil, err
	}
	if err := automationSourceAccess(ctx, c.client, source); err != nil {
		return nil, err
	}
	reader, ok := c.github.(GitHubRecoveryReader)
	if !ok {
		return nil, ErrGitHubUnavailable
	}
	installation, err := c.client.GitHubInstallation.Get(ctx, *source.GithubInstallationID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := lockAutomationSource(ctx, tx, actor.OrganizationID, sourceID); err != nil {
		return nil, err
	}
	scan, err := tx.GitHubRecoveryScan.Query().Where(githubrecoveryscan.OrganizationID(actor.OrganizationID), githubrecoveryscan.SourceAppID(sourceID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if scan == nil {
		scan, err = tx.GitHubRecoveryScan.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetSourceAppID(sourceID).Save(ctx)
		if err != nil {
			return nil, err
		}
	}
	if scan.NextAttemptAt != nil && scan.NextAttemptAt.After(now) {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return c.GetGitHubRecovery(ctx, actor, sourceID)
	}
	if err := scan.Update().SetStatus("scanning").SetNextAttemptAt(now.Add(time.Minute)).Exec(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.github_recovery_requested", "source_app", sourceID, map[string]any{"redeliver": redeliver}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	scan = scan.Unwrap()
	page, readErr := reader.Deliveries(ctx, scan.Cursor)
	if readErr != nil {
		update := scan.Update().SetStatus("failed").SetReason("App delivery inspection failed. Check App credentials, rate limits and webhook configuration; retry after the recorded backoff.").SetGap(true)
		var status githubapp.StatusError
		if scan.Cursor != "" && errors.As(readErr, &status) && (status.Status == 400 || status.Status == 422) {
			update.SetCursor("").SetReason("GitHub rejected an expired delivery cursor. The next inspection restarts the available history window; the intervening gap requires review.")
		}
		if err := update.Exec(ctx); err != nil {
			return nil, err
		}
		return c.GetGitHubRecovery(ctx, actor, sourceID)
	}
	window := now.Add(-72 * time.Hour)
	// Persist every matching failure before any provider redelivery. The GUID
	// suppression marker is global because one delivery fans out to many tenants.
	for _, d := range page.Deliveries {
		if d.InstallationID != installation.InstallationID || strconv.FormatInt(d.RepositoryID, 10) != *source.ExternalID {
			continue
		}
		row, err := c.client.GitHubDeliveryRecovery.Query().Where(githubdeliveryrecovery.GUID(d.GUID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if row == nil {
			if d.StatusCode >= 200 && d.StatusCode < 400 {
				continue
			}
			row, err = c.client.GitHubDeliveryRecovery.Create().SetID(strconv.FormatInt(d.ID, 10)).SetGUID(d.GUID).SetInstallationID(d.InstallationID).SetRepositoryID(strconv.FormatInt(d.RepositoryID, 10)).SetEventName(d.Event).SetDeliveredAt(d.DeliveredAt).SetStatusCode(d.StatusCode).Save(ctx)
			if ent.IsConstraintError(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
		} else if d.DeliveredAt.After(row.DeliveredAt) && d.StatusCode >= 200 && d.StatusCode < 400 {
			if err := row.Update().SetStatus("delivered_for_review").SetStatusCode(d.StatusCode).Exec(ctx); err != nil {
				return nil, err
			}
		}
	}
	if redeliver {
		due, err := c.client.GitHubDeliveryRecovery.Query().Where(githubdeliveryrecovery.InstallationID(installation.InstallationID), githubdeliveryrecovery.RepositoryID(*source.ExternalID), githubdeliveryrecovery.AttemptsLT(3), githubdeliveryrecovery.StatusIn("failed", "redelivery_requested"), githubdeliveryrecovery.Or(githubdeliveryrecovery.NextAttemptAtIsNil(), githubdeliveryrecovery.NextAttemptAtLTE(now))).Order(ent.Asc(githubdeliveryrecovery.FieldDeliveredAt)).Limit(5).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, r := range due {
			if r.DeliveredAt.Before(window) {
				if err := r.Update().SetStatus("history_gap").Exec(ctx); err != nil {
					return nil, err
				}
				continue
			}
			// CAS is the provider-mutation lease. A lost acknowledgement remains
			// review-only and is retried at most three times, never in a tight loop.
			n, err := c.client.GitHubDeliveryRecovery.Update().Where(githubdeliveryrecovery.ID(r.ID), githubdeliveryrecovery.Attempts(r.Attempts)).SetRecovery(true).AddAttempts(1).SetStatus("redelivery_requested").SetNextAttemptAt(now.Add(time.Duration(1<<r.Attempts) * time.Minute)).Save(ctx)
			if err != nil {
				return nil, err
			}
			if n == 0 {
				continue
			}
			if err := reader.Redeliver(ctx, r.ID); err != nil {
				status := "failed"
				if r.Attempts+1 >= 3 {
					status = "exhausted"
				}
				if saveErr := r.Update().SetStatus(status).Exec(ctx); saveErr != nil {
					return nil, saveErr
				}
			}
		}
	}
	update := scan.Update().SetCursor(page.NextCursor).SetWindowStart(window).SetStatus("partial").SetReason("Inspection is paginated. Continue inspection; event history is not yet complete.").SetNextAttemptAt(now.Add(time.Second))
	if page.NextCursor == "" {
		gap := scan.LastCompleteAt == nil || scan.LastCompleteAt.Before(window) || scan.Gap
		reason := "Checked what GitHub still has. Anything GitHub never sent or no longer keeps stays unknown, so compare releases and deployments with whoever owns the repository."
		update.SetStatus("inspected").SetGap(gap).SetLastCompleteAt(now).SetReason(reason).SetNextAttemptAt(now.Add(time.Minute))
	}
	if err := update.Exec(ctx); err != nil {
		return nil, err
	}
	return c.GetGitHubRecovery(ctx, actor, sourceID)
}

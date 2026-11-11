package product

import (
	"context"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/accountdeletionrequest"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacedeletion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Account deletion (RFC 024) is a request, not a switch. A person who still
// owns a workspace must delete it or hand it over first, because a workspace
// without an owner has nobody to pay for it or to administer it. After a grace
// period the maintenance job signs the person out everywhere, removes their
// sign-in methods and memberships, and anonymizes the user row; the row stays
// so audit history keeps a stable actor.

// AccountDeletionGrace is how long a request waits before it is carried out.
const AccountDeletionGrace = 14 * 24 * time.Hour

// freshSessionAge is how recent a sign-in a destructive personal action needs.
const freshSessionAge = 15 * time.Minute

// AccountDeletionBlocker is something that must be resolved first.
type AccountDeletionBlocker struct {
	Code          string `json:"code"`
	Message       string `json:"message"`
	WorkspaceID   string `json:"workspaceId"`
	WorkspaceName string `json:"workspaceName"`
}

// AccountDeletionRecord is a request as the API returns it.
type AccountDeletionRecord struct {
	ExecuteAfter time.Time `json:"executeAfter"`
	ID           string    `json:"id"`
	RequestedAt  time.Time `json:"requestedAt"`
	Status       string    `json:"status"`
}

// AccountDeletionStatus is the open request, if any, and what blocks one.
type AccountDeletionStatus struct {
	Blockers []AccountDeletionBlocker `json:"blockers"`
	Request  *AccountDeletionRecord   `json:"request"`
}

// AccountDeletionBlockedError refuses a request while blockers remain.
type AccountDeletionBlockedError struct{ Blockers []AccountDeletionBlocker }

func (e *AccountDeletionBlockedError) Error() string {
	return "Delete or hand over the workspaces you own before deleting your account."
}

func (e *AccountDeletionBlockedError) Unwrap() error { return publishing.ErrConflict }

func accountDeletionRecord(row *ent.AccountDeletionRequest) *AccountDeletionRecord {
	if row == nil {
		return nil
	}
	return &AccountDeletionRecord{ExecuteAfter: row.ExecuteAfter, ID: row.ID, RequestedAt: row.RequestedAt, Status: string(row.Status)}
}

// accountDeletionBlockers lists the live workspaces the person owns.
func accountDeletionBlockers(ctx context.Context, client *ent.Client, userID string) ([]AccountDeletionBlocker, error) {
	owned, err := client.Member.Query().Where(member.UserID(userID)).All(ctx)
	if err != nil {
		return nil, err
	}
	blockers := []AccountDeletionBlocker{}
	for _, membership := range owned {
		if !strings.Contains(membership.Role, "owner") {
			continue
		}
		workspace, err := client.Organization.Get(ctx, membership.OrganizationID)
		if ent.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		purged, err := client.WorkspaceDeletion.Query().Where(workspacedeletion.OrganizationID(membership.OrganizationID),
			workspacedeletion.StatusIn(workspacedeletion.StatusPURGED, workspacedeletion.StatusPROCESSING)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if purged {
			continue
		}
		blockers = append(blockers, AccountDeletionBlocker{Code: "owns_workspace", WorkspaceID: membership.OrganizationID,
			WorkspaceName: workspace.Name, Message: "You own " + workspace.Name + ". Delete it or make someone else its owner."})
	}
	if err := client.PlatformQuery(ctx, `SELECT workspace_id, workspace_name FROM platform_account_attachment_blockers($1)`, []any{userID}, func(row entsql.ColumnScanner) error {
		blocker := AccountDeletionBlocker{Code: "shared_attachments", Message: "This workspace has shared attachments stored under your account. They must be transferred or removed before your account can be deleted."}
		if err := row.Scan(&blocker.WorkspaceID, &blocker.WorkspaceName); err != nil {
			return err
		}
		blockers = append(blockers, blocker)
		return nil
	}); err != nil {
		return nil, err
	}
	return blockers, nil
}

func (c *Configuration) openAccountDeletion(ctx context.Context, userID string) (*ent.AccountDeletionRequest, error) {
	row, err := c.client.AccountDeletionRequest.Query().Where(accountdeletionrequest.UserID(userID),
		accountdeletionrequest.StatusIn(accountdeletionrequest.StatusREQUESTED, accountdeletionrequest.StatusPROCESSING)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	return row, err
}

// GetAccountDeletion reports the person's open deletion request and blockers.
func (c *Configuration) GetAccountDeletion(ctx context.Context, actor Actor) (*AccountDeletionStatus, error) {
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	blockers, err := accountDeletionBlockers(ctx, c.client, actor.UserID)
	if err != nil {
		return nil, err
	}
	open, err := c.openAccountDeletion(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	return &AccountDeletionStatus{Blockers: blockers, Request: accountDeletionRecord(open)}, nil
}

// RequestAccountDeletion schedules the person's account for deletion. The
// confirmation must be their sign-in email, the session must be fresh, and no
// owned workspace may remain. A repeat returns the open request.
func (c *Configuration) RequestAccountDeletion(ctx context.Context, actor Actor, confirmation string) (*AccountDeletionStatus, error) {
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	user, err := c.client.User.Get(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(strings.TrimSpace(confirmation), user.Email) {
		return nil, invalid("Type your sign-in email to confirm.")
	}
	session, err := c.client.Session.Get(ctx, actor.SessionID)
	if ent.IsNotFound(err) || (err == nil && session.UserID != actor.UserID) {
		return nil, publishing.ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if time.Since(session.CreatedAt) > freshSessionAge {
		return nil, userError{publishing.ErrUnauthorized, "Sign in again to confirm it is you, then request deletion."}
	}
	blockers, err := accountDeletionBlockers(ctx, c.client, actor.UserID)
	if err != nil {
		return nil, err
	}
	if len(blockers) > 0 {
		return nil, &AccountDeletionBlockedError{Blockers: blockers}
	}
	open, err := c.openAccountDeletion(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	if open == nil {
		tx, err := c.client.Tx(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		open, err = tx.AccountDeletionRequest.Create().SetID(cuid.New()).SetUserID(actor.UserID).
			SetExecuteAfter(time.Now().UTC().Add(AccountDeletionGrace)).Save(ctx)
		if ent.IsConstraintError(err) {
			return c.GetAccountDeletion(ctx, actor)
		}
		if err != nil {
			return nil, err
		}
		if err := appendAccountDeletionAudit(ctx, tx, actor, "product.account_deletion_requested", open.ID,
			map[string]any{"executeAfter": open.ExecuteAfter}); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
	}
	return &AccountDeletionStatus{Blockers: []AccountDeletionBlocker{}, Request: accountDeletionRecord(open)}, nil
}

// CancelAccountDeletion withdraws the person's open request.
func (c *Configuration) CancelAccountDeletion(ctx context.Context, actor Actor) (*AccountDeletionStatus, error) {
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	open, err := c.openAccountDeletion(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	if open == nil {
		return nil, notFound("There is no account deletion to cancel.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	count, err := tx.AccountDeletionRequest.Update().Where(accountdeletionrequest.ID(open.ID),
		accountdeletionrequest.StatusEQ(accountdeletionrequest.StatusREQUESTED)).
		SetStatus(accountdeletionrequest.StatusCANCELLED).SetCancelledAt(time.Now().UTC()).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, conflict("Your account deletion changed. Reload and try again.")
	}
	if err := appendAccountDeletionAudit(ctx, tx, actor, "product.account_deletion_cancelled", open.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.GetAccountDeletion(ctx, actor)
}

func appendAccountDeletionAudit(ctx context.Context, tx *ent.Tx, actor Actor, action, requestID string, metadata ...map[string]any) error {
	memberships, err := tx.Member.Query().Where(member.UserID(actor.UserID)).All(ctx)
	if err != nil {
		return err
	}
	// With no memberships, the retained request and its timestamps are the person's audit record.
	for _, membership := range memberships {
		scoped := actor
		scoped.OrganizationID = membership.OrganizationID
		if err := appendConfigurationAudit(ctx, tx, scoped, action, "account_deletion_request", requestID, metadata...); err != nil {
			return err
		}
	}
	return nil
}

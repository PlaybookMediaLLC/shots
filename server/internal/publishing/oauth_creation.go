package publishing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/lucsky/cuid"
)

func oauthOperation(options OAuthStartOptions) socialoauthstart.Operation {
	if options.Operation != "" {
		return socialoauthstart.Operation(options.Operation)
	}
	if options.ExpectedConnectionID != nil {
		return socialoauthstart.OperationRECONNECT
	}
	return socialoauthstart.OperationADD_ACCOUNT
}

// ValidateOAuthStartOptions rejects mixed creation, addition and reconnect targets.
// A missing operation preserves the legacy add/reconnect contract.
func ValidateOAuthStartOptions(options OAuthStartOptions) error {
	switch oauthOperation(options) {
	case socialoauthstart.OperationCREATE_SET:
		if options.SocialSetID != nil || options.ExpectedConnectionID != nil ||
			(options.CreationVisibility != "PRIVATE" && options.CreationVisibility != "WORKSPACE") {
			return ErrConflict
		}
	case socialoauthstart.OperationADD_ACCOUNT:
		if options.CreationVisibility != "" || options.ExpectedConnectionID != nil {
			return ErrConflict
		}
	case socialoauthstart.OperationRECONNECT:
		if options.CreationVisibility != "" || options.SocialSetID == nil || options.ExpectedConnectionID == nil {
			return ErrConflict
		}
	default:
		return ErrConflict
	}
	return nil
}

func authorizeOAuthCreation(ctx context.Context, client *ent.Client, actor Actor) error {
	allowed, err := client.Member.Query().Where(member.OrganizationID(actor.Organization),
		member.UserID(actor.UserID), member.RoleIn("owner", "admin")).Exist(ctx)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrForbidden
	}
	return nil
}

// The caller holds the workspace lock and creates the account and receipt in
// this transaction. A failed or cancelled authorization therefore leaves no set.
func createOAuthSocialSet(ctx context.Context, tx *ent.Tx, actor Actor, start *ent.SocialOAuthStart) (*string, error) {
	zone := "UTC"
	settings, err := tx.WorkspaceSettings.Get(ctx, actor.Organization)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if settings != nil {
		if _, err := time.LoadLocation(settings.TimeZone); settings.TimeZone != "" && err == nil {
			zone = settings.TimeZone
		}
	}
	var slug [12]byte
	if _, err := rand.Read(slug[:]); err != nil {
		return nil, err
	}
	created, err := tx.SocialSet.Create().SetID(cuid.New()).SetOrganizationID(actor.Organization).
		SetName("New profile").SetVisibility(socialset.Visibility(start.CreationVisibility)).
		SetOwnerUserID(start.UserID).SetCreatedByUserID(start.UserID).SetTimeZone(zone).
		SetPostingSlots(schema.DefaultQueueSlots()).SetPublicSlug(hex.EncodeToString(slug[:])).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendAudit(ctx, tx, auditInput{Action: "product.social_set_created", Actor: actor,
		EntityID: created.ID, EntityType: "social_set", Organization: actor.Organization,
		Outcome: auditlog.OutcomeSUCCEEDED, Metadata: map[string]any{"visibility": start.CreationVisibility}}); err != nil {
		return nil, err
	}
	return &created.ID, nil
}

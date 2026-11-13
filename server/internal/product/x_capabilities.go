package product

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/mediaresize"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

func checkXTarget(ctx context.Context, tx *ent.Tx, connection *ent.ChannelConnection, target ContentDraftScheduleTarget, ids []string, article bool, budget *helpers.ScanBudget) (*socialidentity.XCapabilities, error) {
	var caps *socialidentity.XCapabilities
	err := tx.Client().PlatformQuery(ctx, `SELECT i."internalId", i."verifiedAccountKey", i."verifiedAccountKind",
		i."verifiedScopes", i."verifiedCapabilities", i."identityVerifiedAt"
		FROM channel_connection c
		JOIN social_tenant_binding b ON b."organizationId" = c."organizationId"
		JOIN "Integration" i ON i.id = c."externalAccountId" AND i."organizationId" = b."goOrganizationId"
		WHERE c.id = $1 AND c."organizationId" = $2 AND c.provider = 'social' AND i."providerIdentifier" = 'x'`,
		[]any{connection.ID, connection.OrganizationID}, func(row entsql.ColumnScanner) error {
			var native string
			var key, kind *string
			var scopes, capabilities []byte
			var verified *time.Time
			if err := row.Scan(&native, &key, &kind, &scopes, &capabilities, &verified); err != nil {
				return err
			}
			if key == nil || kind == nil || verified == nil {
				return nil
			}
			proof := socialidentity.Verification{AccountKey: *key, AccountKind: *kind}
			if json.Unmarshal(scopes, &proof.GrantedScopes) == nil && json.Unmarshal(capabilities, &proof.Capabilities) == nil && proof.Validate("x", native) == nil {
				caps = proof.Capabilities.X
			}
			return nil
		})
	if err != nil {
		return nil, err
	}
	if caps == nil {
		return nil, conflict("Reconnect X to verify this account's publishing permissions and limits.")
	}
	if target.AutoActions != nil && target.AutoActions.QuoteAfterHours > 0 {
		return nil, conflict("X automated quotes require verified Enterprise API access. Remove the automated quote before scheduling.")
	}
	if article && (caps.Articles == nil || !*caps.Articles) {
		return nil, conflict("This connection has no verified X Articles access. Reconnect an eligible account.")
	}
	if target.AutoActions != nil && target.AutoActions.QuoteAfterHours > 0 && !socialidentity.XEnterpriseQuotesEnabled() {
		return nil, conflict("X quote follow-ups require the deployed application's approved Enterprise API access.")
	}
	check := func(text string, selected []string, options *postoptions.PublishOptions, isArticle bool) error {
		if options != nil && (options.QuoteRemoteID != "" || options.QuoteFirstPost) && !socialidentity.XEnterpriseQuotesEnabled() {
			return conflict("X quote posts require Enterprise API access, which this connection has not verified.")
		}
		if !isArticle {
			// Trimmed, as it is stored and published, and as draftPostLength counts it.
			if err := socialidentity.CheckXText(*caps, strings.TrimSpace(text), budget); err != nil {
				return conflict(err.Error())
			}
		}
		if len(selected) > caps.MaxImages {
			if isArticle {
				return conflict("Shots supports up to four attached images in an X article.")
			}
			return conflict("Choose up to four images, one GIF, or one video for each X post.")
		}
		if _, err := contentDraftAssets(ctx, tx, connection.OrganizationID, selected); err != nil {
			return err
		}
		media := make([]socialidentity.XMedia, 0, len(selected))
		if len(selected) > 0 {
			rows, err := tx.Asset.Query().Where(asset.OrganizationID(connection.OrganizationID), asset.IDIn(selected...), asset.StatusEQ(asset.StatusUPLOADED)).All(ctx)
			if err != nil {
				return err
			}
			if len(rows) != len(selected) {
				return invalid("Select distinct uploaded files from this workspace.")
			}
			for _, row := range rows {
				if isArticle && row.MediaType != "image/jpeg" && row.MediaType != "image/png" && row.MediaType != "image/webp" {
					return conflict("X articles support JPEG, PNG, or WebP images here.")
				}
				size := int64(row.Bytes)
				if mediaresize.Static(row.MediaType) && size <= mediaresize.MaxSourceBytes {
					size = min(size, caps.ImageMaxBytes)
				}
				media = append(media, socialidentity.XMedia{MIME: row.MediaType, Bytes: size, DurationMs: derefInt(row.DurationMs)})
			}
		}
		if options != nil && len(options.PhotoTagIDs) > 0 {
			if isArticle || len(media) == 0 {
				return invalid("Photo tagging needs an attached photo on a regular X post.")
			}
			for _, item := range media {
				if !mediaresize.Static(item.MIME) {
					return invalid("Photo tags are supported on static photos only.")
				}
			}
		}
		if options != nil {
			if len(options.TaggedUserIDs) == 0 {
				options.TaggedUserIDs = options.PhotoTagIDs
			}
			if isArticle && len(options.TaggedUserIDs) > 0 {
				return conflict("Photo tags are not supported on articles.")
			}
			if err := socialidentity.CheckXPhotoTags(options.TaggedUserIDs, media); err != nil {
				return conflict(err.Error())
			}
		}
		if err := socialidentity.CheckXMedia(*caps, media); err != nil {
			return conflict(err.Error())
		}
		return nil
	}
	if err := check(target.Caption, ids, target.Options, article); err != nil {
		return nil, err
	}
	if article && target.Options != nil && target.Options.ArticleCoverAssetID != "" {
		if err := check("", []string{target.Options.ArticleCoverAssetID}, nil, true); err != nil {
			return nil, err
		}
	}
	for _, reply := range target.Replies {
		if err := check(reply.Caption, reply.AssetIDs, reply.Options, false); err != nil {
			return nil, err
		}
	}
	return caps, nil
}

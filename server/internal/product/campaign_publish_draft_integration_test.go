package product

import (
	"errors"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
)

// An edited campaign visual becomes a Publish draft: the export is attached
// to the campaign and the draft names the campaign, both or neither. A retry
// adds no second draft, another workspace's campaign is not found, and a
// plain draft create still cannot claim a campaign.
func TestCampaignVisualBecomesPublishDraft(t *testing.T) {
	w, other := newTestWorkspace(t), newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	if _, err := w.repo.CreateSocialSet(w.ctx, w.owner, SocialSetInput{Name: "Acme"}); err != nil {
		t.Fatal(err)
	}
	campaign, err := w.repo.CreateCampaign(w.ctx, w.owner, CreateCampaignInput{Name: "Launch", Objective: "Launch",
		Angles: []CampaignAngleInput{{Hook: "Named views", Title: "Views"}},
		Posts:  []CampaignPostInput{{Channel: "x", Copy: "Saved views have names now."}}})
	if err != nil {
		t.Fatal(err)
	}
	export := uuid.NewString()
	w.exec(t, `INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"updatedAt") VALUES ($1,$2,$3,'image/png',2048,'UPLOADED',now())`,
		export, w.org, "exports/"+export+".png")
	caption := "Edited in the Shots editor"
	input := CampaignPublishDraftInput{AssetID: export, CampaignPostID: campaign.Posts[0].ID, Caption: &caption,
		Draft: ContentDraftInput{RequestKey: uuid.NewString(), Title: campaign.Name, Body: []any{
			map[string]any{"type": "p", "children": []any{map[string]any{"text": campaign.Posts[0].Copy}}}}}}

	draft, err := w.repo.CreateCampaignPublishDraft(w.ctx, w.owner, campaign.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if draft.CampaignID == nil || *draft.CampaignID != campaign.ID {
		t.Fatalf("draft lost its campaign: %v", draft.CampaignID)
	}
	// The export is attached, so the campaign's asset board shows what was published.
	link, err := w.db.Client.CampaignAsset.Query().Where(campaignasset.CampaignID(campaign.ID),
		campaignasset.AssetID(export)).Only(w.ctx)
	if err != nil || link.Kind != editorExportAssetKind || link.Caption == nil || *link.Caption != caption {
		t.Fatalf("export was not attached to the campaign: %+v %v", link, err)
	}
	// The asset reaches the draft even though the caller listed none.
	if len(draft.AssetIDs) != 1 || draft.AssetIDs[0] != export {
		t.Fatalf("draft does not carry the export: %v", draft.AssetIDs)
	}

	// A retry with the same request key returns the first draft.
	again, err := w.repo.CreateCampaignPublishDraft(w.ctx, w.owner, campaign.ID, input)
	if err != nil || again.ID != draft.ID {
		t.Fatalf("retry made a second draft: %v %v", again, err)
	}
	count, err := w.db.Client.ContentDraft.Query().Where(contentdraft.CampaignID(campaign.ID)).Count(w.ctx)
	if err != nil || count != 1 {
		t.Fatalf("expected one campaign draft, got %d (%v)", count, err)
	}

	// Publishing the same export again keeps one link and takes the newer
	// caption, so the board never shows the first post's words for the second.
	second := input
	second.Draft.RequestKey = uuid.NewString()
	newer := "Reframed for LinkedIn"
	second.Caption = &newer
	if _, err := w.repo.CreateCampaignPublishDraft(w.ctx, w.owner, campaign.ID, second); err != nil {
		t.Fatal(err)
	}
	links, err := w.db.Client.CampaignAsset.Query().Where(campaignasset.CampaignID(campaign.ID),
		campaignasset.AssetID(export)).All(w.ctx)
	if err != nil || len(links) != 1 || links[0].Caption == nil || *links[0].Caption != newer {
		t.Fatalf("re-publishing did not keep one current link: %+v %v", links, err)
	}

	// A post of another campaign is refused, and nothing is written.
	elsewhere, err := w.repo.CreateCampaign(w.ctx, w.owner, CreateCampaignInput{Name: "Other", Objective: "Launch",
		Angles: []CampaignAngleInput{{Hook: "Other", Title: "Other"}},
		Posts:  []CampaignPostInput{{Channel: "x", Copy: "Something else."}}})
	if err != nil {
		t.Fatal(err)
	}
	strayPost := input
	strayPost.CampaignPostID = elsewhere.Posts[0].ID
	strayPost.Draft.RequestKey = uuid.NewString()
	if _, err := w.repo.CreateCampaignPublishDraft(w.ctx, w.owner, campaign.ID, strayPost); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("a post of another campaign was accepted: %v", err)
	}

	// Another workspace cannot publish from this campaign, nor reach its asset.
	subscribe(t, other.ctx, other.repo, other.org, "pro")
	if _, err := other.repo.CreateSocialSet(other.ctx, other.owner, SocialSetInput{Name: "Other"}); err != nil {
		t.Fatal(err)
	}
	stray := input
	stray.Draft.RequestKey = uuid.NewString()
	if _, err := other.repo.CreateCampaignPublishDraft(other.ctx, other.owner, campaign.ID, stray); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("tenant escape: %v", err)
	}

	// An unknown asset is refused and leaves no draft behind.
	missing := input
	missing.AssetID = uuid.NewString()
	missing.Draft.RequestKey = uuid.NewString()
	if _, err := w.repo.CreateCampaignPublishDraft(w.ctx, w.owner, campaign.ID, missing); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("unknown asset accepted: %v", err)
	}
	count, err = w.db.Client.ContentDraft.Query().Where(contentdraft.CampaignID(campaign.ID)).Count(w.ctx)
	// Only the two deliberate posts exist; every refusal above rolled back.
	if err != nil || count != 2 {
		t.Fatalf("a refused handoff left a draft: %d (%v)", count, err)
	}

	// An archived campaign is closed to new posts.
	if _, err := w.repo.TransitionCampaign(w.ctx, w.owner, campaign.ID, "ARCHIVED"); err != nil {
		t.Fatal(err)
	}
	archived := input
	archived.Draft.RequestKey = uuid.NewString()
	if _, err := w.repo.CreateCampaignPublishDraft(w.ctx, w.owner, campaign.ID, archived); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("archived campaign accepted a post: %v", err)
	}

	// The draft API's own input cannot name a campaign: the field is not on the wire.
	plain, err := w.repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{Body: []any{
		map[string]any{"type": "p", "children": []any{map[string]any{"text": "Unrelated"}}}}})
	if err != nil {
		t.Fatal(err)
	}
	if plain.CampaignID != nil {
		t.Fatalf("a plain draft claimed a campaign: %v", *plain.CampaignID)
	}
}

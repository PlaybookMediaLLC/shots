package product

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
)

func TestCampaignDiscoveryAndInactiveRelease(t *testing.T) {
	w, other := newTestWorkspace(t), newTestWorkspace(t)
	releaseID, foreignRelease := uuid.NewString(), uuid.NewString()
	w.exec(t, `INSERT INTO release (id,"organizationId",title,"benefitStatement","updatedAt") VALUES ($1,$2,'Release','Useful',now())`, releaseID, w.org)
	other.exec(t, `INSERT INTO release (id,"organizationId",title,"benefitStatement","updatedAt") VALUES ($1,$2,'Private','Private',now())`, foreignRelease, other.org)
	key := "first-campaign"
	ids := []string{}
	for i := 0; i < 3; i++ {
		input := CreateCampaignInput{Name: "Campaign", Objective: "Explain", ReleaseID: &releaseID}
		if i == 0 {
			input.IdempotencyKey = &key
		}
		created, err := w.repo.CreateCampaign(w.ctx, w.owner, input)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, created.ID)
	}
	replayID := ids[0]
	w.exec(t, `UPDATE campaign SET "createdAt"='2026-01-01' WHERE "organizationId"=$1`, w.org)
	sort.Sort(sort.Reverse(sort.StringSlice(ids)))
	unrelated, err := w.repo.CreateCampaign(w.ctx, w.owner, CreateCampaignInput{Name: "Other", Objective: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := w.repo.ListCampaigns(w.ctx, w.owner, CampaignListFilter{ReleaseID: releaseID, Limit: 2})
	if err != nil || len(first) != 2 || first[0].ID != ids[0] || first[1].ID != ids[1] {
		t.Fatalf("first page=%+v err=%v", first, err)
	}
	last, err := w.repo.ListCampaigns(w.ctx, w.owner, CampaignListFilter{ReleaseID: releaseID, Cursor: first[1].ID, Limit: 2})
	if err != nil || len(last) != 1 || last[0].ID != ids[2] || last[0].Release == nil || last[0].Release.ID != releaseID {
		t.Fatalf("last page=%+v err=%v", last, err)
	}
	// A recently edited older campaign is discoverable without downloading the full collection.
	w.exec(t, `UPDATE campaign SET "updatedAt"='2027-01-01' WHERE id=$1`, ids[2])
	found, err := w.repo.ListCampaigns(w.ctx, w.owner, CampaignListFilter{Limit: 1, Search: "cAmPaIgN", Sort: "updated"})
	if err != nil || len(found) != 1 || found[0].ID != ids[2] {
		t.Fatalf("updated search=%+v err=%v", found, err)
	}
	after, err := w.repo.ListCampaigns(w.ctx, w.owner, CampaignListFilter{Limit: 3, Search: "Campaign", Sort: "updated", Cursor: ids[2]})
	if err != nil || len(after) != 2 {
		t.Fatalf("updated cursor=%+v err=%v", after, err)
	}
	for _, term := range []string{"Other workspace", "%"} {
		found, err := w.repo.ListCampaigns(w.ctx, w.owner, CampaignListFilter{Limit: 1, Search: term})
		if err != nil || len(found) != 0 {
			t.Fatalf("literal search %q=%+v err=%v", term, found, err)
		}
	}
	if _, err := w.repo.ListCampaigns(w.ctx, w.owner, CampaignListFilter{ReleaseID: releaseID, Cursor: unrelated.ID, Limit: 2}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cursor outside collection: %v", err)
	}
	for _, filter := range []CampaignListFilter{{Limit: 0}, {Limit: 101}, {Limit: 1, IdempotencyKey: strings.Repeat("x", 129)}, {Limit: 1, Search: strings.Repeat("x", 201)}, {Limit: 1, Sort: "arbitrary"}} {
		if _, err := w.repo.ListCampaigns(w.ctx, w.owner, filter); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid filter accepted: %v", err)
		}
	}
	foreign, err := w.repo.ListCampaigns(w.ctx, w.owner, CampaignListFilter{ReleaseID: foreignRelease, Limit: 2})
	if err != nil || len(foreign) != 0 {
		t.Fatalf("foreign release list=%+v err=%v", foreign, err)
	}
	if _, err := w.repo.CreateCampaign(w.ctx, w.owner, CreateCampaignInput{Name: "Foreign", Objective: "Other", ReleaseID: &foreignRelease}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign release creation: %v", err)
	}
	lookup, err := w.repo.ListCampaigns(w.ctx, w.owner, CampaignListFilter{IdempotencyKey: key, Limit: 1})
	if err != nil || len(lookup) != 1 || lookup[0].ID != replayID {
		t.Fatalf("recovery lookup=%+v err=%v", lookup, err)
	}
	foreign, err = other.repo.ListCampaigns(other.ctx, other.owner, CampaignListFilter{IdempotencyKey: key, Limit: 1})
	if err != nil || len(foreign) != 0 {
		t.Fatalf("cross-tenant recovery=%+v err=%v", foreign, err)
	}
	foreign, err = other.repo.ListCampaigns(other.ctx, other.owner, CampaignListFilter{Search: "Campaign", Limit: 5})
	if err != nil || len(foreign) != 0 {
		t.Fatalf("cross-tenant search=%+v err=%v", foreign, err)
	}
	for _, term := range []string{"rElEaSe", "Private", "%"} {
		found, err := w.repo.ListReleases(w.ctx, w.owner, 1, term)
		expected := 0
		if term == "rElEaSe" {
			expected = 1
		}
		if err != nil || len(found) != expected || (expected == 1 && found[0].ID != releaseID) {
			t.Fatalf("release search %q=%+v err=%v", term, found, err)
		}
	}
	if _, err := w.repo.ListReleases(w.ctx, w.owner, 1, strings.Repeat("x", 201)); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unbounded release search: %v", err)
	}
	w.addMember(t, "viewer", "viewer")
	if _, err := w.repo.CreateCampaign(w.ctx, w.actor("viewer"), CreateCampaignInput{Name: "Forbidden", Objective: "Other", ReleaseID: &releaseID}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("viewer creation: %v", err)
	}
	for _, status := range []string{"ARCHIVED", "CANCELLED"} {
		w.exec(t, `UPDATE release SET status=$1 WHERE id=$2`, status, releaseID)
		if _, err := w.repo.CreateCampaign(w.ctx, w.owner, CreateCampaignInput{Name: "Blocked", Objective: "Other", ReleaseID: &releaseID}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("%s creation: %v", status, err)
		}
		// A lost-response retry returns existing work, even after its source was archived.
		replay, err := w.repo.CreateCampaign(w.ctx, w.owner, CreateCampaignInput{Name: "Campaign", Objective: "Explain", ReleaseID: &releaseID, IdempotencyKey: &key})
		if err != nil || replay.ID != replayID || replay.Created == nil || *replay.Created {
			t.Fatalf("replay=%+v err=%v", replay, err)
		}
	}
	all, err := w.repo.ListCampaigns(w.ctx, w.owner)
	if err != nil || len(all) != 4 {
		t.Fatalf("legacy list or refused create changed: %+v %v", all, err)
	}
}

func TestCampaignCreationReadsLockedRelease(t *testing.T) {
	for _, change := range []string{"surface", "ARCHIVED", "CANCELLED"} {
		t.Run(change, func(t *testing.T) {
			w := newTestWorkspace(t)
			ctx, cancel := context.WithTimeout(w.ctx, 10*time.Second)
			defer cancel()
			a, b, releaseID := uuid.NewString(), uuid.NewString(), uuid.NewString()
			for _, id := range []string{a, b} {
				w.exec(t, `INSERT INTO product_surface (id,"organizationId",name,slug,url,"featureTags","screenshotAssetIds","createdAt","updatedAt") VALUES ($1,$2,$1,$1,$3,'[]','[]',now(),now())`, id, w.org, "https://"+id+".example.test")
			}
			updatedAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			w.exec(t, `INSERT INTO release (id,"organizationId",title,"benefitStatement","productSurfaceId","updatedAt") VALUES ($1,$2,'Release','Useful',$3,$4)`, releaseID, w.org, a, updatedAt)
			tx, err := w.db.SQL.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			var blocker int
			if err := tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
				t.Fatal(err)
			}
			status := "DRAFT"
			if change != "surface" {
				status = change
			}
			if _, err := tx.ExecContext(ctx, `UPDATE release SET "productSurfaceId"=$2, status=$3 WHERE id=$1`, releaseID, b, status); err != nil {
				t.Fatal(err)
			}
			type result struct {
				campaign *CampaignDetail
				err      error
			}
			done := make(chan result, 1)
			go func() {
				campaign, err := w.repo.CreateCampaign(ctx, w.owner, CreateCampaignInput{Name: "Campaign", Objective: "Explain", ReleaseID: &releaseID})
				done <- result{campaign, err}
			}()
			for {
				var blocked bool
				if err := w.db.SQL.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case got := <-done:
					t.Fatalf("creation did not wait for release edit: %+v %v", got.campaign, got.err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			got := <-done
			if change == "surface" {
				if got.err != nil || got.campaign.ProductSurface == nil || got.campaign.ProductSurface.ID != b {
					t.Fatalf("campaign inherited stale release: %+v %v", got.campaign, got.err)
				}
			} else if !errors.Is(got.err, publishing.ErrConflict) {
				t.Fatalf("inactive release accepted: %+v %v", got.campaign, got.err)
			}
			var actual time.Time
			if err := w.db.SQL.QueryRowContext(ctx, `SELECT "updatedAt" FROM release WHERE id=$1`, releaseID).Scan(&actual); err != nil {
				t.Fatal(err)
			}
			if !actual.Equal(updatedAt) {
				t.Fatalf("campaign creation changed release updatedAt: %v", actual)
			}
		})
	}
}

func TestCampaignReviewLimitsAndArchive(t *testing.T) {
	w, other := newTestWorkspace(t), newTestWorkspace(t)
	created, err := w.repo.CreateCampaign(w.ctx, w.owner, CreateCampaignInput{Name: "QA", Objective: "Launch", Posts: []CampaignPostInput{
		{Channel: "x", Copy: strings.Repeat("x", 281)}, {Channel: "x", Copy: "Valid"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = w.repo.TransitionCampaignPosts(w.ctx, w.owner, created.ID, CampaignPostDecision{Decision: "submit"})
	if !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("bulk submit accepted long copy: %v", err)
	}
	count, err := w.db.Client.CampaignPost.Query().Where(campaignpost.CampaignID(created.ID), campaignpost.StatusEQ(campaignpost.StatusDRAFT)).Count(w.ctx)
	if err != nil || count != 2 {
		t.Fatalf("bulk review was not atomic: %d %v", count, err)
	}
	_, err = w.repo.TransitionCampaignPosts(w.ctx, other.owner, created.ID, CampaignPostDecision{Decision: "submit"})
	if !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("tenant escape: %v", err)
	}
	// Legacy over-limit posts already in review cannot be approved either.
	w.exec(t, `UPDATE campaign_post SET status='READY_FOR_REVIEW' WHERE "campaignId"=$1`, created.ID)
	_, err = w.repo.TransitionCampaignPosts(w.ctx, w.owner, created.ID, CampaignPostDecision{Decision: "approve"})
	if !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("bulk approval accepted long copy: %v", err)
	}
	note := "   "
	_, err = w.repo.TransitionCampaignPosts(w.ctx, w.owner, created.ID, CampaignPostDecision{Decision: "request_changes", Note: &note})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty review note accepted: %v", err)
	}
	if _, err := w.repo.TransitionCampaign(w.ctx, w.owner, created.ID, "ARCHIVED"); err != nil {
		t.Fatal(err)
	}
	_, err = w.repo.TransitionCampaignPosts(w.ctx, w.owner, created.ID, CampaignPostDecision{Decision: "reject"})
	if !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("archived review accepted: %v", err)
	}
	expected, edited := created.Posts[0].Copy, "Edited"
	_, err = w.repo.UpdateCampaignPost(w.ctx, w.owner, created.ID, created.Posts[0].ID, UpdateCampaignPostInput{ExpectedCopy: &expected, Copy: &edited})
	if !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("archived edit accepted: %v", err)
	}
	_, err = w.repo.ScheduleCampaignPost(w.ctx, w.owner, created.ID, created.Posts[0].ID, ScheduleCampaignPostInput{ChannelConnectionID: "missing"})
	if !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("archived schedule accepted: %v", err)
	}
	if _, err := w.repo.TransitionCampaign(w.ctx, w.owner, created.ID, "DRAFT"); err != nil {
		t.Fatal(err)
	}
	before, _ := w.repo.GetCampaign(w.ctx, w.owner, created.ID)
	_, err = w.repo.UpdateCampaignPost(w.ctx, w.owner, created.ID, created.Posts[0].ID, UpdateCampaignPostInput{ExpectedCopy: &expected, Copy: &edited})
	if err != nil {
		t.Fatal(err)
	}
	after, _ := w.repo.GetCampaign(w.ctx, w.owner, created.ID)
	if !after.UpdatedAt.After(before.UpdatedAt) {
		t.Fatal("post edit did not update campaign timestamp")
	}
}

func TestCampaignProductShotApproval(t *testing.T) {
	w, other := newTestWorkspace(t), newTestWorkspace(t)
	releaseID := uuid.NewString()
	w.exec(t, `INSERT INTO release (id,"organizationId",title,"benefitStatement","updatedAt") VALUES ($1,$2,'Release','Useful',now())`, releaseID, w.org)
	created, err := w.repo.CreateCampaign(w.ctx, w.owner, CreateCampaignInput{Name: "QA", Objective: "Launch", ReleaseID: &releaseID})
	if err != nil {
		t.Fatal(err)
	}
	shot := uuid.NewString()
	w.exec(t, `INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,width,height,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,'UPLOADED',1200,630,now(),now())`, shot, w.org, "org/"+w.org+"/"+shot)
	key := "A1"
	_, err = w.repo.LinkCampaignAsset(w.ctx, w.owner, created.ID, shot, LinkCampaignAssetInput{Kind: "product-shot", PlanAssetKey: &key})
	if err != nil {
		t.Fatal(err)
	}
	_, err = w.repo.ApproveCampaignAsset(w.ctx, other.owner, created.ID, shot)
	if !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross tenant approval: %v", err)
	}
	w.addMember(t, "viewer", "viewer")
	_, err = w.repo.ApproveCampaignAsset(w.ctx, w.actor("viewer"), created.ID, shot)
	if !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("viewer approval: %v", err)
	}
	first, err := w.repo.ApproveCampaignAsset(w.ctx, w.owner, created.ID, shot)
	if err != nil {
		t.Fatal(err)
	}
	again, err := w.repo.ApproveCampaignAsset(w.ctx, w.owner, created.ID, shot)
	if err != nil || again.Variant.ID != first.Variant.ID {
		t.Fatalf("approval retry: %+v %v", again, err)
	}
	designs, err := w.repo.ListCampaignDesigns(w.ctx, w.owner, created.ID)
	if err != nil || len(designs) != 1 || designs[0].ApprovedVariant == nil || designs[0].ApprovedVariant.SourceAssetID != shot {
		t.Fatalf("shot lineage: %+v %v", designs, err)
	}
	if _, err := w.repo.TransitionCampaign(w.ctx, w.owner, created.ID, "ARCHIVED"); err != nil {
		t.Fatal(err)
	}
	_, err = w.repo.ApproveCampaignAsset(w.ctx, w.owner, created.ID, shot)
	if !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("archived approval: %v", err)
	}
}

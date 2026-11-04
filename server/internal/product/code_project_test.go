package product

import (
	"errors"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

func codeFixture(code string) map[string]any {
	return map[string]any{
		"version": float64(1), "kind": "code",
		"style": map[string]any{"theme": "midnight"},
		"slides": []any{map[string]any{"id": "slide-1", "panes": []any{map[string]any{
			"id": "pane-1", "files": []any{map[string]any{"id": "file-1", "name": "main.ts", "lang": "typescript", "code": code}},
		}}}},
	}
}

func TestCodeDocumentValidation(t *testing.T) {
	// Code text is never read as a reference, so local and asset-like strings are plain text.
	ids, err := creativeDocumentAssetIDs(codeFixture(`const url = "blob:local"; // asset:` + uuid.NewString()))
	if err != nil || len(ids) != 0 {
		t.Fatalf("ids=%v err=%v", ids, err)
	}
	logo := uuid.NewString()
	withLogo := codeFixture("x")
	withLogo["style"].(map[string]any)["footer"] = map[string]any{"logo": "asset:" + logo}
	if ids, err := creativeDocumentAssetIDs(withLogo); err != nil || len(ids) != 1 || ids[0] != logo {
		t.Fatalf("logo ids=%v err=%v", ids, err)
	}
	file := func(doc map[string]any) map[string]any {
		return doc["slides"].([]any)[0].(map[string]any)["panes"].([]any)[0].(map[string]any)["files"].([]any)[0].(map[string]any)
	}
	for name, mutate := range map[string]func(map[string]any){
		"future version": func(doc map[string]any) { doc["version"] = float64(2) },
		"no slides":      func(doc map[string]any) { doc["slides"] = []any{} },
		"too many slides": func(doc map[string]any) {
			slides := []any{}
			for range 51 {
				slides = append(slides, doc["slides"].([]any)[0])
			}
			doc["slides"] = slides
		},
		"no files": func(doc map[string]any) {
			doc["slides"].([]any)[0].(map[string]any)["panes"] = []any{map[string]any{"files": []any{}}}
		},
		"long code":    func(doc map[string]any) { file(doc)["code"] = strings.Repeat("x", 100_001) },
		"long base":    func(doc map[string]any) { file(doc)["base"] = strings.Repeat("x", 100_001) },
		"missing code": func(doc map[string]any) { delete(file(doc), "code") },
		"foreign logo": func(doc map[string]any) {
			doc["style"].(map[string]any)["footer"] = map[string]any{"logo": "https://example.com/logo.png"}
		},
		"over one MB": func(doc map[string]any) { doc["source"] = map[string]any{"url": strings.Repeat("x", 1<<20)} },
		"three panes": func(doc map[string]any) {
			s := doc["slides"].([]any)[0].(map[string]any)
			p := s["panes"].([]any)
			s["panes"] = append(p, p[0], p[0])
		},
		"slide not a map": func(doc map[string]any) { doc["slides"] = []any{"slide"} },
	} {
		t.Run(name, func(t *testing.T) {
			doc := codeFixture("x")
			mutate(doc)
			if _, err := creativeDocumentAssetIDs(doc); err == nil {
				t.Fatal("invalid input accepted")
			}
		})
	}
	if creativeSetKind(codeFixture("x")) != "code" {
		t.Fatal("code documents are misread")
	}
}

// A code project uses the creative-set lifecycle, keeps its own kind and stays in its workspace.
func TestCodeProjectLifecycle(t *testing.T) {
	w, foreign := newTestWorkspace(t), newTestWorkspace(t)
	// Code projects are part of the paid workspace, not the Story Set rollout.
	t.Setenv("PLATFORM_CREATIVE_SETS", "disabled")
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	subscribe(t, foreign.ctx, foreign.repo, foreign.org, "pro")
	w.addMember(t, "viewer", "viewer")
	media := uuid.NewString()
	if err := w.db.Client.Asset.Create().SetID(media).SetOrganizationID(foreign.org).SetObjectKey("org/" + foreign.org + "/input/" + media + "/1/logo.png").SetMediaType("image/png").SetBytes(100).SetStatus(asset.StatusUPLOADED).Exec(w.ctx); err != nil {
		t.Fatal(err)
	}
	id := cuid.New()
	doc := codeFixture("console.log('hi')")
	created, err := w.repo.CreateCreativeSet(w.ctx, w.owner, id, "Snippet", doc)
	if err != nil || created.Kind != "code" || created.Revision != 1 {
		t.Fatalf("create=%+v err=%v", created, err)
	}
	if replay, err := w.repo.CreateCreativeSet(w.ctx, w.owner, id, "Snippet", doc); err != nil || replay.ID != id {
		t.Fatalf("a retried create was not idempotent: %+v %v", replay, err)
	}
	if _, err := w.repo.CreateCreativeSet(w.ctx, w.actor("viewer"), cuid.New(), "Viewer", codeFixture("x")); err == nil {
		t.Fatal("viewer created a code project")
	}
	foreignLogo := codeFixture("x")
	foreignLogo["style"].(map[string]any)["footer"] = map[string]any{"logo": "asset:" + media}
	if _, err := w.repo.CreateCreativeSet(w.ctx, w.owner, cuid.New(), "Foreign logo", foreignLogo); err == nil {
		t.Fatal("a code project accepted another workspace's logo")
	}
	if page, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{Kind: "code"}); err != nil || len(page.Items) != 1 || page.Items[0].ID != id {
		t.Fatalf("code list=%+v %v", page, err)
	}
	for _, kind := range []string{"", "canvas"} {
		if page, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{Kind: kind}); err != nil || len(page.Items) != 0 {
			t.Fatalf("%q list shows code projects=%+v %v", kind, page, err)
		}
	}
	if _, err := w.repo.GetCreativeSet(w.ctx, foreign.owner, id); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant read: %v", err)
	}
	if _, err := w.repo.UpdateCreativeSetDocument(w.ctx, foreign.owner, id, CreativeSetDocumentWrite{BaseRevision: 1, Document: doc}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant update: %v", err)
	}
	if _, err := w.repo.UpdateCreativeSetDocument(w.ctx, w.owner, id, CreativeSetDocumentWrite{BaseRevision: 1, Document: canvasFixture()}); err == nil || errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("a code project became a canvas: %v", err)
	}
	if result, err := w.repo.UpdateCreativeSetDocument(w.ctx, w.owner, id, CreativeSetDocumentWrite{BaseRevision: 1, Document: codeFixture("console.log('bye')")}); err != nil || result.Revision != 2 {
		t.Fatalf("update=%+v %v", result, err)
	}
	duplicate, err := w.repo.DuplicateCreativeSet(w.ctx, w.owner, id, nil)
	if err != nil || duplicate.Kind != "code" {
		t.Fatalf("duplicate=%+v %v", duplicate, err)
	}
	releaseID, campaignID := cuid.New(), cuid.New()
	w.exec(t, `INSERT INTO release(id,"organizationId",title,"benefitStatement","updatedAt") VALUES($1,$2,'Launch','Decide together',now())`, releaseID, w.org)
	w.exec(t, `INSERT INTO campaign (id,"organizationId",name,objective,"releaseId","updatedAt") VALUES ($1,$2,'Launch','Adoption',$3,now())`, campaignID, w.org, releaseID)
	if _, err := w.repo.AttachCreativeSetDelivery(w.ctx, w.owner, id, CreativeSetHandoffInput{BaseRevision: 2, DeliveryID: uuid.NewString(), CampaignID: campaignID, Channel: "linkedin", Copy: "Hi"}); err == nil || !strings.Contains(err.Error(), "Code projects") {
		t.Fatalf("a code project was handed off as a delivery: %v", err)
	}
	if exists, err := w.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(w.org), auditlog.EntityID(id), auditlog.Action("product.code_project_created")).Exist(w.ctx); err != nil || !exists {
		t.Fatalf("audit=%v %v", exists, err)
	}
}

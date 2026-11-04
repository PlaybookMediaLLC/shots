package product

import (
	"errors"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativesetversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

func canvasFixture(assetIDs ...string) map[string]any {
	artboards := []any{}
	for index, id := range assetIDs {
		artboards = append(artboards, map[string]any{
			"id": "board-" + id[:8], "name": "Artboard", "x": float64(index * 1700), "y": float64(0),
			"document": map[string]any{"version": float64(2), "image": map[string]any{"src": "asset:" + id}},
		})
	}
	return map[string]any{"version": float64(1), "kind": "canvas", "artboards": artboards, "deliveries": []any{}}
}

func storeProjectFixture(assetID string) map[string]any {
	return map[string]any{
		"id": "project-1", "kind": "store", "name": "Launch", "bindings": []any{}, "review": map[string]any{"source": false, "wording": false},
		"assetMap": map[string]any{"img_1": "asset:" + assetID},
		"document": map[string]any{
			"version": float64(2),
			"assets":  map[string]any{"img_1": map[string]any{"id": "img_1", "src": nil}},
			"slides":  []any{map[string]any{"id": "slide-1", "layers": []any{map[string]any{"id": "layer-1"}}}},
		},
	}
}

func TestStoreProjectValidation(t *testing.T) {
	id := uuid.NewString()
	if creativeSetKind(storeProjectFixture(id)) != "store" {
		t.Fatal("a store project names its kind")
	}
	if ids, err := creativeDocumentAssetIDs(storeProjectFixture(id)); err != nil || len(ids) != 1 || ids[0] != id {
		t.Fatalf("ids=%v err=%v", ids, err)
	}
	native := func(doc map[string]any) map[string]any { return doc["document"].(map[string]any) }
	for name, mutate := range map[string]func(map[string]any){
		"local image": func(doc map[string]any) {
			native(doc)["assets"].(map[string]any)["img_1"].(map[string]any)["src"] = "blob:local"
		},
		"unmapped image": func(doc map[string]any) { doc["assetMap"] = map[string]any{} },
		"story binding": func(doc map[string]any) {
			doc["bindings"] = []any{map[string]any{"storyId": "s", "slideId": "slide-1", "layerId": "layer-1"}}
		},
		"future version":    func(doc map[string]any) { native(doc)["version"] = float64(3) },
		"no slides":         func(doc map[string]any) { native(doc)["slides"] = []any{} },
		"missing native id": func(doc map[string]any) { delete(doc, "id") },
	} {
		t.Run(name, func(t *testing.T) {
			doc := storeProjectFixture(id)
			mutate(doc)
			if _, err := creativeDocumentAssetIDs(doc); err == nil {
				t.Fatal("invalid input accepted")
			}
		})
	}
}

// A store screenshot project saved to the workspace keeps its kind, its images and its tenant.
func TestStoreProjectLifecycle(t *testing.T) {
	w, foreign := newTestWorkspace(t), newTestWorkspace(t)
	// Like a canvas, a store project is part of the paid workspace, not the Story Set rollout.
	t.Setenv("PLATFORM_CREATIVE_SETS", "disabled")
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	subscribe(t, foreign.ctx, foreign.repo, foreign.org, "pro")
	w.addMember(t, "viewer", "viewer")
	media, other := uuid.NewString(), uuid.NewString()
	for id, org := range map[string]string{media: w.org, other: foreign.org} {
		if err := w.db.Client.Asset.Create().SetID(id).SetOrganizationID(org).SetObjectKey("org/" + org + "/input/" + id + "/1/screen.png").SetMediaType("image/png").SetWidth(1320).SetHeight(2868).SetBytes(100).SetStatus(asset.StatusUPLOADED).Exec(w.ctx); err != nil {
			t.Fatal(err)
		}
	}
	id := cuid.New()
	if _, err := w.repo.CreateCreativeSet(w.ctx, w.actor("viewer"), id, "Launch", storeProjectFixture(media)); err == nil {
		t.Fatal("a viewer saved a store project")
	}
	if _, err := w.repo.CreateCreativeSet(w.ctx, w.owner, cuid.New(), "Foreign", storeProjectFixture(other)); err == nil {
		t.Fatal("a store project accepted another workspace's image")
	}
	created, err := w.repo.CreateCreativeSet(w.ctx, w.owner, id, "Launch", storeProjectFixture(media))
	if err != nil || created.Kind != "store" || created.Revision != 1 {
		t.Fatalf("create=%+v err=%v", created, err)
	}
	if page, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{Kind: "store"}); err != nil || len(page.Items) != 1 || page.Items[0].ID != id {
		t.Fatalf("store list=%+v %v", page, err)
	}
	for _, kind := range []string{"", "canvas"} {
		if page, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{Kind: kind}); err != nil || len(page.Items) != 0 {
			t.Fatalf("%q list shows store projects=%+v %v", kind, page, err)
		}
	}
	if page, err := w.repo.ListCreativeSets(w.ctx, foreign.owner, CreativeSetListQuery{Kind: "store"}); err != nil || len(page.Items) != 0 {
		t.Fatalf("foreign store list=%+v %v", page, err)
	}
	if _, err := w.repo.UpdateCreativeSetDocument(w.ctx, w.owner, id, CreativeSetDocumentWrite{BaseRevision: 1, Document: canvasFixture(media)}); err == nil || errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("a store project became a canvas: %v", err)
	}
	updated, err := w.repo.UpdateCreativeSetDocument(w.ctx, w.owner, id, CreativeSetDocumentWrite{BaseRevision: 1, Document: storeProjectFixture(media)})
	if err != nil || updated.Revision != 2 {
		t.Fatalf("update=%+v err=%v", updated, err)
	}
	if _, err := w.repo.UpdateCreativeSetDocument(w.ctx, w.owner, id, CreativeSetDocumentWrite{BaseRevision: 1, Document: storeProjectFixture(media)}); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("stale update=%v", err)
	}
	if result, err := w.repo.DeleteAsset(w.ctx, w.owner, media); err != nil || result != AssetInUse {
		t.Fatalf("store image deletion=%s %v", result, err)
	}
}

func TestCanvasValidation(t *testing.T) {
	id := uuid.NewString()
	if ids, err := creativeDocumentAssetIDs(canvasFixture(id)); err != nil || len(ids) != 1 || ids[0] != id {
		t.Fatalf("ids=%v err=%v", ids, err)
	}
	if ids, err := creativeDocumentAssetIDs(map[string]any{"version": float64(1), "kind": "canvas", "artboards": []any{}}); err != nil || len(ids) != 0 {
		t.Fatalf("an empty canvas is a valid start: ids=%v err=%v", ids, err)
	}
	board := func(doc map[string]any) map[string]any { return doc["artboards"].([]any)[0].(map[string]any) }
	for name, mutate := range map[string]func(map[string]any){
		"future version":     func(doc map[string]any) { doc["version"] = float64(2) },
		"missing artboards":  func(doc map[string]any) { delete(doc, "artboards") },
		"duplicate artboard": func(doc map[string]any) { doc["artboards"] = append(doc["artboards"].([]any), board(doc)) },
		"blank name":         func(doc map[string]any) { board(doc)["name"] = "  " },
		"missing position":   func(doc map[string]any) { delete(board(doc), "x") },
		"far position":       func(doc map[string]any) { board(doc)["y"] = 2e6 },
		"unsupported native": func(doc map[string]any) { board(doc)["document"].(map[string]any)["version"] = float64(9) },
		"local image": func(doc map[string]any) {
			board(doc)["document"].(map[string]any)["image"] = map[string]any{"src": "blob:local"}
		},
		"nested local image": func(doc map[string]any) {
			board(doc)["document"].(map[string]any)["overlays"] = []any{map[string]any{"src": "blob:local"}}
		},
		"local context reference": func(doc map[string]any) { doc["context"] = map[string]any{"screenshot": "blob:local"} },
	} {
		t.Run(name, func(t *testing.T) {
			doc := canvasFixture(id)
			mutate(doc)
			if _, err := creativeDocumentAssetIDs(doc); err == nil {
				t.Fatal("invalid input accepted")
			}
		})
	}
	if creativeSetKind(creativeSetFixture(id)) != "story-set" || creativeSetKind(canvasFixture(id)) != "canvas" {
		t.Fatal("document kinds are misread")
	}
}

func TestCanvasArchiveRecovery(t *testing.T) {
	w, foreign := newTestWorkspace(t), newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	subscribe(t, foreign.ctx, foreign.repo, foreign.org, "pro")
	w.addMember(t, "viewer", "viewer")
	id := cuid.New()
	created, err := w.repo.CreateCreativeSet(w.ctx, w.owner, id, "Recoverable", canvasFixture())
	if err != nil {
		t.Fatal(err)
	}
	if err := w.repo.ArchiveCreativeSet(w.ctx, w.owner, id); err != nil {
		t.Fatal(err)
	}
	if page, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{Kind: "canvas"}); err != nil || len(page.Items) != 0 {
		t.Fatalf("active list=%+v err=%v", page, err)
	}
	if page, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{Kind: "canvas", Archived: true}); err != nil || len(page.Items) != 1 || page.Items[0].ID != id {
		t.Fatalf("archive list=%+v err=%v", page, err)
	}
	if page, err := w.repo.ListCreativeSets(w.ctx, foreign.owner, CreativeSetListQuery{Kind: "canvas", Archived: true}); err != nil || len(page.Items) != 0 {
		t.Fatalf("foreign archive list=%+v err=%v", page, err)
	}
	if err := w.repo.ArchiveCreativeSet(w.ctx, foreign.owner, id, false); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant restore=%v", err)
	}
	if err := w.repo.ArchiveCreativeSet(w.ctx, w.actor("viewer"), id, false); err == nil {
		t.Fatal("viewer restored an archived canvas")
	}
	for range 2 {
		if err := w.repo.ArchiveCreativeSet(w.ctx, w.owner, id, false); err != nil {
			t.Fatal(err)
		}
	}
	if page, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{Kind: "canvas"}); err != nil || len(page.Items) != 1 || page.Items[0].ID != id || page.Items[0].Revision != created.Revision {
		t.Fatalf("restored list=%+v err=%v", page, err)
	}
}

// A canvas uses the Story Set lifecycle, but never without its own kind and never across workspaces.
func TestCanvasLifecycleAndHandoff(t *testing.T) {
	w, foreign := newTestWorkspace(t), newTestWorkspace(t)
	w.repo.WithMonthlyMeter(&recordingMonthlyMeter{})
	// Canvas creation is part of the paid workspace, not the Story Set rollout.
	t.Setenv("PLATFORM_CREATIVE_SETS", "disabled")
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	subscribe(t, foreign.ctx, foreign.repo, foreign.org, "pro")
	media, other := uuid.NewString(), uuid.NewString()
	for id, org := range map[string]string{media: w.org, other: foreign.org} {
		if err := w.db.Client.Asset.Create().SetID(id).SetOrganizationID(org).SetObjectKey("org/" + org + "/input/" + id + "/1/screen.png").SetMediaType("image/png").SetWidth(1600).SetHeight(900).SetBytes(100).SetStatus(asset.StatusUPLOADED).Exec(w.ctx); err != nil {
			t.Fatal(err)
		}
	}
	canvasID := cuid.New()
	doc := canvasFixture(media)
	created, err := w.repo.CreateCreativeSet(w.ctx, w.owner, canvasID, "Launch board", doc)
	if err != nil || created.Kind != "canvas" || created.Revision != 1 {
		t.Fatalf("create=%+v err=%v", created, err)
	}
	if _, err := w.repo.CreateCreativeSet(w.ctx, w.owner, cuid.New(), "Story", creativeSetFixture(media)); err == nil {
		t.Fatal("a Story Set was created while its rollout is disabled")
	}
	if _, err := w.repo.CreateCreativeSet(w.ctx, w.owner, cuid.New(), "Foreign", canvasFixture(other)); err == nil {
		t.Fatal("a canvas accepted another workspace's image")
	}
	if page, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{Kind: "canvas"}); err != nil || len(page.Items) != 1 || page.Items[0].ID != canvasID {
		t.Fatalf("canvas list=%+v %v", page, err)
	}
	if page, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{}); err != nil || len(page.Items) != 0 {
		t.Fatalf("Story Set list shows canvases=%+v %v", page, err)
	}
	if _, err := w.repo.ListCreativeSets(w.ctx, w.owner, CreativeSetListQuery{Kind: "slides"}); err == nil {
		t.Fatal("unknown kind listed")
	}
	if _, err := w.repo.GetCreativeSet(w.ctx, foreign.owner, canvasID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant read: %v", err)
	}
	if _, err := w.repo.UpdateCreativeSetDocument(w.ctx, foreign.owner, canvasID, CreativeSetDocumentWrite{BaseRevision: 1, Document: canvasFixture(other)}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant update: %v", err)
	}
	if _, err := w.repo.UpdateCreativeSetDocument(w.ctx, foreign.owner, canvasID, CreativeSetDocumentWrite{BaseRevision: 1, Document: doc}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant update with this workspace's images: %v", err)
	}
	if _, err := w.repo.UpdateCreativeSetDocument(w.ctx, w.owner, canvasID, CreativeSetDocumentWrite{BaseRevision: 1, Document: creativeSetFixture(media)}); err == nil || errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("a canvas became a Story Set: %v", err)
	}
	if result, err := w.repo.DeleteAsset(w.ctx, w.owner, media); err != nil || result != AssetInUse {
		t.Fatalf("artboard image deletion=%s %v", result, err)
	}
	duplicate, err := w.repo.DuplicateCreativeSet(w.ctx, w.owner, canvasID, nil)
	if err != nil || duplicate.Kind != "canvas" {
		t.Fatalf("duplicate=%+v %v", duplicate, err)
	}

	setID := canvasID
	if _, err := w.repo.CreateCreativeSetVersion(w.ctx, w.owner, setID, "Delivery revision 1", 1); err != nil {
		t.Fatal(err)
	}
	artboardID := doc["artboards"].([]any)[0].(map[string]any)["id"].(string)
	deliveryID := uuid.NewString()
	doc["deliveries"] = []any{map[string]any{"id": deliveryID, "asset": "asset:" + media, "revision": float64(1), "outputId": artboardID, "documentHash": "immutable-document-hash"}}
	if _, err := w.repo.UpdateCreativeSetDocument(w.ctx, w.owner, setID, CreativeSetDocumentWrite{BaseRevision: 1, Document: doc}); err != nil {
		t.Fatal(err)
	}
	releaseID, campaignID := cuid.New(), cuid.New()
	w.exec(t, `INSERT INTO release(id,"organizationId",title,"benefitStatement","updatedAt") VALUES($1,$2,'Launch','Decide together',now())`, releaseID, w.org)
	w.exec(t, `INSERT INTO campaign (id,"organizationId",name,objective,"releaseId","updatedAt") VALUES ($1,$2,'Launch','Adoption',$3,now())`, campaignID, w.org, releaseID)
	input := CreativeSetHandoffInput{BaseRevision: 2, DeliveryID: deliveryID, CampaignID: campaignID, Channel: "linkedin", Copy: "Approvals in one place."}
	attached, err := w.repo.AttachCreativeSetDelivery(w.ctx, w.owner, setID, input)
	if err != nil {
		t.Fatal(err)
	}
	design, err := w.repo.GetDesign(w.ctx, w.owner, attached.DesignID)
	if err != nil || design.RenderedAssetID == nil || *design.RenderedAssetID != media || design.Name != "Launch board · canvas artboard" {
		t.Fatalf("delivered design=%+v %v", design, err)
	}
	if exists, err := w.db.Client.CampaignAsset.Query().Where(campaignasset.CampaignID(campaignID), campaignasset.Kind("canvas-delivery")).Exist(w.ctx); err != nil || !exists {
		t.Fatalf("canvas delivery asset=%v %v", exists, err)
	}
	doc["artboards"].([]any)[0].(map[string]any)["name"] = "Edited after delivery"
	if _, err := w.repo.UpdateCreativeSetDocument(w.ctx, w.owner, setID, CreativeSetDocumentWrite{BaseRevision: 2, Document: doc}); err != nil {
		t.Fatal(err)
	}
	unchanged, err := w.repo.GetDesign(w.ctx, w.owner, attached.DesignID)
	if err != nil || unchanged.RenderKey == nil || *unchanged.RenderKey != *design.RenderKey {
		t.Fatal("a canvas edit rewrote its campaign delivery")
	}
	if err := w.repo.DeleteCanvas(w.ctx, w.owner, setID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.GetDesign(w.ctx, w.owner, attached.DesignID); err != nil {
		t.Fatalf("deleting the canvas removed its delivered design: %v", err)
	}
	if exists, err := w.db.Client.CampaignAsset.Query().Where(campaignasset.CampaignID(campaignID), campaignasset.Kind("canvas-delivery")).Exist(w.ctx); err != nil || !exists {
		t.Fatalf("deleting the canvas removed its campaign delivery: %v %v", exists, err)
	}
}

func TestCanvasPermanentDeletionIsTenantScoped(t *testing.T) {
	w, foreign := newTestWorkspace(t), newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	w.addMember(t, "viewer", "viewer")
	id := cuid.New()
	if _, err := w.repo.CreateCreativeSet(w.ctx, w.owner, id, "Remove me", canvasFixture()); err != nil {
		t.Fatal(err)
	}
	if err := w.repo.DeleteCanvas(w.ctx, foreign.owner, id); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign delete: %v", err)
	}
	if err := w.repo.DeleteCanvas(w.ctx, w.actor("viewer"), id); err == nil {
		t.Fatal("viewer deleted canvas")
	}
	if err := w.repo.DeleteCanvas(w.ctx, Actor{}, id); err == nil {
		t.Fatal("unauthenticated delete")
	}
	if _, err := w.repo.GetCreativeSet(w.ctx, w.owner, id); err != nil {
		t.Fatal(err)
	}
	if err := w.repo.DeleteCanvas(w.ctx, w.owner, id); err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.GetCreativeSet(w.ctx, w.owner, id); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("canvas survived: %v", err)
	}
	if exists, err := w.db.Client.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.CreativeSetID(id)).Exist(w.ctx); err != nil || exists {
		t.Fatalf("versions survived: %v %v", exists, err)
	}
	event, err := w.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(w.org), auditlog.EntityID(id), auditlog.Action("product.canvas_deleted")).Only(w.ctx)
	if err != nil || event.Metadata["name"] != "Remove me" {
		t.Fatalf("audit: %+v %v", event, err)
	}
	if err := w.repo.DeleteCanvas(w.ctx, w.owner, id); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("repeat delete: %v", err)
	}
}

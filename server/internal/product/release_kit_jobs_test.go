package product

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"testing"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitartifactrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/launchrunstep"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
)

type fakeKitDispatcher struct {
	prepared []string
	exported []string
}

func (f *fakeKitDispatcher) StartKitPrepare(_ context.Context, org, id string) error {
	f.prepared = append(f.prepared, org+"/"+id)
	return nil
}

func (f *fakeKitDispatcher) StartKitExport(_ context.Context, org, id string) error {
	f.exported = append(f.exported, org+"/"+id)
	return nil
}

func TestHandleOutboxEventDelegatesKitJobsToDispatcher(t *testing.T) {
	dispatcher := &fakeKitDispatcher{}
	config := NewConfiguration(nil).WithKitDispatcher(dispatcher)
	handled, err := config.HandleOutboxEvent(context.Background(), "ev-1", "org-1", EventKitPrepare, "rev-1")
	if err != nil || !handled {
		t.Fatalf("prepare: handled=%v err=%v", handled, err)
	}
	handled, err = config.HandleOutboxEvent(context.Background(), "ev-2", "org-1", EventKitExport, "exp-1")
	if err != nil || !handled {
		t.Fatalf("export: handled=%v err=%v", handled, err)
	}
	if len(dispatcher.prepared) != 1 || dispatcher.prepared[0] != "org-1/rev-1" {
		t.Fatalf("prepared=%v", dispatcher.prepared)
	}
	if len(dispatcher.exported) != 1 || dispatcher.exported[0] != "org-1/exp-1" {
		t.Fatalf("exported=%v", dispatcher.exported)
	}
}

type kitTestObjectStore struct {
	recordingAssetObjects
	files     map[string][]byte
	readCalls int
}

func (s *kitTestObjectStore) Read(_ context.Context, key string) ([]byte, error) {
	s.readCalls++
	data, ok := s.files[key]
	if !ok {
		return nil, ErrStorageUnavailable
	}
	return append([]byte(nil), data...), nil
}

type kitSignedObjectStore struct {
	kitTestObjectStore
	signedURL string
	signErr   error
}

func (s *kitSignedObjectStore) SignInternalDownload(_ context.Context, key string) (string, error) {
	if s.signErr != nil {
		return "", s.signErr
	}
	return s.signedURL + "/" + key, nil
}

type fakeKitRenderer struct {
	AutomationRenderer
	lastRequest KitRenderRequest
	output      KitRenderOutput
}

func (r *fakeKitRenderer) RenderKit(_ context.Context, req KitRenderRequest) (KitRenderOutput, error) {
	r.lastRequest = req
	return r.output, nil
}

func tinyValidPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.RGBA{R: 10, G: 20, B: 30, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestRenderKitArtifactSignedURLsAndFallback(t *testing.T) {
	pngBytes := tinyValidPNG(t)
	sum := sha256.Sum256(pngBytes)
	hash := hex.EncodeToString(sum[:])
	pin := releasekits.AssetPin{
		ID:         "asset-1",
		ObjectKey:  "org/o1/assets/a1.png",
		MediaType:  "image/png",
		SHA256:     hash,
		ByteLength: int64(len(pngBytes)),
	}

	t.Run("creative_uses_internal_signed_url_without_go_download", func(t *testing.T) {
		store := &kitSignedObjectStore{
			kitTestObjectStore: kitTestObjectStore{files: map[string][]byte{pin.ObjectKey: pngBytes}},
			signedURL:          "http://rustfs:9000/bucket",
		}
		renderer := &fakeKitRenderer{output: KitRenderOutput{
			Body:            pngBytes,
			MediaType:       "image/png",
			RendererVersion: releasekits.ExporterVersion,
		}}
		config := NewConfiguration(nil).WithObjectStore(store)
		config.automationRenderer = renderer
		artifact := &ent.KitArtifactRevision{
			ID:       "art-1",
			Kind:     kitartifactrevision.KindSCREENSHOT,
			Snapshot: releasekits.NativeSnapshot{Kind: "CREATIVE", Assets: []releasekits.AssetPin{pin}},
		}
		out, err := config.renderKitArtifact(context.Background(), "org-1", artifact, nil)
		if err != nil {
			t.Fatalf("renderKitArtifact: %v", err)
		}
		if len(out.Body) == 0 || renderer.lastRequest.AssetURLs["asset-1"] != "http://rustfs:9000/bucket/"+pin.ObjectKey {
			t.Fatalf("expected signed URL, got %+v", renderer.lastRequest.AssetURLs)
		}
		if len(renderer.lastRequest.Assets) != 0 || store.readCalls != 0 {
			t.Fatalf("creative should avoid reading/base64-encoding asset in Go: assets=%d reads=%d", len(renderer.lastRequest.Assets), store.readCalls)
		}
	})

	t.Run("draft_verifies_object_when_using_signed_url", func(t *testing.T) {
		store := &kitSignedObjectStore{
			kitTestObjectStore: kitTestObjectStore{files: map[string][]byte{pin.ObjectKey: pngBytes}},
			signedURL:          "http://rustfs:9000/bucket",
		}
		renderer := &fakeKitRenderer{output: KitRenderOutput{
			Body:            []byte("# Release Notes\n"),
			MediaType:       "text/markdown; charset=utf-8",
			RendererVersion: releasekits.ExporterVersion,
		}}
		config := NewConfiguration(nil).WithObjectStore(store)
		config.automationRenderer = renderer
		artifact := &ent.KitArtifactRevision{
			ID:       "art-2",
			Kind:     kitartifactrevision.KindANNOUNCEMENT,
			Snapshot: releasekits.NativeSnapshot{Kind: "DRAFT", Assets: []releasekits.AssetPin{pin}},
		}
		if _, err := config.renderKitArtifact(context.Background(), "org-1", artifact, nil); err != nil {
			t.Fatalf("renderKitArtifact: %v", err)
		}
		if store.readCalls != 1 {
			t.Fatalf("draft should verify pinned object once, got %d reads", store.readCalls)
		}
		if renderer.lastRequest.AssetURLs["asset-1"] == "" || len(renderer.lastRequest.Assets) != 0 {
			t.Fatalf("unexpected draft assets: urls=%v inline=%v", renderer.lastRequest.AssetURLs, renderer.lastRequest.Assets)
		}
	})

	t.Run("falls_back_to_inline_base64_when_signer_fails", func(t *testing.T) {
		store := &kitSignedObjectStore{
			kitTestObjectStore: kitTestObjectStore{files: map[string][]byte{pin.ObjectKey: pngBytes}},
			signErr:            errors.New("presign unavailable"),
		}
		renderer := &fakeKitRenderer{output: KitRenderOutput{
			Body:            pngBytes,
			MediaType:       "image/png",
			RendererVersion: releasekits.ExporterVersion,
		}}
		config := NewConfiguration(nil).WithObjectStore(store)
		config.automationRenderer = renderer
		artifact := &ent.KitArtifactRevision{
			ID:       "art-3",
			Kind:     kitartifactrevision.KindSCREENSHOT,
			Snapshot: releasekits.NativeSnapshot{Kind: "CREATIVE", Assets: []releasekits.AssetPin{pin}},
		}
		if _, err := config.renderKitArtifact(context.Background(), "org-1", artifact, nil); err != nil {
			t.Fatalf("renderKitArtifact fallback: %v", err)
		}
		if !strings.HasPrefix(renderer.lastRequest.Assets["asset-1"], "data:image/png;base64,") || len(renderer.lastRequest.AssetURLs) != 0 {
			t.Fatalf("expected inline data URI fallback, got urls=%v inline=%v", renderer.lastRequest.AssetURLs, renderer.lastRequest.Assets)
		}
	})

	t.Run("nil_object_store_fails_closed", func(t *testing.T) {
		renderer := &fakeKitRenderer{}
		config := NewConfiguration(nil)
		config.automationRenderer = renderer
		artifact := &ent.KitArtifactRevision{
			ID:       "art-4",
			Kind:     kitartifactrevision.KindSCREENSHOT,
			Snapshot: releasekits.NativeSnapshot{Kind: "CREATIVE", Assets: []releasekits.AssetPin{pin}},
		}
		if _, err := config.renderKitArtifact(context.Background(), "org-1", artifact, nil); !errors.Is(err, ErrStorageUnavailable) {
			t.Fatalf("expected ErrStorageUnavailable, got %v", err)
		}
	})
}

func TestVerifyKitObjectChecksDigestAndLength(t *testing.T) {
	body := []byte("deterministic kit artifact payload")
	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:])
	store := &kitTestObjectStore{files: map[string][]byte{
		"ok":    body,
		"short": body[:5],
		"long":  append(append([]byte(nil), body...), '!'),
	}}
	config := NewConfiguration(nil).WithObjectStore(store)
	if err := config.verifyKitObject(context.Background(), "ok", hash, int64(len(body))); err != nil {
		t.Fatalf("valid object failed: %v", err)
	}
	if err := config.verifyKitObject(context.Background(), "ok", strings.Repeat("0", 64), int64(len(body))); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("hash mismatch returned %v", err)
	}
	if err := config.verifyKitObject(context.Background(), "short", hash, int64(len(body))); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("truncated object returned %v", err)
	}
	if err := config.verifyKitObject(context.Background(), "long", hash, int64(len(body))); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("oversized object returned %v", err)
	}
}

func TestConversationRunStepsLimitPredicateBuildsWindowQuery(t *testing.T) {
	sel := entsql.Dialect(dialect.Postgres).
		Select(launchrunstep.Columns...).
		From(entsql.Table(launchrunstep.Table))
	conversationRunStepsLimitPredicate("org-1", []string{"run-a", "run-b"}, 500)(sel)
	query, args := sel.Query()
	if !strings.Contains(query, `ROW_NUMBER() OVER (PARTITION BY "runId" ORDER BY "index" ASC, "id" ASC) AS rn`) {
		t.Fatalf("unexpected window query: %s", query)
	}
	if !strings.Contains(query, `"rn" <= $4`) {
		t.Fatalf("expected bounded rn predicate, got: %s", query)
	}
	if len(args) != 4 || args[0] != "org-1" || args[1] != "run-a" || args[2] != "run-b" || args[3] != 500 {
		t.Fatalf("unexpected args: %#v", args)
	}
}

var _ io.Reader = (*bytes.Reader)(nil)

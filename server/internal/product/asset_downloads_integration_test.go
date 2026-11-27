package product

import (
	"context"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
)

type downloadObjects struct {
	recordingAssetObjects
	reads, signatures int
	beforeRead        func()
}

func (o *downloadObjects) Read(ctx context.Context, key string) ([]byte, error) {
	o.reads++
	if o.beforeRead != nil {
		o.beforeRead()
	}
	return o.recordingAssetObjects.Read(ctx, key)
}
func (o *downloadObjects) SignDownload(ctx context.Context, key string) (string, error) {
	o.signatures++
	return o.recordingAssetObjects.SignDownload(ctx, key)
}

func downloadFixture(t *testing.T) (*testWorkspace, *downloadObjects, string) {
	t.Helper()
	w := newTestWorkspace(t)
	objects := &downloadObjects{recordingAssetObjects: recordingAssetObjects{written: []byte("private media")}}
	w.repo.WithObjectStore(objects).WithAssetDownloads(strings.Repeat("a", 32), "https://shots.example.test")
	id := uuid.NewString()
	_, err := w.db.Client.Asset.Create().SetID(id).SetOrganizationID(w.org).
		SetObjectKey("org/" + w.org + "/input/" + id + "/1/private.png").SetMediaType("image/png").SetBytes(13).SetStatus("UPLOADED").Save(w.ctx)
	if err != nil {
		t.Fatal(err)
	}
	return w, objects, id
}

func downloadToken(t *testing.T, w *testWorkspace, actor Actor, id string) string {
	t.Helper()
	link, err := w.repo.SignAssetDownload(w.ctx, actor, id)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(link)
	if err != nil || u.Host != "shots.example.test" || u.Path != "/api/v1/assets/"+id+"/content" || u.Query().Get("downloadToken") == "" {
		t.Fatal("download did not use the revocable content route")
	}
	return u.Query().Get("downloadToken")
}

func TestAssetDownloadGrantRechecksMembershipAndSession(t *testing.T) {
	for _, scenario := range []struct {
		name, sql string
		want      error
	}{
		{"removed", `DELETE FROM member WHERE "userId"=$1`, publishing.ErrForbidden},
		{"banned", `UPDATE "user" SET banned=true WHERE id=$1`, publishing.ErrForbidden},
		{"expired", `UPDATE session SET "expiresAt"=now()-interval '1 minute' WHERE "userId"=$1`, publishing.ErrUnauthorized},
		{"switched", `UPDATE session SET "activeOrganizationId"='other' WHERE "userId"=$1`, publishing.ErrForbidden},
		{"logged-out", `DELETE FROM session WHERE "userId"=$1`, publishing.ErrUnauthorized},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			w, objects, id := downloadFixture(t)
			w.addMember(t, "reader", "viewer")
			reader := w.actor("reader")
			token := downloadToken(t, w, reader, id)
			for range 2 {
				body, mediaType, err := w.repo.ReadAssetDownload(w.ctx, id, token, "download-before-removal")
				if err != nil || string(body) != "private media" || mediaType != "image/png" {
					t.Fatalf("read: %q %q %v", body, mediaType, err)
				}
			}
			w.exec(t, scenario.sql, reader.UserID)
			if body, _, err := w.repo.ReadAssetDownload(w.ctx, id, token, "download-after-removal"); !errors.Is(err, scenario.want) || len(body) != 0 {
				t.Fatalf("revoked grant read: %q %v", body, err)
			}
			if objects.reads != 2 || objects.signatures != 0 {
				t.Fatalf("storage reads=%d signatures=%d", objects.reads, objects.signatures)
			}
		})
	}
}

func TestAssetDownloadGrantRejectsTamperingAndWrongResources(t *testing.T) {
	w, objects, id := downloadFixture(t)
	token := downloadToken(t, w, w.owner, id)
	sealed, _ := base64.RawURLEncoding.DecodeString(token)
	sealed[len(sealed)-1] ^= 1
	for _, bad := range []string{"", "bad", strings.Repeat("a", 4097), base64.RawURLEncoding.EncodeToString(sealed)} {
		if _, _, err := w.repo.ReadAssetDownload(w.ctx, id, bad, "tamper"); !errors.Is(err, publishing.ErrUnauthorized) {
			t.Fatalf("tamper: %v", err)
		}
	}
	for _, expiry := range []time.Time{time.Now().Add(-time.Second), time.Now().Add(10 * time.Minute)} {
		bad, err := w.repo.sealAssetDownload(assetDownloadGrant{Actor: w.owner, AssetID: id, ExpiresAt: expiry.Unix()})
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := w.repo.ReadAssetDownload(w.ctx, id, bad, "expired"); !errors.Is(err, publishing.ErrUnauthorized) {
			t.Fatalf("expiry: %v", err)
		}
	}
	foreign, _, other := downloadFixture(t)
	if _, err := w.repo.SignAssetDownload(w.ctx, w.owner, other); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign sign: %v", err)
	}
	if _, _, err := w.repo.ReadAssetDownload(w.ctx, other, token, "wrong-id"); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("wrong resource: %v", err)
	}
	foreignToken := downloadToken(t, foreign, foreign.owner, other)
	if _, _, err := w.repo.ReadAssetDownload(w.ctx, id, foreignToken, "wrong-workspace"); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("foreign token: %v", err)
	}
	w.repo.WithAssetDownloads(strings.Repeat("b", 32), "https://shots.example.test")
	if _, _, err := w.repo.ReadAssetDownload(w.ctx, id, token, "rotated-key"); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("rotated key: %v", err)
	}
	if objects.reads != 0 || objects.signatures != 0 {
		t.Fatalf("denied request reached storage: %+v", objects)
	}
}

func TestAssetDownloadRechecksAPIKeyScopeAndRevocation(t *testing.T) {
	w, objects, id := downloadFixture(t)
	keyID := "download_key_" + w.id
	w.exec(t, `INSERT INTO apikey (id,"referenceId",key,enabled,permissions,"createdAt","updatedAt") VALUES ($1,$2,'hashed',true,'{"artifact":["read"]}',now(),now())`, keyID, w.org)
	key := Actor{OrganizationID: w.org, Kind: "api_key", KeyID: keyID, RequestID: "download-key"}
	token := downloadToken(t, w, key, id)
	if _, _, err := w.repo.ReadAssetDownload(w.ctx, id, token, "key-read"); err != nil {
		t.Fatal(err)
	}
	w.exec(t, `UPDATE apikey SET permissions='{"asset":["write"]}' WHERE id=$1`, keyID)
	if _, _, err := w.repo.ReadAssetDownload(w.ctx, id, token, "scope-revoked"); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("scope: %v", err)
	}
	w.exec(t, `UPDATE apikey SET permissions='{"artifact":["read"]}', enabled=false WHERE id=$1`, keyID)
	if _, _, err := w.repo.ReadAssetDownload(w.ctx, id, token, "key-revoked"); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("disabled key: %v", err)
	}
	if objects.reads != 1 {
		t.Fatalf("revoked key reached storage: %d", objects.reads)
	}
}

func TestAssetDownloadDiscardsBytesWhenRemovedDuringStorageRead(t *testing.T) {
	w, objects, id := downloadFixture(t)
	w.addMember(t, "reader", "viewer")
	reader := w.actor("reader")
	token := downloadToken(t, w, reader, id)
	objects.beforeRead = func() {
		if _, err := w.repo.RemoveMember(w.ctx, w.owner, "member_reader_"+w.id); err != nil {
			t.Fatal(err)
		}
	}
	if body, _, err := w.repo.ReadAssetDownload(w.ctx, id, token, "during-removal"); !errors.Is(err, publishing.ErrUnauthorized) || len(body) != 0 {
		t.Fatalf("returned bytes after removal: %q %v", body, err)
	}
}

func TestSignAssetDownloadsBatchIsolationAndLimits(t *testing.T) {
	w, _, uploadedID := downloadFixture(t)
	pendingID := uuid.NewString()
	if _, err := w.db.Client.Asset.Create().SetID(pendingID).SetOrganizationID(w.org).
		SetObjectKey("org/" + w.org + "/input/" + pendingID + "/1/pending.png").SetMediaType("image/png").SetBytes(13).SetStatus("PENDING").Save(w.ctx); err != nil {
		t.Fatal(err)
	}
	foreign, _, foreignID := downloadFixture(t)
	_ = foreign

	urls, err := w.repo.SignAssetDownloads(w.ctx, w.owner, []string{uploadedID, uploadedID, pendingID, foreignID})
	if err != nil {
		t.Fatalf("SignAssetDownloads: %v", err)
	}
	if len(urls) != 1 || urls[uploadedID] == "" {
		t.Fatalf("expected only uploaded own asset, got %+v", urls)
	}
	if _, ok := urls[pendingID]; ok {
		t.Fatalf("unexpected pending asset URL: %+v", urls)
	}
	if _, ok := urls[foreignID]; ok {
		t.Fatalf("unexpected foreign asset URL: %+v", urls)
	}
	if u, err := url.Parse(urls[uploadedID]); err != nil || u.Path != "/api/v1/assets/"+uploadedID+"/content" || u.Query().Get("downloadToken") == "" {
		t.Fatalf("unexpected batch signed URL: %q (%v)", urls[uploadedID], err)
	}

	empty, err := w.repo.SignAssetDownloads(w.ctx, w.owner, nil)
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty batch: %+v %v", empty, err)
	}
	if _, err := w.repo.SignAssetDownloads(w.ctx, w.owner, []string{"not-a-uuid"}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid UUID: expected ErrInvalidInput, got %v", err)
	}
	tooMany := make([]string, maxBatchSignDownloads+1)
	for i := range tooMany {
		tooMany[i] = uuid.NewString()
	}
	if _, err := w.repo.SignAssetDownloads(w.ctx, w.owner, tooMany); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("over limit: expected ErrInvalidInput, got %v", err)
	}
}

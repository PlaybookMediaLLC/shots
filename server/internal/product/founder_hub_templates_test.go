package product

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/founderhub"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestFounderHubTemplatesPreservePrivateDraftsOrderingAndDeletions(t *testing.T) {
	w := newTestWorkspace(t)
	w.addMember(t, "viewer", "viewer")
	page, err := w.repo.ListFounderHubTemplates(w.ctx, w.owner, "", false, "")
	if err != nil || len(page.Items) != 17 {
		t.Fatalf("default templates: %+v %v", page, err)
	}
	for _, item := range page.Items {
		if !item.TemplateContent.Valid() || !item.Seeded {
			t.Fatalf("invalid seed: %+v", item)
		}
		if _, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.owner, item.ID, FounderHubTemplateUpdate{BaseVersion: &item.Version, Deleted: true}); err != nil {
			t.Fatal(err)
		}
	}
	page, err = w.repo.ListFounderHubTemplates(w.ctx, w.owner, "", false, "")
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("deleted defaults resurrected: %+v %v", page, err)
	}
	content := founderhub.TemplateContent{Icon: founderhub.TemplateIcon{Type: "emoji", Value: "📝"}, Targets: []string{}, Sections: []founderhub.TemplateSection{}}
	created, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.owner, "personal-draft", FounderHubTemplateUpdate{BaseVersion: ptr(0), Content: &content})
	if err != nil {
		t.Fatal("blank drafts must survive", err)
	}
	content.Title = "Quarterly review"
	content.Category = "Team"
	content.Description = "Keep the original content"
	content.Targets = []string{"Leadership", "Product"}
	content.Sections = []founderhub.TemplateSection{{Title: "Decisions", Description: "{{ notes }}"}, {Title: "Next steps", Description: "Preserve this order"}}
	saved, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.owner, created.ID, FounderHubTemplateUpdate{BaseVersion: &created.Version, Content: &content})
	if err != nil || !reflect.DeepEqual(saved.TemplateContent, content) {
		t.Fatalf("full content lost: %+v %v", saved, err)
	}
	if _, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.owner, created.ID, FounderHubTemplateUpdate{BaseVersion: &created.Version, Content: &content}); !errors.Is(err, publishing.ErrConflict) {
		t.Fatal("stale edit accepted", err)
	}
	pinned, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.owner, saved.ID, FounderHubTemplateUpdate{BaseVersion: &saved.Version, Pinned: ptr(true)})
	if err != nil || !pinned.Pinned || pinned.PinOrder == nil || !pinned.UpdatedAt.Equal(saved.UpdatedAt) {
		t.Fatalf("favorite changed content time: %+v %v", pinned, err)
	}
	other, err := w.repo.ListFounderHubTemplates(w.ctx, w.actor("viewer"), "", false, "")
	if err != nil || len(other.Items) != 17 {
		t.Fatalf("other user: %+v %v", other, err)
	}
	for _, item := range other.Items {
		if item.ID == saved.ID {
			t.Fatal("private template exposed to coworker")
		}
	}
	w.exec(t, `INSERT INTO "oauthRefreshToken" (id,token,"clientId","sessionId","userId","expiresAt","createdAt",scopes)
    VALUES ($1,$1,'shots-founder-hub',$2,$3,now()+interval '1 hour',now(),'["founder-hub","offline_access"]')`,
		"template_refresh_"+w.id, w.actor("viewer").SessionID, w.actor("viewer").UserID)
	seed := other.Items[0]
	importedAt := time.Now().Add(-24 * time.Hour).UTC().Truncate(time.Microsecond)
	imported, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.actor("viewer"), seed.ID, FounderHubTemplateUpdate{
		BaseVersion: &seed.Version, Content: &seed.TemplateContent, Native: true, ImportedUpdatedAt: &importedAt,
	})
	if err != nil || !imported.UpdatedAt.Equal(importedAt) {
		t.Fatalf("unchanged seed lost its desktop timestamp: %+v %v", imported, err)
	}
	if _, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.actor("viewer"), saved.ID, FounderHubTemplateUpdate{BaseVersion: &pinned.Version, Deleted: true}); !errors.Is(err, publishing.ErrConflict) {
		t.Fatal("cross-user delete accepted", err)
	}
	now := time.Now()
	if _, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.owner, saved.ID, FounderHubTemplateUpdate{BaseVersion: &pinned.Version, Content: &content, ImportedUpdatedAt: &now}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatal("browser set trusted migration timestamp", err)
	}
	for i := range 38 {
		if _, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.owner, fmt.Sprintf("draft-%02d", i), FounderHubTemplateUpdate{BaseVersion: ptr(0), Content: &content}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := w.repo.ListFounderHubTemplates(w.ctx, w.owner, "", true, "")
	if err != nil || len(first.Items) != 50 || first.NextCursor == "" {
		t.Fatalf("first page: %+v %v", first, err)
	}
	last, err := w.repo.ListFounderHubTemplates(w.ctx, w.owner, first.NextCursor, true, "")
	if err != nil || len(last.Items) != 6 || last.NextCursor != "" {
		t.Fatalf("last page: %+v %v", last, err)
	}
	unchanged, err := w.repo.ListFounderHubTemplates(w.ctx, w.owner, "", true, first.Revision)
	if err != nil || !unchanged.Unchanged || len(unchanged.Items) != 0 {
		t.Fatalf("unchanged snapshot: %+v %v", unchanged, err)
	}
	deleted, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.owner, saved.ID, FounderHubTemplateUpdate{BaseVersion: &pinned.Version, Deleted: true})
	if err != nil || len(deleted.Sections) != 0 || deleted.Description != "" {
		t.Fatalf("tombstone retained full content: %+v %v", deleted, err)
	}
	changed, err := w.repo.ListFounderHubTemplates(w.ctx, w.owner, "", true, first.Revision)
	if err != nil || changed.Unchanged || changed.Revision == first.Revision {
		t.Fatalf("deletion missed revision: %+v %v", changed, err)
	}
	w.exec(t, `INSERT INTO platform_founder_hub_template(id,"userId","templateId",content,"deletedAt")
    SELECT $1 || '-' || n, $2, 'retained-' || n, $3::jsonb, now() FROM generate_series(1,10000-(SELECT count(*)::integer FROM platform_founder_hub_template WHERE "userId"=$2)) AS n`, "retained_"+w.id, w.owner.UserID, `{"title":"","icon":{"type":"emoji","value":"📝"},"targets":[],"sections":[]}`)
	if _, err := w.repo.UpdateFounderHubTemplate(w.ctx, w.owner, "beyond-retention", FounderHubTemplateUpdate{BaseVersion: ptr(0), Content: &content}); !errors.Is(err, publishing.ErrConflict) {
		t.Fatal("retained identities exceeded bound", err)
	}
	actor := w.owner
	actor.SessionID = "revoked"
	if _, err := w.repo.ListFounderHubTemplates(w.ctx, actor, "", false, ""); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatal("revoked session accepted", err)
	}
}

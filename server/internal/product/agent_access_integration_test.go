package product

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"slices"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/apikey"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type fakeAgentClients map[string]*AgentClient

func (f fakeAgentClients) FindAgentClient(_ context.Context, clientID string) (*AgentClient, error) {
	return f[clientID], nil
}

func pkce(verifier string) *string {
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	return &challenge
}

// An owner approves an agent; its single-use code becomes a workspace API
// key with exactly the approved scopes, and a replayed code disables it.
func TestAgentConsentAndCodeExchange(t *testing.T) {
	w := newTestWorkspace(t)
	w.addMember(t, "creator", "creator")
	clients := fakeAgentClients{
		"pcd_claude": {ClientID: "pcd_claude", Name: "Claude", Dynamic: true, Public: true, RedirectURIs: []string{"https://claude.ai/api/mcp/auth_callback"}},
		"static":     {ClientID: "static", Name: "ChatGPT", RedirectURL: "https://chatgpt.com/connector/oauth/cb"},
	}
	w.repo.WithAgentClients(clients)
	s256 := "S256"
	request := AgentAuthorizationRequest{ClientID: "pcd_claude", RedirectURI: "https://claude.ai/api/mcp/auth_callback",
		CodeChallenge: pkce("verifier-1"), CodeChallengeMethod: &s256, Scopes: []string{"release:create", "artifact:read"}}

	// Validation before consent.
	for name, bad := range map[string]AgentAuthorizationRequest{
		"unknown client":       {ClientID: "nope", RedirectURI: request.RedirectURI},
		"unregistered":         {ClientID: "pcd_claude", RedirectURI: "https://evil.test/cb", CodeChallenge: request.CodeChallenge, CodeChallengeMethod: &s256},
		"public without PKCE":  {ClientID: "pcd_claude", RedirectURI: request.RedirectURI},
		"static wrong address": {ClientID: "static", RedirectURI: "https://evil.test/cb"},
	} {
		if _, err := w.repo.DescribeAgentClient(w.ctx, w.owner, bad); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s: %v", name, err)
		}
	}
	consent, err := w.repo.DescribeAgentClient(w.ctx, w.owner, request)
	if err != nil || consent.ClientName != "Claude" || consent.RedirectHost != "claude.ai" {
		t.Fatalf("describe: %+v %v", consent, err)
	}
	// Only an owner or admin may connect an agent, as only they create keys;
	// a key cannot connect another agent.
	if _, err := w.repo.ApproveAgentAccess(w.ctx, w.actor("creator"), request); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("creator consent: %v", err)
	}
	if _, err := w.repo.ApproveAgentAccess(w.ctx, Actor{OrganizationID: w.org, Kind: "api_key", KeyID: "k"}, request); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("key consent: %v", err)
	}
	bad := request
	bad.Scopes = []string{"release:approve"}
	if _, err := w.repo.ApproveAgentAccess(w.ctx, w.owner, bad); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("a scope outside the API key scopes: %v", err)
	}

	code, err := w.repo.ApproveAgentAccess(w.ctx, w.owner, request)
	if err != nil || code.RedirectURI != request.RedirectURI {
		t.Fatalf("approve: %+v %v", code, err)
	}
	for name, attempt := range map[string][4]string{
		"another client":   {"static", code.Code, "verifier-1", request.RedirectURI},
		"wrong verifier":   {"pcd_claude", code.Code, "verifier-2", request.RedirectURI},
		"another redirect": {"pcd_claude", code.Code, "verifier-1", "https://claude.ai/other"},
		"unknown code":     {"pcd_claude", "shc_unknown", "verifier-1", request.RedirectURI},
	} {
		if _, err := w.repo.ExchangeAgentCode(w.ctx, attempt[0], attempt[1], attempt[2], attempt[3]); !errors.Is(err, ErrInvalidGrant) {
			t.Errorf("%s: %v", name, err)
		}
	}
	token, err := w.repo.ExchangeAgentCode(w.ctx, "pcd_claude", code.Code, "verifier-1", request.RedirectURI)
	if err != nil || !slices.Equal(token.Scopes, []string{"artifact:read", "release:create"}) {
		t.Fatalf("exchange: %+v %v", token, err)
	}
	key, err := w.repo.VerifyAPIKey(w.ctx, token.AccessToken)
	if err != nil || key.OrganizationID != w.org || key.ClientName != "Claude" || !key.HasScope("release:create") || key.HasScope("asset:write") {
		t.Fatalf("minted key: %+v %v", key, err)
	}
	if n := w.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(w.org), auditlog.ActionIn("product.agent_access_granted",
		"product.api_key_created")).CountX(w.ctx); n != 2 {
		t.Fatalf("audit records=%d", n)
	}

	// A replayed code is refused and disables the key it produced.
	if _, err := w.repo.ExchangeAgentCode(w.ctx, "pcd_claude", code.Code, "verifier-1", request.RedirectURI); !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("replay: %v", err)
	}
	if enabled := w.db.Client.Apikey.Query().Where(apikey.ID(key.ID)).OnlyX(w.ctx).Enabled; enabled == nil || *enabled {
		t.Fatal("the key of a replayed code is still enabled")
	}
	if _, err := w.repo.VerifyAPIKey(w.ctx, token.AccessToken); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("disabled key verified: %v", err)
	}
	t.Cleanup(func() { _, _ = w.db.SQL.ExecContext(w.ctx, `DELETE FROM apikey WHERE "referenceId"=$1`, w.org) })
}

// An agent acts for the member who consented to it: when they are removed or
// leave, the keys their consents minted stop working, and a code they approved
// can no longer be exchanged. Keys of members who stay keep working.
func TestAgentKeysLeaveWithTheMemberWhoConsented(t *testing.T) {
	w := newTestWorkspace(t)
	t.Cleanup(func() { _, _ = w.db.SQL.ExecContext(w.ctx, `DELETE FROM apikey WHERE "referenceId"=$1`, w.org) })
	w.addMember(t, "removed", "admin")
	w.addMember(t, "leaver", "admin")
	w.addMember(t, "deprovisioned", "admin")
	w.repo.WithAgentClients(fakeAgentClients{
		"pcd_claude": {ClientID: "pcd_claude", Name: "Claude", Dynamic: true, Public: true, RedirectURIs: []string{"https://claude.ai/api/mcp/auth_callback"}},
	})
	s256 := "S256"
	request := AgentAuthorizationRequest{ClientID: "pcd_claude", RedirectURI: "https://claude.ai/api/mcp/auth_callback",
		CodeChallenge: pkce("verifier"), CodeChallengeMethod: &s256, Scopes: []string{"artifact:read"}}
	connect := func(actor Actor) string {
		t.Helper()
		code, err := w.repo.ApproveAgentAccess(w.ctx, actor, request)
		if err != nil {
			t.Fatal(err)
		}
		token, err := w.repo.ExchangeAgentCode(w.ctx, "pcd_claude", code.Code, "verifier", request.RedirectURI)
		if err != nil {
			t.Fatal(err)
		}
		return token.AccessToken
	}
	works := func(token string) bool {
		_, err := w.repo.VerifyAPIKey(w.ctx, token)
		return err == nil
	}
	// A key an admin created in API settings belongs to the workspace, not to them.
	w.exec(t, `INSERT INTO apikey (id,name,"referenceId",key,enabled,"createdAt","updatedAt") VALUES ($1,'Settings key',$2,$3,true,now(),now())`,
		"key_settings_"+w.id, w.org, "hashed-settings-"+w.id)
	ownerKey, removedKey, leaverKey := connect(w.owner), connect(w.actor("removed")), connect(w.actor("leaver"))
	provisionedKey := connect(w.actor("deprovisioned"))
	pending, err := w.repo.ApproveAgentAccess(w.ctx, w.actor("removed"), request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.RemoveMember(w.ctx, w.owner, "member_removed_"+w.id); err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.LeaveWorkspace(w.ctx, w.actor("leaver")); err != nil {
		t.Fatal(err)
	}
	// SCIM and enterprise provisioning remove the row through Better Auth, then report it.
	w.exec(t, `DELETE FROM member WHERE id=$1`, "member_deprovisioned_"+w.id)
	if err := w.repo.RecordAuthEvent(w.ctx, AuthEvent{Action: "product.member_removed", EntityID: "member_deprovisioned_" + w.id,
		EntityType: "member", OrganizationID: w.org, RemovedUserID: "user_deprovisioned_" + w.id}); err != nil {
		t.Fatal(err)
	}
	if works(removedKey) || works(leaverKey) || works(provisionedKey) || !works(ownerKey) {
		t.Fatalf("removed=%v leaver=%v deprovisioned=%v owner=%v", works(removedKey), works(leaverKey), works(provisionedKey), works(ownerKey))
	}
	if _, err := w.repo.ExchangeAgentCode(w.ctx, "pcd_claude", pending.Code, "verifier", request.RedirectURI); !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("a removed member's consent minted a key: %v", err)
	}
	if settings := w.db.Client.Apikey.Query().Where(apikey.ID("key_settings_" + w.id)).OnlyX(w.ctx); settings.Enabled == nil || !*settings.Enabled {
		t.Fatal("removal disabled a key that belongs to the workspace")
	}
	// A late removal event for someone who rejoined revokes nothing.
	w.addMember(t, "rejoined", "admin")
	rejoinedKey := connect(w.actor("rejoined"))
	if err := w.repo.RecordAuthEvent(w.ctx, AuthEvent{Action: "product.member_removed", EntityID: "member_rejoined_" + w.id,
		EntityType: "member", OrganizationID: w.org, RemovedUserID: "user_rejoined_" + w.id}); err != nil {
		t.Fatal(err)
	}
	if !works(rejoinedKey) {
		t.Fatal("a late removal event revoked a current member's key")
	}
	if n := w.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(w.org), auditlog.Action("product.agent_keys_revoked")).CountX(w.ctx); n != 3 {
		t.Fatalf("revocation audits=%d", n)
	}
}

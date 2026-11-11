package product

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestFounderHubNangoListsOnlyRequestedUsersCRMConnections(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/connections" || r.URL.Query().Get("endUserId") != "user-1" {
			t.Errorf("unexpected Nango request: %s", r.URL.String())
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("authorization header missing")
		}
		_, _ = w.Write([]byte(`{"connections":[{"provider_config_key":"hubspot","connection_id":"owned","end_user":{"id":"user-1"}},{"provider_config_key":"salesforce","connection_id":"foreign","end_user":{"id":"user-2"}},{"provider_config_key":"not-allowed","connection_id":"unexpected","end_user":{"id":"user-1"}}]}`))
	}))
	defer server.Close()

	got, err := NewFounderHubNangoClient("secret", server.URL, "").listConnections(context.Background(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].IntegrationID != "hubspot" || got[0].ConnectionID != "owned" {
		t.Fatalf("connections = %#v", got)
	}
}

func TestFounderHubNangoCreatesProviderScopedSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/connect/sessions" {
			t.Errorf("unexpected Nango request: %s %s", r.Method, r.URL.Path)
		}
		var body struct {
			EndUser struct {
				ID    string `json:"id"`
				Email string `json:"email"`
			} `json:"end_user"`
			Allowed []string `json:"allowed_integrations"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.EndUser.ID != "user-1" || body.EndUser.Email != "user@example.com" || len(body.Allowed) != 1 || body.Allowed[0] != "attio" {
			t.Errorf("unexpected connect session body: %#v", body)
		}
		_, _ = w.Write([]byte(`{"data":{"token":"session-token","expires_at":"2026-11-10T20:00:00Z"}}`))
	}))
	defer server.Close()

	got, err := NewFounderHubNangoClient("secret", server.URL, "https://connect.example.test").createSession(context.Background(), "user-1", "user@example.com", FounderHubCRMConnectInput{Provider: "attio", Mode: "connect"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Token != "session-token" || got.Mode != "connect" || got.APIURL != server.URL || got.ConnectURL != "https://connect.example.test" {
		t.Fatalf("session = %#v", got)
	}
}

func TestFounderHubNangoRejectsMissingConnectionList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	if _, err := NewFounderHubNangoClient("secret", server.URL, "").listConnections(context.Background(), "user-1"); err == nil {
		t.Fatal("malformed Nango response was accepted as an empty connection list")
	}
}

func TestFounderHubCRMRegistrationPersistsForNativeConsumersAndDisconnectRemovesIt(t *testing.T) {
	w := newTestWorkspace(t)
	profile, err := w.repo.GetFounderHubProfile(w.ctx, w.owner.UserID)
	if err != nil {
		t.Fatal(err)
	}
	userID := profile.AccountUserID.String()
	callerTx, err := w.db.SQL.BeginTx(w.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer callerTx.Rollback()
	if _, err := callerTx.ExecContext(w.ctx, `SET LOCAL ROLE shots_hub_authenticated`); err != nil {
		t.Fatal(err)
	}
	claims, err := json.Marshal(map[string]string{"sub": userID, "role": "shots_hub_authenticated"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := callerTx.ExecContext(w.ctx, `SELECT set_config('request.jwt.claims',$1,true)`, string(claims)); err != nil {
		t.Fatal(err)
	}
	var canWrite bool
	if err := callerTx.QueryRowContext(w.ctx, `SELECT has_function_privilege('shots_hub_authenticated', 'founder_hub.upsert_nango_connection(uuid,text,text,text)', 'EXECUTE')`).Scan(&canWrite); err != nil {
		t.Fatal(err)
	}
	if canWrite {
		t.Fatal("authenticated role can execute the Nango ownership registration function")
	}
	if _, err := callerTx.ExecContext(w.ctx, `SELECT founder_hub.upsert_nango_connection($1::uuid,'hubspot','unverified','HubSpot')`, userID); err == nil {
		t.Fatal("authenticated client directly registered an unverified Nango connection")
	}
	var listRequests atomic.Int32
	var unhealthy atomic.Bool
	var remoteDeleted atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(wr http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/connections/conn-1":
			if remoteDeleted.Load() {
				wr.WriteHeader(http.StatusNotFound)
			} else if unhealthy.Load() {
				_, _ = fmt.Fprintf(wr, `{"connection_id":"conn-1","provider_config_key":"hubspot","provider":"hubspot","end_user":{"id":%q},"errors":[{"type":"auth"}]}`, userID)
			} else {
				_, _ = fmt.Fprintf(wr, `{"connection_id":"conn-1","provider_config_key":"hubspot","provider":"hubspot","end_user":{"id":%q},"errors":[]}`, userID)
			}
		case r.Method == http.MethodGet && r.URL.Path == "/connections":
			listRequests.Add(1)
			if remoteDeleted.Load() {
				_, _ = wr.Write([]byte(`{"connections":[]}`))
			} else if unhealthy.Load() {
				_, _ = fmt.Fprintf(wr, `{"connections":[{"provider_config_key":"hubspot","provider":"hubspot","connection_id":"conn-1","end_user":{"id":%q},"errors":[{"type":"auth"}]}]}`, userID)
			} else {
				_, _ = fmt.Fprintf(wr, `{"connections":[{"provider_config_key":"hubspot","provider":"hubspot","connection_id":"conn-1","end_user":{"id":%q},"errors":[]}]}`, userID)
			}
		case r.Method == http.MethodDelete && r.URL.Path == "/connections/conn-1":
			remoteDeleted.Store(true)
			wr.WriteHeader(http.StatusNoContent)
		default:
			wr.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	repo := w.repo.WithFounderHubNango(NewFounderHubNangoClient("secret", server.URL, ""))
	input := FounderHubCRMRegisterInput{Provider: "hubspot", ConnectionID: "conn-1"}
	unhealthy.Store(true)
	if err := repo.RegisterFounderHubCRMConnection(w.ctx, w.owner, input); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("unhealthy remote connection registration error=%v", err)
	}
	unhealthy.Store(false)
	if err := repo.RegisterFounderHubCRMConnection(w.ctx, w.owner, input); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := w.db.SQL.QueryRowContext(w.ctx, `SELECT count(*) FROM founder_hub.nango_connections WHERE user_id=$1 AND integration_id='hubspot' AND connection_id='conn-1'`, userID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("native connection rows=%d err=%v", count, err)
	}
	if err := repo.DeleteFounderHubCRMConnection(w.ctx, w.owner, "hubspot", "conn-1"); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteFounderHubCRMConnection(w.ctx, w.owner, "hubspot", "conn-1"); err != nil {
		t.Fatalf("repeated disconnect after Nango deletion failed: %v", err)
	}
	if err := w.db.SQL.QueryRowContext(w.ctx, `SELECT count(*) FROM founder_hub.nango_connections WHERE user_id=$1 AND integration_id='hubspot' AND connection_id='conn-1'`, userID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("native connection rows after disconnect=%d err=%v", count, err)
	}
	if _, err := w.db.SQL.ExecContext(w.ctx, `DELETE FROM session WHERE id=$1`, w.owner.SessionID); err != nil {
		t.Fatal(err)
	}
	before := listRequests.Load()
	if _, err := repo.ListFounderHubCRMConnections(w.ctx, w.owner); err == nil {
		t.Fatal("revoked Shots session still listed CRM connections")
	}
	if listRequests.Load() != before {
		t.Fatal("Nango was called after the Shots session was revoked")
	}
}

func TestFounderHubCRMReconnectRejectsAnotherUsersConnection(t *testing.T) {
	w := newTestWorkspace(t)
	var sessionRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(wr http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/connections/foreign" {
			_, _ = wr.Write([]byte(`{"connection_id":"foreign","provider_config_key":"hubspot","provider":"hubspot","end_user":{"id":"someone-else"},"errors":[]}`))
			return
		}
		if r.Method == http.MethodPost {
			sessionRequests.Add(1)
		}
		wr.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	repo := w.repo.WithFounderHubNango(NewFounderHubNangoClient("secret", server.URL, ""))
	_, err := repo.CreateFounderHubCRMConnectSession(w.ctx, w.owner, FounderHubCRMConnectInput{Provider: "hubspot", Mode: "reconnect", ConnectionID: "foreign"})
	if !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("foreign reconnect error=%v", err)
	}
	if sessionRequests.Load() != 0 {
		t.Fatal("Nango reconnect session was requested for another user's connection")
	}
}

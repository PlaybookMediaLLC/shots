package notifications

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testSlackConnection(t *testing.T, f fixture) *SlackConnection {
	t.Helper()
	grant := &slackGrant{AppID: "A" + f.owner.UserID, AccessToken: "fixture-token", Scope: strings.Join(slackScopes, ",")}
	grant.Team.ID, grant.Team.Name = "T123", "Fixture team"
	connection, err := f.s.saveInstallation(context.Background(), f.owner, grant, "")
	if err != nil {
		t.Fatal(err)
	}
	return connection
}
func execFixture(t *testing.T, f fixture, query string, args ...any) {
	t.Helper()
	if _, err := f.s.DB.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
func TestRefreshSerializedAndReplacementPersisted(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	connection := testSlackConnection(t, f)
	raw, _ := json.Marshal(slackCredentials{AccessToken: "old", RefreshToken: "refresh-one"})
	encrypted, err := seal(raw)
	if err != nil {
		t.Fatal(err)
	}
	execFixture(t, f, `UPDATE platform_slack_installation SET encrypted_credentials=$2,expires_at=now() WHERE id=(SELECT installation_id FROM platform_slack_connection WHERE id=$1)`, connection.ID, encrypted)
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_ = r.ParseForm()
		if r.Form.Get("refresh_token") != "refresh-one" {
			t.Error("wrong refresh token")
		}
		close(entered)
		<-release
		_, _ = io.WriteString(w, `{"ok":true,"access_token":"replacement","refresh_token":"refresh-two","expires_in":43200}`)
	}))
	defer server.Close()
	f.s.SlackBase = server.URL
	done := make(chan error, 1)
	go func() {
		token, err := f.s.Token(ctx, f.owner.OrganizationID, connection.ID)
		if err == nil && token != "replacement" {
			err = errors.New("wrong token")
		}
		done <- err
	}()
	<-entered
	if _, err = f.s.Token(ctx, f.owner.OrganizationID, connection.ID); err == nil {
		t.Fatal("concurrent refresh was accepted")
	}
	close(release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	token, err := f.s.Token(ctx, f.owner.OrganizationID, connection.ID)
	if err != nil || token != "replacement" || calls.Load() != 1 {
		t.Fatalf("token=%s calls=%d err=%v", token, calls.Load(), err)
	}
	var stored string
	if err = f.s.DB.QueryRow(`SELECT encrypted_credentials FROM platform_slack_installation WHERE id=(SELECT installation_id FROM platform_slack_connection WHERE id=$1)`, connection.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	clear, err := unseal(stored)
	if err != nil || !strings.Contains(string(clear), "refresh-two") {
		t.Fatalf("replacement refresh token not persisted: %v", err)
	}
}
func TestQueuedTestLosesMembershipAndClaimIsFenced(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	t.Setenv("RESEND_API_KEY", "fixture")
	id, err := f.s.Test(ctx, f.creator, "email", "one-stable-test-request")
	if err != nil {
		t.Fatal(err)
	}
	execFixture(t, f, `DELETE FROM member WHERE "organizationId"=$1 AND "userId"=$2`, f.creator.OrganizationID, f.creator.UserID)
	calls := 0
	f.s.Send = func(context.Context, Delivery, Envelope) (Outcome, error) {
		calls++
		return Outcome{Status: "SUCCEEDED"}, nil
	}
	if err = f.s.Process(ctx); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatal("removed recipient received queued test")
	}
	execFixture(t, f, `UPDATE platform_notification_delivery SET status='CLAIMED',claim_token='new-worker' WHERE id=$1`, id)
	if err = f.s.finish(ctx, Delivery{ID: id, claimToken: "stale-worker"}, Outcome{Status: "SUCCEEDED"}); err != nil {
		t.Fatal(err)
	}
	var status string
	if err = f.s.DB.QueryRow(`SELECT status FROM platform_notification_delivery WHERE id=$1`, id).Scan(&status); err != nil || status != "CLAIMED" {
		t.Fatalf("stale completion accepted: %s %v", status, err)
	}
	execFixture(t, f, `UPDATE platform_notification_delivery SET claimed_at=now()-interval '3 minutes',send_started_at=now()-interval '3 minutes' WHERE id=$1`, id)
	if err = f.s.Process(ctx); err != nil {
		t.Fatal(err)
	}
	if err = f.s.DB.QueryRow(`SELECT status FROM platform_notification_delivery WHERE id=$1`, id).Scan(&status); err != nil || status != "UNCERTAIN" || calls != 0 {
		t.Fatalf("lost send replayed: %s %v", status, err)
	}
}
func TestIndependentRecipientsDoNotResendSuccess(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	t.Setenv("RESEND_API_KEY", "fixture")
	execFixture(t, f, `UPDATE member SET role='approver' WHERE "organizationId"=$1 AND "userId"=$2`, f.owner.OrganizationID, f.creator.UserID)
	f.event(t, "campaign_posts.submitted", "")
	sent := map[string]int{}
	f.s.Send = func(_ context.Context, d Delivery, _ Envelope) (Outcome, error) {
		sent[d.Destination]++
		if d.Destination == f.creator.UserID && sent[d.Destination] == 1 {
			return Outcome{Status: "PENDING", RetryAfter: time.Minute}, nil
		}
		return Outcome{Status: "SUCCEEDED", Receipt: "accepted"}, nil
	}
	if err := f.s.Process(ctx); err != nil {
		t.Fatal(err)
	}
	execFixture(t, f, `UPDATE platform_notification_delivery SET next_attempt_at=now() WHERE "organizationId"=$1 AND status='PENDING'`, f.owner.OrganizationID)
	if err := f.s.Process(ctx); err != nil {
		t.Fatal(err)
	}
	if sent[f.owner.UserID] != 1 || sent[f.creator.UserID] != 2 {
		t.Fatalf("recipient retry fanout=%+v", sent)
	}
	var id string
	if err := f.s.DB.QueryRow(`SELECT id FROM platform_notification_delivery WHERE "organizationId"=$1 AND channel='email' AND destination=$2 AND status='SUCCEEDED' LIMIT 1`, f.owner.OrganizationID, f.owner.UserID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Recover(ctx, f.owner, id, "retry"); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Process(ctx); err != nil {
		t.Fatal(err)
	}
	if sent[f.owner.UserID] != 1 || sent[f.creator.UserID] != 2 {
		t.Fatal("successful receipt was replayed")
	}
}

// Automatic retries stop at their budget: the delivery ends DEAD, is not sent
// again and writes no audit row. Only a person's recovery is audited, once.
func TestSpentRetryBudgetEndsDeadWithoutAudit(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	t.Setenv("RESEND_API_KEY", "fixture")
	f.event(t, "campaign_posts.submitted", "")
	sent := 0
	f.s.Send = func(_ context.Context, d Delivery, _ Envelope) (Outcome, error) {
		if d.Channel == "email" && d.Destination == f.owner.UserID {
			sent++
		}
		return Outcome{Status: "PENDING", Code: "503", RetryAfter: time.Minute}, nil
	}
	audits := func() (n int) {
		if err := f.s.DB.QueryRow(`SELECT count(*) FROM audit_log WHERE "organizationId"=$1`, f.owner.OrganizationID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := audits()
	for range 12 {
		if err := f.s.Process(ctx); err != nil {
			t.Fatal(err)
		}
		execFixture(t, f, `UPDATE platform_notification_delivery SET next_attempt_at=now() WHERE "organizationId"=$1 AND status='PENDING'`, f.owner.OrganizationID)
	}
	var id, status string
	if err := f.s.DB.QueryRow(`SELECT id,status FROM platform_notification_delivery WHERE "organizationId"=$1 AND channel='email' AND destination=$2`, f.owner.OrganizationID, f.owner.UserID).Scan(&id, &status); err != nil {
		t.Fatal(err)
	}
	if status != "DEAD" || sent != 8 || audits() != before {
		t.Fatalf("status=%s sends=%d audit rows added=%d", status, sent, audits()-before)
	}
	for range 2 {
		if err := f.s.Recover(ctx, f.owner, id, "retry"); err != nil {
			t.Fatal(err)
		}
	}
	if audits() != before+1 {
		t.Fatalf("recovery wrote %d audit rows", audits()-before)
	}
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestDesignUploadUsesManagedTokenAndRejectsForeignUploadURL(t *testing.T) {
	f := notificationFixture(t)
	connection := testSlackConnection(t, f)
	ctx := context.Background()
	uploaded, completed := 0, 0
	foreign := false
	f.s.HTTP = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		body := `{"ok":true}`
		switch r.URL.Path {
		case "/api/conversations.info":
			body = `{"ok":true,"channel":{"id":"C123","name":"launch","is_member":true}}`
		case "/api/files.getUploadURLExternal":
			target := "https://files.slack.com/upload"
			if foreign {
				target = "http://127.0.0.1/private"
			}
			body = `{"ok":true,"file_id":"F123","upload_url":"` + target + `"}`
		case "/upload":
			uploaded++
			if r.Header.Get("Authorization") != "" {
				t.Error("credentials leaked to upload host")
			}
		case "/api/files.completeUploadExternal":
			completed++
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			if strings.Contains(input["initial_comment"].(string), "<!channel>") {
				t.Error("automatic mention in design message")
			}
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("managed token absent")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	design := SlackDesign{Bytes: []byte("image"), Filename: "design.png", MediaType: "image/png", Title: "Design", Message: "<!channel>", ChannelID: "C123", ShareURL: "https://studio.example/s/share"}
	if err := f.s.UploadDesign(ctx, f.owner.OrganizationID, connection.ID, design); err != nil {
		t.Fatal(err)
	}
	if uploaded != 1 || completed != 1 {
		t.Fatalf("upload=%d complete=%d", uploaded, completed)
	}
	foreign = true
	if err := f.s.UploadDesign(ctx, f.owner.OrganizationID, connection.ID, design); err == nil {
		t.Fatal("foreign upload URL accepted")
	}
	if uploaded != 1 || completed != 1 {
		t.Fatal("foreign upload reached provider")
	}
	for _, raw := range []string{"https://files.slack.com.evil.example/x", "https://user:password@files.slack.com/x", "http://files.slack.com/x"} {
		u, _ := url.Parse(raw)
		if validSlackUpload(u) {
			t.Fatalf("accepted %s", raw)
		}
	}
}
func TestEmailRetryKeepsOriginalSenderAndRejectsTransportChange(t *testing.T) {
	t.Setenv("RESEND_API_KEY", "fixture")
	t.Setenv("AUTH_EMAIL_FROM", "Changed <changed@example.test>")
	s := &Service{EmailBase: "https://resend.test", HTTP: &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["from"] != "Original <original@example.test>" {
			t.Error("retry payload changed")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":"accepted"}`))}, nil
	})}}
	env := Envelope{To: "person@example.test", From: "Original <original@example.test>", Transport: "resend", Endpoint: s.emailEndpoint()}
	out, err := s.send(context.Background(), Delivery{ID: "stable", Channel: "email", sendStartedAt: sql.NullTime{Time: time.Now(), Valid: true}}, env)
	if err != nil || out.Status != "SUCCEEDED" {
		t.Fatalf("%+v %v", out, err)
	}
	env.Transport = "webhook"
	out, err = s.send(context.Background(), Delivery{Channel: "email"}, env)
	if err != nil || out.Status != "BLOCKED" {
		t.Fatalf("transport changed: %+v %v", out, err)
	}
}

func TestDisconnectPreservesSharedInstallationAndFencesQueuedWork(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	connection := testSlackConnection(t, f)
	other := Principal{OrganizationID: f.otherOrg, UserID: f.owner.UserID, SessionID: "other_" + f.owner.SessionID}
	execFixture(t, f, `INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,'owner',now())`, other.SessionID, other.OrganizationID, other.UserID)
	execFixture(t, f, `INSERT INTO session(id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, other.SessionID, other.UserID, other.OrganizationID)
	grant := &slackGrant{AppID: connection.AppID, AccessToken: "fixture-token", Scope: strings.Join(slackScopes, ",")}
	grant.Team.ID, grant.Team.Name = connection.TeamID, connection.TeamName
	shared, err := f.s.saveInstallation(ctx, other, grant, "")
	if err != nil {
		t.Fatal(err)
	}
	event := f.event(t, "source_app.connected", f.creator.UserID)
	for _, status := range []string{"PENDING", "CLAIMED", "SUCCEEDED"} {
		execFixture(t, f, `INSERT INTO platform_notification_delivery(id,"organizationId",event_id,kind,channel,destination,status,connection_id,claim_token,send_started_at,provider_receipt) VALUES($1,$2,$3,'source_app.connected','slack',$4,$4,$5,'worker',now(),'immutable-receipt')`, event+status, f.owner.OrganizationID, event, status, connection.ID)
	}
	if err = f.s.Disconnect(ctx, f.owner, connection.ID); err != nil {
		t.Fatal(err)
	}
	for before, want := range map[string]string{"PENDING": "SKIPPED", "CLAIMED": "UNCERTAIN", "SUCCEEDED": "SUCCEEDED"} {
		var status, claim, receipt string
		err = f.s.DB.QueryRow(`SELECT status,claim_token,provider_receipt FROM platform_notification_delivery WHERE id=$1`, event+before).Scan(&status, &claim, &receipt)
		if err != nil || status != want || before != "SUCCEEDED" && claim != "" || receipt != "immutable-receipt" {
			t.Fatalf("disconnect %s: %s %s %s %v", before, status, claim, receipt, err)
		}
	}
	if token, err := f.s.Token(ctx, other.OrganizationID, shared.ID); err != nil || token != "fixture-token" {
		t.Fatalf("shared installation lost: %v", err)
	}
	if _, err = f.s.Token(ctx, f.owner.OrganizationID, connection.ID); err == nil {
		t.Fatal("disconnected token accessible")
	}
}

func TestUncertainRefreshRequiresReconnectAndIsNotRetried(t *testing.T) {
	f := notificationFixture(t)
	connection := testSlackConnection(t, f)
	raw, _ := json.Marshal(slackCredentials{AccessToken: "old", RefreshToken: "one-use"})
	encrypted, err := seal(raw)
	if err != nil {
		t.Fatal(err)
	}
	execFixture(t, f, `UPDATE platform_slack_installation SET encrypted_credentials=$2,expires_at=now() WHERE id=(SELECT installation_id FROM platform_slack_connection WHERE id=$1)`, connection.ID, encrypted)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(503) }))
	defer server.Close()
	f.s.SlackBase = server.URL
	for range 2 {
		if _, err = f.s.Token(context.Background(), f.owner.OrganizationID, connection.ID); err == nil {
			t.Fatal("uncertain refresh returned a token")
		}
	}
	var health string
	err = f.s.DB.QueryRow(`SELECT health FROM platform_slack_installation WHERE id=(SELECT installation_id FROM platform_slack_connection WHERE id=$1)`, connection.ID).Scan(&health)
	if err != nil || health != "REFRESH_UNCERTAIN" || calls.Load() != 1 {
		t.Fatalf("health=%s calls=%d err=%v", health, calls.Load(), err)
	}
}

func TestSlackDestinationRejectsArchivedForeignAndNonmemberChannels(t *testing.T) {
	f := notificationFixture(t)
	connection := testSlackConnection(t, f)
	for _, channel := range []string{
		`{"id":"C123","name":"archived","is_member":true,"is_archived":true}`,
		`{"id":"C123","name":"private","is_private":true,"is_member":false}`,
		`{"id":"C999","name":"foreign","is_member":true}`,
		`{}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, `{"ok":true,"channel":`+channel+`}`)
		}))
		f.s.SlackBase = server.URL
		_, err := f.s.ValidateChannel(context.Background(), f.owner.OrganizationID, connection.ID, "C123")
		server.Close()
		if err == nil {
			t.Fatalf("accepted unavailable channel %s", channel)
		}
	}
}

func TestBriefDestinationUsesAssociatedCampaignInCurrentWorkspace(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	releaseID, specID := "release_"+f.campaign, "spec_"+f.campaign
	execFixture(t, f, `INSERT INTO release(id,"organizationId",title,"benefitStatement","updatedAt") VALUES($1,$2,'Release','Benefit',now())`, releaseID, f.owner.OrganizationID)
	execFixture(t, f, `UPDATE campaign SET "releaseId"=$2 WHERE id=$1`, f.campaign, releaseID)
	execFixture(t, f, `INSERT INTO release_spec(id,"organizationId","releaseId",version,status,origin,content) VALUES($1,$2,$3,1,'APPROVED','fixture','{}')`, specID, f.owner.OrganizationID, releaseID)
	allowed, row, err := f.s.resource(ctx, f.owner.OrganizationID, f.owner.UserID, "release_spec", specID)
	if err != nil || !allowed || href("release_spec", specID, row) != "/campaigns/"+f.campaign+"/spec" {
		t.Fatalf("brief link=%v allowed=%v err=%v", row, allowed, err)
	}
	allowed, _, err = f.s.resource(ctx, f.otherOrg, f.creator.UserID, "release_spec", specID)
	if err != nil || allowed {
		t.Fatal("cross-workspace brief authorized", err)
	}
}

func TestSlackHealthRevocationEmitsOnceAndRequiresReconnect(t *testing.T) {
	f := notificationFixture(t)
	connection := testSlackConnection(t, f)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{"ok":false,"error":"token_revoked"}`)
	}))
	defer server.Close()
	f.s.SlackBase = server.URL
	for range 2 {
		if err := f.s.Maintain(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	var health string
	var events int
	err := f.s.DB.QueryRow(`SELECT health FROM platform_slack_installation WHERE id=(SELECT installation_id FROM platform_slack_connection WHERE id=$1)`, connection.ID).Scan(&health)
	if err != nil || health != "RECONNECT_REQUIRED" || calls.Load() != 1 {
		t.Fatalf("health=%s calls=%d err=%v", health, calls.Load(), err)
	}
	err = f.s.DB.QueryRow(`SELECT count(*) FROM outbox_event WHERE "organizationId"=$1 AND type='activity.integration.reconnect_required'`, f.owner.OrganizationID).Scan(&events)
	if err != nil || events != 1 {
		t.Fatalf("health intent=%d %v", events, err)
	}
}

func TestPublishingConnectionUsesBackendInstallationAndKeepsLegacyID(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	socialOrg := "social_" + f.owner.OrganizationID
	execFixture(t, f, `INSERT INTO "Organization"(id,name,"updatedAt") VALUES($1,'Publishing',now())`, socialOrg)
	t.Cleanup(func() { _, _ = f.s.DB.Exec(`DELETE FROM "Organization" WHERE id=$1`, socialOrg) })
	execFixture(t, f, `INSERT INTO social_tenant_binding("organizationId","goOrganizationId","secretReference","createdAt") VALUES($1,$2,'fixture',now())`, f.owner.OrganizationID, socialOrg)
	grant := &slackGrant{AppID: "publish_" + f.owner.UserID, AccessToken: "backend-fixture", Scope: strings.Join(slackScopes, ",")}
	grant.Team.ID, grant.Team.Name = "T123", "Fixture team"
	connection, err := f.s.saveInstallation(ctx, f.owner, grant, "", false, true)
	if err != nil {
		t.Fatal(err)
	}
	var legacyID, token string
	err = f.s.DB.QueryRow(`SELECT c.legacy_social_id,i.token FROM platform_slack_connection c JOIN "Integration" i ON i.id=c.legacy_social_id WHERE c.id=$1`, connection.ID).Scan(&legacyID, &token)
	if err != nil || legacyID == "" || token != "backend-owned" {
		t.Fatalf("publishing adapter %s %s %v", legacyID, token, err)
	}
	var validationRecovered atomic.Bool
	var sends atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer backend-fixture" {
			t.Error("publishing did not use backend installation")
		}
		switch r.URL.Path {
		case "/api/conversations.info":
			if !validationRecovered.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_, _ = io.WriteString(w, `{"ok":true,"channel":{"id":"C123","name":"publishing","is_member":true}}`)
			return
		case "/api/chat.postMessage":
			sends.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true,"channels":[],"response_metadata":{"next_cursor":""}}`)
	}))
	defer server.Close()
	f.s.SlackBase = server.URL
	if _, err = f.s.SocialSlackCall(ctx, socialOrg, legacyID, "conversations.list", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.SocialSlackCall(ctx, socialOrg, legacyID, "chat.postMessage", map[string]any{"channel": "C123", "text": "fixture"})
	var provider *slackError
	if !errors.As(err, &provider) || provider.MayHaveBeenAccepted() || sends.Load() != 0 {
		t.Fatalf("read-only preflight was treated as a publication: sends=%d err=%v", sends.Load(), err)
	}
	validationRecovered.Store(true)
	_, err = f.s.SocialSlackCall(ctx, socialOrg, legacyID, "chat.postMessage", map[string]any{"channel": "C123", "text": "fixture"})
	if !errors.As(err, &provider) || !provider.MayHaveBeenAccepted() || sends.Load() != 1 {
		t.Fatalf("uncertain publication became retryable: sends=%d err=%v", sends.Load(), err)
	}
	reconnected, err := f.s.saveInstallation(ctx, f.owner, grant, connection.ID, false, true)
	if err != nil || reconnected.ID != connection.ID {
		t.Fatalf("reconnect changed compatibility ID: %+v %v", reconnected, err)
	}
	var after string
	if err = f.s.DB.QueryRow(`SELECT legacy_social_id FROM platform_slack_connection WHERE id=$1`, connection.ID).Scan(&after); err != nil || after != legacyID {
		t.Fatalf("legacy ID changed %s %v", after, err)
	}
}

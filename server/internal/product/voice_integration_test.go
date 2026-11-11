package product

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/maintenance"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/media"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// voiceObjects is object storage in memory: what was signed, stored and
// deleted, and switches to make deletes or writes fail.
type voiceObjects struct {
	mu          sync.Mutex
	stored      map[string][]byte
	deleted     []string
	signs       int
	signedSize  int64
	signedSum   []byte
	failDeletes bool
	failPuts    bool
	// onRead runs as a stored object is read back, before its bytes.
	onRead func()
}

func (o *voiceObjects) SignUpload(context.Context, string, string) (string, error) {
	return "", errors.New("assets are not used by voice notes")
}
func (o *voiceObjects) SignDownload(_ context.Context, key string) (string, error) {
	return "https://storage.example.test/get/" + key, nil
}
func (o *voiceObjects) Exists(_ context.Context, key string) (bool, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	_, ok := o.stored[key]
	return ok, nil
}
func (o *voiceObjects) Put(_ context.Context, key, _ string, body io.Reader) error {
	data, err := io.ReadAll(body)
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.failPuts {
		return errors.New("storage is down")
	}
	o.stored[key] = data
	return err
}
func (o *voiceObjects) Read(_ context.Context, key string) ([]byte, error) {
	if o.onRead != nil {
		o.onRead()
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	data, ok := o.stored[key]
	if !ok {
		return nil, media.ErrObjectNotFound
	}
	return data, nil
}
func (o *voiceObjects) Delete(_ context.Context, key string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.failDeletes {
		return errors.New("storage is down")
	}
	delete(o.stored, key)
	o.deleted = append(o.deleted, key)
	return nil
}
func (o *voiceObjects) SignChecksummedUpload(_ context.Context, key, mediaType string, size int64, digest []byte, _ time.Duration) (string, http.Header, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.signs++
	o.signedSize, o.signedSum = size, digest
	headers := http.Header{}
	headers.Set("Content-Type", mediaType)
	headers.Set("Content-Length", strconv.FormatInt(size, 10))
	headers.Set("If-None-Match", "*")
	headers.Set("X-Amz-Checksum-Sha256", base64.StdEncoding.EncodeToString(digest))
	return fmt.Sprintf("https://storage.example.test/put/%s?signature=%d", key, o.signs), headers, nil
}
func (o *voiceObjects) SignDownloadFor(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://storage.example.test/play/" + key, nil
}
func (o *voiceObjects) put(key string, data []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.stored[key] = data
}

// audio counts the stored voice recordings.
func (o *voiceObjects) audio() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	count := 0
	for key := range o.stored {
		if strings.HasPrefix(key, "voice/") {
			count++
		}
	}
	return count
}

// ledger reads back the deletion-ledger entries, each filed under the day it
// was requested and named by its event ID.
func (o *voiceObjects) ledger(t *testing.T) []media.DeletionRecord {
	t.Helper()
	o.mu.Lock()
	defer o.mu.Unlock()
	records := []media.DeletionRecord{}
	for key, body := range o.stored {
		if !strings.HasPrefix(key, "deletion-ledger/") {
			continue
		}
		var record media.DeletionRecord
		if err := json.Unmarshal(body, &record); err != nil {
			t.Fatal(err)
		}
		if key != media.DeletionLedgerDay(record.RequestedAt)+record.EventID+".json" {
			t.Fatalf("ledger entry %s is filed under the wrong key", key)
		}
		records = append(records, record)
	}
	return records
}

type voiceFixture struct {
	t       *testing.T
	ctx     context.Context
	db      *database.Database
	repo    *Configuration
	objects *voiceObjects
	id      string
	org     string
	other   string
	owner   Actor
	creator Actor
	foreign Actor
	apiKey  Actor
}

func newVoiceFixture(t *testing.T) *voiceFixture {
	t.Helper()
	url := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatalf("refusing database %q: %v", name, err)
	}
	id := cuid.New()
	f := &voiceFixture{t: t, ctx: ctx, db: db, id: id, org: "org_" + id, other: "other_" + id,
		objects: &voiceObjects{stored: map[string][]byte{}}}
	for _, organization := range []string{f.org, f.other} {
		f.exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, organization)
	}
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1 OR id=$2`, f.org, f.other)
	})
	f.owner, f.creator, f.foreign = f.member(f.org, "owner", "owner"), f.member(f.org, "creator", "creator"), f.member(f.other, "foreign", "owner")
	f.apiKey = Actor{OrganizationID: f.org, Kind: "api_key", KeyID: "key_" + id, RequestID: "request_" + id}
	f.repo = NewConfiguration(db.Client).WithObjectStore(f.objects)
	return f
}

func (f *voiceFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.SQL.ExecContext(f.ctx, query, args...); err != nil {
		f.t.Fatalf("%v\n%s", err, query)
	}
}

// value reads one value of a query as text.
func (f *voiceFixture) value(query string, args ...any) string {
	f.t.Helper()
	var value *string
	if err := f.db.SQL.QueryRowContext(f.ctx, query, args...).Scan(&value); err != nil {
		f.t.Fatalf("%v\n%s", err, query)
	}
	if value == nil {
		return "<null>"
	}
	return *value
}

func (f *voiceFixture) member(organization, label, role string) Actor {
	f.t.Helper()
	userID := "user_" + label + "_" + f.id
	f.exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Person',$2,true,now(),now())`, userID, userID+"@example.test")
	f.exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`,
		"session_"+userID, userID, organization)
	f.exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())`, "member_"+userID, organization, userID, role)
	f.t.Cleanup(func() { _, _ = f.db.SQL.ExecContext(f.ctx, `DELETE FROM "user" WHERE id=$1`, userID) })
	return Actor{OrganizationID: organization, UserID: userID, SessionID: "session_" + userID, RequestID: "request_" + f.id}
}

func (f *voiceFixture) enable(notes, audio bool) {
	f.t.Helper()
	if _, err := f.repo.UpdateVoiceWorkspaceSettings(f.ctx, f.owner, VoiceWorkspaceFlagsInput{VoiceNotes: &notes, AudioUpload: &audio}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *voiceFixture) note(actor Actor, clientNoteID string, consent bool) *VoiceNoteDetail {
	f.t.Helper()
	note, _, err := f.repo.CreateVoiceNote(f.ctx, actor, CreateVoiceNoteInput{ClientNoteID: clientNoteID, RecordedAt: time.Now(),
		RecordedTimeZone: "UTC", AudioUploadConsent: &consent})
	if err != nil {
		f.t.Fatal(err)
	}
	return note
}

func (f *voiceFixture) transcript(actor Actor, noteID, clientRevisionID string, parentID *string, origin, text string) (*VoiceTranscriptResult, bool, error) {
	return f.repo.AddVoiceTranscript(f.ctx, actor, noteID, AddVoiceTranscriptInput{ClientRevisionID: clientRevisionID, ParentID: parentID,
		Origin: origin, Text: text})
}

func (f *voiceFixture) audited(action string) int {
	f.t.Helper()
	count, err := strconv.Atoi(f.value(`SELECT count(*)::text FROM audit_log WHERE "organizationId"=$1 AND action=$2`, f.org, action))
	if err != nil {
		f.t.Fatal(err)
	}
	return count
}

func expectVoice(t *testing.T, err, kind error, what string) {
	t.Helper()
	if !errors.Is(err, kind) {
		t.Fatalf("%s: got %v, want %v", what, err, kind)
	}
}

func voicePtr[T any](value T) *T { return &value }

// Settings (rows 1-3): all off by default, owners and admins change the
// workspace, server switches and the consent rule (plan 6.9).
func TestVoiceSettingsAndGates(t *testing.T) {
	f := newVoiceFixture(t)
	ctx, on, off := f.ctx, true, false
	settings, err := f.repo.GetVoiceSettings(ctx, f.creator)
	if err != nil || settings.Workspace != (VoiceWorkspaceFlags{}) || settings.CanManage || settings.MinAppVersion != "0.0.0" ||
		settings.Limits != (VoiceLimits{MaxNoteMs: 1800000, WarnAtMs: 1500000, MinNoteMs: 1000, MaxTranscriptChars: 100000, MaxCommandChars: 2000}) ||
		settings.Switches != (VoiceSwitches{Notes: true, AudioUpload: true, Drafts: true, Parse: true, Confirm: true}) {
		t.Fatalf("defaults=%+v err=%v", settings, err)
	}
	if settings, err := f.repo.GetVoiceSettings(ctx, f.owner); err != nil || !settings.CanManage {
		t.Fatalf("owner settings=%+v err=%v", settings, err)
	}
	_, err = f.repo.GetVoiceSettings(ctx, f.apiKey)
	expectVoice(t, err, publishing.ErrForbidden, "API key settings")
	_, _, err = f.repo.CreateVoiceNote(ctx, f.creator, CreateVoiceNoteInput{ClientNoteID: "n1", RecordedAt: time.Now(), RecordedTimeZone: "UTC"})
	expectVoice(t, err, publishing.ErrForbidden, "create while voice notes are off")

	_, err = f.repo.UpdateVoiceWorkspaceSettings(ctx, f.creator, VoiceWorkspaceFlagsInput{VoiceNotes: &on})
	expectVoice(t, err, publishing.ErrForbidden, "creator changes workspace settings")
	_, err = f.repo.UpdateVoiceWorkspaceSettings(ctx, f.apiKey, VoiceWorkspaceFlagsInput{VoiceNotes: &on})
	expectVoice(t, err, publishing.ErrForbidden, "API key changes workspace settings")
	settings, err = f.repo.UpdateVoiceWorkspaceSettings(ctx, f.owner, VoiceWorkspaceFlagsInput{VoiceNotes: &on})
	if err != nil || settings.Workspace != (VoiceWorkspaceFlags{VoiceNotes: true}) || f.audited("product.voice_settings_updated") != 1 {
		t.Fatalf("enabled=%+v err=%v", settings, err)
	}
	if _, err := f.repo.UpdateVoiceWorkspaceSettings(ctx, f.owner, VoiceWorkspaceFlagsInput{VoiceNotes: &on}); err != nil || f.audited("product.voice_settings_updated") != 1 {
		t.Fatalf("an unchanged save was audited: %v", err)
	}
	if settings, err := f.repo.GetVoiceSettings(ctx, f.foreign); err != nil || settings.Workspace.VoiceNotes {
		t.Fatalf("another workspace changed: %+v %v", settings, err)
	}
	note := f.note(f.creator, "n1", false)

	t.Setenv("VOICE_COMMANDS_PARSE_DISABLED", "true")
	t.Setenv("VOICE_MIN_APP_VERSION", "1.4.0")
	if settings, err := f.repo.GetVoiceSettings(ctx, f.creator); err != nil || settings.Switches.Parse || !settings.Switches.Notes || settings.MinAppVersion != "1.4.0" {
		t.Fatalf("parse switch=%+v err=%v", settings, err)
	}
	t.Setenv("VOICE_DISABLED", "true")
	if settings, err := f.repo.GetVoiceSettings(ctx, f.creator); err != nil || settings.Switches != (VoiceSwitches{}) {
		t.Fatalf("all switches=%+v err=%v", settings, err)
	}
	_, _, err = f.repo.CreateVoiceNote(ctx, f.creator, CreateVoiceNoteInput{ClientNoteID: "n2", RecordedAt: time.Now(), RecordedTimeZone: "UTC"})
	expectVoice(t, err, publishing.ErrForbidden, "create while switched off")
	_, err = f.repo.ListVoiceNoteIndex(ctx, f.creator)
	expectVoice(t, err, publishing.ErrForbidden, "index while switched off")
	// A member can always delete their own recording.
	if err := f.repo.DeleteVoiceNote(ctx, f.creator, note.ID); err != nil {
		t.Fatalf("delete while switched off: %v", err)
	}
	t.Setenv("VOICE_DISABLED", "")

	// Audio upload needs the workspace flag, the note's consent and the switch.
	run := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 4096))
	upload := VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(run)), SHA256: digestOf(run)}
	withoutConsent, withConsent := f.note(f.creator, "n3", false), f.note(f.creator, "n4", true)
	_, err = f.repo.SignVoiceRunUpload(ctx, f.creator, withConsent.ID, 0, upload)
	expectVoice(t, err, publishing.ErrForbidden, "upload while the workspace has audio off")
	f.enable(true, true)
	_, err = f.repo.SignVoiceRunUpload(ctx, f.creator, withoutConsent.ID, 0, upload)
	expectVoice(t, err, publishing.ErrForbidden, "upload without the note's consent")
	if _, err := f.repo.SignVoiceRunUpload(ctx, f.creator, withConsent.ID, 0, upload); err != nil {
		t.Fatalf("upload with consent: %v", err)
	}
	t.Setenv("VOICE_AUDIO_UPLOAD_DISABLED", "true")
	_, err = f.repo.SignVoiceRunUpload(ctx, f.creator, withConsent.ID, 0, upload)
	expectVoice(t, err, publishing.ErrForbidden, "upload while switched off")
	if settings, err := f.repo.GetVoiceSettings(ctx, f.creator); err != nil || settings.Switches.AudioUpload || !settings.Switches.Notes {
		t.Fatalf("audio switch=%+v err=%v", settings, err)
	}

	// Commands need consent; withdrawing consent turns them off.
	_, err = f.repo.UpdateVoiceMemberSettings(ctx, f.creator, VoiceMemberSettingsInput{VoiceCommands: &on})
	expectVoice(t, err, ErrInvalidInput, "commands without consent")
	settings, err = f.repo.UpdateVoiceMemberSettings(ctx, f.creator, VoiceMemberSettingsInput{RemoteTextConsent: &on, VoiceCommands: &on})
	if err != nil || settings.Member.RemoteTextConsentAt == nil || !settings.Member.VoiceCommands {
		t.Fatalf("consent and commands=%+v err=%v", settings, err)
	}
	consentedAt := *settings.Member.RemoteTextConsentAt
	if settings, err := f.repo.UpdateVoiceMemberSettings(ctx, f.creator, VoiceMemberSettingsInput{RemoteTextConsent: &on}); err != nil ||
		!settings.Member.RemoteTextConsentAt.Equal(consentedAt) {
		t.Fatalf("consent again moved its time: %+v %v", settings, err)
	}
	settings, err = f.repo.UpdateVoiceMemberSettings(ctx, f.creator, VoiceMemberSettingsInput{RemoteTextConsent: &off})
	if err != nil || settings.Member.RemoteTextConsentAt != nil || settings.Member.VoiceCommands {
		t.Fatalf("withdrawn=%+v err=%v", settings, err)
	}
	if settings, err := f.repo.GetVoiceSettings(ctx, f.owner); err != nil || settings.Member != (VoiceMemberChoices{}) {
		t.Fatalf("another member's choices changed: %+v %v", settings, err)
	}
	_, err = f.repo.UpdateVoiceMemberSettings(ctx, f.apiKey, VoiceMemberSettingsInput{RemoteTextConsent: &on})
	expectVoice(t, err, publishing.ErrForbidden, "API key member settings")
}

// Notes (rows 4-11): idempotent create (S1), the server's receive time (S14),
// owner-only access, labels, the current-transcript rule (S9), conflicts
// (S6), redaction, and deletion that wins over every replay (S7, S8).
// A Founder Hub session acts in the workspace it names rather than the
// browser's active one, only where the person is a member, and a note stays
// private to its owner (the middleware marks the session after checking its grant).
func TestVoiceFounderHubSessionActsInTheWorkspaceItNames(t *testing.T) {
	f := newVoiceFixture(t)
	f.enable(true, false)
	notes := true
	if _, err := f.repo.UpdateVoiceWorkspaceSettings(f.ctx, f.foreign, VoiceWorkspaceFlagsInput{VoiceNotes: &notes}); err != nil {
		t.Fatal(err)
	}
	// The other workspace's owner also joins this one; their browser session stays in theirs.
	f.exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'creator',now())`,
		"member_hub_"+f.id, f.org, f.foreign.UserID)
	hub := f.foreign
	hub.OrganizationID = f.org
	_, err := f.repo.ListVoiceNoteIndex(f.ctx, hub)
	expectVoice(t, err, publishing.ErrForbidden, "a browser session outside its active workspace")

	delegated := publishing.ForDelegatedSession(f.ctx)
	note, created, err := f.repo.CreateVoiceNote(delegated, hub, CreateVoiceNoteInput{ClientNoteID: "hub-note", RecordedAt: time.Now(), RecordedTimeZone: "UTC"})
	if err != nil || !created {
		t.Fatalf("note=%+v created=%v err=%v", note, created, err)
	}
	if index, err := f.repo.ListVoiceNoteIndex(delegated, hub); err != nil || len(index) != 1 || index[0].ID != note.ID {
		t.Fatalf("index=%+v err=%v", index, err)
	}
	_, err = f.repo.GetVoiceNote(delegated, hub, f.note(f.owner, "owner-note", false).ID)
	expectVoice(t, err, publishing.ErrNotFound, "another member's note")

	stranger := f.creator
	stranger.OrganizationID = f.other
	_, err = f.repo.ListVoiceNoteIndex(delegated, stranger)
	expectVoice(t, err, publishing.ErrForbidden, "notes of a workspace the person is not a member of")
	f.exec(`DELETE FROM session WHERE id=$1`, hub.SessionID)
	_, err = f.repo.ListVoiceNoteIndex(delegated, hub)
	expectVoice(t, err, publishing.ErrUnauthorized, "a signed-out session")
}

func TestVoiceNotesSyncAndIsolation(t *testing.T) {
	f := newVoiceFixture(t)
	ctx := f.ctx
	f.enable(true, false)
	recordedAt := time.Date(2001, 2, 3, 4, 5, 6, 0, time.UTC) // a phone clock far off
	input := CreateVoiceNoteInput{ClientNoteID: "phone-note-1", Title: voicePtr(" Standup "), RecordedAt: recordedAt,
		RecordedTimeZone: "Europe/Paris", Locale: voicePtr("en-US"), DurationMs: voicePtr(42000)}
	before := time.Now().Add(-time.Second)
	note, created, err := f.repo.CreateVoiceNote(ctx, f.creator, input)
	if err != nil || !created || note.Revision != 1 || note.Title != "Standup" || !note.RecordedAt.Equal(recordedAt) ||
		note.ReceivedAt.Before(before) || note.ReceivedAt.After(time.Now().Add(time.Second)) || note.Deleted ||
		note.Transcripts == nil || note.Runs == nil || note.Command != nil {
		t.Fatalf("note=%+v created=%v err=%v", note, created, err)
	}
	changed := input
	changed.Title = voicePtr("Changed")
	replay, created, err := f.repo.CreateVoiceNote(ctx, f.creator, changed)
	if err != nil || created || replay.ID != note.ID || replay.Title != "Standup" {
		t.Fatalf("replay=%+v created=%v err=%v", replay, created, err)
	}
	if count := f.value(`SELECT count(*)::text FROM voice_note WHERE "organizationId"=$1 AND "clientNoteId"=$2`, f.org, input.ClientNoteID); count != "1" {
		t.Fatalf("notes for one clientNoteId=%s", count)
	}
	_, _, err = f.repo.CreateVoiceNote(ctx, f.creator, CreateVoiceNoteInput{ClientNoteID: "bad", RecordedAt: recordedAt, RecordedTimeZone: "Mars/Base"})
	expectVoice(t, err, ErrInvalidInput, "unknown time zone")
	ownersNote, created, err := f.repo.CreateVoiceNote(ctx, f.owner, input)
	if err != nil || !created || ownersNote.ID == note.ID {
		t.Fatalf("another member's note with the same client id=%+v err=%v", ownersNote, err)
	}

	// Private to the owner: another member or workspace finds nothing; a key is refused.
	_, err = f.repo.GetVoiceNote(ctx, f.owner, note.ID)
	expectVoice(t, err, publishing.ErrNotFound, "workspace owner reads a member's note")
	_, err = f.repo.GetVoiceNote(ctx, f.foreign, note.ID)
	expectVoice(t, err, publishing.ErrNotFound, "another workspace reads the note")
	_, err = f.repo.GetVoiceNote(ctx, f.apiKey, note.ID)
	expectVoice(t, err, publishing.ErrForbidden, "API key reads the note")
	_, err = f.repo.ListVoiceNoteIndex(ctx, f.apiKey)
	expectVoice(t, err, publishing.ErrForbidden, "API key lists notes")
	expectVoice(t, f.repo.DeleteVoiceNote(ctx, f.owner, note.ID), publishing.ErrNotFound, "workspace owner deletes a member's note")
	_, _, err = f.transcript(f.owner, note.ID, "x", nil, "user_edit", "not mine")
	expectVoice(t, err, publishing.ErrNotFound, "workspace owner edits a member's note")
	_, err = f.repo.RedactVoiceTranscript(ctx, f.foreign, note.ID, "anything0001")
	expectVoice(t, err, publishing.ErrNotFound, "another workspace redacts")
	index, err := f.repo.ListVoiceNoteIndex(ctx, f.creator)
	if err != nil || len(index) != 1 || index[0] != (VoiceNoteIndexEntry{ID: note.ID, ClientNoteID: "phone-note-1", Revision: 1}) {
		t.Fatalf("index=%+v err=%v", index, err)
	}

	// Labels: last writer wins; a replay of the same values changes nothing.
	projectID, foreignProject := "project_"+f.id, "foreign_project_"+f.id
	f.exec(`INSERT INTO project (id,"organizationId",name,document,"documentVersion") VALUES ($1,$2,'Launch','{}',1),($3,$4,'Other','{}',1)`,
		projectID, f.org, foreignProject, f.other)
	patch := UpdateVoiceNoteInput{ExpectedRevision: 1, Title: voicePtr("Retro"), ProjectID: OptionalValue[string]{Set: true, Value: &projectID}}
	patched, err := f.repo.UpdateVoiceNote(ctx, f.creator, note.ID, patch)
	if err != nil || patched.Revision != 2 || patched.Title != "Retro" || patched.ProjectID == nil || *patched.ProjectID != projectID {
		t.Fatalf("patched=%+v err=%v", patched, err)
	}
	if again, err := f.repo.UpdateVoiceNote(ctx, f.creator, note.ID, patch); err != nil || again.Revision != 2 {
		t.Fatalf("replayed patch=%+v err=%v", again, err)
	}
	_, err = f.repo.UpdateVoiceNote(ctx, f.creator, note.ID, UpdateVoiceNoteInput{ExpectedRevision: 2, ProjectID: OptionalValue[string]{Set: true, Value: &foreignProject}})
	expectVoice(t, err, ErrInvalidInput, "another workspace's project")
	cleared, err := f.repo.UpdateVoiceNote(ctx, f.creator, note.ID, UpdateVoiceNoteInput{ExpectedRevision: 2, ProjectID: OptionalValue[string]{Set: true}})
	if err != nil || cleared.ProjectID != nil || cleared.Title != "Retro" || cleared.Revision != 3 {
		t.Fatalf("cleared=%+v err=%v", cleared, err)
	}

	// The current transcript rule and conflicts.
	device, created, err := f.transcript(f.creator, note.ID, "rev-device", nil, "on_device", "first words")
	if err != nil || !created || device.Note.CurrentTranscriptRevisionID == nil || *device.Note.CurrentTranscriptRevisionID != device.Revision.ID ||
		device.Note.Revision != 4 || device.Command != nil || device.Revision.CreatedByUserID != f.creator.UserID {
		t.Fatalf("device=%+v err=%v", device, err)
	}
	if second, _, err := f.transcript(f.creator, note.ID, "rev-device-2", nil, "on_device", "again"); err != nil || *second.Note.CurrentTranscriptRevisionID != device.Revision.ID {
		t.Fatalf("a second phone transcript replaced the current one: %+v %v", second, err)
	}
	editA, _, err := f.transcript(f.creator, note.ID, "rev-edit-a", &device.Revision.ID, "user_edit", "edited on the phone")
	if err != nil || *editA.Note.CurrentTranscriptRevisionID != editA.Revision.ID || editA.Note.TranscriptConflict {
		t.Fatalf("edit=%+v err=%v", editA, err)
	}
	remote, _, err := f.transcript(f.creator, note.ID, "rev-remote", nil, "remote", "remote words")
	if err != nil || *remote.Note.CurrentTranscriptRevisionID != editA.Revision.ID {
		t.Fatalf("S9: the remote transcript replaced the member's edit: %+v %v", remote, err)
	}
	editB, _, err := f.transcript(f.creator, note.ID, "rev-edit-b", &device.Revision.ID, "user_edit", "edited on the web")
	if err != nil || !editB.Note.TranscriptConflict || *editB.Note.CurrentTranscriptRevisionID != editB.Revision.ID {
		t.Fatalf("S6: two edits of one revision=%+v err=%v", editB, err)
	}
	if detail, err := f.repo.GetVoiceNote(ctx, f.creator, note.ID); err != nil || !detail.TranscriptConflict || len(detail.Transcripts) != 5 {
		t.Fatalf("S6 detail=%+v err=%v", detail, err)
	}
	if page, err := f.repo.ListVoiceNotes(ctx, f.creator, VoiceNoteListQuery{}); err != nil || len(page.Notes) != 1 || !page.Notes[0].TranscriptConflict {
		t.Fatalf("S6 inbox=%+v err=%v", page, err)
	}
	replayed, created, err := f.transcript(f.creator, note.ID, "rev-edit-b", &device.Revision.ID, "user_edit", "different text")
	if err != nil || created || replayed.Revision.ID != editB.Revision.ID || replayed.Revision.Text != "edited on the web" || replayed.Note.Revision != editB.Note.Revision {
		t.Fatalf("replayed revision=%+v created=%v err=%v", replayed, created, err)
	}
	chosen, _, err := f.transcript(f.creator, note.ID, "rev-chosen", &editA.Revision.ID, "user_edit", strings.Repeat("chosen words ", 30))
	if err != nil || chosen.Note.TranscriptConflict {
		t.Fatalf("an edit on top of one side settles the conflict: %+v %v", chosen, err)
	}
	later, _, err := f.transcript(f.creator, note.ID, "rev-later", &chosen.Revision.ID, "user_edit", "later words")
	if err != nil || later.Note.TranscriptConflict {
		t.Fatalf("the conflict came back: %+v %v", later, err)
	}
	_, _, err = f.transcript(f.owner, ownersNote.ID, "rev-x", &device.Revision.ID, "user_edit", "parent of another note")
	expectVoice(t, err, ErrInvalidInput, "parent from another note")
	_, _, err = f.transcript(f.creator, note.ID, "rev-bad", nil, "dictation", "words")
	expectVoice(t, err, ErrInvalidInput, "unknown origin")
	page, err := f.repo.ListVoiceNotes(ctx, f.creator, VoiceNoteListQuery{})
	if err != nil || len(page.Notes) != 1 || page.Notes[0].Excerpt != "later words" || page.NextCursor != nil {
		t.Fatalf("inbox=%+v err=%v", page, err)
	}

	// Redaction (D1): text and segments cleared, audited once, never shown in the
	// audit, and no unconfirmed command row keeps transcript words.
	commandWords := func() string {
		return f.value(`SELECT status || ':' || concat(text, notice, platform, "localTime") FROM voice_command WHERE id=$1`, "command_"+f.id)
	}
	f.exec(`INSERT INTO voice_command (id,"organizationId","ownerUserId","noteId","transcriptRevisionId",status,"timeZone",text,notice,platform,"localTime")
		VALUES ($1,$2,$3,$4,$5,'expired','UTC','post the words','words','x','2026-11-12T09:00')`, "command_"+f.id, f.org, f.creator.UserID, note.ID, later.Revision.ID)
	redacted, err := f.repo.RedactVoiceTranscript(ctx, f.creator, note.ID, editA.Revision.ID)
	if err != nil || !redacted.Redacted || redacted.Text != "" || len(redacted.Segments) != 0 || f.audited("product.voice_transcript_redacted") != 1 {
		t.Fatalf("redacted=%+v err=%v", redacted, err)
	}
	if words := commandWords(); words != "expired:" {
		t.Fatalf("an expired command kept transcript words after a redaction: %s", words)
	}
	if _, err := f.repo.RedactVoiceTranscript(ctx, f.creator, note.ID, editA.Revision.ID); err != nil || f.audited("product.voice_transcript_redacted") != 1 {
		t.Fatalf("redacting again: %v", err)
	}
	_, err = f.repo.RedactVoiceTranscript(ctx, f.creator, note.ID, ownersNote.ID)
	expectVoice(t, err, publishing.ErrNotFound, "redact a revision of no such note")

	// Deletion: a tombstone, every transcript redacted, the proposal withdrawn
	// with no transcript words left on it.
	f.exec(`UPDATE voice_command SET status='proposed',text='post the words',notice='words',platform='x',"localTime"='2026-11-12T09:00' WHERE id=$1`, "command_"+f.id)
	revision := later.Note.Revision + 1 // the redaction bumped it
	if err := f.repo.DeleteVoiceNote(ctx, f.creator, note.ID); err != nil {
		t.Fatal(err)
	}
	tombstone, err := f.repo.GetVoiceNote(ctx, f.creator, note.ID)
	if err != nil || !tombstone.Deleted || tombstone.DeletedAt == nil || tombstone.Title != "" || tombstone.ProjectID != nil || tombstone.Revision != revision+1 {
		t.Fatalf("tombstone=%+v err=%v", tombstone, err)
	}
	for _, transcript := range tombstone.Transcripts {
		if !transcript.Redacted || transcript.Text != "" {
			t.Fatalf("a transcript survived deletion: %+v", transcript)
		}
	}
	if words := commandWords(); words != "withdrawn:" {
		t.Fatalf("command after deletion=%s", words)
	}
	if f.audited("product.voice_note_deleted") != 1 {
		t.Fatal("deletion was not audited")
	}
	if leaked := f.value(`SELECT count(*)::text FROM audit_log WHERE "organizationId"=$1 AND metadata::text LIKE '%words%'`, f.org); leaked != "0" {
		t.Fatalf("transcript text reached the audit log in %s entries", leaked)
	}
	if err := f.repo.DeleteVoiceNote(ctx, f.creator, note.ID); err != nil || f.audited("product.voice_note_deleted") != 1 {
		t.Fatalf("a replayed delete: %v", err)
	}
	if again, err := f.repo.GetVoiceNote(ctx, f.creator, note.ID); err != nil || again.Revision != tombstone.Revision {
		t.Fatalf("a replayed delete changed the note: %+v %v", again, err)
	}

	// S7, S8: an offline phone's replays never recreate or change it.
	_, _, err = f.repo.CreateVoiceNote(ctx, f.creator, input)
	expectVoice(t, err, publishing.ErrConflict, "replayed create of a deleted note")
	_, _, err = f.transcript(f.creator, note.ID, "rev-offline", nil, "user_edit", "offline edit")
	expectVoice(t, err, publishing.ErrConflict, "edit of a deleted note")
	_, err = f.repo.UpdateVoiceNote(ctx, f.creator, note.ID, UpdateVoiceNoteInput{ExpectedRevision: 1, Title: voicePtr("Renamed")})
	expectVoice(t, err, publishing.ErrConflict, "rename of a deleted note")
	if count := f.value(`SELECT count(*)::text FROM voice_note WHERE "ownerUserId"=$1`, f.creator.UserID); count != "1" {
		t.Fatalf("notes=%s", count)
	}
	if index, err := f.repo.ListVoiceNoteIndex(ctx, f.creator); err != nil || len(index) != 1 || !index[0].Deleted || index[0].Revision != tombstone.Revision {
		t.Fatalf("index after delete=%+v err=%v", index, err)
	}
	if page, err := f.repo.ListVoiceNotes(ctx, f.creator, VoiceNoteListQuery{}); err != nil || len(page.Notes) != 0 {
		t.Fatalf("inbox after delete=%+v err=%v", page, err)
	}

	// The inbox pages newest received first, every note once.
	for i := range 4 {
		f.note(f.owner, "page-"+strconv.Itoa(i), false)
	}
	seen, cursor := map[string]bool{}, ""
	var previous time.Time
	for {
		page, err := f.repo.ListVoiceNotes(ctx, f.owner, VoiceNoteListQuery{Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Notes {
			if seen[item.ID] || (!previous.IsZero() && item.ReceivedAt.After(previous)) {
				t.Fatalf("page out of order: %+v", item)
			}
			seen[item.ID], previous = true, item.ReceivedAt
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 5 {
		t.Fatalf("paged %d notes, want 5", len(seen))
	}
	_, err = f.repo.ListVoiceNotes(ctx, f.owner, VoiceNoteListQuery{Cursor: "%%%"})
	expectVoice(t, err, ErrInvalidInput, "bad cursor")
}

// Audio (rows 12-15): signed whole-run upload (S3, S5), a conflicting
// checksum, the server's own check of the stored object (S4, S19), playback,
// and audio deletion that keeps transcripts (D1).
func TestVoiceAudioRuns(t *testing.T) {
	f := newVoiceFixture(t)
	ctx := f.ctx
	f.enable(true, true)
	note := f.note(f.creator, "audio-note", true)
	run := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 6144)) // 192 ms at 16 kHz
	sum := digestOf(run)
	sign := func(runIndex int, input VoiceRunUploadInput) (*VoiceRunUpload, error) {
		return f.repo.SignVoiceRunUpload(ctx, f.creator, note.ID, runIndex, input)
	}
	pcm := VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(run)), SHA256: strings.ToUpper(sum), StartOffsetMs: 0, DurationMs: voicePtr(5000)}
	first, err := sign(0, pcm)
	key := "voice/" + f.org + "/" + note.ID + "/0-" + sum + ".wav"
	if err != nil || first.Method != "PUT" || !strings.Contains(first.URL, key) || first.Headers["If-None-Match"] != "*" ||
		first.Headers["X-Amz-Checksum-Sha256"] == "" || !first.ExpiresAt.After(time.Now()) {
		t.Fatalf("upload=%+v err=%v", first, err)
	}
	if f.objects.signedSize != int64(len(run)) || fmt.Sprintf("%x", f.objects.signedSum) != sum {
		t.Fatal("S5: the URL was not signed with the file's length and checksum")
	}
	second, err := sign(0, pcm)
	if err != nil || second.URL == first.URL || f.value(`SELECT count(*)::text FROM voice_audio_run WHERE "noteId"=$1`, note.ID) != "1" {
		t.Fatalf("S3: a new URL for the same run=%+v err=%v", second, err)
	}
	other := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 4096))
	_, err = sign(0, VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(other)), SHA256: digestOf(other)})
	expectVoice(t, err, publishing.ErrConflict, "another file for an uploaded run index")
	for name, input := range map[string]VoiceRunUploadInput{
		"another format":         {ContentType: "audio/mpeg", Bytes: 10, SHA256: sum},
		"AAC":                    {ContentType: "audio/aac", Bytes: 10, SHA256: sum},
		"too large WAV":          {ContentType: "audio/wav", Bytes: 201 << 20, SHA256: sum},
		"not a checksum":         {ContentType: "audio/wav", Bytes: 10, SHA256: "xyz"},
		"negative offset":        {ContentType: "audio/wav", Bytes: 10, SHA256: sum, StartOffsetMs: -1},
		"offset past 31 minutes": {ContentType: "audio/wav", Bytes: 10, SHA256: sum, StartOffsetMs: voiceMaxRunMs + 1},
	} {
		_, err := sign(1, input)
		expectVoice(t, err, ErrInvalidInput, name)
	}
	_, err = sign(50, pcm)
	expectVoice(t, err, ErrInvalidInput, "run index out of range")
	_, err = f.repo.SignVoiceRunUpload(ctx, f.owner, note.ID, 0, pcm)
	expectVoice(t, err, publishing.ErrNotFound, "another member signs an upload")

	// S4: a missing, truncated or non-audio object stays pending; the phone resends.
	complete := func(runIndex int) (*VoiceAudioRun, error) {
		return f.repo.CompleteVoiceRun(ctx, f.creator, note.ID, runIndex)
	}
	status := func(runIndex int) string {
		return f.value(`SELECT status FROM voice_audio_run WHERE "noteId"=$1 AND "runIndex"=$2`, note.ID, runIndex)
	}
	_, err = complete(0)
	expectVoice(t, err, ErrObjectMissing, "missing object")
	f.objects.put(key, run[:30])
	_, err = complete(0)
	expectVoice(t, err, ErrInvalidInput, "truncated object")
	if exists, _ := f.objects.Exists(ctx, key); exists || status(0) != "pending" {
		t.Fatalf("a truncated object was kept (exists=%v) or the run left pending (%s)", exists, status(0))
	}
	garbage := bytes.Repeat([]byte("not audio "), 10)
	if _, err := sign(2, VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(garbage)), SHA256: digestOf(garbage)}); err != nil {
		t.Fatal(err)
	}
	f.objects.put("voice/"+f.org+"/"+note.ID+"/2-"+digestOf(garbage)+".wav", garbage)
	_, err = complete(2)
	expectVoice(t, err, ErrInvalidInput, "an object that is not audio")
	if status(2) != "pending" {
		t.Fatalf("non-audio run status=%s", status(2))
	}
	_, err = complete(5)
	expectVoice(t, err, publishing.ErrNotFound, "complete a run never started")

	// S19: the decoded duration is kept, not the phone's claim.
	f.objects.put(key, run)
	revision := f.value(`SELECT revision::text FROM voice_note WHERE id=$1`, note.ID)
	available, err := complete(0)
	if err != nil || available.Status != "available" || available.DurationMs == nil || *available.DurationMs != 192 ||
		available.SampleRateHz == nil || *available.SampleRateHz != 16000 || available.SHA256 != sum {
		t.Fatalf("S19 run=%+v err=%v", available, err)
	}
	if client := f.value(`SELECT "clientDurationMs"::text FROM voice_audio_run WHERE "noteId"=$1 AND "runIndex"=0`, note.ID); client != "5000" {
		t.Fatalf("the phone's claimed duration was lost: %s", client)
	}
	bumped := f.value(`SELECT revision::text FROM voice_note WHERE id=$1`, note.ID)
	if bumped == revision {
		t.Fatal("an available run did not bump the note's revision")
	}
	if again, err := complete(0); err != nil || again.Status != "available" || f.value(`SELECT revision::text FROM voice_note WHERE id=$1`, note.ID) != bumped {
		t.Fatalf("completing again=%+v err=%v", again, err)
	}
	wav := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 48000))
	if _, err := sign(3, VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(wav)), SHA256: digestOf(wav), StartOffsetMs: 192}); err != nil {
		t.Fatal(err)
	}
	f.objects.put("voice/"+f.org+"/"+note.ID+"/3-"+digestOf(wav)+".wav", wav)
	if wavRun, err := complete(3); err != nil || *wavRun.DurationMs != 1500 || *wavRun.SampleRateHz != 16000 || wavRun.ContentType != "audio/wav" {
		t.Fatalf("wav run=%+v err=%v", wavRun, err)
	}

	// A note holds at most 31 minutes of audio across its runs.
	if _, err := sign(4, VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(wav)), SHA256: digestOf(wav), StartOffsetMs: 1692}); err != nil {
		t.Fatal(err)
	}
	f.objects.put("voice/"+f.org+"/"+note.ID+"/4-"+digestOf(wav)+".wav", wav)
	f.exec(`UPDATE voice_audio_run SET "durationMs"=$2 WHERE "noteId"=$1 AND "runIndex"=0`, note.ID, voiceMaxRunMs-2999)
	_, err = complete(4)
	expectVoice(t, err, publishing.ErrConflict, "a run past the note's 31 minutes")
	if status(4) != "pending" {
		t.Fatalf("a refused run status=%s", status(4))
	}
	f.exec(`UPDATE voice_audio_run SET "durationMs"=$2 WHERE "noteId"=$1 AND "runIndex"=0`, note.ID, voiceMaxRunMs-3000)
	if run, err := complete(4); err != nil || run.Status != "available" {
		t.Fatalf("a run filling the note exactly=%+v err=%v", run, err)
	}

	// Playback is the owner's alone, and only of an available run.
	if audio, err := f.repo.SignVoiceRunAudio(ctx, f.creator, note.ID, 0); err != nil || !strings.Contains(audio.URL, key) {
		t.Fatalf("audio=%+v err=%v", audio, err)
	}
	_, err = f.repo.SignVoiceRunAudio(ctx, f.owner, note.ID, 0)
	expectVoice(t, err, publishing.ErrNotFound, "another member plays the audio")
	_, err = f.repo.SignVoiceRunAudio(ctx, f.creator, note.ID, 2)
	expectVoice(t, err, publishing.ErrNotFound, "play a pending run")

	// D1: deleting the audio purges every object and keeps the transcripts.
	if _, _, err := f.transcript(f.creator, note.ID, "kept", nil, "on_device", "kept words"); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.DeleteVoiceAudio(ctx, f.creator, note.ID); err != nil {
		t.Fatal(err)
	}
	detail, err := f.repo.GetVoiceNote(ctx, f.creator, note.ID)
	if err != nil || len(detail.Transcripts) != 1 || detail.Transcripts[0].Text != "kept words" || len(detail.Runs) != 4 || f.audited("product.voice_audio_deleted") != 1 {
		t.Fatalf("after deleting audio=%+v err=%v", detail, err)
	}
	for _, run := range detail.Runs {
		if run.Status != "deleted" {
			t.Fatalf("run=%+v", run)
		}
	}
	// The objects go at once; the purge is recorded once no upload URL is left.
	if left := f.value(`SELECT count(*)::text FROM voice_audio_run WHERE "noteId"=$1 AND "objectPurgedAt" IS NULL`, note.ID); left != "4" || f.objects.audio() != 0 {
		t.Fatalf("unrecorded runs=%s objects=%d", left, f.objects.audio())
	}
	_, err = f.repo.SignVoiceRunAudio(ctx, f.creator, note.ID, 0)
	expectVoice(t, err, publishing.ErrNotFound, "play deleted audio")
	_, err = sign(0, pcm)
	expectVoice(t, err, publishing.ErrConflict, "upload a deleted run again")
	if err := f.repo.DeleteVoiceAudio(ctx, f.creator, note.ID); err != nil || f.audited("product.voice_audio_deleted") != 1 {
		t.Fatalf("deleting audio again: %v", err)
	}
	expectVoice(t, f.repo.DeleteVoiceAudio(ctx, f.owner, note.ID), publishing.ErrNotFound, "another member deletes the audio")

	// A purge that fails after the commit is retried by the sweep; the
	// deletion itself still succeeds.
	second2 := f.note(f.creator, "audio-note-2", true)
	if _, err := f.repo.SignVoiceRunUpload(ctx, f.creator, second2.ID, 0, pcm); err != nil {
		t.Fatal(err)
	}
	key2 := "voice/" + f.org + "/" + second2.ID + "/0-" + sum + ".wav"
	f.objects.put(key2, run)
	if _, err := f.repo.CompleteVoiceRun(ctx, f.creator, second2.ID, 0); err != nil {
		t.Fatal(err)
	}
	f.objects.failDeletes = true
	if err := f.repo.DeleteVoiceNote(ctx, f.creator, second2.ID); err != nil {
		t.Fatalf("deleting a note while storage is down: %v", err)
	}
	if purged := f.value(`SELECT "objectPurgedAt"::text FROM voice_audio_run WHERE "noteId"=$1`, second2.ID); purged != "<null>" {
		t.Fatalf("a failed purge was recorded: %s", purged)
	}
	_, err = f.repo.SweepVoice(ctx)
	expectVoice(t, err, ErrStorageUnavailable, "the sweep reports storage failures")
	f.objects.failDeletes = false
	f.exec(`UPDATE voice_audio_run SET "updatedAt"=now()-interval '21 minutes' WHERE "noteId"=$1`, second2.ID)
	if _, err := f.repo.SweepVoice(ctx); err != nil {
		t.Fatal(err)
	}
	if exists, _ := f.objects.Exists(ctx, key2); exists || f.value(`SELECT "objectPurgedAt" IS NOT NULL FROM voice_audio_run WHERE "noteId"=$1`, second2.ID) != "true" {
		t.Fatal("the sweep did not purge the deleted note's audio")
	}
	_, err = f.repo.SignVoiceRunUpload(ctx, f.creator, second2.ID, 1, pcm)
	expectVoice(t, err, publishing.ErrConflict, "upload to a deleted note")
	_, err = f.repo.CompleteVoiceRun(ctx, f.creator, second2.ID, 0)
	expectVoice(t, err, publishing.ErrConflict, "complete a run of a deleted note")

	// A note deleted while its upload is in flight: the signed PUT stays
	// valid for 15 minutes and can land after the purge. The sweep deletes it
	// again, and records the purge only once that URL has expired.
	inflight := f.note(f.creator, "audio-note-3", true)
	if _, err := f.repo.SignVoiceRunUpload(ctx, f.creator, inflight.ID, 0, pcm); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.DeleteVoiceNote(ctx, f.creator, inflight.ID); err != nil {
		t.Fatal(err)
	}
	key3 := "voice/" + f.org + "/" + inflight.ID + "/0-" + sum + ".wav"
	purged := func() string {
		return f.value(`SELECT ("objectPurgedAt" IS NOT NULL)::text FROM voice_audio_run WHERE "noteId"=$1`, inflight.ID)
	}
	f.objects.put(key3, run) // the late PUT
	if _, err := f.repo.SweepVoice(ctx); err != nil || purged() != "false" {
		t.Fatalf("purge recorded while the upload URL is valid: %s %v", purged(), err)
	}
	if exists, _ := f.objects.Exists(ctx, key3); exists {
		t.Fatal("a late upload outlived the sweep")
	}
	f.objects.put(key3, run)
	f.exec(`UPDATE voice_audio_run SET "updatedAt"=now()-interval '21 minutes' WHERE "noteId"=$1`, inflight.ID)
	if _, err := f.repo.SweepVoice(ctx); err != nil || purged() != "true" {
		t.Fatalf("purge not recorded after the URL expired: %s %v", purged(), err)
	}
	if exists, _ := f.objects.Exists(ctx, key3); exists {
		t.Fatal("the last sweep left the late upload")
	}
}

// Sweeps: unfinished uploads fail after a day (D5); a removed member is
// refused at once (S10) and their notes deleted 30 days later (D7); a deleted
// account's notes and choices go at once (D2).
func TestVoiceSweeps(t *testing.T) {
	f := newVoiceFixture(t)
	ctx := f.ctx
	f.enable(true, true)
	note := f.note(f.creator, "sweep-note", true)
	run := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 4096))
	pcm := VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(run)), SHA256: digestOf(run)}
	key := "voice/" + f.org + "/" + note.ID + "/0-" + digestOf(run) + ".wav"
	if _, err := f.repo.SignVoiceRunUpload(ctx, f.creator, note.ID, 0, pcm); err != nil {
		t.Fatal(err)
	}
	f.objects.put(key, run)
	f.exec(`UPDATE voice_audio_run SET "updatedAt"=now()-interval '25 hours' WHERE "noteId"=$1`, note.ID)
	if _, err := f.repo.SweepVoice(ctx); err != nil {
		t.Fatal(err)
	}
	if status := f.value(`SELECT status || ':' || ("failureReason" IS NOT NULL) || ':' || ("objectPurgedAt" IS NOT NULL) FROM voice_audio_run WHERE "noteId"=$1`, note.ID); status != "failed:true:false" {
		t.Fatalf("expired upload=%s", status)
	}
	if exists, _ := f.objects.Exists(ctx, key); exists {
		t.Fatal("an expired upload's object was kept")
	}
	_, err := f.repo.CompleteVoiceRun(ctx, f.creator, note.ID, 0)
	expectVoice(t, err, ErrInvalidInput, "complete an expired upload")
	if _, err := f.repo.SignVoiceRunUpload(ctx, f.creator, note.ID, 0, pcm); err != nil {
		t.Fatal(err)
	}
	f.objects.put(key, run)
	if run, err := f.repo.CompleteVoiceRun(ctx, f.creator, note.ID, 0); err != nil || run.Status != "available" {
		t.Fatalf("restarted upload=%+v err=%v", run, err)
	}

	// S10, D7: a removed member is refused; their notes wait 30 days.
	removed := f.member(f.org, "removed", "creator")
	kept := f.note(removed, "removed-note", false)
	if _, _, err := f.transcript(removed, kept.ID, "r1", nil, "on_device", "private words"); err != nil {
		t.Fatal(err)
	}
	f.exec(`DELETE FROM member WHERE "userId"=$1`, removed.UserID)
	_, _, err = f.repo.CreateVoiceNote(ctx, removed, CreateVoiceNoteInput{ClientNoteID: "unsent", RecordedAt: time.Now(), RecordedTimeZone: "UTC"})
	expectVoice(t, err, publishing.ErrForbidden, "S10: a removed member's unsent note")
	_, _, err = f.transcript(removed, kept.ID, "r2", nil, "user_edit", "words")
	expectVoice(t, err, publishing.ErrForbidden, "S10: a removed member's edit")
	removal := func() string {
		return f.value(`SELECT ("ownerRemovedAt" IS NOT NULL) || ':' || ("deletedAt" IS NOT NULL) FROM voice_note WHERE id=$1`, kept.ID)
	}
	if _, err := f.repo.SweepVoice(ctx); err != nil || removal() != "true:false" {
		t.Fatalf("removal not noted: %s %v", removal(), err)
	}
	f.exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'creator',now())`, "back_"+removed.UserID, f.org, removed.UserID)
	if _, err := f.repo.SweepVoice(ctx); err != nil || removal() != "false:false" {
		t.Fatalf("a member added back lost their notes: %s %v", removal(), err)
	}
	f.exec(`DELETE FROM member WHERE "userId"=$1`, removed.UserID)
	if _, err := f.repo.SweepVoice(ctx); err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE voice_note SET "ownerRemovedAt"=now()-interval '29 days' WHERE id=$1`, kept.ID)
	if _, err := f.repo.SweepVoice(ctx); err != nil || removal() != "true:false" {
		t.Fatalf("deleted before 30 days: %s %v", removal(), err)
	}
	f.exec(`UPDATE voice_note SET "ownerRemovedAt"=now()-interval '31 days' WHERE id=$1`, kept.ID)
	if _, err := f.repo.SweepVoice(ctx); err != nil || removal() != "true:true" {
		t.Fatalf("not deleted after 30 days: %s %v", removal(), err)
	}
	if text := f.value(`SELECT string_agg(text, '') FROM voice_transcript_revision WHERE "noteId"=$1`, kept.ID); text != "" {
		t.Fatalf("a removed member's transcript survived: %q", text)
	}
	if reason := f.value(`SELECT metadata->>'reason' FROM audit_log WHERE "organizationId"=$1 AND action='product.voice_note_deleted' AND "entityId"=$2`, f.org, kept.ID); reason != "member_removed" {
		t.Fatalf("deletion reason=%s", reason)
	}

	// D2: a deleted account's notes go at once, with its voice choices.
	gone := f.member(f.org, "gone", "creator")
	goneNote := f.note(gone, "gone-note", false)
	on := true
	if _, err := f.repo.UpdateVoiceMemberSettings(ctx, gone, VoiceMemberSettingsInput{RemoteTextConsent: &on}); err != nil {
		t.Fatal(err)
	}
	// What the account-deletion job leaves: no membership, a completed request.
	f.exec(`DELETE FROM member WHERE "userId"=$1`, gone.UserID)
	f.exec(`INSERT INTO account_deletion_request (id,"userId",status,"executeAfter","completedAt") VALUES ($1,$2,'COMPLETED',now(),now())`, "deletion_"+f.id, gone.UserID)
	if _, err := f.repo.SweepVoice(ctx); err != nil {
		t.Fatal(err)
	}
	if deleted := f.value(`SELECT ("deletedAt" IS NOT NULL)::text FROM voice_note WHERE id=$1`, goneNote.ID); deleted != "true" {
		t.Fatal("a deleted account's note was kept")
	}
	if choices := f.value(`SELECT count(*)::text FROM voice_member_settings WHERE "userId"=$1`, gone.UserID); choices != "0" {
		t.Fatal("a deleted account's voice choices were kept")
	}
	if reason := f.value(`SELECT metadata->>'reason' FROM audit_log WHERE "organizationId"=$1 AND action='product.voice_note_deleted' AND "entityId"=$2`, f.org, goneNote.ID); reason != "account_deleted" {
		t.Fatalf("deletion reason=%s", reason)
	}
	if live := f.value(`SELECT ("deletedAt" IS NULL)::text FROM voice_note WHERE id=$1`, note.ID); live != "true" {
		t.Fatal("the sweep deleted a current member's note")
	}
}

// A note holds at most 50 transcript revisions; a replay of a stored one
// still answers.
func TestVoiceTranscriptRevisionLimit(t *testing.T) {
	f := newVoiceFixture(t)
	f.enable(true, false)
	note := f.note(f.creator, "many-revisions", false)
	for i := range voiceMaxRevisions {
		if _, _, err := f.transcript(f.creator, note.ID, "rev-"+strconv.Itoa(i), nil, "user_edit", "words"); err != nil {
			t.Fatal(err)
		}
	}
	_, _, err := f.transcript(f.creator, note.ID, "rev-extra", nil, "user_edit", "words")
	expectVoice(t, err, publishing.ErrConflict, "a 51st revision")
	if _, created, err := f.transcript(f.creator, note.ID, "rev-0", nil, "user_edit", "words"); err != nil || created {
		t.Fatalf("a replay at the limit: created=%v err=%v", created, err)
	}
}

// The workspace purge keeps the organization row, so nothing cascades to
// voice data: the sweep removes it, objects first, once the upload URLs
// signed before the purge have expired.
func TestVoiceSweepRemovesAPurgedWorkspace(t *testing.T) {
	f := newVoiceFixture(t)
	ctx, on := f.ctx, true
	f.enable(true, true)
	note := f.note(f.creator, "purged-note", true)
	if _, _, err := f.transcript(f.creator, note.ID, "r1", nil, "on_device", "private words"); err != nil {
		t.Fatal(err)
	}
	run := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 4096))
	pcm := VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(run)), SHA256: digestOf(run)}
	for runIndex := range 2 {
		if _, err := f.repo.SignVoiceRunUpload(ctx, f.creator, note.ID, runIndex, pcm); err != nil {
			t.Fatal(err)
		}
		f.objects.put("voice/"+f.org+"/"+note.ID+"/"+strconv.Itoa(runIndex)+"-"+digestOf(run)+".wav", run)
	}
	if _, err := f.repo.CompleteVoiceRun(ctx, f.creator, note.ID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.UpdateVoiceMemberSettings(ctx, f.creator, VoiceMemberSettingsInput{RemoteTextConsent: &on}); err != nil {
		t.Fatal(err)
	}
	f.exec(`INSERT INTO voice_command (id,"organizationId","ownerUserId","noteId","transcriptRevisionId",status,"timeZone",text)
		SELECT $1,$2,$3,$4,id,'proposed','UTC','post the words' FROM voice_transcript_revision WHERE "noteId"=$4`, "command_"+f.id, f.org, f.creator.UserID, note.ID)
	if _, err := f.repo.UpdateVoiceWorkspaceSettings(ctx, f.foreign, VoiceWorkspaceFlagsInput{VoiceNotes: &on}); err != nil {
		t.Fatal(err)
	}
	kept := f.note(f.foreign, "kept-note", false)

	// What the workspace deletion job leaves: the organization, no members, a purged request.
	f.exec(`INSERT INTO workspace_deletion(id,"organizationId","requestedByUserId","scheduledFor","updatedAt") VALUES($1,$2,$3,now()-interval '1 day',now())`,
		"deletion_"+f.id, f.org, f.owner.UserID)
	if purged, err := (&maintenance.Store{DB: f.db.SQL}).WorkspaceCleanup(ctx); err != nil || purged != 1 {
		t.Fatalf("workspace purge=%d err=%v", purged, err)
	}
	voiceRows := func() string {
		return f.value(`SELECT concat_ws(',', (SELECT count(*) FROM voice_note WHERE "organizationId"=$1), (SELECT count(*) FROM voice_transcript_revision WHERE "organizationId"=$1),
			(SELECT count(*) FROM voice_audio_run WHERE "organizationId"=$1), (SELECT count(*) FROM voice_command WHERE "organizationId"=$1),
			(SELECT count(*) FROM voice_settings WHERE "organizationId"=$1), (SELECT count(*) FROM voice_member_settings WHERE "organizationId"=$1))`, f.org)
	}
	if _, err := f.repo.SweepVoice(ctx); err != nil || voiceRows() != "1,1,2,1,1,1" || f.objects.audio() != 2 {
		t.Fatalf("removed while upload URLs are valid: rows=%s objects=%d err=%v", voiceRows(), f.objects.audio(), err)
	}
	f.exec(`UPDATE workspace_deletion SET "purgedAt"=now()-interval '21 minutes' WHERE id=$1`, "deletion_"+f.id)
	f.objects.failDeletes = true
	_, err := f.repo.SweepVoice(ctx)
	expectVoice(t, err, ErrStorageUnavailable, "a purged workspace's objects while storage is down")
	if voiceRows() != "1,1,2,1,1,1" {
		t.Fatalf("rows went before their objects: %s", voiceRows())
	}
	f.objects.failDeletes = false
	if _, err := f.repo.SweepVoice(ctx); err != nil || voiceRows() != "0,0,0,0,0,0" || f.objects.audio() != 0 {
		t.Fatalf("after the sweep: rows=%s objects=%d err=%v", voiceRows(), f.objects.audio(), err)
	}
	if _, err := f.repo.GetVoiceNote(ctx, f.foreign, kept.ID); err != nil {
		t.Fatalf("another workspace's note: %v", err)
	}
}

// D3: each deletion a member makes is written to the R2 deletion ledger
// before it commits, and a replay after a database restore deletes it again
// through the same paths.
func TestVoiceDeletionLedger(t *testing.T) {
	f := newVoiceFixture(t)
	ctx := f.ctx
	f.enable(true, true)
	run := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 4096))
	pcm := VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(run)), SHA256: digestOf(run)}
	recorded := func(clientNoteID string) (*VoiceNoteDetail, string, string) {
		t.Helper()
		note := f.note(f.creator, clientNoteID, true)
		result, _, err := f.transcript(f.creator, note.ID, "r1", nil, "on_device", "private words")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.repo.SignVoiceRunUpload(ctx, f.creator, note.ID, 0, pcm); err != nil {
			t.Fatal(err)
		}
		key := "voice/" + f.org + "/" + note.ID + "/0-" + digestOf(run) + ".wav"
		f.objects.put(key, run)
		if _, err := f.repo.CompleteVoiceRun(ctx, f.creator, note.ID, 0); err != nil {
			t.Fatal(err)
		}
		return note, result.Revision.ID, key
	}
	state := func(noteID string) string {
		return f.value(`SELECT ("deletedAt" IS NOT NULL) || ':' || (SELECT string_agg(text, '') FROM voice_transcript_revision WHERE "noteId"=n.id) || ':' ||
			(SELECT string_agg(status, ',') FROM voice_audio_run WHERE "noteId"=n.id) FROM voice_note n WHERE id=$1`, noteID)
	}

	// Writing: one entry for each deletion, none for a replayed request.
	note, revisionID, _ := recorded("ledger-note")
	before := time.Now().Add(-time.Second)
	if _, err := f.repo.RedactVoiceTranscript(ctx, f.creator, note.ID, revisionID); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.DeleteVoiceAudio(ctx, f.creator, note.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.DeleteVoiceNote(ctx, f.creator, note.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.DeleteVoiceNote(ctx, f.creator, note.ID); err != nil {
		t.Fatal(err)
	}
	written := map[string]string{}
	for _, record := range f.objects.ledger(t) {
		if record.OrganizationID != f.org || record.RequestedAt.Before(before) || record.RequestedAt.After(time.Now()) {
			t.Fatalf("ledger entry=%+v", record)
		}
		written[record.Kind] += record.ID
	}
	if len(written) != 3 || written["voice_transcript"] != revisionID || written["voice_audio"] != note.ID || written["voice_note"] != note.ID {
		t.Fatalf("ledger=%v", written)
	}

	// A deletion the ledger cannot record does not happen.
	unrecorded, _, key := recorded("unrecorded-note")
	f.objects.failPuts = true
	expectVoice(t, f.repo.DeleteVoiceNote(ctx, f.creator, unrecorded.ID), ErrStorageUnavailable, "delete while the ledger is down")
	f.objects.failPuts = false
	if state(unrecorded.ID) != "false:private words:available" || f.objects.audio() != 1 {
		t.Fatalf("an unrecorded deletion went ahead: %s", state(unrecorded.ID))
	}
	if err := f.repo.DeleteVoiceNote(ctx, f.creator, unrecorded.ID); err != nil {
		t.Fatal(err)
	}

	// Replaying: a restore to before the deletion brings the note back whole;
	// the ledger's entries delete it again, once.
	restoredTo := before.Add(-time.Hour)
	f.exec(`UPDATE voice_note SET "deletedAt"=NULL WHERE id=$1`, unrecorded.ID)
	f.exec(`UPDATE voice_transcript_revision SET text='private words',"redactedAt"=NULL WHERE "noteId"=$1`, unrecorded.ID)
	f.exec(`UPDATE voice_audio_run SET status='available',"objectPurgedAt"=NULL WHERE "noteId"=$1`, unrecorded.ID)
	f.objects.put(key, run)
	jobs := &maintenance.Store{DB: f.db.SQL, Events: f.repo}
	if replayed, err := jobs.ReplayDeletions(ctx, f.objects.ledger(t), restoredTo); err != nil || replayed != 1 {
		t.Fatalf("replayed=%d err=%v", replayed, err)
	}
	if state(unrecorded.ID) != "true::deleted" || f.objects.audio() != 0 {
		t.Fatalf("after the replay: %s objects=%d", state(unrecorded.ID), f.objects.audio())
	}
	if reason := f.value(`SELECT metadata->>'reason' FROM audit_log WHERE action='product.voice_note_deleted' AND "entityId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, unrecorded.ID); reason != "ledger_replay" {
		t.Fatalf("replay audit reason=%s", reason)
	}
	if replayed, err := jobs.ReplayDeletions(ctx, f.objects.ledger(t), restoredTo); err != nil || replayed != 0 {
		t.Fatalf("a second replay=%d err=%v", replayed, err)
	}

	// Audio and transcript entries delete just that, and only in their workspace.
	live, liveRevision, _ := recorded("live-note")
	if changed, err := f.repo.ReplayVoiceDeletion(ctx, "voice_audio", f.other, live.ID); err != nil || changed {
		t.Fatalf("another workspace's entry changed the note: %v %v", changed, err)
	}
	if changed, err := f.repo.ReplayVoiceDeletion(ctx, "voice_audio", f.org, live.ID); err != nil || !changed || state(live.ID) != "false:private words:deleted" {
		t.Fatalf("audio replay: %v %v %s", changed, err, state(live.ID))
	}
	if changed, err := f.repo.ReplayVoiceDeletion(ctx, "voice_transcript", f.org, liveRevision); err != nil || !changed || state(live.ID) != "false::deleted" {
		t.Fatalf("transcript replay: %v %v %s", changed, err, state(live.ID))
	}
	if changed, err := f.repo.ReplayVoiceDeletion(ctx, "voice_transcript", f.org, liveRevision); err != nil || changed {
		t.Fatalf("a second transcript replay: %v %v", changed, err)
	}
	if _, err := f.repo.ReplayVoiceDeletion(ctx, "voice_memo", f.org, live.ID); err == nil {
		t.Fatal("an unknown voice kind was skipped")
	}
}

// Postgres text holds no NUL, and a phone clock a day ahead is wrong: both
// answer 400 instead of failing the write.
func TestVoiceNoteInputHardening(t *testing.T) {
	f := newVoiceFixture(t)
	ctx := f.ctx
	f.enable(true, false)
	create := func(clientNoteID string, title *string, recordedAt time.Time) error {
		_, _, err := f.repo.CreateVoiceNote(ctx, f.creator, CreateVoiceNoteInput{ClientNoteID: clientNoteID, Title: title, RecordedAt: recordedAt, RecordedTimeZone: "UTC"})
		return err
	}
	expectVoice(t, create("n\x00", nil, time.Now()), ErrInvalidInput, "a NUL in clientNoteId")
	expectVoice(t, create("titled", voicePtr("a\x00b"), time.Now()), ErrInvalidInput, "a NUL in the title")
	expectVoice(t, create("future", nil, time.Now().Add(25*time.Hour)), ErrInvalidInput, "recordedAt a day ahead")
	if err := create("ahead", nil, time.Now().Add(23*time.Hour)); err != nil {
		t.Fatalf("a clock less than a day ahead: %v", err)
	}
	note := f.note(f.creator, "plain", false)
	_, err := f.repo.UpdateVoiceNote(ctx, f.creator, note.ID, UpdateVoiceNoteInput{ExpectedRevision: 1, Title: voicePtr("a\x00b")})
	expectVoice(t, err, ErrInvalidInput, "a NUL in a new title")
	_, _, err = f.transcript(f.creator, note.ID, "r1", nil, "on_device", "a\x00b")
	expectVoice(t, err, ErrInvalidInput, "a NUL in a transcript")
}

// A run read back while the upload sweep expires it answers that the upload
// expired and must be resent, not that its audio was deleted.
func TestVoiceCompleteLosesToTheUploadSweep(t *testing.T) {
	f := newVoiceFixture(t)
	ctx := f.ctx
	f.enable(true, true)
	note := f.note(f.creator, "slow-note", true)
	run := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 4096))
	pcm := VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(run)), SHA256: digestOf(run)}
	if _, err := f.repo.SignVoiceRunUpload(ctx, f.creator, note.ID, 0, pcm); err != nil {
		t.Fatal(err)
	}
	f.objects.put("voice/"+f.org+"/"+note.ID+"/0-"+digestOf(run)+".wav", run)
	// What the sweep's expiry writes, between the read and the conditional update.
	f.objects.onRead = func() {
		f.exec(`UPDATE voice_audio_run SET status='failed',"failureReason"='The upload was not completed within 24 hours.' WHERE "noteId"=$1`, note.ID)
	}
	_, err := f.repo.CompleteVoiceRun(ctx, f.creator, note.ID, 0)
	f.objects.onRead = nil
	expectVoice(t, err, ErrInvalidInput, "complete after the sweep expired the run")
	if !strings.Contains(err.Error(), "expired") {
		t.Fatalf("message=%v", err)
	}
}

// S1 under a real race: two creates of one clientNoteId at once both answer
// with the one note, exactly one of them as created.
func TestVoiceCreateRace(t *testing.T) {
	f := newVoiceFixture(t)
	f.enable(true, false)
	type outcome struct {
		id      string
		created bool
		err     error
	}
	for round := range 20 {
		input := CreateVoiceNoteInput{ClientNoteID: "race-" + strconv.Itoa(round), RecordedAt: time.Now(), RecordedTimeZone: "UTC"}
		start, results := make(chan struct{}), make([]outcome, 2)
		var wg sync.WaitGroup
		for i := range results {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				note, created, err := f.repo.CreateVoiceNote(f.ctx, f.creator, input)
				results[i] = outcome{created: created, err: err}
				if note != nil {
					results[i].id = note.ID
				}
			}()
		}
		close(start)
		wg.Wait()
		if results[0].err != nil || results[1].err != nil || results[0].id == "" || results[0].id != results[1].id || results[0].created == results[1].created {
			t.Fatalf("round %d: %+v", round, results)
		}
		if count := f.value(`SELECT count(*)::text FROM voice_note WHERE "ownerUserId"=$1 AND "clientNoteId"=$2`, f.creator.UserID, input.ClientNoteID); count != "1" {
			t.Fatalf("round %d: %s notes", round, count)
		}
	}
}

// Every operation on a note: another member of the workspace and another
// workspace find nothing (its existence never leaks); an API key, which has
// no member, is refused. Nothing changes.
func TestVoiceNoteOperationsAreTheOwnersAlone(t *testing.T) {
	f := newVoiceFixture(t)
	ctx := f.ctx
	f.enable(true, true)
	note := f.note(f.creator, "private-note", true)
	result, _, err := f.transcript(f.creator, note.ID, "r1", nil, "on_device", "private words")
	if err != nil {
		t.Fatal(err)
	}
	run := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 4096))
	pcm := VoiceRunUploadInput{ContentType: "audio/wav", Bytes: int64(len(run)), SHA256: digestOf(run)}
	if _, err := f.repo.SignVoiceRunUpload(ctx, f.creator, note.ID, 0, pcm); err != nil {
		t.Fatal(err)
	}
	f.objects.put("voice/"+f.org+"/"+note.ID+"/0-"+digestOf(run)+".wav", run)
	if _, err := f.repo.CompleteVoiceRun(ctx, f.creator, note.ID, 0); err != nil {
		t.Fatal(err)
	}
	revision := f.value(`SELECT revision::text FROM voice_note WHERE id=$1`, note.ID)
	operations := map[string]func(Actor) error{
		"get": func(a Actor) error { _, err := f.repo.GetVoiceNote(ctx, a, note.ID); return err },
		"update": func(a Actor) error {
			_, err := f.repo.UpdateVoiceNote(ctx, a, note.ID, UpdateVoiceNoteInput{ExpectedRevision: 1, Title: voicePtr("Mine now")})
			return err
		},
		"delete": func(a Actor) error { return f.repo.DeleteVoiceNote(ctx, a, note.ID) },
		"add transcript": func(a Actor) error {
			_, _, err := f.repo.AddVoiceTranscript(ctx, a, note.ID, AddVoiceTranscriptInput{ClientRevisionID: "x", Origin: "user_edit", Text: "words"})
			return err
		},
		"redact": func(a Actor) error {
			_, err := f.repo.RedactVoiceTranscript(ctx, a, note.ID, result.Revision.ID)
			return err
		},
		"sign upload": func(a Actor) error {
			_, err := f.repo.SignVoiceRunUpload(ctx, a, note.ID, 1, pcm)
			return err
		},
		"complete":     func(a Actor) error { _, err := f.repo.CompleteVoiceRun(ctx, a, note.ID, 0); return err },
		"play":         func(a Actor) error { _, err := f.repo.SignVoiceRunAudio(ctx, a, note.ID, 0); return err },
		"delete audio": func(a Actor) error { return f.repo.DeleteVoiceAudio(ctx, a, note.ID) },
	}
	for name, operation := range operations {
		for _, caller := range []struct {
			who   string
			actor Actor
			want  error
		}{{"another member", f.owner, publishing.ErrNotFound}, {"another workspace", f.foreign, publishing.ErrNotFound}, {"an API key", f.apiKey, publishing.ErrForbidden}} {
			expectVoice(t, operation(caller.actor), caller.want, caller.who+": "+name)
		}
	}
	if after := f.value(`SELECT revision::text FROM voice_note WHERE id=$1`, note.ID); after != revision || f.objects.audio() != 1 {
		t.Fatalf("someone else changed the note: revision %s -> %s, objects=%d", revision, after, f.objects.audio())
	}
}

// The transcript's bounds, at their edges.
func TestValidVoiceTranscript(t *testing.T) {
	segments := func(lengths ...int) []schema.VoiceSegment {
		list := []schema.VoiceSegment{}
		for i, length := range lengths {
			list = append(list, schema.VoiceSegment{StartMs: i * 1000, EndMs: i*1000 + 999, Text: strings.Repeat("a", length)})
		}
		return list
	}
	for name, test := range map[string]struct {
		change func(*AddVoiceTranscriptInput)
		valid  bool
	}{
		"plain":                             {func(*AddVoiceTranscriptInput) {}, true},
		"100,000 characters":                {func(i *AddVoiceTranscriptInput) { i.Text = strings.Repeat("é", 100000) }, true},
		"100,001 characters":                {func(i *AddVoiceTranscriptInput) { i.Text = strings.Repeat("é", 100001) }, false},
		"segments of 100,000 characters":    {func(i *AddVoiceTranscriptInput) { i.Segments = segments(60000, 40000) }, true},
		"segments of 100,001 characters":    {func(i *AddVoiceTranscriptInput) { i.Segments = segments(60000, 40001) }, false},
		"a segment ending before it starts": {func(i *AddVoiceTranscriptInput) { i.Segments = []schema.VoiceSegment{{StartMs: 5, EndMs: 4}} }, false},
		"a segment starting before zero":    {func(i *AddVoiceTranscriptInput) { i.Segments = []schema.VoiceSegment{{StartMs: -1, EndMs: 4}} }, false},
		"a NUL in a segment":                {func(i *AddVoiceTranscriptInput) { i.Segments = []schema.VoiceSegment{{Text: "a\x00b"}} }, false},
		"a NUL in the text":                 {func(i *AddVoiceTranscriptInput) { i.Text = "a\x00b" }, false},
		"a 100-character clientRevisionId":  {func(i *AddVoiceTranscriptInput) { i.ClientRevisionID = strings.Repeat("r", 100) }, true},
		"a 101-character clientRevisionId":  {func(i *AddVoiceTranscriptInput) { i.ClientRevisionID = strings.Repeat("r", 101) }, false},
		"no clientRevisionId":               {func(i *AddVoiceTranscriptInput) { i.ClientRevisionID = "" }, false},
		"a NUL in the clientRevisionId":     {func(i *AddVoiceTranscriptInput) { i.ClientRevisionID = "r\x00" }, false},
		"an empty engine":                   {func(i *AddVoiceTranscriptInput) { i.Engine = voicePtr("") }, false},
		"a 65-character engine":             {func(i *AddVoiceTranscriptInput) { i.Engine = voicePtr(strings.Repeat("e", 65)) }, false},
		"a NUL in the engine":               {func(i *AddVoiceTranscriptInput) { i.Engine = voicePtr("e\x00") }, false},
		"an unknown origin":                 {func(i *AddVoiceTranscriptInput) { i.Origin = "dictation" }, false},
		"a locale that is not a tag":        {func(i *AddVoiceTranscriptInput) { i.Locale = voicePtr("en US") }, false},
	} {
		input := AddVoiceTranscriptInput{ClientRevisionID: "r", Origin: "on_device", Text: "words"}
		test.change(&input)
		if err := validVoiceTranscript(input); (err == nil) != test.valid || (err != nil && !errors.Is(err, ErrInvalidInput)) {
			t.Errorf("%s: err=%v", name, err)
		}
	}
}

// The inbox pages by the server's receive time, breaking ties by id, and an
// aged tombstone still refuses a replayed create after the sweep (S8).
func TestVoiceNotePagingAndAgedTombstones(t *testing.T) {
	f := newVoiceFixture(t)
	ctx := f.ctx
	f.enable(true, false)
	for i := range 3 {
		f.note(f.creator, "same-time-"+strconv.Itoa(i), false)
	}
	f.exec(`UPDATE voice_note SET "receivedAt"='2026-11-11 09:00:00' WHERE "ownerUserId"=$1`, f.creator.UserID)
	order, cursor := []string{}, ""
	for {
		page, err := f.repo.ListVoiceNotes(ctx, f.creator, VoiceNoteListQuery{Limit: 1, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Notes {
			order = append(order, item.ID)
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if want := f.value(`SELECT string_agg(id, ',' ORDER BY id DESC) FROM voice_note WHERE "ownerUserId"=$1`, f.creator.UserID); strings.Join(order, ",") != want {
		t.Fatalf("paged %v, want %s", order, want)
	}

	input := CreateVoiceNoteInput{ClientNoteID: "old-note", RecordedAt: time.Now(), RecordedTimeZone: "UTC"}
	note, _, err := f.repo.CreateVoiceNote(ctx, f.creator, input)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.repo.DeleteVoiceNote(ctx, f.creator, note.ID); err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE voice_note SET "deletedAt"=now()-interval '400 days',"updatedAt"=now()-interval '400 days' WHERE id=$1`, note.ID)
	if _, err := f.repo.SweepVoice(ctx); err != nil {
		t.Fatal(err)
	}
	_, _, err = f.repo.CreateVoiceNote(ctx, f.creator, input)
	expectVoice(t, err, publishing.ErrConflict, "a replayed create of a note deleted 400 days ago")
}

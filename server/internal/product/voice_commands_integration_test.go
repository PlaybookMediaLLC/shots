package product

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicecommand"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/platformai"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// fakeVoiceModel answers model calls from a function and counts them.
type fakeVoiceModel struct {
	mu     sync.Mutex
	calls  int
	answer func(platformai.Request) (string, error)
}

func (m *fakeVoiceModel) Structured(_ context.Context, request platformai.Request, out any) (platformai.Usage, error) {
	m.mu.Lock()
	m.calls++
	answer := m.answer
	m.mu.Unlock()
	reply, err := answer(request)
	if err != nil {
		return platformai.Usage{}, err
	}
	return platformai.Usage{CostUSD: 0.002}, json.Unmarshal([]byte(reply), out)
}

func (m *fakeVoiceModel) set(answer func(platformai.Request) (string, error)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.answer, m.calls = answer, 0
}

func (m *fakeVoiceModel) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

// voiceFixture is a workspace with an X account, an owner and a creator, and
// voice notes written straight to the tables the notes domain owns.
type voiceFixture struct {
	t                  *testing.T
	ctx                context.Context
	db                 *database.Database
	repo               *Configuration
	model              *fakeVoiceModel
	meter              *recordingMonthlyMeter
	org, other         string
	owner, creator     Actor
	foreign            Actor
	xChannel, foreignX string
	// when is a wall time two days out, in UTC, that the fake model proposes.
	when string
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
	f := &voiceFixture{t: t, ctx: ctx, db: db, model: &fakeVoiceModel{}, meter: &recordingMonthlyMeter{}, org: "org_" + id, other: "other_" + id,
		when: time.Now().UTC().Add(48*time.Hour).Format("2006-01-02") + "T10:00"}
	f.repo = NewConfiguration(db.Client).WithMonthlyMeter(f.meter).WithAutomationModel(f.model)
	f.model.set(f.tweet)
	for _, organization := range []string{f.org, f.other} {
		f.exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, organization)
		subscribe(t, ctx, f.repo, organization, "pro")
		if _, err := f.repo.defaultSocialSet(ctx, organization); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM scheduled_post WHERE "organizationId" IN ($1,$2)`, f.org, f.other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM content_draft WHERE "organizationId" IN ($1,$2)`, f.org, f.other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id IN ($1,$2)`, f.org, f.other)
	})
	f.owner, f.creator, f.foreign = f.member(f.org, "owner", "owner"), f.member(f.org, "creator", "creator"), f.member(f.other, "foreign", "owner")
	connect := func(org string, actor Actor) string {
		socialCredentialFixture(t, ctx, db.SQL, org)("x-"+org, "x")
		connection, err := f.repo.auth.CreateConnection(ctx, publishing.Actor{Organization: org, UserID: actor.UserID, RequestID: actor.RequestID, Type: "USER"},
			publishing.CreateConnectionInput{ExternalAccountID: "x-" + org, Platform: "x", ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
		if err != nil {
			t.Fatal(err)
		}
		return connection.ID
	}
	f.xChannel, f.foreignX = connect(f.org, f.owner), connect(f.other, f.foreign)
	return f
}

func (f *voiceFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.SQL.ExecContext(f.ctx, query, args...); err != nil {
		f.t.Fatalf("%v\n%s", err, query)
	}
}

func (f *voiceFixture) member(org, label, role string) Actor {
	userID := "user_" + label + "_" + org
	f.exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Person',$2,true,now(),now())`, userID, userID+"@example.test")
	f.exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`,
		"session_"+userID, userID, org)
	f.exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())`, "member_"+userID, org, userID, role)
	f.t.Cleanup(func() { _, _ = f.db.SQL.ExecContext(f.ctx, `DELETE FROM "user" WHERE id=$1`, userID) })
	return Actor{OrganizationID: org, UserID: userID, SessionID: "session_" + userID, RequestID: "request_" + org}
}

// enable turns voice commands and draft generation on for the workspace and
// the member, with the remote-text consent the member switch needs.
func (f *voiceFixture) enable(actor Actor, workspace, member bool) {
	f.t.Helper()
	f.exec(`DELETE FROM voice_settings WHERE "organizationId"=$1`, actor.OrganizationID)
	f.exec(`DELETE FROM voice_member_settings WHERE "organizationId"=$1 AND "userId"=$2`, actor.OrganizationID, actor.UserID)
	if err := f.db.Client.VoiceSettings.Create().SetID(actor.OrganizationID).SetVoiceCommands(workspace).SetDraftGeneration(workspace).
		Exec(f.ctx); err != nil {
		f.t.Fatal(err)
	}
	if err := f.db.Client.VoiceMemberSettings.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetUserID(actor.UserID).
		SetRemoteTextConsentAt(time.Now()).SetVoiceCommands(member).Exec(f.ctx); err != nil {
		f.t.Fatal(err)
	}
}

// note writes a note with one current transcript revision.
func (f *voiceFixture) note(actor Actor, transcript string) (string, string) {
	f.t.Helper()
	noteID, revisionID := cuid.New(), cuid.New()
	if _, err := f.db.Client.VoiceNote.Create().SetID(noteID).SetOrganizationID(actor.OrganizationID).SetOwnerUserID(actor.UserID).
		SetClientNoteID(noteID).SetTitle("Walk and talk").SetRecordedAt(time.Now().Add(-time.Hour)).SetRecordedTimeZone("UTC").Save(f.ctx); err != nil {
		f.t.Fatal(err)
	}
	f.revise(actor, noteID, revisionID, transcript)
	return noteID, revisionID
}

// revise adds a revision and makes it the note's current one.
func (f *voiceFixture) revise(actor Actor, noteID, revisionID, transcript string) {
	f.t.Helper()
	if _, err := f.db.Client.VoiceTranscriptRevision.Create().SetID(revisionID).SetOrganizationID(actor.OrganizationID).SetNoteID(noteID).
		SetClientRevisionID(revisionID).SetOrigin("user_edit").SetText(transcript).SetCreatedByUserID(actor.UserID).Save(f.ctx); err != nil {
		f.t.Fatal(err)
	}
	f.exec(`UPDATE voice_note SET "currentTranscriptRevisionId"=$1 WHERE id=$2`, revisionID, noteID)
}

const voiceTweet = "Shots, post the following tweet at 10 am on Friday: entrepreneurship is hard."

func (f *voiceFixture) tweet(platformai.Request) (string, error) {
	return `{"action":"schedule_post","platform":"x","text":"Entrepreneurship is hard.","local_time":"` + f.when +
		`","guessed":[],"second_request":false,"unsupported":null}`, nil
}

func (f *voiceFixture) command(noteID string) *ent.VoiceCommand {
	f.t.Helper()
	row, err := f.db.Client.VoiceCommand.Query().Where(voicecommand.NoteID(noteID)).Only(f.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	return row
}

func (f *voiceFixture) propose(actor Actor, noteID, revisionID string) *VoiceCommand {
	f.t.Helper()
	command, err := f.repo.proposeVoiceCommand(f.ctx, actor, noteID, revisionID)
	if err != nil {
		f.t.Fatal(err)
	}
	return command
}

func (f *voiceFixture) confirmInput() VoiceCommandConfirmInput {
	return VoiceCommandConfirmInput{Text: "Entrepreneurship is hard.", ChannelConnectionID: f.xChannel, LocalTime: f.when, TimeZone: "UTC"}
}

func (f *voiceFixture) drafts(revisionID string) []*ent.ContentDraft {
	f.t.Helper()
	rows, err := f.db.Client.ContentDraft.Query().Where(contentdraft.SourceVoiceRevisionID(revisionID)).All(f.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	return rows
}

func (f *voiceFixture) posts(draftID string) int {
	f.t.Helper()
	n, err := f.db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draftID), scheduledpost.StatusNEQ(scheduledpost.StatusCANCELLED)).Count(f.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestVoiceCommandProposals(t *testing.T) {
	f := newVoiceFixture(t)

	t.Run("no proposal unless the workspace and the member both have commands on", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.enable(f.owner, false, true)
		if command := f.propose(f.owner, noteID, revisionID); command != nil || f.model.count() != 0 {
			t.Fatalf("workspace off: command=%+v calls=%d", command, f.model.count())
		}
		f.enable(f.owner, true, false)
		if command := f.propose(f.owner, noteID, revisionID); command != nil || f.model.count() != 0 {
			t.Fatalf("member off: command=%+v calls=%d", command, f.model.count())
		}
		t.Setenv(voiceSwitchParse, "true")
		f.enable(f.owner, true, true)
		if command := f.propose(f.owner, noteID, revisionID); command != nil || f.model.count() != 0 {
			t.Fatalf("switch off: command=%+v calls=%d", command, f.model.count())
		}
		t.Setenv(voiceSwitchParse, "false")
		command := f.propose(f.owner, noteID, revisionID)
		if command == nil || command.Status != "proposed" || command.Action != "schedule_post" || command.ChannelConnectionID == nil ||
			*command.ChannelConnectionID != f.xChannel || len(command.Candidates) != 1 || len(command.AddedWords) != 0 || command.TimeZone != "UTC" {
			t.Fatalf("proposal=%+v", command)
		}
		if command.ExpiresAt == nil || command.ScheduledFor == nil || !command.ExpiresAt.Equal(*command.ScheduledFor) {
			t.Fatalf("a proposal expires at its proposed time: %+v", command)
		}
		if f.model.count() != 1 {
			t.Fatalf("model calls=%d", f.model.count())
		}
		// A replay of the same revision returns the stored proposal without a second call.
		if again := f.propose(f.owner, noteID, revisionID); again == nil || again.ID != command.ID || f.model.count() != 1 {
			t.Fatalf("replay=%+v calls=%d", again, f.model.count())
		}
		// Another member never sees it, even in the same workspace.
		if view, err := f.repo.voiceCommandFor(f.ctx, f.creator, noteID); err != nil || view != nil {
			t.Fatalf("other member view=%+v err=%v", view, err)
		}
	})

	t.Run("a transcript over 2,000 characters is not parsed", func(t *testing.T) {
		f.model.set(f.tweet)
		noteID, revisionID := f.note(f.owner, strings.Repeat("a", 2001))
		if command := f.propose(f.owner, noteID, revisionID); command != nil || f.model.count() != 0 {
			t.Fatalf("long transcript command=%+v calls=%d", command, f.model.count())
		}
	})

	t.Run("an edited transcript withdraws the proposal and is parsed into the same row (K18)", func(t *testing.T) {
		f.model.set(f.tweet)
		noteID, revisionID := f.note(f.owner, voiceTweet)
		first := f.propose(f.owner, noteID, revisionID)
		edited := cuid.New()
		f.revise(f.owner, noteID, edited, voiceTweet+" Really.")
		second := f.propose(f.owner, noteID, edited)
		if first == nil || second == nil || second.ID != first.ID || second.TranscriptRevisionID != edited || second.Status != "proposed" || f.model.count() != 2 {
			t.Fatalf("first=%+v second=%+v calls=%d", first, second, f.model.count())
		}
		// Confirming against a revision that is no longer current is refused.
		f.revise(f.owner, noteID, cuid.New(), "something else")
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput()); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("stale confirm err=%v", err)
		}
	})

	t.Run("parses are limited per member, and the sweep takes the rest", func(t *testing.T) {
		f.model.set(f.tweet)
		for range voiceCommandParseLimit {
			noteID, revisionID := f.note(f.owner, voiceTweet)
			if _, err := f.db.Client.VoiceCommand.Create().SetID(cuid.New()).SetOrganizationID(f.org).SetOwnerUserID(f.owner.UserID).
				SetNoteID(noteID).SetTranscriptRevisionID(revisionID).SetTimeZone("UTC").SetStatus(voicecommand.StatusWithdrawn).
				SetParsedAt(time.Now()).Save(f.ctx); err != nil {
				t.Fatal(err)
			}
		}
		noteID, revisionID := f.note(f.owner, voiceTweet)
		command := f.propose(f.owner, noteID, revisionID)
		row := f.command(noteID)
		if command == nil || command.Status != "waiting" || f.model.count() != 0 || row.NextAttemptAt == nil || !row.NextAttemptAt.After(time.Now()) || row.Attempts != 0 {
			t.Fatalf("limited command=%+v row=%+v calls=%d", command, row, f.model.count())
		}
		f.exec(`UPDATE voice_command SET "parsedAt"=now()-interval '2 hours' WHERE "ownerUserId"=$1 AND "noteId"<>$2`, f.owner.UserID, noteID)
		f.exec(`UPDATE voice_command SET "nextAttemptAt"=now()-interval '1 minute' WHERE "noteId"=$1`, noteID)
		if _, err := f.repo.SweepVoiceCommands(f.ctx); err != nil {
			t.Fatal(err)
		}
		if row := f.command(noteID); row.Status != voicecommand.StatusProposed || f.model.count() != 1 {
			t.Fatalf("after the hour row=%+v calls=%d", row, f.model.count())
		}
	})

	t.Run("a provider failure waits, the sweep retries, and retries are bounded (K12, K25)", func(t *testing.T) {
		down := func(platformai.Request) (string, error) {
			return "", &platformai.Error{Retryable: true}
		}
		f.model.set(down)
		noteID, revisionID := f.note(f.owner, voiceTweet)
		command := f.propose(f.owner, noteID, revisionID)
		row := f.command(noteID)
		if command == nil || command.Status != "waiting" || row.Attempts != 1 || row.NextAttemptAt == nil || !row.NextAttemptAt.After(time.Now()) {
			t.Fatalf("waiting command=%+v row=%+v", command, row)
		}
		// Not due yet: the sweep leaves it.
		if _, err := f.repo.SweepVoiceCommands(f.ctx); err != nil || f.command(noteID).Attempts != 1 {
			t.Fatalf("early sweep attempts=%d err=%v", f.command(noteID).Attempts, err)
		}
		f.model.set(f.tweet)
		f.exec(`UPDATE voice_command SET "nextAttemptAt"=now()-interval '1 minute' WHERE "noteId"=$1`, noteID)
		if _, err := f.repo.SweepVoiceCommands(f.ctx); err != nil {
			t.Fatal(err)
		}
		if row := f.command(noteID); row.Status != voicecommand.StatusProposed || row.Attempts != 2 {
			t.Fatalf("retried row=%+v", row)
		}

		f.model.set(down)
		exhausted, exhaustedRevision := f.note(f.owner, voiceTweet)
		f.propose(f.owner, exhausted, exhaustedRevision)
		f.exec(`UPDATE voice_command SET attempts=$1, "nextAttemptAt"=now()-interval '1 minute' WHERE "noteId"=$2`, voiceCommandAttempts-1, exhausted)
		if _, err := f.repo.SweepVoiceCommands(f.ctx); err != nil {
			t.Fatal(err)
		}
		view, err := f.repo.voiceCommandFor(f.ctx, f.owner, exhausted)
		if err != nil || view == nil || view.Status != "failed" || view.Notice == nil || !strings.Contains(*view.Notice, "could not understand") {
			t.Fatalf("exhausted view=%+v err=%v", view, err)
		}
	})

	t.Run("an unconfirmed proposal expires at its proposed time (K14)", func(t *testing.T) {
		f.model.set(f.tweet)
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		f.exec(`UPDATE voice_command SET "expiresAt"=now()-interval '1 second' WHERE "noteId"=$1`, noteID)
		if _, err := f.repo.SweepVoiceCommands(f.ctx); err != nil {
			t.Fatal(err)
		}
		if row := f.command(noteID); row.Status != voicecommand.StatusExpired {
			t.Fatalf("expired row=%+v", row)
		}
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput()); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("confirm after expiry err=%v", err)
		}
	})
}

func TestVoiceCommandConfirm(t *testing.T) {
	f := newVoiceFixture(t)
	f.enable(f.owner, true, true)
	f.enable(f.creator, true, true)

	t.Run("confirm schedules one post through the draft path, and a resent confirm returns it (K11)", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		first, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput())
		if err != nil || first.Outcome != "scheduled" || first.ContentDraftID == nil || first.ScheduledPostID == nil || len(first.Scheduled) != 1 ||
			first.Command.Status != "confirmed" {
			t.Fatalf("first=%+v err=%v", first, err)
		}
		drafts := f.drafts(revisionID)
		if len(drafts) != 1 || drafts[0].ID != *first.ContentDraftID || drafts[0].PlainText != "Entrepreneurship is hard." || f.posts(drafts[0].ID) != 1 {
			t.Fatalf("drafts=%+v", drafts)
		}
		post, err := f.db.Client.ScheduledPost.Get(f.ctx, *first.ScheduledPostID)
		if err != nil || post.Caption != "Entrepreneurship is hard." || post.ChannelConnectionID != f.xChannel ||
			post.ScheduledFor.UTC().Format("2006-01-02T15:04") != f.when {
			t.Fatalf("post=%+v err=%v", post, err)
		}
		again, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput())
		if err != nil || again.Outcome != "scheduled" || *again.ScheduledPostID != *first.ScheduledPostID || len(f.drafts(revisionID)) != 1 || f.posts(drafts[0].ID) != 1 {
			t.Fatalf("again=%+v err=%v", again, err)
		}
		audits, err := f.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(f.org), auditlog.Action("product.voice_command_confirmed"),
			auditlog.EntityType("voice_note"), auditlog.EntityID(noteID)).Count(f.ctx)
		if err != nil || audits != 1 {
			t.Fatalf("audits=%d err=%v", audits, err)
		}
		record, err := f.repo.GetContentDraft(f.ctx, f.owner, drafts[0].ID)
		if err != nil || record.SourceVoiceRevisionID == nil || *record.SourceVoiceRevisionID != revisionID {
			t.Fatalf("draft record=%+v err=%v", record, err)
		}
	})

	t.Run("two confirms at once make one post (K11)", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		var wait sync.WaitGroup
		results := make([]*VoiceCommandConfirmation, 2)
		failures := make([]error, 2)
		for i := range 2 {
			wait.Go(func() { results[i], failures[i] = f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput()) })
		}
		wait.Wait()
		for i := range 2 {
			if failures[i] != nil || results[i].Outcome != "scheduled" || results[i].ScheduledPostID == nil {
				t.Fatalf("confirm %d=%+v err=%v", i, results[i], failures[i])
			}
		}
		drafts := f.drafts(revisionID)
		if *results[0].ScheduledPostID != *results[1].ScheduledPostID || len(drafts) != 1 || f.posts(drafts[0].ID) != 1 {
			t.Fatalf("posts=%v/%v drafts=%d", *results[0].ScheduledPostID, *results[1].ScheduledPostID, len(drafts))
		}
	})

	t.Run("a confirm the server cannot trust is refused and leaves nothing (K22)", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		past := f.confirmInput()
		past.LocalTime = time.Now().UTC().Add(-time.Hour).Format("2006-01-02T15:04")
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, past); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("past time err=%v", err)
		}
		gap := f.confirmInput()
		gap.LocalTime, gap.TimeZone = "2027-03-14T02:30", "America/New_York"
		var local *LocalTimeError
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, gap); !errors.As(err, &local) {
			t.Fatalf("skipped time err=%v", err)
		}
		foreign := f.confirmInput()
		foreign.ChannelConnectionID = f.foreignX
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, foreign); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("foreign account err=%v", err)
		}
		long := f.confirmInput()
		long.Text = strings.Repeat("a", 281)
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, long); !errors.Is(err, publishing.ErrConflict) || !strings.Contains(err.Error(), "limit") {
			t.Fatalf("over-limit text err=%v", err)
		}
		if drafts := f.drafts(revisionID); len(drafts) != 0 || f.command(noteID).Status != voicecommand.StatusProposed {
			t.Fatalf("refused confirms left drafts=%d status=%s", len(drafts), f.command(noteID).Status)
		}
		// Another member's note is not found, never forbidden.
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.creator, noteID, f.confirmInput()); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("other member err=%v", err)
		}
		t.Setenv(voiceSwitchConfirm, "true")
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput()); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("switch off err=%v", err)
		}
	})

	t.Run("a member who cannot schedule gets a draft (K10)", func(t *testing.T) {
		noteID, revisionID := f.note(f.creator, voiceTweet)
		command := f.propose(f.creator, noteID, revisionID)
		if command == nil || command.Action != "create_draft" || !strings.Contains(strings.Join(command.Flags, ","), voiceFlagCannotSchedule) {
			t.Fatalf("creator proposal=%+v", command)
		}
		result, err := f.repo.ConfirmVoiceCommand(f.ctx, f.creator, noteID, f.confirmInput())
		if err != nil || result.Outcome != "draft" || result.ScheduledPostID != nil || len(result.Scheduled) != 0 {
			t.Fatalf("creator confirm=%+v err=%v", result, err)
		}
		if drafts := f.drafts(revisionID); len(drafts) != 1 || f.posts(drafts[0].ID) != 0 {
			t.Fatalf("creator drafts=%+v", drafts)
		}
	})

	t.Run("a workspace that requires approval gets a review request and no post (K10)", func(t *testing.T) {
		required, off := true, false
		if _, err := f.repo.UpdateContentDraftSettings(f.ctx, f.owner, ContentDraftSettingsUpdate{RequireApproval: &required}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = f.repo.UpdateContentDraftSettings(f.ctx, f.owner, ContentDraftSettingsUpdate{RequireApproval: &off})
		})
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		result, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput())
		if err != nil || result.Outcome != "pending_approval" || result.ScheduledPostID != nil {
			t.Fatalf("approval confirm=%+v err=%v", result, err)
		}
		drafts := f.drafts(revisionID)
		if len(drafts) != 1 || drafts[0].ReviewStatus != contentdraft.ReviewStatusPending || f.posts(drafts[0].ID) != 0 {
			t.Fatalf("approval drafts=%+v", drafts)
		}
	})
}

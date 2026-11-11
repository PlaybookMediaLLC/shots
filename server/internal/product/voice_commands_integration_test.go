package product

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
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

// hangingVoiceModel never answers: it returns when the call's context ends.
type hangingVoiceModel struct{}

func (hangingVoiceModel) Structured(ctx context.Context, _ platformai.Request, _ any) (platformai.Usage, error) {
	<-ctx.Done()
	return platformai.Usage{}, ctx.Err()
}

// waitForLockWaiter waits until a session of the test database waits on a lock.
func (f *voiceCommandFixture) waitForLockWaiter(t *testing.T) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		var waiting int
		if err := f.db.SQL.QueryRowContext(f.ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`).
			Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			return
		}
	}
	t.Fatal("nothing waited on the lock")
}

// voiceCommandFixture is a workspace with an X account, an owner and a creator, and
// voice notes written straight to the tables the notes domain owns.
type voiceCommandFixture struct {
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
	// socialAccounts adds an account to each workspace's social tenant.
	socialAccounts map[string]func(string, string)
}

func newVoiceCommandFixture(t *testing.T) *voiceCommandFixture {
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
	f := &voiceCommandFixture{t: t, ctx: ctx, db: db, model: &fakeVoiceModel{}, meter: &recordingMonthlyMeter{used: map[string]int64{}}, org: "org_" + id, other: "other_" + id,
		when: time.Now().UTC().Add(48*time.Hour).Format("2006-01-02") + "T10:00", socialAccounts: map[string]func(string, string){}}
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
	f.xChannel, f.foreignX = f.connect(f.owner, "x-"+f.org, "x", nil), f.connect(f.foreign, "x-"+f.other, "x", nil)
	return f
}

// connect adds an account to the actor's workspace, in the default social set
// unless one is named.
func (f *voiceCommandFixture) connect(actor Actor, account, platform string, set *string) string {
	f.t.Helper()
	if f.socialAccounts[actor.OrganizationID] == nil {
		f.socialAccounts[actor.OrganizationID] = socialCredentialFixture(f.t, f.ctx, f.db.SQL, actor.OrganizationID)
	}
	f.socialAccounts[actor.OrganizationID](account, platform)
	connection, err := f.repo.auth.CreateConnection(f.ctx, publishing.Actor{Organization: actor.OrganizationID, UserID: actor.UserID, RequestID: actor.RequestID, Type: "USER"},
		publishing.CreateConnectionInput{ExternalAccountID: account, Platform: platform, ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY",
			SocialSetID: set})
	if err != nil {
		f.t.Fatal(err)
	}
	return connection.ID
}

func (f *voiceCommandFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.SQL.ExecContext(f.ctx, query, args...); err != nil {
		f.t.Fatalf("%v\n%s", err, query)
	}
}

func (f *voiceCommandFixture) member(org, label, role string) Actor {
	userID := "user_" + label + "_" + org
	f.exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Person',$2,true,now(),now())`, userID, userID+"@example.test")
	f.exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`,
		"session_"+userID, userID, org)
	f.exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())`, "member_"+userID, org, userID, role)
	f.t.Cleanup(func() { _, _ = f.db.SQL.ExecContext(f.ctx, `DELETE FROM "user" WHERE id=$1`, userID) })
	return Actor{OrganizationID: org, UserID: userID, SessionID: "session_" + userID, RequestID: "request_" + org}
}

// enable turns voice commands and draft generation on for the workspace and
// the member, with the remote-text consent the member switch needs. Voice
// notes stay on, so transcripts can be synced.
func (f *voiceCommandFixture) enable(actor Actor, workspace, member bool) {
	f.t.Helper()
	f.exec(`DELETE FROM voice_settings WHERE "organizationId"=$1`, actor.OrganizationID)
	f.exec(`DELETE FROM voice_member_settings WHERE "organizationId"=$1 AND "userId"=$2`, actor.OrganizationID, actor.UserID)
	if err := f.db.Client.VoiceSettings.Create().SetID(actor.OrganizationID).SetVoiceNotes(true).SetVoiceCommands(workspace).SetDraftGeneration(workspace).
		Exec(f.ctx); err != nil {
		f.t.Fatal(err)
	}
	if err := f.db.Client.VoiceMemberSettings.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetUserID(actor.UserID).
		SetRemoteTextConsentAt(time.Now()).SetVoiceCommands(member).Exec(f.ctx); err != nil {
		f.t.Fatal(err)
	}
}

// note writes a note with one current transcript revision.
func (f *voiceCommandFixture) note(actor Actor, transcript string) (string, string) {
	f.t.Helper()
	noteID, revisionID := f.bareNote(actor, time.Now().Add(-time.Hour), "UTC"), cuid.New()
	f.revise(actor, noteID, revisionID, transcript)
	return noteID, revisionID
}

// bareNote writes a note recorded at a time in a zone, with no transcript.
func (f *voiceCommandFixture) bareNote(actor Actor, recordedAt time.Time, zone string) string {
	f.t.Helper()
	noteID := cuid.New()
	if _, err := f.db.Client.VoiceNote.Create().SetID(noteID).SetOrganizationID(actor.OrganizationID).SetOwnerUserID(actor.UserID).
		SetClientNoteID(noteID).SetTitle("Walk and talk").SetRecordedAt(recordedAt).SetRecordedTimeZone(zone).Save(f.ctx); err != nil {
		f.t.Fatal(err)
	}
	return noteID
}

// sync posts a transcript through the sync API, as the phone does.
func (f *voiceCommandFixture) sync(actor Actor, noteID, transcript string) (*VoiceTranscriptResult, bool) {
	f.t.Helper()
	result, created, err := f.repo.AddVoiceTranscript(f.ctx, actor, noteID, AddVoiceTranscriptInput{ClientRevisionID: cuid.New(), Origin: "on_device", Text: transcript})
	if err != nil {
		f.t.Fatal(err)
	}
	return result, created
}

// setAndRestore runs a change, and the statement that undoes it when t ends.
func (f *voiceCommandFixture) setAndRestore(t *testing.T, change, restore string, args ...any) {
	t.Helper()
	if _, err := f.db.SQL.ExecContext(f.ctx, change, args...); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := f.db.SQL.ExecContext(f.ctx, restore, args...); err != nil {
			t.Error(err)
		}
	})
}

// revise adds a revision and makes it the note's current one.
func (f *voiceCommandFixture) revise(actor Actor, noteID, revisionID, transcript string) {
	f.t.Helper()
	if _, err := f.db.Client.VoiceTranscriptRevision.Create().SetID(revisionID).SetOrganizationID(actor.OrganizationID).SetNoteID(noteID).
		SetClientRevisionID(revisionID).SetOrigin("user_edit").SetText(transcript).SetCreatedByUserID(actor.UserID).Save(f.ctx); err != nil {
		f.t.Fatal(err)
	}
	f.exec(`UPDATE voice_note SET "currentTranscriptRevisionId"=$1 WHERE id=$2`, revisionID, noteID)
}

const voiceTweet = "Shots, post the following tweet at 10 am on Friday: entrepreneurship is hard."

func (f *voiceCommandFixture) tweet(platformai.Request) (string, error) {
	return `{"action":"schedule_post","platform":"x","text":"Entrepreneurship is hard.","local_time":"` + f.when +
		`","guessed":[],"second_request":false,"unsupported":null}`, nil
}

func (f *voiceCommandFixture) command(noteID string) *ent.VoiceCommand {
	f.t.Helper()
	row, err := f.db.Client.VoiceCommand.Query().Where(voicecommand.NoteID(noteID)).Only(f.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	return row
}

func (f *voiceCommandFixture) propose(actor Actor, noteID, revisionID string) *VoiceCommand {
	f.t.Helper()
	command, err := f.repo.proposeVoiceCommand(f.ctx, actor, noteID, revisionID)
	if err != nil {
		f.t.Fatal(err)
	}
	return command
}

func (f *voiceCommandFixture) confirmInput() VoiceCommandConfirmInput {
	return VoiceCommandConfirmInput{Text: "Entrepreneurship is hard.", ChannelConnectionID: f.xChannel, LocalTime: f.when, TimeZone: "UTC"}
}

func (f *voiceCommandFixture) drafts(revisionID string) []*ent.ContentDraft {
	f.t.Helper()
	rows, err := f.db.Client.ContentDraft.Query().Where(contentdraft.SourceVoiceRevisionID(revisionID)).All(f.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	return rows
}

func (f *voiceCommandFixture) posts(draftID string) int {
	f.t.Helper()
	n, err := f.db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draftID), scheduledpost.StatusNEQ(scheduledpost.StatusCANCELLED)).Count(f.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestVoiceCommandProposals(t *testing.T) {
	f := newVoiceCommandFixture(t)

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
		noteID, revisionID = f.note(f.owner, strings.Repeat("a", 2000))
		if command := f.propose(f.owner, noteID, revisionID); command == nil || command.Status != "proposed" || f.model.count() != 1 {
			t.Fatalf("transcript at the limit command=%+v calls=%d", command, f.model.count())
		}
	})

	t.Run("a synced transcript returns its proposal (contract row 10)", func(t *testing.T) {
		f.model.set(f.tweet)
		noteID := f.bareNote(f.owner, time.Now().Add(-time.Hour), "UTC")
		result, created := f.sync(f.owner, noteID, voiceTweet)
		if !created || result.Command == nil || result.Command.Status != "proposed" || result.Command.TranscriptRevisionID != result.Revision.ID ||
			result.Command.ChannelConnectionID == nil || *result.Command.ChannelConnectionID != f.xChannel {
			t.Fatalf("synced result=%+v created=%v", result, created)
		}
	})

	t.Run("a model that fails or never answers leaves the transcript synced and the command waiting (K25)", func(t *testing.T) {
		f.model.set(func(platformai.Request) (string, error) { return "", &platformai.Error{Retryable: true} })
		noteID := f.bareNote(f.owner, time.Now().Add(-time.Hour), "UTC")
		result, created := f.sync(f.owner, noteID, voiceTweet)
		if !created || result.Revision.Text != voiceTweet || result.Command == nil || result.Command.Status != "waiting" || f.command(noteID).Attempts != 1 {
			t.Fatalf("failing model result=%+v created=%v", result, created)
		}
		hung := *f.repo
		hung.automationModel = hangingVoiceModel{}
		noteID = f.bareNote(f.owner, time.Now().Add(-time.Hour), "UTC")
		started := time.Now()
		result, created, err := hung.AddVoiceTranscript(f.ctx, f.owner, noteID, AddVoiceTranscriptInput{ClientRevisionID: cuid.New(), Origin: "on_device", Text: voiceTweet})
		if elapsed := time.Since(started); err != nil || !created || result.Command == nil || result.Command.Status != "waiting" ||
			elapsed > voiceCommandParseTimeout+3*time.Second {
			t.Fatalf("hung model result=%+v created=%v err=%v after %v", result, created, err, elapsed)
		}
		if row := f.command(noteID); row.Status != voicecommand.StatusWaiting || row.Attempts != 1 || row.NextAttemptAt == nil {
			t.Fatalf("hung model row=%+v", row)
		}
	})

	t.Run("the recording's zone and time are used, not the workspace's or the sync's (K1, K3, K24)", func(t *testing.T) {
		zone, err := time.LoadLocation("America/New_York")
		if err != nil {
			t.Fatal(err)
		}
		recorded := time.Now().Add(-time.Hour)
		local := recorded.In(zone).Add(48*time.Hour).Format("2006-01-02") + "T10:00"
		var prompt string
		f.model.set(func(request platformai.Request) (string, error) {
			prompt = request.Prompt
			return `{"action":"schedule_post","platform":"x","text":"Entrepreneurship is hard.","local_time":"` + local +
				`","guessed":[],"second_request":false,"unsupported":null}`, nil
		})
		noteID := f.bareNote(f.owner, recorded, "America/New_York")
		result, _ := f.sync(f.owner, noteID, voiceTweet)
		want, err := time.ParseInLocation("2006-01-02T15:04", local, zone)
		if err != nil {
			t.Fatal(err)
		}
		command := result.Command
		if command == nil || command.TimeZone != "America/New_York" || command.LocalTime == nil || *command.LocalTime != local ||
			command.ScheduledFor == nil || !command.ScheduledFor.Equal(want) || len(command.Flags) != 0 {
			t.Fatalf("command=%+v, want %s at %v", command, local, want.UTC())
		}
		if !strings.Contains(prompt, recorded.In(zone).Format("2006-01-02T15:04")+" in the time zone America/New_York") {
			t.Fatalf("prompt=%q", prompt)
		}
	})

	t.Run("a proposal racing the note's deletion sees the tombstone", func(t *testing.T) {
		f.model.set(f.tweet)
		noteID, revisionID := f.note(f.owner, voiceTweet)
		// The delete holds the note's lock while the proposal starts.
		tx, err := f.db.Client.Tx(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if _, err := lockVoiceNote(f.ctx, tx, noteID); err != nil {
			t.Fatal(err)
		}
		var command *VoiceCommand
		done := make(chan error, 1)
		go func() {
			var err error
			command, err = f.repo.proposeVoiceCommand(f.ctx, f.owner, noteID, revisionID)
			done <- err
		}()
		f.waitForLockWaiter(t)
		if _, err := tx.PlatformExec(f.ctx, `UPDATE voice_note SET "deletedAt"=now() WHERE id=$1`, noteID); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil || command != nil || f.model.count() != 0 {
			t.Fatalf("command=%+v err=%v calls=%d", command, err, f.model.count())
		}
		if exists, err := f.db.Client.VoiceCommand.Query().Where(voicecommand.NoteID(noteID)).Exist(f.ctx); err != nil || exists {
			t.Fatalf("a deleted note got a command row: %v %v", exists, err)
		}
	})

	t.Run("a withdrawn proposal keeps none of the transcript's words; a confirmed one keeps its own", func(t *testing.T) {
		f.model.set(f.tweet)
		long := strings.Repeat("a ", voiceCommandTextLimit/2+1)
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		edited := cuid.New()
		f.revise(f.owner, noteID, edited, long)
		if command := f.propose(f.owner, noteID, edited); command != nil {
			t.Fatalf("withdrawn command=%+v", command)
		}
		if row := f.command(noteID); row.Status != voicecommand.StatusWithdrawn || row.TranscriptRevisionID != edited || row.Text != nil ||
			row.Notice != nil || row.Platform != nil || row.LocalTime != nil {
			t.Fatalf("withdrawn row=%+v", row)
		}
		confirmed, confirmedRevision := f.note(f.owner, voiceTweet)
		f.propose(f.owner, confirmed, confirmedRevision)
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, confirmed, f.confirmInput()); err != nil {
			t.Fatal(err)
		}
		later := cuid.New()
		f.revise(f.owner, confirmed, later, long)
		f.propose(f.owner, confirmed, later)
		if row := f.command(confirmed); row.Status != voicecommand.StatusConfirmed || row.TranscriptRevisionID != confirmedRevision ||
			row.Text == nil || *row.Text != "Entrepreneurship is hard." {
			t.Fatalf("confirmed row=%+v", row)
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
		// The sweep takes every workspace's due rows, so count this row's parses.
		if row := f.command(noteID); row.Status != voicecommand.StatusProposed || row.Attempts != 1 {
			t.Fatalf("after the hour row=%+v", row)
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
	f := newVoiceCommandFixture(t)
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
		gap.LocalTime, gap.TimeZone = "2026-03-08T02:30", "America/New_York"
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

	t.Run("a post at exactly the platform's limit is scheduled (K6)", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		exact := f.confirmInput()
		exact.Text = strings.Repeat("a", 280)
		result, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, exact)
		if err != nil || result.Outcome != "scheduled" || result.ScheduledPostID == nil {
			t.Fatalf("280 characters=%+v err=%v", result, err)
		}
	})

	t.Run("without an account the confirm saves a draft; part of a schedule is refused (K5)", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		const text = "Entrepreneurship is hard."
		for _, partial := range []VoiceCommandConfirmInput{
			{Text: text, ChannelConnectionID: f.xChannel},
			{Text: text, LocalTime: f.when, TimeZone: "UTC"},
			{Text: text, ChannelConnectionID: f.xChannel, LocalTime: f.when},
		} {
			if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, partial); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("partial %+v err=%v", partial, err)
			}
		}
		if drafts := f.drafts(revisionID); len(drafts) != 0 || f.command(noteID).Status != voicecommand.StatusProposed {
			t.Fatalf("partial confirms left drafts=%d status=%s", len(drafts), f.command(noteID).Status)
		}
		for name, reply := range map[string]string{
			voiceFlagNotConnected: `{"action":"schedule_post","platform":"linkedin","text":"Entrepreneurship is hard.","local_time":"` + f.when +
				`","guessed":[],"second_request":false,"unsupported":null}`,
			"create_draft": `{"action":"create_draft","platform":"x","text":"Entrepreneurship is hard.","local_time":null,"guessed":[],"second_request":false,"unsupported":null}`,
		} {
			f.model.set(func(platformai.Request) (string, error) { return reply, nil })
			noteID, revisionID := f.note(f.owner, voiceTweet)
			command := f.propose(f.owner, noteID, revisionID)
			if command == nil || command.Action != "create_draft" || (name == voiceFlagNotConnected && !slices.Contains(command.Flags, name)) {
				t.Fatalf("%s proposal=%+v", name, command)
			}
			result, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, VoiceCommandConfirmInput{Text: text})
			if err != nil || result.Outcome != "draft" || result.ContentDraftID == nil || result.ScheduledPostID != nil || result.Command.Status != "confirmed" {
				t.Fatalf("%s confirm=%+v err=%v", name, result, err)
			}
			if drafts := f.drafts(revisionID); len(drafts) != 1 || drafts[0].PlainText != text || f.posts(drafts[0].ID) != 0 {
				t.Fatalf("%s drafts=%+v", name, drafts)
			}
		}
		f.model.set(f.tweet)
	})

	t.Run("an account disconnected after the card is refused at confirm (K21)", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		f.setAndRestore(t, `UPDATE channel_connection SET status='DISABLED' WHERE id=$1`, `UPDATE channel_connection SET status='ACTIVE' WHERE id=$1`, f.xChannel)
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput()); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("disconnected account err=%v", err)
		}
		if drafts := f.drafts(revisionID); len(drafts) != 0 || f.command(noteID).Status != voicecommand.StatusProposed {
			t.Fatalf("refused confirm left drafts=%d status=%s", len(drafts), f.command(noteID).Status)
		}
	})

	t.Run("a member demoted after the card gets a draft, not a post (K10, K21)", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		if command := f.propose(f.owner, noteID, revisionID); command == nil || command.Action != "schedule_post" {
			t.Fatalf("owner proposal=%+v", command)
		}
		f.setAndRestore(t, `UPDATE member SET role='creator' WHERE "userId"=$1`, `UPDATE member SET role='owner' WHERE "userId"=$1`, f.owner.UserID)
		result, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput())
		if err != nil || result.Outcome != "draft" || result.ScheduledPostID != nil || len(result.Scheduled) != 0 {
			t.Fatalf("demoted confirm=%+v err=%v", result, err)
		}
		if drafts := f.drafts(revisionID); len(drafts) != 1 || f.posts(drafts[0].ID) != 0 {
			t.Fatalf("demoted drafts=%+v", drafts)
		}
	})

	t.Run("a confirm after the workspace turns commands off is refused", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		f.setAndRestore(t, `UPDATE voice_settings SET "voiceCommands"=false WHERE "organizationId"=$1`,
			`UPDATE voice_settings SET "voiceCommands"=true WHERE "organizationId"=$1`, f.org)
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput()); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("commands off err=%v", err)
		}
		if drafts := f.drafts(revisionID); len(drafts) != 0 || f.command(noteID).Status != voicecommand.StatusProposed {
			t.Fatalf("refused confirm left drafts=%d status=%s", len(drafts), f.command(noteID).Status)
		}
	})

	t.Run("deleting the note keeps the scheduled post and the draft, whose source shows removed (K15)", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		result, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput())
		if err != nil || result.ScheduledPostID == nil {
			t.Fatalf("confirm=%+v err=%v", result, err)
		}
		if err := f.repo.DeleteVoiceNote(f.ctx, f.owner, noteID); err != nil {
			t.Fatal(err)
		}
		post, err := f.db.Client.ScheduledPost.Get(f.ctx, *result.ScheduledPostID)
		if err != nil || post.Status != scheduledpost.StatusSCHEDULED || post.Caption != "Entrepreneurship is hard." {
			t.Fatalf("post=%+v err=%v", post, err)
		}
		record, err := f.repo.GetContentDraft(f.ctx, f.owner, *result.ContentDraftID)
		if err != nil || record.PlainText != "Entrepreneurship is hard." || record.SourceVoiceRevisionID == nil || *record.SourceVoiceRevisionID != revisionID ||
			!record.SourceVoiceRemoved {
			t.Fatalf("draft=%+v err=%v", record, err)
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

// A confirm that fails partway leaves what it did recorded on the row, and a
// retry finishes it with one draft and one post (K11).
func TestVoiceCommandConfirmRecovers(t *testing.T) {
	f := newVoiceCommandFixture(t)
	f.enable(f.owner, true, true)

	t.Run("a schedule refused after the draft exists is retried with edits into the same draft", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		posts := monthlyMeterKey(QuotaPosts, f.org, time.Now())
		f.meter.used[posts] = int64(planQuotas["pro"][QuotaPosts])
		var exceeded *QuotaExceededError
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput()); !errors.As(err, &exceeded) {
			t.Fatalf("over the post quota err=%v", err)
		}
		row, drafts := f.command(noteID), f.drafts(revisionID)
		if row.Status != voicecommand.StatusProposed || row.ContentDraftID == nil || len(drafts) != 1 || drafts[0].ID != *row.ContentDraftID ||
			f.posts(drafts[0].ID) != 0 {
			t.Fatalf("after the refusal row=%+v drafts=%d", row, len(drafts))
		}
		f.meter.used[posts] = 0
		// Edited text, another account of the draft's social set and a renamed note.
		linkedin := f.connect(f.owner, "li-"+f.org, "linkedin", nil)
		f.exec(`UPDATE voice_note SET title='Renamed' WHERE id=$1`, noteID)
		retry := f.confirmInput()
		retry.Text, retry.ChannelConnectionID = "Entrepreneurship is hard. Truly.", linkedin
		result, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, retry)
		if err != nil || result.Outcome != "scheduled" || result.ContentDraftID == nil || *result.ContentDraftID != drafts[0].ID || result.ScheduledPostID == nil {
			t.Fatalf("retry=%+v err=%v", result, err)
		}
		draft, err := f.db.Client.ContentDraft.Get(f.ctx, drafts[0].ID)
		if err != nil || draft.PlainText != retry.Text || !slices.Equal(draft.ChannelConnectionIds, []string{linkedin}) {
			t.Fatalf("draft=%+v err=%v", draft, err)
		}
		post, err := f.db.Client.ScheduledPost.Get(f.ctx, *result.ScheduledPostID)
		if err != nil || post.Caption != retry.Text || post.ChannelConnectionID != linkedin || len(f.drafts(revisionID)) != 1 || f.posts(draft.ID) != 1 {
			t.Fatalf("post=%+v err=%v drafts=%d", post, err, len(f.drafts(revisionID)))
		}
	})

	t.Run("a retry with an account of another social set writes a new draft and one post", func(t *testing.T) {
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		posts := monthlyMeterKey(QuotaPosts, f.org, time.Now())
		f.meter.used[posts] = int64(planQuotas["pro"][QuotaPosts])
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput()); err == nil {
			t.Fatal("over the post quota, the confirm succeeded")
		}
		f.meter.used[posts] = 0
		first := *f.command(noteID).ContentDraftID
		set, err := f.repo.CreateSocialSet(f.ctx, f.owner, SocialSetInput{Name: "Second brand"})
		if err != nil {
			t.Fatal(err)
		}
		other := f.connect(f.owner, "x2-"+f.org, "x", &set.ID)
		retry := f.confirmInput()
		retry.ChannelConnectionID = other
		result, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, retry)
		if err != nil || result.Outcome != "scheduled" || result.ContentDraftID == nil || *result.ContentDraftID == first || result.ScheduledPostID == nil {
			t.Fatalf("retry=%+v err=%v", result, err)
		}
		// The first draft stays an ordinary draft, with no post.
		if drafts := f.drafts(revisionID); len(drafts) != 2 || f.posts(first) != 0 || f.posts(*result.ContentDraftID) != 1 {
			t.Fatalf("drafts=%d first posts=%d", len(drafts), f.posts(first))
		}
	})

	t.Run("a confirm whose last write fails keeps its post, is not expired or reopened, and a retry records it (K11, K14)", func(t *testing.T) {
		f.model.set(f.tweet)
		noteID, revisionID := f.note(f.owner, voiceTweet)
		f.propose(f.owner, noteID, revisionID)
		// The database refuses to mark this note's command confirmed.
		trigger := "voice_confirm_fails_" + noteID
		f.exec(`CREATE OR REPLACE FUNCTION voice_confirm_fails() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`)
		f.exec(`CREATE TRIGGER ` + trigger + ` BEFORE UPDATE ON voice_command FOR EACH ROW WHEN (NEW.status = 'confirmed' AND NEW."noteId" = '` + noteID +
			`') EXECUTE FUNCTION voice_confirm_fails()`)
		t.Cleanup(func() { _, _ = f.db.SQL.ExecContext(f.ctx, `DROP TRIGGER IF EXISTS `+trigger+` ON voice_command`) })
		if _, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput()); err == nil || !strings.Contains(err.Error(), "injected failure") {
			t.Fatalf("failing last write err=%v", err)
		}
		row := f.command(noteID)
		if row.Status != voicecommand.StatusProposed || row.ContentDraftID == nil || row.ScheduledPostID == nil || f.posts(*row.ContentDraftID) != 1 {
			t.Fatalf("after the failure row=%+v", row)
		}
		f.exec(`UPDATE voice_command SET "expiresAt"=now()-interval '1 second' WHERE "noteId"=$1`, noteID)
		if _, err := f.repo.SweepVoiceCommands(f.ctx); err != nil {
			t.Fatal(err)
		}
		edited := cuid.New()
		f.revise(f.owner, noteID, edited, voiceTweet+" Really.")
		calls := f.model.count()
		f.propose(f.owner, noteID, edited)
		if again := f.command(noteID); again.Status != voicecommand.StatusProposed || again.TranscriptRevisionID != revisionID || f.model.count() != calls {
			t.Fatalf("expired or reopened row=%+v calls=%d", again, f.model.count()-calls)
		}
		f.exec(`DROP TRIGGER ` + trigger + ` ON voice_command`)
		// The card's time has passed and the transcript changed: the post is the outcome.
		late := f.confirmInput()
		late.LocalTime = time.Now().UTC().Add(-time.Hour).Format("2006-01-02T15:04")
		result, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, late)
		if err != nil || result.Outcome != "scheduled" || result.ScheduledPostID == nil || *result.ScheduledPostID != *row.ScheduledPostID ||
			result.Command.Status != "confirmed" || result.Command.LocalTime == nil || *result.Command.LocalTime != f.when {
			t.Fatalf("retry=%+v err=%v", result, err)
		}
		resent, err := f.repo.ConfirmVoiceCommand(f.ctx, f.owner, noteID, f.confirmInput())
		if err != nil || resent.ScheduledPostID == nil || *resent.ScheduledPostID != *row.ScheduledPostID || len(f.drafts(revisionID)) != 1 ||
			f.posts(*row.ContentDraftID) != 1 {
			t.Fatalf("resent=%+v err=%v", resent, err)
		}
		audits, err := f.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(f.org), auditlog.Action("product.voice_command_confirmed"),
			auditlog.EntityID(noteID)).Count(f.ctx)
		if err != nil || audits != 1 {
			t.Fatalf("audits=%d err=%v", audits, err)
		}
	})
}

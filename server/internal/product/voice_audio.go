package product

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voiceaudiorun"
	"github.com/lucsky/cuid"
)

// Voice audio (implementation plan, section 4, rows 12-15). A run is one
// uninterrupted recording file, uploaded whole with one signed PUT straight
// to storage. Its object is not an asset: assets are visible to the whole
// workspace, and voice audio is private to the note's owner.

// voiceAudioStore signs voice uploads with their length and checksum, and
// playback that lasts through seeking. media.S3Store implements it.
type voiceAudioStore interface {
	SignChecksummedUpload(ctx context.Context, key, mediaType string, size int64, digest []byte, expires time.Duration) (string, http.Header, error)
	SignDownloadFor(ctx context.Context, key string, expires time.Duration) (string, error)
}

// voiceAudioFormats are the run formats the server can decode: the PCM WAV
// the Founder Hub recorder writes, bounded to 31 minutes on decode.
var voiceAudioFormats = map[string]struct {
	extension string
	maxBytes  int64
}{"audio/wav": {"wav", 200 << 20}}

const (
	// voiceMaxRunIndex bounds a note to 50 runs.
	voiceMaxRunIndex    = 49
	voiceUploadExpiry   = 15 * time.Minute
	voicePlaybackExpiry = time.Hour
)

// VoiceRunUploadInput describes the file the phone will PUT.
type VoiceRunUploadInput struct {
	ContentType   string `json:"contentType"`
	Bytes         int64  `json:"bytes"`
	SHA256        string `json:"sha256"`
	StartOffsetMs int    `json:"startOffsetMs"`
	DurationMs    *int   `json:"durationMs"`
	// SampleRateHz is accepted and checked, but the decoded rate is stored.
	SampleRateHz *int `json:"sampleRateHz"`
}

// VoiceRunUpload is a signed PUT: send exactly these headers and the file.
type VoiceRunUpload struct {
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt time.Time         `json:"expiresAt"`
}

// VoiceRunAudio is a signed read of one available run.
type VoiceRunAudio struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// requireVoiceAudio refuses an upload unless the server switch, the workspace
// and the note's own consent all allow audio to leave the phone.
func (c *Configuration) requireVoiceAudio(ctx context.Context, actor Actor, note *ent.VoiceNote) error {
	flags, _, err := c.voiceSettings(ctx, actor)
	switch {
	case err != nil:
		return err
	case voiceSwitchedOff(voiceSwitchAudioUpload):
		return forbidden("Voice audio upload is turned off on this server.")
	case !flags.AudioUpload:
		return forbidden("Voice audio upload is off in this workspace.")
	case !note.AudioUploadConsent:
		return forbidden("This note was recorded without consent to upload its audio.")
	}
	return nil
}

func validVoiceRunIndex(runIndex int) error {
	if runIndex < 0 || runIndex > voiceMaxRunIndex {
		return invalid("runIndex must be between 0 and 49.")
	}
	return nil
}

// SignVoiceRunUpload signs the PUT of one run, keyed on (note, run index):
// the same file asked again gets a new URL for the same run (S3); a different
// file for an index already used is a conflict. The URL carries the length
// and SHA-256, so storage refuses a larger or different file (S5).
func (c *Configuration) SignVoiceRunUpload(ctx context.Context, actor Actor, noteID string, runIndex int, input VoiceRunUploadInput) (*VoiceRunUpload, error) {
	note, err := c.liveVoiceNote(ctx, actor, noteID)
	if err != nil {
		return nil, err
	}
	if err := c.requireVoiceAudio(ctx, actor, note); err != nil {
		return nil, err
	}
	format, known := voiceAudioFormats[input.ContentType]
	digest, digestErr := hex.DecodeString(input.SHA256)
	input.SHA256 = strings.ToLower(input.SHA256)
	switch {
	case validVoiceRunIndex(runIndex) != nil:
		return nil, validVoiceRunIndex(runIndex)
	case !known:
		return nil, invalid("Voice audio must be audio/wav (PCM).")
	case input.Bytes < 1 || input.Bytes > format.maxBytes:
		return nil, invalid(fmt.Sprintf("A %s run has 1 to %d bytes.", input.ContentType, format.maxBytes))
	case digestErr != nil || len(digest) != 32:
		return nil, invalid("sha256 must be the file's hex SHA-256.")
	case input.StartOffsetMs < 0 || input.StartOffsetMs > voiceMaxRunMs:
		return nil, invalid("startOffsetMs must be within the note's 31 minutes.")
	case input.DurationMs != nil && (*input.DurationMs < 0 || *input.DurationMs > 24*60*60*1000):
		return nil, invalid("durationMs is out of range.")
	case input.SampleRateHz != nil && *input.SampleRateHz <= 0:
		return nil, invalid("sampleRateHz must be positive.")
	}
	store, ok := c.objects.(voiceAudioStore)
	if !ok {
		return nil, ErrStorageUnavailable
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if note, err = lockVoiceNote(ctx, tx, noteID); err != nil {
		return nil, err
	}
	if note.DeletedAt != nil {
		return nil, voiceNoteDeleted()
	}
	run, err := tx.VoiceAudioRun.Query().Where(voiceaudiorun.NoteID(noteID), voiceaudiorun.RunIndex(runIndex)).Only(ctx)
	switch {
	case ent.IsNotFound(err):
		key := fmt.Sprintf("voice/%s/%s/%d-%s.%s", note.OrganizationID, noteID, runIndex, input.SHA256, format.extension)
		run, err = tx.VoiceAudioRun.Create().SetID(cuid.New()).SetOrganizationID(note.OrganizationID).SetNoteID(noteID).
			SetRunIndex(runIndex).SetStartOffsetMs(input.StartOffsetMs).SetNillableClientDurationMs(input.DurationMs).
			SetContentType(input.ContentType).SetBytes(input.Bytes).SetSha256(input.SHA256).SetObjectKey(key).Save(ctx)
	case err != nil:
	case run.Sha256 != input.SHA256 || run.Bytes != input.Bytes || run.ContentType != input.ContentType:
		return nil, conflict("This run was already uploaded with a different file.")
	case run.Status == voiceaudiorun.StatusDeleted:
		return nil, conflict("This run's audio was deleted.")
	case run.Status == voiceaudiorun.StatusFailed:
		// An upload that expired is started again under the same key.
		run, err = run.Update().SetStatus(voiceaudiorun.StatusPending).ClearFailureReason().ClearObjectPurgedAt().Save(ctx)
	case run.Status == voiceaudiorun.StatusPending:
		// A new URL restarts the clock on an unfinished upload.
		run, err = run.Update().SetUpdatedAt(time.Now()).Save(ctx)
	}
	if err != nil {
		return nil, err
	}
	// An available run is signed too: the write-once PUT then answers 412,
	// and complete returns the run as it is.
	url, headers, err := store.SignChecksummedUpload(ctx, run.ObjectKey, run.ContentType, run.Bytes, digest, voiceUploadExpiry)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := &VoiceRunUpload{URL: url, Method: http.MethodPut, Headers: map[string]string{}, ExpiresAt: time.Now().UTC().Add(voiceUploadExpiry)}
	for name := range headers {
		result.Headers[name] = headers.Get(name)
	}
	return result, nil
}

// CompleteVoiceRun reads the stored run back: its size, its SHA-256 and its
// audio frames, measuring the duration and sample rate the server keeps
// (S19). Only then is it available. A missing, truncated or non-audio object
// answers 400 and the run stays pending for the phone to resend (S4, D6); a
// bad object is removed so the write-once resend can store the good one.
// shortcut: the check runs in the request, as CompleteAssetUpload's does; a
// Temporal activity is the upgrade when runs grow.
func (c *Configuration) CompleteVoiceRun(ctx context.Context, actor Actor, noteID string, runIndex int) (*VoiceAudioRun, error) {
	note, err := c.liveVoiceNote(ctx, actor, noteID)
	if err != nil {
		return nil, err
	}
	if err := c.requireVoiceAudio(ctx, actor, note); err != nil {
		return nil, err
	}
	if err := validVoiceRunIndex(runIndex); err != nil {
		return nil, err
	}
	run, err := c.client.VoiceAudioRun.Query().Where(voiceaudiorun.OrganizationID(note.OrganizationID), voiceaudiorun.NoteID(noteID),
		voiceaudiorun.RunIndex(runIndex)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("This run was never started. Ask for its upload URL first.")
	}
	if err != nil {
		return nil, err
	}
	switch run.Status {
	case voiceaudiorun.StatusAvailable:
		result := voiceAudioRunRecord(run)
		return &result, nil
	case voiceaudiorun.StatusDeleted:
		return nil, conflict("This run's audio was deleted.")
	case voiceaudiorun.StatusFailed:
		return nil, invalid("This upload expired. Ask for a new upload URL and send the run again.")
	}
	if c.objects == nil {
		return nil, ErrStorageUnavailable
	}
	exists, err := c.objects.Exists(ctx, run.ObjectKey)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	if !exists {
		return nil, ErrObjectMissing
	}
	object, err := c.openObject(ctx, run.ObjectKey)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	audio, err := verifyVoiceRun(object, run.Bytes, run.Sha256)
	object.Close()
	if errors.Is(err, ErrInvalidInput) {
		if deleteErr := c.objects.Delete(ctx, run.ObjectKey); deleteErr != nil {
			return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, deleteErr)
		}
		return nil, err
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := lockVoiceNote(ctx, tx, noteID); err != nil {
		return nil, err
	}
	available, err := tx.VoiceAudioRun.Query().Where(voiceaudiorun.NoteID(noteID), voiceaudiorun.StatusEQ(voiceaudiorun.StatusAvailable),
		voiceaudiorun.IDNEQ(run.ID)).All(ctx)
	if err != nil {
		return nil, err
	}
	total := audio.durationMs
	for _, other := range available {
		if other.DurationMs != nil {
			total += *other.DurationMs
		}
	}
	if total > voiceMaxRunMs {
		// The run stays pending; the upload sweep removes its object.
		return nil, conflict("This run would make the note's audio longer than 31 minutes. Start a new note.")
	}
	updated, err := tx.VoiceAudioRun.Update().Where(voiceaudiorun.ID(run.ID), voiceaudiorun.StatusEQ(voiceaudiorun.StatusPending)).
		SetStatus(voiceaudiorun.StatusAvailable).SetDurationMs(audio.durationMs).SetSampleRateHz(audio.sampleRateHz).Save(ctx)
	if err != nil {
		return nil, err
	}
	if updated == 1 {
		if err := tx.VoiceNote.UpdateOneID(noteID).AddRevision(1).Exec(ctx); err != nil {
			return nil, err
		}
	}
	if run, err = tx.VoiceAudioRun.Get(ctx, run.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if run.Status != voiceaudiorun.StatusAvailable {
		// The note or its audio was deleted while the run was read.
		return nil, conflict("This run's audio was deleted.")
	}
	result := voiceAudioRunRecord(run)
	return &result, nil
}

// SignVoiceRunAudio signs a read of an available run for its owner.
func (c *Configuration) SignVoiceRunAudio(ctx context.Context, actor Actor, noteID string, runIndex int) (*VoiceRunAudio, error) {
	note, err := c.ownedVoiceNote(ctx, actor, noteID)
	if err != nil {
		return nil, err
	}
	if err := c.requireVoiceNotes(ctx, actor); err != nil {
		return nil, err
	}
	run, err := c.client.VoiceAudioRun.Query().Where(voiceaudiorun.OrganizationID(note.OrganizationID), voiceaudiorun.NoteID(noteID),
		voiceaudiorun.RunIndex(runIndex), voiceaudiorun.StatusEQ(voiceaudiorun.StatusAvailable)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("This audio is not available.")
	}
	if err != nil {
		return nil, err
	}
	store, ok := c.objects.(voiceAudioStore)
	if !ok {
		return nil, ErrStorageUnavailable
	}
	url, err := store.SignDownloadFor(ctx, run.ObjectKey, voicePlaybackExpiry)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	return &VoiceRunAudio{URL: url, ExpiresAt: time.Now().UTC().Add(voicePlaybackExpiry)}, nil
}

// DeleteVoiceAudio deletes every run of the member's note: the objects are
// purged and the rows keep a deleted marker; the transcripts stay (D1).
func (c *Configuration) DeleteVoiceAudio(ctx context.Context, actor Actor, noteID string) error {
	if _, err := c.ownedVoiceNote(ctx, actor, noteID); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := lockVoiceNote(ctx, tx, noteID); err != nil {
		return err
	}
	deleted, err := tx.VoiceAudioRun.Update().Where(voiceaudiorun.NoteID(noteID), voiceaudiorun.StatusNEQ(voiceaudiorun.StatusDeleted)).
		SetStatus(voiceaudiorun.StatusDeleted).Save(ctx)
	if err != nil {
		return err
	}
	if deleted > 0 {
		if err := tx.VoiceNote.UpdateOneID(noteID).AddRevision(1).Exec(ctx); err != nil {
			return err
		}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.voice_audio_deleted", "voice_note", noteID,
			map[string]any{"deletedRuns": deleted}); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	c.purgeVoiceObjectsNow(ctx, noteID)
	return nil
}

// purgeVoiceObjects deletes the stored objects of deleted and failed runs,
// oldest first, and records each one storage confirms. It returns the first
// storage failure after trying them all; unmarked runs are retried later.
func (c *Configuration) purgeVoiceObjects(ctx context.Context, limit int, where ...predicate.VoiceAudioRun) (int, error) {
	if c.objects == nil {
		// Without storage no upload was ever signed, so there is nothing to purge.
		return 0, nil
	}
	purgeable := []predicate.VoiceAudioRun{voiceaudiorun.StatusIn(voiceaudiorun.StatusDeleted, voiceaudiorun.StatusFailed),
		voiceaudiorun.ObjectPurgedAtIsNil()}
	runs, err := c.client.VoiceAudioRun.Query().Where(append(where, purgeable...)...).
		Order(ent.Asc(voiceaudiorun.FieldUpdatedAt)).Limit(limit).All(ctx)
	if err != nil {
		return 0, err
	}
	purged := 0
	var failure error
	for _, run := range runs {
		if err := c.objects.Delete(ctx, run.ObjectKey); err != nil {
			if failure == nil {
				failure = fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
			}
			continue
		}
		// A failed run started again since is pending and keeps its object.
		marked, err := c.client.VoiceAudioRun.Update().Where(append([]predicate.VoiceAudioRun{voiceaudiorun.ID(run.ID)}, purgeable...)...).
			SetObjectPurgedAt(time.Now().UTC()).Save(ctx)
		if err != nil {
			return purged, err
		}
		purged += marked
	}
	return purged, failure
}

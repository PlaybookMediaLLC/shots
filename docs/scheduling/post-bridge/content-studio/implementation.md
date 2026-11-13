# Shots Content Studio implementation

Authorized 13 November 2026 as a scoped exception to the [RFC 042](../../../rfcs/042-scheduling-feature-priorities.md) deferral, whose Later list holds one-click short-video templates and AI UGC videos. No paid-customer evidence is recorded for it. The [Post Bridge analysis](post-bridge-content-studio-technical-analysis.md) is reference material, not a specification: where they conflict, [media scheduling](../../../media-scheduling.md#bulk-tools) and the existing batch model win.

## Decisions

Made with the product owner on 13 November 2026, before any code:

| Question | Decision |
| --- | --- |
| Where the templates live | New kinds of batch item beside grid videos, under Publish › Bulk tools. One video is a batch of one. |
| UGC template clips | The workspace's own clip, whose rights the person confirms, as for music. A built-in clip library waits for commissioned footage with talent releases that cover advertising and implied endorsement. |
| Music | The person's own file, now with a chosen start. A built-in library waits for tracks bought outright and not registered with Content ID. |
| AI actors and voices | Out of scope: template clips and text only, as the study observed. They need their own RFC for consent, likeness and disclosure. |

## Slices

| Slice | Scope | Owner | Status |
| --- | --- | --- | --- |
| 1 | Fade-in videos: one image, a headline, image only, optional music | `lib/write/grid-layout.ts`, `lib/write/grid-render.ts`, `components/write/batch/TemplateCreator.tsx`; Go `checkBatchGrid` | In review |
| 2 | Music: uploaded audio checks and a trimmed start, for every template | `lib/write/audio-trim.ts`, `components/write/batch/MusicTrim.tsx` | In review |
| 3 | UGC videos: the workspace's clip, text at the top, middle or bottom, the caption assistant, a 3 to 15 second closing clip | `lib/write/grid-render.ts`, `lib/write/caption-assistant.ts`, `components/write/batch/CaptionAssistant.tsx`, `editorAi.suggestOverlayIdeas` | In review |
| 4 | Built-in music library | Waits for licensed tracks | Not started |
| 5 | Built-in UGC clip library | Waits for licensed clips | Not started |

Slices 1 to 3 ship together because they share the concept shape and the render path. A slice is accepted when it has merged with its tests.

## Design

Every template is a `content_batch_item` with a `grid` concept, so the batch already gives a template what the study found missing: a durable record that survives a reload and another device, tenancy and asset checks in Go, protection from cleanup while the batch is open, render runs that freeze a concept and refuse a video for one that changed, and a handoff by asset ID. A video becomes the item's media and then an ordinary draft. Nothing goes through browser storage.

The concept gains a `kind` (absent for the 2×2 grid, `single`, `ugc`) and these optional fields, checked per kind in Go and mirrored in zod:

| Field | Kinds | Rule |
| --- | --- | --- |
| `headline` | all | Grid and fade-in up to 60 characters, UGC up to 150 with line breaks. Empty only for an image-only fade-in. |
| `hideHeadline` | single | Leaves the headline out of the video and keeps its text. |
| `textPosition` | ugc | `top`, `middle` (the default) or `bottom`. |
| `slots` | all | Four images for a grid; one image (JPEG, PNG or WebP) for a fade-in; one clip (MP4 or MOV, 3 to 60 seconds) for UGC. |
| `closingAssetId` | ugc | MP4 or MOV, 3 to 15 seconds, shown after the clip. |
| `musicAssetId`, `musicStartMs` | all | An audio asset, and where it starts (0 to 10 minutes; only with music). |

Clip lengths come from the upload probe (`asset."durationMs"`) and are compared to the tenth of a second, so an encoder's few extra milliseconds pass. A concept keeps its kind: changing it is a conflict.

Rendering stays in the browser. One frame loop serves every kind, with the browser's H.264 and AAC encoders, or FFmpeg frame by frame where the browser lacks them. A grid on FFmpeg keeps its previous single still with no fade, so a batch of grids stays quick there. The batch page holds one renderer for all its creators, because the server keeps one render per batch: a second creator cannot start a render that would cancel the first. A render waits for edits still being saved before the server freezes the concepts.

| Kind | Output |
| --- | --- |
| Grid | Unchanged: 1080×1920, 30 fps, 6 s, H.264, AAC with music. |
| Fade-in | The same envelope. The image fits whole under the headline on the light panel; a one-second fade from 10 % brightness. |
| UGC | 1080×1920 at 30 fps, as long as the clip plus the closing clip. Each clip covers the frame at its own size and frame rate, sampled at 30 fps. The clips keep their sound, and music plays under it at half volume. Text has a dark outline and wraps to eight lines. |

The preview draws with the export's own functions, `composeStill` and `drawOverlay`, which use `wrapLines` and the layout in `grid-layout.ts`. That function keeps typed line breaks, breaks a word wider than a line between characters (CJK, long URLs) without splitting an emoji, and sets right-to-left lines from their first letter.

The trim dialog moves a draft start; Save selection stores it as `musicStartMs`, and Cancel or closing drops it, as does a save that fails. The last start is the track's length less the video's, on 0.1-second steps, and never past ten minutes. A track shorter than the video plays once from its start. A track may be up to ten minutes long, read from its metadata before it is decoded, because decoded audio takes about 23 MB a minute. Decoded audio is released after each video renders.

The caption assistant asks `editorAi.suggestOverlayIdeas` for five ideas from a product description, in the workspace's voice and charged as AI credits. Choosing one replaces the video's text. The post's caption follows the text only while the two are still equal, as a grid's caption follows its headline. Each request has a number, and only the waiting request's answer counts. A failure keeps the description so the person can try again, and an answer that arrives after Cancel changes nothing.

## Data and authority boundaries

- No new table. Migration `20261113090000_content_batch_template_clips.sql` only extends `platform_asset_in_use_v1` with the closing clip, so cleanup cannot retire it while its batch is open.
- Every asset in a concept must be an uploaded asset of the actor's workspace; another workspace's asset is refused as if it did not exist.
- Render runs, their request keys and supersession are unchanged. Only one render runs per batch, whatever its kinds.

## Acceptance

| Behavior | Slice | Proved by |
| --- | --- | --- |
| A fade-in renders at 1080×1920, 180 frames over 6 s, H.264, with AAC only when it has music | 1 | `content-studio.spec.ts` |
| Image only disables the headline, keeps its text, and leaves it out of the frame | 1 | `content-studio.spec.ts`, `write-grid-layout.test.ts` |
| The first frame is dark but not black, and the image is fully visible after one second | 1 | `write-grid-layout.test.ts`, decoded frames in `content-studio.spec.ts` |
| Music that does not decode, is not audio, is empty or is over 50 MB is refused before upload; Go refuses a non-audio music asset | 2 | `write-audio-trim.test.ts`, `content-studio.spec.ts`, `TestContentBatches` |
| Cancel discards a dragged start; Save keeps it across a reload; the help names the chosen interval | 2 | `write-audio-trim.test.ts`, `content-studio.spec.ts` |
| A UGC video is its clip, then its closing clip, at 30 fps; 5.1 s gives 153 frames | 3 | `write-grid-layout.test.ts`, `content-studio.spec.ts` |
| Closing clips of 3 and 15 s pass; 2.9 and 15.1 s are refused, in the browser and in Go | 3 | `write-grid-concepts.test.ts`, `TestContentBatches`, `content-studio.spec.ts` |
| A landscape 25 fps closing clip renders into the 9:16, 30 fps frame | 3 | `content-studio.spec.ts` |
| Overlay text at the top, middle and bottom stays in the frame, for long, multiline, emoji, CJK and RTL text | 3 | `write-grid-layout.test.ts` |
| Caption assistant failure, retry, empty answer and an answer after Cancel | 3 | `write-caption-assistant.test.ts`, `content-studio.spec.ts` |
| A render survives a reload, and the video reaches its draft by asset ID | 1–3 | `content-studio.spec.ts` |
| The fade-in's second frame is about a sixth as bright as its middle; the trimmed start is what plays | 1, 2 | decoded frames and audio in `content-studio.spec.ts` |
| A UGC render is as long as its clips (3 s and 4 s give 210 frames), and the closing clip moves on screen | 3 | `content-studio.spec.ts` |
| A concept keeps its kind, takes only its kind's fields, and holds only this workspace's assets | 1–3 | `TestContentBatches` |

### Known limits

- Where the browser cannot encode H.264 and AAC, FFmpeg holds every frame in memory, so that fallback takes UGC videos of up to 20 seconds and says so.
- A UGC render seeks the clip for every frame. In headless Chromium at 1080×1920 that took 48 ms a frame with a keyframe every second and 143 ms with x264's default spacing, so a 75-second video takes two to five minutes. Reading frames during playback would be close to real time and is the next step if this is too slow on real devices.
- Previews draw the export's frame at a quarter of its size. A UGC clip plays in its preview only when asked, so a page of videos does not decode every clip at once.
- A clip uploaded before upload-time probing has no stored length and is refused. The creator always uploads a fresh file, so this happens only through the API.
- Text uses the device's system font, so emoji and CJK glyphs depend on the fonts the device has. Preview and export run on the same device, so they match each other.

## Outcome metric

Weekly workspaces that render a fade-in or UGC video and schedule it, read beside grid video use. If it does not move within a quarter of use, remove the templates rather than extend them.

## Rollback

Deploy the migration, then the API, then the web. To roll back, redeploy the previous web and API. The migration only adds a closing clip to the in-use check, so it can stay. Fade-in and UGC concepts written meanwhile stay readable: the previous API refuses to edit them (it expects four slots), and the previous grid creator lists them. Close those batches before rolling back, or roll forward.

## Verification

```bash
python3 dev/verify-rfcs.py
(cd clients && npm run quality:check)
make -C server check
make e2e
```

The browser flows are in `clients/apps/web/test/e2e/content-studio.spec.ts`; `bulk-tools.spec.ts` covers the grid on the shared render path.

## Check mapping

Every check from the [verification matrix](studio-verification-matrix.csv), against Shots.

| Check | Disposition |
| --- | --- |
| ST-001 | Differs by decision: there is no separate Studio page. The templates are kinds of batch under Publish › Bulk tools. |
| ST-002 | Slices 1 and 3: New batch offers Grid videos, Fade-in videos and UGC videos (`NewBatchButton`). |
| ST-003 | Exists: a batch has its own URL (`/publish/batches/{id}?start=<kind>`), and a reload or a deep link reopens it. The specs reload. |
| ST-004, ST-041 | Exists: grid uploads per slot and in bulk, rendered with real images in `bulk-tools.spec.ts` (BULK-035 to 052). |
| ST-005 | Exists: grid readiness counts missing images, and Go refuses to render a concept with an empty slot. |
| ST-006 | Skip: the grid covers its cells. A fade-in shows the whole image, which is what portrait mode is for. |
| ST-007 | Exists: `bulk-tools.spec.ts` measures 1080×1920, 6 s, H.264 and AAC. |
| ST-008 | Differs by decision: each video is its own concept, and nothing carries between templates unseen. A grid batch still has "Music for all videos". |
| ST-009, ST-010, ST-011, ST-042 | Slice 1. |
| ST-012 | Slice 1: a one-second fade from 10 % brightness and a 0.4-second fade out, in `frameAlpha`. |
| ST-013 | Skip: no third-party embeds. The preview is drawn by the renderer itself. |
| ST-014 | Deferred to Slice 4: no built-in tracks until licensed tracks are supplied. |
| ST-015, ST-016, ST-017, ST-018 | Slice 2. ST-016 (Cancel kept the change) is fixed by the draft start. |
| ST-019 | Deferred to Slice 5: no built-in UGC styles. The workspace's own clip takes a style's place. |
| ST-020 | Slice 3: a concept without a clip says "Needs a clip" and cannot render. |
| ST-021 | Slice 3: Add video is disabled until the text has a letter. Go and zod refuse blank text. |
| ST-022 | Slice 3: music and the closing clip are optional, in Go and in the creator. |
| ST-023 | Slice 3: each concept is its own server record. A reload keeps its text and position. |
| ST-024 | Slice 3: one `overlayBlock`, shared by preview and export. |
| ST-025 | Differs: clips are workspace assets read through the signed-in content route, never signed URLs held by the page. A render loads the clip whole before it seeks. |
| ST-026, ST-044 | Slice 3: closing clip. |
| ST-027, ST-028, ST-029, ST-045 | Slice 3: caption assistant. |
| ST-030 | Exists: per-video progress, Stop, and a failure recorded on the run. |
| ST-031 | Slice 3: 30 fps at 1080×1920. A 5.1 s clip gives 153 frames, as measured. |
| ST-032 | Exists: no audio track without sound. The fade-in spec asserts H.264 alone. |
| ST-033 | Slice 3: one wrap for preview and export, tested with long, multiline, emoji, CJK and RTL text. Text past eight lines ends in an ellipsis. |
| ST-034 | Exists: Download, and Download all as a ZIP. |
| ST-035, ST-048 | Fixed by design: the video is an uploaded asset on its item, sent in parts above 16 MiB up to 512 MiB, and the draft references it by ID. No browser storage is involved. |
| ST-036 | Exists: a failure stays on its item, and a finished video stays downloadable after it becomes a draft. |
| ST-037 | Differs: finished videos are saved. Leaving warns only while a render runs, and then loses only that video. |
| ST-038 | Skip: there is no result modal. Results show beside each video. Checked at 1440 and 390 pixels without horizontal scrolling. |
| ST-039 | Slices 1 to 3: every new control has a name. These include "Trim music for video N", "Write text for video N with AI", "Download video N", "Preview of video N", the image-only switches and the text-position group. |
| ST-040 | Skip for the public API: renders are web API routes of a batch. The public API takes finished MP4s. |
| ST-043 | Slice 2: MP3, M4A/AAC, WAV, Ogg and WebM, up to 50 MB, decoded in the browser before upload. An empty file is refused. A short track plays once. The start is bounded. |
| ST-046 | Exists: concepts are tenant-scoped batch items. Reload is tested, and another workspace's asset is refused (`TestContentBatches`). |
| ST-047 | Exists: render runs replay by request key, and a newer run replaces an older one. A concept that changed during a render refuses the video. |
| ST-049 | Exists: drafts schedule through the ordinary path ([scheduling reliability](../../reliability.md)). Not repeated here. |

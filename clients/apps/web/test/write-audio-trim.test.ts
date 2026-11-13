import assert from 'node:assert/strict'
import test from 'node:test'
import {
  audioFileProblem,
  clampStart,
  clock,
  excerptText,
  latestStart,
  trimDialog,
} from '@/lib/write/audio-trim'

test('the latest start leaves a full video of music, on the tenth of a second', () => {
  // The analysis's 30.14525-second track: Post Bridge allowed 24.1 at most (ST-015).
  assert.equal(latestStart(30_145, 6000), 24_100)
  assert.equal(latestStart(6000, 6000), 0)
  // A track shorter than the video cannot move: it plays once from its start.
  assert.equal(latestStart(4000, 6000), 0)
})

test('a start is kept within the track and on the step', () => {
  assert.equal(clampStart(-500, 30_145, 6000), 0)
  assert.equal(clampStart(24_149, 30_145, 6000), 24_100)
  assert.equal(clampStart(99_000, 30_145, 6000), 24_100)
  assert.equal(clampStart(1234, 30_145, 6000), 1200)
  assert.equal(clampStart(3000, 4000, 6000), 0)
})

test('the help says the interval chosen, not a fixed first six seconds (ST-018)', () => {
  assert.equal(clock(24_100), '0:24.1')
  assert.equal(clock(65_000), '1:05.0')
  assert.equal(excerptText(24_100, 30_145, 6000), 'Plays 0:24.1 to 0:30.1 of the 0:30.1 track.')
  assert.equal(excerptText(0, 30_145, 6000), 'Plays 0:00.0 to 0:06.0 of the 0:30.1 track.')
  assert.match(excerptText(0, 4000, 6000), /plays once from its start, then the video is silent/)
  assert.doesNotMatch(excerptText(0, 6000, 6000), /silent/)
})

test('Cancel drops the dragged start, so reopening shows the saved one (ST-016)', () => {
  const track = { trackMs: 30_145, videoMs: 6000 }
  let state = trimDialog({ draftMs: null }, { committedMs: 0, type: 'open' })
  state = trimDialog(state, { ms: 24_100, type: 'move', ...track })
  assert.equal(state.draftMs, 24_100)
  state = trimDialog(state, { type: 'close' })
  assert.equal(state.draftMs, null)
  state = trimDialog(state, { committedMs: 0, type: 'open' })
  assert.equal(state.draftMs, 0)
  // A closed dialog ignores a late slider event.
  assert.equal(trimDialog({ draftMs: null }, { ms: 5000, type: 'move', ...track }).draftMs, null)
  // The slider cannot go past the end.
  assert.equal(trimDialog({ draftMs: 0 }, { ms: 30_000, type: 'move', ...track }).draftMs, 24_100)
})

test('music files are checked for type, size and emptiness before they upload (ST-043)', () => {
  for (const name of ['song.mp3', 'song.m4a', 'song.wav', 'song.ogg', 'song.webm', 'song.aac'])
    assert.equal(audioFileProblem({ name, size: 1000, type: '' }), null, name)
  assert.equal(audioFileProblem({ name: 'x', size: 1000, type: 'audio/x-wav' }), null)
  assert.match(audioFileProblem({ name: 'song.flac', size: 1000, type: 'audio/flac' }) ?? '', /MP3/)
  assert.match(audioFileProblem({ name: 'clip.mp4', size: 1000, type: 'video/mp4' }) ?? '', /MP3/)
  assert.match(
    audioFileProblem({ name: 'song.wav', size: 51 * 1024 * 1024, type: 'audio/wav' }) ?? '',
    /under 50 MB/
  )
  assert.match(audioFileProblem({ name: 'song.mp3', size: 0, type: 'audio/mpeg' }) ?? '', /empty/)
})

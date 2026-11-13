import assert from 'node:assert/strict'
import test from 'node:test'
import { type AssistantState, captionAssistant } from '@/lib/write/caption-assistant'

const ideas = ['One', 'Two', 'Three', 'Four', 'Five']

test('ideas arrive for the request that is waiting', () => {
  let state: AssistantState = captionAssistant({ phase: 'closed' }, { type: 'open' })
  assert.deepEqual(state, { phase: 'describe' })
  state = captionAssistant(state, { request: 1, type: 'request' })
  state = captionAssistant(state, { choices: [...ideas, ' '], request: 1, type: 'answered' })
  assert.deepEqual(state, { choices: ideas, phase: 'choices' })
})

test('a failure keeps the description and can be tried again (ST-045)', () => {
  let state = captionAssistant(
    { phase: 'requesting', request: 1 },
    {
      error: 'The AI service is unavailable.',
      request: 1,
      type: 'failed',
    }
  )
  assert.deepEqual(state, { error: 'The AI service is unavailable.', phase: 'describe' })
  state = captionAssistant(state, { request: 2, type: 'request' })
  state = captionAssistant(state, { choices: ideas, request: 2, type: 'answered' })
  assert.equal(state.phase, 'choices')
})

test('an empty answer is a failure, not an empty list', () => {
  const state = captionAssistant(
    { phase: 'requesting', request: 3 },
    { choices: ['', '  '], request: 3, type: 'answered' }
  )
  assert.deepEqual(state, { error: 'No ideas came back. Try again.', phase: 'describe' })
})

test('an answer after Cancel or after a newer request changes nothing (ST-045)', () => {
  // Closed while waiting: the late answer is dropped.
  const closed = captionAssistant({ phase: 'requesting', request: 1 }, { type: 'close' })
  assert.deepEqual(
    captionAssistant(closed, { choices: ideas, request: 1, type: 'answered' }),
    closed
  )
  // Reopened and asked again: the first request's answer still does not count.
  const again: AssistantState = { phase: 'requesting', request: 2 }
  assert.deepEqual(captionAssistant(again, { choices: ideas, request: 1, type: 'answered' }), again)
  assert.deepEqual(
    captionAssistant(again, { error: 'Timed out', request: 1, type: 'failed' }),
    again
  )
  // Ideas already on screen are not replaced by a stray answer.
  const shown: AssistantState = { choices: ['Shown'], phase: 'choices' }
  assert.deepEqual(captionAssistant(shown, { choices: ideas, request: 2, type: 'answered' }), shown)
})

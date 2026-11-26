import assert from 'node:assert/strict'
import test from 'node:test'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { createScriptedModel } from '@/lib/ai/models/scripted'

/** The scripted model's studio edits read ids from what the inspect tools really send. */
for (const [ask, inspect, edit, seen, expected] of [
  ['Rename the first artboard', 'inspectBoard', 'editBoard', [{ id: 'art-1' }], 'art-1'],
  [
    'Rewrite the first story headline',
    'inspectStorySet',
    'editStorySet',
    { activeOutputId: 'out-1', outputs: [{ id: 'out-1' }], stories: [{ id: 'story-1' }] },
    'story-1',
  ],
] as const) {
  test(`${edit} is called with the id from ${inspect}`, async () => {
    const sent: unknown[] = []
    const result = streamText({
      messages: [{ content: ask, role: 'user' }],
      model: createScriptedModel('scripted'),
      stopWhen: stepCountIs(4),
      tools: {
        [edit]: tool({
          execute: async (input: unknown) => (sent.push(input), { applied: true }),
          inputSchema: z.looseObject({}),
        }),
        [inspect]: tool({
          execute: async () => JSON.stringify(seen),
          inputSchema: z.object({}),
        }),
      },
    })
    await result.consumeStream()
    assert.ok(JSON.stringify(sent).includes(expected), JSON.stringify(sent))
  })
}

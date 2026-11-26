import assert from 'node:assert/strict'
import test from 'node:test'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { createScriptedModel } from '@/lib/ai/models/scripted'

test('the scripted model streams the tool call and then the text it generates', async () => {
  const result = streamText({
    messages: [{ content: 'review this design', role: 'user' }],
    model: createScriptedModel('scripted'),
    stopWhen: stepCountIs(3),
    tools: {
      reviewDesign: tool({ execute: async () => ({ count: 0 }), inputSchema: z.object({}) }),
    },
  })
  const seen: string[] = []
  for await (const part of result.fullStream) {
    if (part.type === 'error') throw part.error
    seen.push(part.type)
  }
  assert.ok(seen.includes('tool-call'))
  assert.ok((await result.text).includes('reviewed the design'))
})

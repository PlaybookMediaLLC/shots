import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText, wrapLanguageModel } from 'ai'
import { validateVoiceMemo, voiceMemoSchema } from '@/lib/write/voice-memo'
import { createAiCreditMeter } from '@/lib/ai/metering/meter'
import { createMeterMiddleware } from '@/lib/ai/models/middleware/meter'
import { DEFAULT_MODEL_IDS } from '@/lib/ai/models/catalog'

const wav = Buffer.from('RIFF0000WAVEfmt fixture audio')

test('voice memo validation rejects forged formats, URLs and oversized audio', () => {
  validateVoiceMemo(wav, 'audio/wav')
  assert.throws(() => validateVoiceMemo(Buffer.from('<html>no audio</html>'), 'audio/wav'))
  assert.throws(() => validateVoiceMemo(wav, 'audio/mpeg'))
  assert.throws(() => validateVoiceMemo(new Uint8Array(10 * 1024 * 1024 + 1), 'audio/wav'))
  assert.throws(() => validateVoiceMemo(wav, 'audio/webm'))
  const input = {
    draftId: 'draft',
    channel: 'x',
    mediaType: 'audio/wav',
    audio: wav.toString('base64'),
  }
  for (const channel of ['x', 'tiktok', 'youtube']) {
    assert.equal(voiceMemoSchema.safeParse({ ...input, channel }).success, true)
  }
  assert.equal(
    voiceMemoSchema.safeParse({ ...input, audio: 'https://example.org/memo.wav' }).success,
    false
  )
  assert.equal(voiceMemoSchema.safeParse({ ...input, organizationId: 'foreign' }).success, false)
})

test('audio goes inline to the configured provider and its reported cost is metered', async () => {
  let payload: Record<string, unknown> | undefined
  const provider = createOpenRouter({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          id: 'audio-fixture',
          object: 'chat.completion',
          created: 1,
          model: DEFAULT_MODEL_IDS.transcription,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'We shipped the first version.' },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108, cost: 0.025 },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    },
  })
  const charges: number[] = []
  const { meter, withAiCredits } = createAiCreditMeter<{ organizationId: string }>(
    async (_tenant, amount) => {
      charges.push(amount)
      return 100 - amount
    }
  )
  const model = wrapLanguageModel({
    model: provider(DEFAULT_MODEL_IDS.transcription),
    middleware: createMeterMiddleware(DEFAULT_MODEL_IDS.transcription, meter),
  })
  await assert.rejects(generateText({ model, prompt: 'No scope' }), /metered AI action/)
  const result = await withAiCredits({ organizationId: 'workspace' }, () =>
    generateText({
      model,
      messages: [{ role: 'user', content: [{ type: 'file', data: wav, mediaType: 'audio/wav' }] }],
    })
  )
  assert.equal(result.text, 'We shipped the first version.')
  assert.deepEqual((payload!.messages as { content: unknown }[])[0].content, [
    { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } },
  ])
  assert.deepEqual(charges, [0, 2, 1])
})

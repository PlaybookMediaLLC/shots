import assert from 'node:assert/strict'
import test from 'node:test'
import { openRouterLanguageModel, openRouterSettings } from '@/lib/ai/models/provider'
import { AI_MODEL_TIER_LIST } from '@/lib/ai/models/tiers'

test('every OpenRouter model skips endpoints that may store or train on prompts', () => {
  for (const model of [
    ...AI_MODEL_TIER_LIST.map((tier) => tier.modelId),
    'openai/gpt-5',
    'google/gemini-2.5-flash-image',
  ]) {
    assert.equal(openRouterSettings(model).provider?.data_collection, 'deny')
    for (const effort of ['low', 'medium', 'high'] as const) {
      const settings = openRouterSettings(model, effort)
      assert.equal(settings.provider?.data_collection, 'deny')
      assert.equal(
        settings.reasoning && 'effort' in settings.reasoning
          ? settings.reasoning.effort
          : undefined,
        effort
      )
    }
  }
})

test('BYOK OpenRouter models still enforce zero data retention, reasoning, and cache settings', () => {
  const byokModel = openRouterLanguageModel(
    'anthropic/claude-sonnet-5.5',
    'medium',
    '  sk-or-v1-test-byok-key-1234567890  '
  ) as {
    modelId?: string
    settings?: {
      cache_control?: { type?: string }
      provider?: { data_collection?: string }
      reasoning?: { effort?: string }
    }
  }
  assert.equal(byokModel.modelId, 'anthropic/claude-sonnet-5.5')
  assert.equal(byokModel.settings?.provider?.data_collection, 'deny')
  assert.equal(byokModel.settings?.reasoning?.effort, 'medium')
  assert.equal(byokModel.settings?.cache_control?.type, 'ephemeral')
})

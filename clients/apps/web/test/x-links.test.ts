import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { WORKSPACE_ADDONS } from '@/lib/billing/plans'
import { postFailureFix, postFailureReason, retryCanHelp } from '@/lib/content-drafts/post-status'
import { countXLinks, extractXLinks, hasXLinks } from '@/lib/content-drafts/x-links'

test('extractXLinks detects full URLs and bare domains while preserving emails and handles', () => {
  assert.deepEqual(extractXLinks('Shipping v2.1.0 today! @shots #launch $USD'), [])
  assert.equal(hasXLinks('Email team@playbookmedia.io for help'), false)
  assert.deepEqual(extractXLinks('Read https://shots.playbookmedia.io/changelog now'), [
    'https://shots.playbookmedia.io/changelog',
  ])
  assert.deepEqual(extractXLinks('Try shots.studio/demo or my.design/kit'), [
    'shots.studio/demo',
    'my.design/kit',
  ])
  assert.equal(countXLinks('🚀 https://example.com/a and example.org/b 🎉'), 2)
})

test('WORKSPACE_ADDONS.x_links constants match Go server/internal/product/x_links.go', () => {
  const go = readFileSync('../../../server/internal/product/x_links.go', 'utf8')
  const limit = Number(go.match(/DefaultXLinksLimit\s*=\s*(\d+)/)?.[1])
  const windowDays = Number(go.match(/XLinksWindowDays\s*=\s*(\d+)/)?.[1])
  const priceUsd = Number(go.match(/XLinksMonthlyPriceUSD\s*=\s*(\d+)/)?.[1])
  assert.equal(WORKSPACE_ADDONS.x_links.limit, limit)
  assert.equal(WORKSPACE_ADDONS.x_links.windowDays, windowDays)
  assert.equal(WORKSPACE_ADDONS.x_links.priceMonthlyUsd, priceUsd)
})

test('X link publishing failure codes map to actionable user messages and fixes', () => {
  assert.match(postFailureReason('X_LINK_STRIPPED_EMPTY') ?? '', /Links in X posts/i)
  assert.match(postFailureReason('X_LINK_QUOTA_EXCEEDED') ?? '', /40 X link posts/i)
  assert.equal(postFailureFix('X_LINK_STRIPPED_EMPTY'), 'edit')
  assert.equal(retryCanHelp('X_LINK_STRIPPED_EMPTY'), false)
  assert.equal(postFailureFix('X_LINK_QUOTA_EXCEEDED'), 'reschedule')
  assert.equal(retryCanHelp('X_LINK_QUOTA_EXCEEDED'), true)
})

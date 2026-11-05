import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { helpTipIdSchema } from '../lib/api/contracts/settings-platform'
import { PLATFORM_DESTINATIONS, type PlatformAccess } from '../lib/platform/navigation'
import {
  getProductTour,
  isOnTourRoute,
  isTourAvailable,
  parseTourSession,
  PRODUCT_TOURS,
  productTourSchema,
  shouldAutoStartTour,
  tourTipId,
  unsavedTips,
} from '../lib/platform/product-tour'

const everything: PlatformAccess = {
  campaignsEnabled: true,
  draftsEnabled: true,
  draftsPlan: true,
  paidPlan: true,
}

test('every registered tour matches the tour schema, with a unique ID', () => {
  for (const tour of PRODUCT_TOURS) {
    const parsed = productTourSchema.safeParse(tour)
    assert.ok(parsed.success, `${tour.id}: ${parsed.error?.message}`)
    const stepIds = tour.steps.map((step) => step.id)
    assert.equal(new Set(stepIds).size, stepIds.length, `${tour.id}: duplicate step IDs`)
  }
  const ids = PRODUCT_TOURS.map((tour) => tour.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('each tour saves as a help tip ID that the preferences API accepts', () => {
  for (const tour of PRODUCT_TOURS) {
    assert.ok(helpTipIdSchema.safeParse(tourTipId(tour)).success, tourTipId(tour))
  }
  assert.equal(tourTipId(getProductTour('workspace')), 'tour-workspace-v1')
})

test('a next tour names a registered tour, so the journey has no dead end', () => {
  for (const tour of PRODUCT_TOURS) {
    const next = 'next' in tour ? tour.next : undefined
    if (next) {
      assert.ok(
        PRODUCT_TOURS.some((candidate) => candidate.id === next),
        `${tour.id} -> ${next}`
      )
    }
  }
})

test('a tour is offered only where the workspace has its feature', () => {
  const publish = getProductTour('publish')
  assert.equal(isTourAvailable(publish, everything), true)
  // Without the rollout, Publish opens link checks; without the plan, it is marked Pro.
  assert.equal(isTourAvailable(publish, { ...everything, draftsEnabled: false }), false)
  assert.equal(isTourAvailable(publish, { ...everything, draftsPlan: false }), false)
  // Automate needs a paid plan, as the sidebar shows it.
  const automate = getProductTour('automate')
  assert.equal(isTourAvailable(automate, everything), true)
  assert.equal(isTourAvailable(automate, { ...everything, paidPlan: false }), false)
  // A tour without a gate is always offered.
  assert.equal(
    isTourAvailable(getProductTour('workspace'), { ...everything, paidPlan: false }),
    true
  )
})

test('a tour starts by itself only until it is finished or skipped, here or on another device', () => {
  const workspace = getProductTour('workspace')
  assert.equal(shouldAutoStartTour(workspace, everything, [], []), true)
  assert.equal(shouldAutoStartTour(workspace, everything, ['tour-workspace-v1'], []), false)
  assert.equal(shouldAutoStartTour(workspace, everything, [], ['tour-workspace-v1']), false)
  // A new version of the tour is new to everyone.
  assert.equal(
    shouldAutoStartTour({ ...workspace, version: 2 }, everything, ['tour-workspace-v1'], []),
    true
  )
  // A tour opened from its button or the menu never starts by itself.
  assert.equal(shouldAutoStartTour(getProductTour('publish'), everything, [], []), false)
})

test('a stored session resumes only for a known tour and a step it has', () => {
  assert.deepEqual(parseTourSession('{"tourId":"publish","stepIndex":2}'), {
    tourId: 'publish',
    stepIndex: 2,
  })
  for (const raw of [
    null,
    '',
    'not json',
    '{"tourId":"other","stepIndex":0}',
    '{"tourId":"publish","stepIndex":-1}',
    `{"tourId":"publish","stepIndex":${getProductTour('publish').steps.length}}`,
    '{"tourId":"publish","stepIndex":1.5}',
  ]) {
    assert.equal(parseTourSession(raw), null, String(raw))
  }
})

test('a step route covers its page and the pages under it, with or without the locale', () => {
  assert.equal(isOnTourRoute('/publish', '/publish'), true)
  assert.equal(isOnTourRoute('/fr/publish', '/publish'), true)
  // An open draft keeps the Publish rail, so the tour does not close it.
  assert.equal(isOnTourRoute('/publish/cmw1n2fx500000a052bauxilt', '/publish'), true)
  assert.equal(isOnTourRoute('/writer', '/publish'), false)
  assert.equal(isOnTourRoute('/home', '/publish'), false)
  assert.equal(isOnTourRoute('/home', undefined), true)
})

test('a seen tour stays in the tab only until its save lands', () => {
  assert.deepEqual(unsavedTips(['tour-workspace-v1'], []), ['tour-workspace-v1'])
  assert.deepEqual(unsavedTips(['tour-workspace-v1'], ['tour-workspace-v1']), [])
  // So "Reset help tips" (an empty saved list) brings a saved tour back.
  assert.deepEqual(unsavedTips([], []), [])
})

/** All component sources, to prove that every step has an element to point at. */
function componentSources(): string {
  return readdirSync('components', { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => readFileSync(join('components', file), 'utf8'))
    .join('\n')
}

test('every tour step points at an element that the app marks', () => {
  const sources = componentSources()
  const navKeys = new Set<string>(PLATFORM_DESTINATIONS.map((destination) => destination.key))
  // Sidebar rows are marked `nav-<key>` from the destination list, and the row
  // passes it on to its link.
  assert.ok(sources.includes('tourId={`nav-${key}`}'), 'the sidebar names its rows')
  assert.ok(
    readFileSync('components/platform-shell/NavRow.tsx', 'utf8').includes('data-tour-id={tourId}'),
    'the sidebar row marks its link'
  )
  for (const tour of PRODUCT_TOURS) {
    for (const step of tour.steps) {
      if (step.anchor.startsWith('nav-')) {
        assert.ok(navKeys.has(step.anchor.slice(4)), `${tour.id}/${step.id}: ${step.anchor}`)
      } else {
        assert.ok(
          sources.includes(`data-tour-id="${step.anchor}"`),
          `${tour.id}/${step.id}: no element has data-tour-id="${step.anchor}"`
        )
      }
    }
  }
})

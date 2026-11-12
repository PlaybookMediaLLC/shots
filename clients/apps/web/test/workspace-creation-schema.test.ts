import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { workspaceCreateSchema } from '../lib/workspace/input-schemas'
import {
  signupSourceSchema,
  workspaceCreationInputSchema,
  workspaceCreationMetadataSchema,
  workspaceCreationLogoSchema,
} from '../../../packages/screenshot-studio-backend-sdk/src/workspace-creation'

test('creation preserves retry identity and optional active-workspace preservation', () => {
  const input = {
    name: 'Team',
    slug: 'team',
    idempotencyKey: 'c070e1ef-a7c8-4f48-b582-e84d5e831e4c',
    keepCurrentActiveOrganization: true,
  }
  assert.deepEqual(workspaceCreateSchema.parse(input), input)
  assert.deepEqual(workspaceCreationInputSchema.parse(input), input)
  for (const schema of [workspaceCreateSchema, workspaceCreationInputSchema]) {
    assert.equal(schema.safeParse({ ...input, idempotencyKey: 'bad' }).success, false)
    assert.equal(
      schema.safeParse({ ...input, keepCurrentActiveOrganization: 'true' }).success,
      false
    )
    assert.equal(schema.safeParse({ name: 'Team', slug: 'team' }).success, true)
  }
})

test('creation metadata is bounded and logo references contain no credentials', () => {
  assert.equal(
    workspaceCreationMetadataSchema.safeParse({
      source: 'test',
      nested: { count: 2, enabled: true },
    }).success,
    true
  )
  for (const value of [
    { large: 'x'.repeat(8193) },
    { escaped: '<'.repeat(1500) },
    { nested: { nested: { nested: {} } } },
  ]) {
    assert.equal(workspaceCreationMetadataSchema.safeParse(value).success, false)
  }
  assert.equal(workspaceCreationLogoSchema.safeParse('https://example.test/logo.png').success, true)
  for (const value of [
    'file:///tmp/logo.png',
    'https://user:password@example.test/logo.png',
    'https://example.test/' + 'x'.repeat(2048),
  ]) {
    assert.equal(workspaceCreationLogoSchema.safeParse(value).success, false)
  }
})

test('where the creator heard about Shots is one known source, with a short detail only for other', () => {
  const base = { name: 'Team', slug: 'team' }
  for (const schema of [workspaceCreateSchema, workspaceCreationInputSchema]) {
    assert.deepEqual(schema.parse({ ...base, heardAbout: { source: 'linkedin' } }).heardAbout, {
      source: 'linkedin',
    })
    assert.deepEqual(
      schema.parse({ ...base, heardAbout: { source: 'other', detail: '  A talk  ' } }).heardAbout,
      { source: 'other', detail: 'A talk' }
    )
    for (const heardAbout of [
      { source: 'billboard' },
      { source: 'search', detail: 'Google' },
      { source: 'other', detail: 'x'.repeat(201) },
      { source: 'other', campaign: 'spring' },
      { source: 'other', detail: 'a\u0000b' },
    ]) {
      assert.equal(
        schema.safeParse({ ...base, heardAbout }).success,
        false,
        JSON.stringify(heardAbout)
      )
    }
  }
})

test('the answers the web offers are exactly the ones Go and the database accept', () => {
  // A value in one list only would fail onboarding with a 400 or a 500 for whoever picks it.
  const quoted = (text: string) =>
    [...text.matchAll(/'([a-z_]+)'|"([a-z_]+)"/g)].map((m) => m[1] ?? m[2])
  const ent = readFileSync(
    new URL('../../../../server/ent/schema/platform_signup_source.go', import.meta.url),
    'utf8'
  )
  const sql = readFileSync(
    new URL(
      '../../../../server/platformmigrations/sql/20261112120000_platform_signup_source.sql',
      import.meta.url
    ),
    'utf8'
  )
  const entValues = quoted(
    ent.slice(ent.indexOf('.Values('), ent.indexOf(').Immutable()', ent.indexOf('.Values(')))
  )
  const sqlList = sql.indexOf('"source" IN (') + '"source" IN ('.length
  const sqlValues = quoted(sql.slice(sqlList, sql.indexOf('))', sqlList)))
  assert.deepEqual(entValues, signupSourceSchema.options)
  assert.deepEqual(sqlValues, signupSourceSchema.options)
})

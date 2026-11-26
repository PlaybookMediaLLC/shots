import assert from 'node:assert/strict'
import test from 'node:test'
import { applyToSession } from '@/lib/assistant/surface-edits'
import { surfaceTools } from '@/lib/ai/assistant/turn'
import {
  boardEditSchema,
  codeSceneEditSchema,
  storySetEditSchema,
} from '@/lib/assistant/surface-commands'
import type { OrganizationRole } from '@/lib/auth/permissions'
import { applyCodeCommand } from '@/lib/code-studio/commands'
import { newCodeDocument } from '@/lib/code-studio/document'

const access = (role: OrganizationRole) => ({
  deniedPermissions: [],
  organizationId: 'org_1',
  principal: { display: 'a', kind: 'session' as const, sessionId: 's', userId: 'u' },
  requestId: 'r',
  role,
})

test('a viewer gets no surface tools, and unknown names are dropped', () => {
  assert.deepEqual(surfaceTools(access('viewer'), ['applyChanges']), [])
  assert.deepEqual(surfaceTools(access('creator'), ['applyChanges', 'publishNow']), [
    'applyChanges',
  ])
})

test('no surface accepts a delete', () => {
  const refused = (schema: { safeParse: (value: unknown) => { success: boolean } }, type: string) =>
    assert.equal(
      schema.safeParse({ commands: [{ type, ids: ['a'], storyId: 'a', slide: 0 }], summary: 'x' })
        .success,
      false
    )
  refused(boardEditSchema, 'remove-artboards')
  refused(storySetEditSchema, 'remove-story')
  refused(codeSceneEditSchema, 'remove-slide')
})

test('a slide patch changes only what it names', () => {
  const document = newCodeDocument()
  document.slides[0]!.duration = 6_000
  const parsed = codeSceneEditSchema.parse({
    commands: [{ patch: { caption: 'New' }, slide: 0, type: 'update-slide' }],
    summary: 'x',
  })
  const after = applyCodeCommand(document, parsed.commands[0] as never)
  assert.equal(after.slides[0]!.duration, 6_000)
  assert.equal(after.slides[0]!.caption, 'New')
})

/** A session as the studios have: history, no step for a no-op, and a fresh object on save. */
function fakeSession() {
  let history: { value: number }[] = [{ value: 0 }]
  return {
    command: (add: number) => {
      if (add !== 0) history.push({ value: history.at(-1)!.value + add })
    },
    save: () => {
      history = history.map((item) => ({ ...item }))
    },
    snapshot: () => ({ document: history.at(-1)! }),
    undo: () => {
      if (history.length > 1) history.pop()
    },
  }
}

test('Undo takes back exactly the applied steps, also after an autosave', () => {
  const session = fakeSession()
  session.command(5)
  const reduce = (document: { value: number }, add: number) => {
    if (add > 100) throw new Error('bad')
    return { value: document.value + add }
  }
  assert.throws(() => applyToSession(session, reduce, [1, 500]))
  assert.equal(session.snapshot().document.value, 5)
  const edit = applyToSession(session, reduce, [1, 0, 2])
  session.save()
  assert.ok(edit.isNewest())
  edit.undo()
  assert.equal(session.snapshot().document.value, 5)
  assert.equal(applyToSession(session, reduce, [0]).isNewest(), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accessAllows,
  hasPermission,
  needsShotsTwoFactor,
  normalizeOrganizationRole,
  organizationRoles,
} from '@/lib/auth/permissions'

test('a permission group subtracts from a role and never adds to it', () => {
  const access = { deniedPermissions: ['publish:manage'], role: 'publisher' }
  assert.equal(accessAllows(access, 'publish:manage'), false)
  assert.equal(accessAllows(access, 'artifact:read'), true)
  assert.equal(accessAllows({ deniedPermissions: [], role: 'publisher' }, 'publish:manage'), true)
  assert.equal(accessAllows({ deniedPermissions: [], role: 'viewer' }, 'publish:manage'), false)
})

test('fixed roles enforce least-privilege permissions', () => {
  assert.equal(hasPermission('creator', 'release:create'), true)
  assert.equal(hasPermission('creator', 'publish:manage'), false)
  assert.equal(hasPermission('publisher', 'publish:manage'), true)
  assert.equal(hasPermission('viewer', 'audit:read'), false)
  assert.equal(hasPermission('admin', 'member:invite'), true)
  assert.equal(hasPermission('admin', 'workspace:delete'), false)
  assert.equal(hasPermission('owner', 'workspace:transfer_ownership'), true)
})

test('writing, approval, account administration and billing stay separate', () => {
  for (const role of organizationRoles) {
    assert.equal(hasPermission(role, 'billing:manage'), role === 'owner', `${role}: billing`)
    assert.equal(
      hasPermission(role, 'workspace:transfer_ownership'),
      role === 'owner',
      `${role}: ownership`
    )
    assert.equal(
      hasPermission(role, 'connection:manage'),
      ['owner', 'admin'].includes(role),
      `${role}: accounts`
    )
    assert.equal(
      hasPermission(role, 'release:approve'),
      ['owner', 'admin', 'approver'].includes(role),
      `${role}: approval`
    )
  }
  assert.equal(hasPermission('writer_publisher', 'artifact:edit'), true)
  assert.equal(hasPermission('writer_publisher', 'publish:manage'), true)
  assert.equal(hasPermission('writer_publisher', 'member:invite'), false)
  assert.equal(hasPermission('publisher', 'artifact:edit'), false)
  assert.equal(normalizeOrganizationRole('writer_publisher'), 'writer_publisher')
})

test('legacy Better Auth member role remains viewer-equivalent', () => {
  assert.equal(normalizeOrganizationRole('member'), 'viewer')
  assert.equal(normalizeOrganizationRole('unexpected-role'), 'viewer')
})

test('a sensitive action needs Shots two-factor unless the account has no Shots password', () => {
  assert.equal(needsShotsTwoFactor(true, ['credential']), false)
  assert.equal(needsShotsTwoFactor(false, ['credential']), true)
  assert.equal(needsShotsTwoFactor(false, ['credential', 'google']), true)
  // Google, GitHub or SSO only: the provider carries the second factor.
  assert.equal(needsShotsTwoFactor(false, ['google']), false)
  assert.equal(needsShotsTwoFactor(false, ['github', 'sso']), false)
  // Unknown accounts fail closed.
  assert.equal(needsShotsTwoFactor(false, null), true)
  assert.equal(needsShotsTwoFactor(false, []), true)
})

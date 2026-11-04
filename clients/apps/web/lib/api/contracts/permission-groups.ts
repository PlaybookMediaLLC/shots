import { z } from 'zod'
import type { BackendPermissionGroup } from 'screenshot-studio-backend-sdk'
import { defineContract, mirrors } from '@/lib/api/contract'
import { permissions } from '@/lib/auth/permissions'

/**
 * Permission group contracts. These serve the workspace settings UI under a
 * session; they are not part of the public OpenAPI surface.
 */

/** The organization a request addresses. */
export const permissionGroupQuerySchema = z.object({
  organizationId: z.string().min(1).max(128),
})

/** A group's editable fields. */
export const permissionGroupInputSchema = z.object({
  deniedPermissions: z.array(z.enum(permissions)).max(permissions.length),
  isDefault: z.boolean().default(false),
  name: z.string().trim().min(1).max(100),
})

/** A permission group and its assigned members. */
export const permissionGroupSchema = mirrors<BackendPermissionGroup>()(
  z.object({
    createdAt: z.string(),
    deniedPermissions: z.array(z.string()),
    id: z.string(),
    isDefault: z.boolean(),
    memberIds: z.array(z.string()),
    name: z.string(),
    updatedAt: z.string(),
  })
)

const groupParamsSchema = z.object({ groupId: z.string().min(1) })

/** `GET /api/enterprise/permission-groups` */
export const listPermissionGroupsContract = defineContract({
  method: 'GET',
  name: 'permission-groups.list',
  output: z.object({ groups: z.array(permissionGroupSchema) }),
  path: '/api/enterprise/permission-groups',
  query: permissionGroupQuerySchema,
  summary: 'List permission groups',
})

/** `POST /api/enterprise/permission-groups` */
export const createPermissionGroupContract = defineContract({
  body: permissionGroupQuerySchema.extend(permissionGroupInputSchema.shape),
  method: 'POST',
  name: 'permission-groups.create',
  output: permissionGroupSchema,
  path: '/api/enterprise/permission-groups',
  status: 201,
  summary: 'Create a permission group',
})

/** `PUT /api/enterprise/permission-groups/{groupId}` */
export const updatePermissionGroupContract = defineContract({
  body: permissionGroupQuerySchema.extend(permissionGroupInputSchema.shape),
  method: 'PUT',
  name: 'permission-groups.update',
  output: permissionGroupSchema,
  params: groupParamsSchema,
  path: '/api/enterprise/permission-groups/{groupId}',
  summary: 'Change a permission group',
})

/** `DELETE /api/enterprise/permission-groups/{groupId}` */
export const deletePermissionGroupContract = defineContract({
  method: 'DELETE',
  name: 'permission-groups.delete',
  output: z.undefined(),
  params: groupParamsSchema,
  path: '/api/enterprise/permission-groups/{groupId}',
  query: permissionGroupQuerySchema,
  status: 204,
  summary: 'Delete a permission group',
})

/** `PUT /api/enterprise/permission-groups/{groupId}/members` */
export const setPermissionGroupMembersContract = defineContract({
  body: permissionGroupQuerySchema.extend({
    memberIds: z.array(z.string().min(1).max(128)).max(10_000),
  }),
  method: 'PUT',
  name: 'permission-groups.set-members',
  output: permissionGroupSchema,
  params: groupParamsSchema,
  path: '/api/enterprise/permission-groups/{groupId}/members',
  summary: 'Set the members of a permission group',
})

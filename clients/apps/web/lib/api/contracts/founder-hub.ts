import { z } from 'zod'
import {
  founderHubSessionSchema,
  founderHubSettingsSchema,
  founderHubSettingsProfileSchema,
  founderHubSettingsUpdateSchema,
} from 'screenshot-studio-backend-sdk'
import { defineContract } from '@/lib/api/contract'
import { permissionSchema } from '@/lib/api/access-requirements'

/** The central authority response consumed by Founder Hub's API boundary. */
export const founderHubAccessSchema = founderHubSessionSchema.extend({
  workspaces: z.array(
    founderHubSessionSchema.shape.workspaces.element.extend({
      permissions: z.array(permissionSchema),
      members: z.array(
        founderHubSessionSchema.shape.workspaces.element.shape.members.element.extend({
          permissions: z.array(permissionSchema),
        })
      ),
    })
  ),
})

/** Read the current Shots session and permissions for a Founder Hub access token. */
export const getFounderHubSessionContract = defineContract({
  method: 'GET',
  name: 'founder-hub.session',
  output: founderHubAccessSchema,
  path: '/api/founder-hub/session',
  summary: 'Resolve Founder Hub access through Shots',
})

/** Resolve the live session binding held privately by a Founder Hub API key. */
export const getFounderHubKeySessionContract = defineContract({
  method: 'POST',
  name: 'founder-hub.key-session',
  body: z
    .object({ userId: z.string().min(1).max(160), sessionId: z.string().min(1).max(160) })
    .strict(),
  output: founderHubAccessSchema,
  path: '/api/founder-hub/key-session',
  summary: 'Resolve current Shots authority for a bound Founder Hub API key',
})

/** Verify a delegated OAuth token against current consent, session, and workspace permissions. */
export const getFounderHubConnectorSessionContract = defineContract({
  method: 'GET',
  name: 'founder-hub.connector-session',
  output: founderHubAccessSchema,
  path: '/api/founder-hub/connector-session',
  summary: 'Resolve current Shots authority for a read-only Founder Hub connector',
})

/** Revoke the live Shots session and every native credential attached to it. */
export const revokeFounderHubSessionContract = defineContract({
  method: 'POST',
  name: 'founder-hub.logout',
  output: z.object({ revoked: z.literal(true) }),
  path: '/api/founder-hub/logout',
  summary: 'Sign out of Shots and Founder Hub',
})

/** Read every account and device preference for the signed-in Founder Hub user. */
export const getFounderHubSettingsContract = defineContract({
  method: 'GET',
  name: 'founder-hub.settings.get',
  output: founderHubSettingsSchema,
  path: '/api/founder-hub/settings',
  summary: 'Read Founder Hub settings',
})

/** Persist a versioned Founder Hub settings patch in Shots. */
export const updateFounderHubSettingsContract = defineContract({
  method: 'PATCH',
  name: 'founder-hub.settings.update',
  body: founderHubSettingsUpdateSchema,
  output: founderHubSettingsProfileSchema,
  path: '/api/founder-hub/settings',
  summary: 'Update Founder Hub settings',
})

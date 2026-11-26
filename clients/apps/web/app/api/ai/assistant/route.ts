import type { ModelMessage } from 'ai'
import { AssistantRefusal, runWorkspaceAssistantTurn } from '@/lib/ai/assistant/turn'
import { workspaceAssistantContract } from '@/lib/api/contracts/ai'
import { streamLines } from '@/lib/api/stream-lines'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'

/** A turn may take several tool steps; give it room on serverless hosts. */
export const maxDuration = 120

/**
 * One step of the unified Shots assistant on every page and editor surface:
 * the browser sends its conversation, page context, optional selection, and any
 * client-executed surface tools (lib/ai/assistant/turn). The reply is a stream
 * of lines. A turn that fails before its first line answers with a status.
 */
export const POST = route(workspaceAssistantContract, {
  auth: organizationAccess('workspace:read'),
  handler: async ({ access, body, request }) => {
    try {
      return await streamLines((send) =>
        runWorkspaceAssistantTurn(access, {
          clientTools: body.clientTools,
          messages: body.messages as unknown as ModelMessage[],
          onEvent: send,
          page: body.page,
          selection: body.selection,
          signal: request.signal,
        }).then((reply) => send({ reply, type: 'reply' }))
      )
    } catch (error) {
      if (error instanceof AssistantRefusal) return errorResponse(error.status, error.message)
      throw error
    }
  },
})

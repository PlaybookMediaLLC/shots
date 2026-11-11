import { generateText, type ModelMessage, stepCountIs } from 'ai'
import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { withAiCredits } from '@/lib/ai/metering'
import { models } from '@/lib/ai/models'
import { EDITOR_COPILOT_INSTRUCTIONS, scopeInstructions } from '@/lib/ai/prompts/editor-copilot'
import { createEditorCopilotTools, editorClientToolNames } from '@/lib/ai/tools/editor-copilot'
import { editorCopilotContract, editorMessageRoleSchema } from '@/lib/api/contracts/ai'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { isAiEnabled } from '@/lib/trpc/routers/launch'
import type { WritingContext } from 'screenshot-studio-backend-sdk'
import { getWorkspaceVoice } from '@/lib/launch/store'
import { voiceInstructions } from '@/lib/write/voice'

/** The model loop can run several tool steps; give it room on serverless hosts. */
export const maxDuration = 120

/**
 * One step of the in-editor copilot loop.
 *
 * The browser owns the conversation: it posts the messages so far, this route
 * runs the model until it calls an editing tool, and the browser executes
 * that tool against the live editor and posts again with the result. Server
 * tools (catalog lookup) run here without a round trip.
 */

const MAX_STEPS_PER_TURN = 16

/** Only the newest snapshot is worth its tokens; older ones become a note. */
function trimSnapshots(messages: ModelMessage[]): ModelMessage[] {
  let latestFound = false
  return [...messages]
    .reverse()
    .map((message) => {
      if (message.role !== 'tool') return message
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== 'tool-result' || part.output.type !== 'content') return part
          if (!latestFound) {
            latestFound = true
            return part
          }
          return {
            ...part,
            output: {
              type: 'content' as const,
              value: part.output.value.map((item) =>
                item.type === 'file'
                  ? { text: '[earlier snapshot omitted]', type: 'text' as const }
                  : item
              ),
            },
          }
        }),
      }
    })
    .reverse()
}

async function runTurn(
  messages: ModelMessage[],
  selection: string | null,
  voice: WritingContext | null
) {
  const result = await generateText({
    messages: trimSnapshots(messages),
    // Sonnet: each round trip re-sends the canvas snapshot and tool schemas.
    model: models.languageModel('drafting'),
    stopWhen: stepCountIs(4),
    // Text the copilot writes onto the canvas is public copy in the brand voice.
    system: EDITOR_COPILOT_INSTRUCTIONS + scopeInstructions(selection) + voiceInstructions(voice),
    tools: createEditorCopilotTools(),
  })
  const clientTools = new Set<string>(editorClientToolNames)
  const pendingToolCalls = result.toolCalls
    .filter((call) => clientTools.has(call.toolName))
    .map((call) => ({ input: call.input, toolCallId: call.toolCallId, toolName: call.toolName }))
  return {
    done: pendingToolCalls.length === 0,
    messages: result.response.messages,
    pendingToolCalls,
    text: result.text,
  }
}

/** Run the copilot until it needs the browser to apply an edit. */
export const POST = route(editorCopilotContract, {
  auth: organizationAccess('artifact:edit'),
  handler: async ({ access, body }) => {
    if (!isCampaignStudioConfigured()) {
      return errorResponse(503, 'AI is not configured.')
    }
    // The workspace kill switch; a turn's many round trips are not rate-limited per call.
    if (!(await isAiEnabled(access))) {
      return errorResponse(403, 'AI is turned off for this workspace.')
    }
    const messages = body.messages as unknown as ModelMessage[]
    const lastUser = messages.findLastIndex(
      (message) => message.role === editorMessageRoleSchema.enum.user
    )
    if (lastUser < 0) return errorResponse(400, 'A user message is required.')
    const stepsThisTurn = messages
      .slice(lastUser)
      .filter((message) => message.role === editorMessageRoleSchema.enum.assistant).length
    if (stepsThisTurn >= MAX_STEPS_PER_TURN) {
      return {
        done: true,
        messages: [],
        pendingToolCalls: [],
        text: 'I stopped here to avoid going in circles. Tell me what to adjust next.',
      }
    }
    // Every round trip is charged AI credits for what its model calls cost.
    const voice = await getWorkspaceVoice(access)
    return withAiCredits(access, () => runTurn(messages, body.selection, voice))
  },
})

'use client'

import { useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { Group, PlanRequired, Row, Section } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Switch } from '@/components/ui/switch'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import type {
  VoiceSettings as Settings,
  voiceWorkspaceFlagsSchema,
} from '@/lib/api/contracts/voice-schemas'
import {
  REMOTE_TEXT_DISCLOSURE,
  useVoiceSettings,
  VOICE_SETTINGS_KEY,
  voiceApi,
} from '@/lib/voice/client'

type Flag = keyof z.output<typeof voiceWorkspaceFlagsSchema>

/** Each workspace switch, what it does, and the server-side switch that can hold it off. */
const FLAGS: { flag: Flag; label: string; description: string; held: (s: Settings) => boolean }[] =
  [
    {
      flag: 'voiceNotes',
      label: 'Voice notes',
      description:
        'Members record notes in the Shots app and read them under Create. A note is private to whoever recorded it.',
      held: (s) => !s.switches.notes,
    },
    {
      flag: 'audioUpload',
      label: 'Audio upload',
      description:
        'Recordings upload with their transcripts, for members who agree on the phone. Off, only transcripts sync.',
      held: (s) => !s.switches.audioUpload,
    },
    {
      flag: 'draftGeneration',
      label: 'Drafts from voice notes',
      description:
        'Members turn a transcript into a draft. The transcript text goes to the model provider, after each member agrees.',
      held: (s) => !s.switches.drafts,
    },
    {
      flag: 'voiceCommands',
      label: 'Voice commands',
      description:
        'Members schedule a post by saying so. Every command is confirmed on the phone before anything is scheduled.',
      held: (s) => !s.switches.parse || !s.switches.confirm,
    },
  ]

/**
 * Voice settings (plan 6.9): the workspace's switches, all off by default,
 * for owners and admins, then the member's own choices.
 */
export function VoiceSettings() {
  const client = useQueryClient()
  const settings = useVoiceSettings()
  const [workspaceState, runWorkspace] = useSaveState()
  const [memberState, runMember] = useSaveState()
  // The server's answer replaces the cache, so the switches never show an unsaved state.
  const save = (run: typeof runWorkspace, request: () => Promise<Settings>) =>
    run(async () => {
      try {
        client.setQueryData(VOICE_SETTINGS_KEY, await request())
        return { ok: true }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'The voice setting could not be saved.',
          ok: false,
        }
      }
    })
  if (isPlanRefusal(settings.error)) {
    return <PlanRequired from="/settings/voice-notes">Voice notes need a paid plan.</PlanRequired>
  }
  if (settings.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{settings.error.message}</AlertDescription>
      </Alert>
    )
  }
  const data = settings.data
  const consented = Boolean(data?.member.remoteTextConsentAt)
  return (
    <>
      <Section
        actions={<SaveStatus state={workspaceState} />}
        description={
          data && !data.canManage
            ? 'Only owners and admins change these.'
            : 'All are off until turned on.'
        }
        title="Workspace"
      >
        <Group>
          {FLAGS.map(({ description, flag, held, label }) => (
            <Row
              description={
                data && held(data)
                  ? `${description} Shots has turned this off for now.`
                  : description
              }
              key={flag}
              label={label}
              layout="inline"
            >
              <Switch
                aria-label={label}
                checked={data?.workspace[flag] ?? false}
                disabled={!data?.canManage}
                onCheckedChange={(checked) =>
                  void save(runWorkspace, () => voiceApi.saveWorkspace({ [flag]: checked }))
                }
              />
            </Row>
          ))}
        </Group>
      </Section>
      <Section actions={<SaveStatus state={memberState} />} title="Your choices">
        <Group>
          <Row
            description={REMOTE_TEXT_DISCLOSURE}
            label="Send transcript text to the model provider"
            layout="inline"
          >
            <Switch
              aria-label="Send transcript text to the model provider"
              checked={consented}
              disabled={!data}
              onCheckedChange={(checked) =>
                void save(runMember, () => voiceApi.saveMember({ remoteTextConsent: checked }))
              }
            />
          </Row>
          <Row
            description="Your transcripts are checked for a scheduling command, which you confirm on your phone. It needs the choice above, and the workspace switch."
            label="Voice commands"
            layout="inline"
          >
            <Switch
              aria-label="Voice commands for my notes"
              checked={data?.member.voiceCommands ?? false}
              // Turning commands off is always allowed; turning them on needs both.
              disabled={
                !data ||
                (!data.member.voiceCommands && (!consented || !data.workspace.voiceCommands))
              }
              onCheckedChange={(checked) =>
                void save(runMember, () => voiceApi.saveMember({ voiceCommands: checked }))
              }
            />
          </Row>
        </Group>
      </Section>
    </>
  )
}

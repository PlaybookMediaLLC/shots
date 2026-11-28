'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTwelveHour } from '@/components/ui/format-preferences'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'

type PublishingPreferencesSettingsProps = {
  canManage: boolean
  organization: {
    id: string
    workspaceSettings?: {
      processVideosOnServer?: boolean
      videoProcessingAvailable?: boolean
      weeklyPostingGoal?: number | null
    } | null
  }
}

/**
 * Publishing Preferences (`/settings/publishing-preferences`):
 * - Platform Preferences: filename-as-caption (personal), 24-hour time format
 *   (personal, synced with Appearance), and server-side video processing (workspace).
 * - Weekly Posting Goal: workspace weekly post target with current-week progress.
 */
export function PublishingPreferencesSettings({
  canManage,
  organization,
}: PublishingPreferencesSettingsProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const { preferences, save: savePersonal, status: prefsStatus } = usePreferences()
  const twelveHour = useTwelveHour()

  const [filenameState, runFilename] = useSaveState()
  const [clockState, runClock] = useSaveState()
  const [videoState, runVideo] = useSaveState()

  const initialProcessVideos = organization.workspaceSettings?.processVideosOnServer ?? true
  const videoProcessingAvailable = organization.workspaceSettings?.videoProcessingAvailable ?? false
  const initialGoal = organization.workspaceSettings?.weeklyPostingGoal ?? null

  const confirmedProcessVideos = useRef(initialProcessVideos)
  const prevInitialProcessVideos = useRef(initialProcessVideos)
  const prevInitialGoal = useRef(initialGoal)
  const [processVideos, setProcessVideos] = useState(initialProcessVideos)
  const [savedGoal, setSavedGoal] = useState<number | null>(initialGoal)
  const [goalInput, setGoalInput] = useState(initialGoal !== null ? String(initialGoal) : '')
  const [goalBusy, setGoalBusy] = useState(false)
  const [goalError, setGoalError] = useState<string | null>(null)

  const videoSaving = videoState === 'saving'

  useEffect(() => {
    if (prevInitialProcessVideos.current === initialProcessVideos) return
    prevInitialProcessVideos.current = initialProcessVideos
    confirmedProcessVideos.current = initialProcessVideos
    setProcessVideos(initialProcessVideos)
  }, [initialProcessVideos])

  useEffect(() => {
    if (prevInitialGoal.current === initialGoal) return
    prevInitialGoal.current = initialGoal
    setSavedGoal(initialGoal)
    setGoalInput(initialGoal !== null ? String(initialGoal) : '')
  }, [initialGoal])

  const weekStart = preferences?.weekStart ?? 'monday'
  const progress = useQuery({
    ...trpc.workspace.weeklyGoalProgress.queryOptions({ weekStart }),
    enabled: savedGoal !== null && prefsStatus !== 'loading',
    staleTime: 60_000,
  })

  const use24Hour = prefsStatus === 'ready' && !twelveHour

  const toggleProcessVideos = (checked: boolean) => {
    if (videoSaving || !canManage) return
    setProcessVideos(checked)
    void runVideo(async () => {
      try {
        await trpcClient.workspace.updatePublishingSettings.mutate({
          processVideosOnServer: checked,
        })
        confirmedProcessVideos.current = checked
        router.refresh()
        return { ok: true }
      } catch (error) {
        setProcessVideos(confirmedProcessVideos.current)
        return { error: getErrorMessage(error), ok: false }
      }
    })
  }

  const saveGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (goalBusy || !canManage) return
    setGoalError(null)
    const trimmed = goalInput.trim()
    if (!trimmed) {
      if (savedGoal !== null) {
        await clearGoal()
      } else {
        setGoalError('Enter a whole number between 1 and 1,000 posts per week.')
      }
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      setGoalError('Enter a whole number between 1 and 1,000 posts per week.')
      return
    }
    setGoalBusy(true)
    try {
      await trpcClient.workspace.updatePublishingSettings.mutate({ weeklyPostingGoal: parsed })
      setSavedGoal(parsed)
      setGoalInput(String(parsed))
      toast.success(`Weekly posting goal set to ${parsed} post${parsed === 1 ? '' : 's'} per week.`)
      void queryClient.invalidateQueries({ queryKey: trpc.workspace.weeklyGoalProgress.queryKey() })
      router.refresh()
    } catch (error) {
      setGoalError(getErrorMessage(error))
    } finally {
      setGoalBusy(false)
    }
  }

  const clearGoal = async () => {
    if (goalBusy || !canManage) return
    setGoalError(null)
    setGoalBusy(true)
    try {
      await trpcClient.workspace.updatePublishingSettings.mutate({ weeklyPostingGoal: null })
      setSavedGoal(null)
      setGoalInput('')
      toast.success('Weekly posting goal cleared.')
      void queryClient.invalidateQueries({ queryKey: trpc.workspace.weeklyGoalProgress.queryKey() })
      router.refresh()
    } catch (error) {
      setGoalError(getErrorMessage(error))
    } finally {
      setGoalBusy(false)
    }
  }

  const pct =
    savedGoal && progress.data
      ? Math.min(100, Math.round((progress.data.totalCount / savedGoal) * 100))
      : 0

  return (
    <div className="grid gap-8">
      <Section
        description="Personal composer defaults and workspace video optimization settings."
        title="Platform preferences"
      >
        {prefsStatus === 'error' ? (
          <Alert variant="destructive">
            <AlertDescription>
              Personal publishing preferences could not be loaded right now. Refresh the page to try
              again.
            </AlertDescription>
          </Alert>
        ) : null}
        <Group>
          <Row
            description="Automatically fill an empty post caption with the uploaded video's file name (without its file extension). Never overwrites existing text."
            label={
              <span className="flex items-center gap-2">
                Use file name as caption <SaveStatus state={filenameState} />
              </span>
            }
          >
            <Switch
              aria-label="Use file name as caption"
              checked={preferences?.useFilenameAsCaption ?? false}
              disabled={prefsStatus !== 'ready'}
              onCheckedChange={(useFilenameAsCaption) =>
                void runFilename(() => savePersonal({ useFilenameAsCaption }))
              }
            />
          </Row>

          <Row
            description={
              <>
                Display times in 24-hour format (14:30) instead of 12-hour format (2:30 PM). Syncs
                with{' '}
                <Link className="underline" href="/settings/appearance">
                  Appearance
                </Link>
                .
              </>
            }
            label={
              <span className="flex items-center gap-2">
                24-hour time format <SaveStatus state={clockState} />
              </span>
            }
          >
            <Switch
              aria-label="24-hour time format"
              checked={use24Hour}
              disabled={prefsStatus !== 'ready'}
              onCheckedChange={(on) =>
                void runClock(() => savePersonal({ timeFormat: on ? '24h' : '12h' }))
              }
            />
          </Row>

          <Row
            description={
              videoProcessingAvailable
                ? 'Automatically normalize uploaded videos to platform-safe H.264/AAC profiles on our servers before publishing. New drafts inherit this workspace default.'
                : 'Workspace default for server-side video normalization (H.264/AAC). Your preference is saved; server-side video transcoding is currently inactive on this deployment.'
            }
            label={
              <span className="flex flex-wrap items-center gap-2">
                Process videos on our servers
                {!videoProcessingAvailable ? <Pill>Worker inactive</Pill> : null}
                <SaveStatus state={videoState} />
              </span>
            }
          >
            <Switch
              aria-label="Process videos on our servers"
              checked={processVideos}
              disabled={!canManage || videoSaving}
              onCheckedChange={toggleProcessVideos}
            />
          </Row>
        </Group>
      </Section>

      <Section
        description="Set a weekly publishing target for this workspace to track consistency on Home and the content calendar."
        title="Weekly posting goal"
      >
        <Group>
          <Row
            description={
              savedGoal !== null
                ? `Current goal: ${savedGoal} post${savedGoal === 1 ? '' : 's'} per week.`
                : 'No weekly posting goal set yet. Choose how many posts your team aims to publish each week.'
            }
            label={<Label htmlFor="weekly-posting-goal">Target posts per week</Label>}
            layout="stacked"
          >
            <form className="flex flex-wrap items-center gap-3" onSubmit={saveGoal}>
              <div className="flex items-center gap-2">
                <Input
                  aria-describedby="weekly-goal-unit"
                  className="w-28"
                  disabled={!canManage || goalBusy}
                  id="weekly-posting-goal"
                  inputMode="numeric"
                  max={1000}
                  min={1}
                  onChange={(event) => setGoalInput(event.target.value)}
                  placeholder="7"
                  type="number"
                  value={goalInput}
                />
                <span className="text-sm text-muted-foreground" id="weekly-goal-unit">
                  posts per week
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button disabled={!canManage || goalBusy} type="submit">
                  {goalBusy ? 'Saving…' : 'Save'}
                </Button>
                {savedGoal !== null ? (
                  <Button
                    disabled={!canManage || goalBusy}
                    onClick={() => void clearGoal()}
                    type="button"
                    variant="outline"
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </form>
            {goalError ? (
              <Alert variant="destructive">
                <AlertDescription>{goalError}</AlertDescription>
              </Alert>
            ) : null}
            {!canManage ? (
              <p className="text-xs text-muted-foreground">
                Only workspace owners and admins can change workspace publishing preferences.
              </p>
            ) : null}
            {savedGoal !== null && progress.isError ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-700 dark:text-red-300" role="alert">
                <span>Could not load weekly goal progress.</span>
                <Button
                  disabled={progress.isFetching}
                  onClick={() => void progress.refetch()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {savedGoal !== null && progress.data ? (
              <div className="mt-2 grid max-w-md gap-1.5" data-testid="weekly-goal-progress">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    This week: <strong className="text-foreground">{progress.data.totalCount}</strong>{' '}
                    of {savedGoal} ({progress.data.publishedCount} published,{' '}
                    {progress.data.scheduledCount} scheduled)
                  </span>
                  <span>{pct}%</span>
                </div>
                <div
                  aria-label="Weekly posting goal progress"
                  aria-valuemax={savedGoal}
                  aria-valuemin={0}
                  aria-valuenow={Math.min(progress.data.totalCount, savedGoal)}
                  aria-valuetext={`${progress.data.totalCount} of ${savedGoal} posts (${pct}%)`}
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            ) : null}
          </Row>
        </Group>
      </Section>
    </div>
  )
}

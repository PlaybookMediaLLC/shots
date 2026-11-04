'use client'

import Link from 'next/link'
import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { draftsApi, type SettingsWire } from '@/lib/content-drafts/client'
import { TimePicker } from '@/components/ui/time-picker'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The workspace's drafts settings: the weekly times the queue fills, and
 * whether a draft needs approval before it is scheduled.
 */
export function DraftSettingsForm({
  canManage,
  settings,
}: {
  canManage: boolean
  settings: SettingsWire
}) {
  const [slots, setSlots] = React.useState(settings.postingSlots)
  const [requireApproval, setRequireApproval] = React.useState(settings.requireApproval)
  const [adding, setAdding] = React.useState<Record<number, string>>({})
  const [saving, setSaving] = React.useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const saved = await draftsApi.saveSettings({ postingSlots: slots, requireApproval })
      setSlots(saved.postingSlots)
      toast.success('Saved.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The settings could not be saved.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10">
      <div>
        <h2 className="text-lg font-medium text-foreground">Drafts settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">Times are in {settings.timeZone}.</p>
      </div>
      <section className="flex flex-col gap-3">
        <h3 className="text-ui-lg font-medium text-foreground">Posting queue</h3>
        <p className="text-xs text-muted-foreground">
          These are the times of your first publishing brand. Each publishing brand now keeps its own queue,
          time zone and defaults; edit them in{' '}
          <Link className="underline" href="/workspace/social-sets">
            Publishing brands
          </Link>
          . “Add to queue” takes the set’s next time that no post has yet.
        </p>
        <ul className="divide-y divide-foreground/[0.05] rounded-xl border border-foreground/[0.06]">
          {WEEKDAYS.map((name, weekday) => {
            const times = slots.filter((slot) => slot.weekday === weekday)
            return (
              <li className="flex flex-wrap items-center gap-2 px-4 py-2.5" key={name}>
                <span className="w-24 text-sm text-foreground/80">{name}</span>
                {times.map((slot) => (
                  <span
                    className="flex items-center gap-1 rounded-full border border-foreground/[0.08] px-2 py-0.5 text-xs text-foreground"
                    key={slot.time}
                  >
                    {slot.time}
                    {canManage ? (
                      <Button variant="custom" size={null}
                        aria-label={`Remove ${name} ${slot.time}`}
                        className="text-muted-foreground hover:text-red-700 dark:hover:text-red-400"
                        onClick={() =>
                          setSlots((current) => current.filter((item) => item !== slot))
                        }
                        type="button"
                      >
                        ✕
                      </Button>
                    ) : null}
                  </span>
                ))}
                {canManage ? (
                  <span className="ml-auto flex items-center gap-1">
                    <TimePicker
                      aria-label={`New ${name} time`}
                      className="w-32"
                      onChange={(time) => setAdding((current) => ({ ...current, [weekday]: time }))}
                      value={adding[weekday] ?? ''}
                    />
                    <Button variant="custom" size={null}
                      className="text-xs text-sky-700 dark:text-sky-300 hover:text-sky-700 dark:hover:text-sky-200 disabled:opacity-40"
                      disabled={!adding[weekday]}
                      onClick={() => {
                        const time = adding[weekday]
                        if (!time) return
                        setSlots((current) =>
                          current.some((slot) => slot.weekday === weekday && slot.time === time)
                            ? current
                            : [...current, { time, weekday }]
                        )
                        setAdding((current) => ({ ...current, [weekday]: '' }))
                      }}
                      type="button"
                    >
                      Add
                    </Button>
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-ui-lg font-medium text-foreground">Approvals</h3>
        <Label className="flex items-center justify-between gap-3 rounded-xl border border-foreground/[0.06] px-4 py-3 text-sm text-foreground/80">
          A publisher or admin approves each draft before it is scheduled
          <Switch
            aria-label="Require approval"
            checked={requireApproval}
            className="shrink-0"
            disabled={!canManage}
            onCheckedChange={(checked) => setRequireApproval((checked === true))}
          />
        </Label>
      </section>
      {canManage ? (
        <div>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

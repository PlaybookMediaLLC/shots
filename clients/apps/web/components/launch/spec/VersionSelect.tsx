'use client'

import { usePathname, useRouter } from 'next/navigation'
import { prepareLinkNavigation } from '@/lib/platform/navigation-guard'
import { toast } from 'sonner'
import { Pill } from '@/components/platform-ui'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

/** One saved version of a spec or plan, newest first in lists. */
export type VersionOption = {
  changeSummary: string | null
  createdAt: string
  id: string
  origin: string
  status: 'APPROVED' | 'DRAFT' | 'SUPERSEDED'
  version: number
}

const ORIGIN: Record<string, string> = { ai: 'AI draft', human: 'Edited', revision: 'AI revision' }

/** Formatted in UTC so the server and browser render the same text. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function VersionStatus({ status }: { status: VersionOption['status'] }) {
  if (status === 'APPROVED') return <Pill tone="green">Approved</Pill>
  if (status === 'DRAFT') return <Pill>Draft</Pill>
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-foreground/[0.08] ring-inset">
      Superseded
    </span>
  )
}

/** Switches the page between versions through `?version=`; the newest has no parameter. */
export function VersionSelect({
  current,
  versions,
}: {
  current: string
  versions: VersionOption[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  return (
    <span className="relative inline-flex">
      <Select
        onValueChange={(nextValue) => {
          const id = nextValue
          void prepareLinkNavigation()
            .then(() =>
              router.push(id === versions[0]?.id ? pathname : `${pathname}?version=${id}`)
            )
            .catch((error: unknown) =>
              toast.error(
                error instanceof Error
                  ? error.message
                  : 'Save or discard your changes before leaving.'
              )
            )
        }}
        value={current}
      >
        <SelectTrigger
          aria-label="Version"
          className="h-8 rounded-lg bg-foreground/[0.03] px-3 text-sm text-foreground ring-1 ring-foreground/[0.08] outline-none hover:bg-foreground/[0.05] focus-visible:ring-foreground/25"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versions.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {`v${option.version} · ${ORIGIN[option.origin] ?? option.origin} · ${shortDate(option.createdAt)}${option.status === 'APPROVED' ? ' · Approved' : ''}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  )
}

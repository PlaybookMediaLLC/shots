'use client'

import { toast } from 'sonner'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { summarizeScopes, type WorkspaceCredential } from './scope-summary'

/** Safely copy text to the clipboard with consistent toast feedback. */
export function copyToClipboard(value: string, label: string): void {
  if (!navigator.clipboard?.writeText) {
    toast.error('Could not copy to clipboard.')
    return
  }
  void navigator.clipboard
    .writeText(value)
    .then(() => toast.success(`${label} copied.`))
    .catch(() => toast.error('Could not copy to clipboard.'))
}

/**
 * Keyboard-accessible scope summary pill with a tooltip enumerating the exact
 * granted scopes so users can verify high-trust access (`post:publish`,
 * `post:delete`) with mouse, touch, or keyboard focus.
 */
export function ScopeBadge({ scopes }: { scopes: WorkspaceCredential['scopes'] }) {
  const summary = summarizeScopes(scopes)
  if (summary.scopes.length === 0) {
    return <Pill tone={summary.tone}>{summary.label}</Pill>
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={`${summary.label} — show granted scopes: ${summary.scopes.join(', ')}`}
          className="inline-flex rounded-full focus-visible:ring-2 focus-visible:ring-ring"
          size={null}
          type="button"
          variant="custom"
        >
          <Pill tone={summary.tone}>{summary.label}</Pill>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1 p-2.5 text-xs">
        <p className="font-medium">Granted scopes</p>
        <p className="font-mono text-[11px] opacity-90">{summary.scopes.join(', ')}</p>
      </TooltipContent>
    </Tooltip>
  )
}

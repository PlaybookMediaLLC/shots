'use client'

import { Row } from '@/components/platform-ui'
import { cn } from '@/lib/utils'

const DEFAULT_SEGMENTS = 12

/**
 * Compact hairline segmented usage meter showing remaining percentage with
 * calm threshold coloring (`< 20%` amber, `< 5%` red) and tabular numerals.
 */
export function SegmentedMeter({
  className,
  included,
  label,
  left,
  segments = DEFAULT_SEGMENTS,
}: {
  className?: string
  included: number
  label: string
  left: number
  segments?: number
}) {
  const safeIncluded = Math.max(0, included)
  const safeLeft = Math.max(0, Math.min(safeIncluded || left, left))
  const percent = safeIncluded > 0 ? Math.round((safeLeft / safeIncluded) * 100) : 0
  const filled =
    safeIncluded > 0
      ? safeLeft === 0
        ? 0
        : Math.max(1, Math.round((safeLeft / safeIncluded) * segments))
      : 0

  const toneClass =
    percent <= 5
      ? 'bg-red-500 dark:bg-red-400'
      : percent <= 20
        ? 'bg-amber-500 dark:bg-amber-400'
        : 'bg-foreground/75'

  return (
    <div
      aria-label={`${label}: ${percent}% left`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      className={cn('inline-flex items-center gap-2', className)}
      role="meter"
    >
      <span aria-hidden="true" className="inline-flex items-center gap-[2px]">
        {Array.from({ length: segments }, (_, index) => (
          <span
            className={cn(
              'h-3 w-[3px] rounded-full transition-colors',
              index < filled ? toneClass : 'bg-foreground/[0.12]'
            )}
            key={index}
          />
        ))}
      </span>
      <span className="min-w-[2.5rem] text-right text-xs font-medium text-foreground/80 tabular-nums">
        {percent}%
      </span>
    </div>
  )
}

/** Shared settings row showing remaining / included allowance alongside a SegmentedMeter. */
export function UsageMeterRow({
  allowance,
  description,
  label,
}: {
  allowance: { included: number; left: number }
  description: string
  label: string
}) {
  return (
    <Row description={description} label={label} layout="split">
      <div className="flex flex-wrap items-center justify-end gap-4">
        <span className="text-sm font-medium text-foreground tabular-nums">
          {allowance.left.toLocaleString('en-US')}
          <span className="text-muted-foreground">
            {' '}
            / {allowance.included.toLocaleString('en-US')}
          </span>
        </span>
        <SegmentedMeter included={allowance.included} label={label} left={allowance.left} />
      </div>
    </Row>
  )
}

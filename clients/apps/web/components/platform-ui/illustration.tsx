import type { ReactNode, SVGProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Decorative scenes that show what a choice makes, drawn on a 320-unit-wide
 * grid in the theme's own colours plus one accent, so they need no image files
 * and read the same in light and dark mode. The accent is `currentColor`.
 */

const TONES = {
  amber: 'text-amber-500 dark:text-amber-400',
  blue: 'text-blue-500 dark:text-blue-400',
  emerald: 'text-emerald-500 dark:text-emerald-400',
  orange: 'text-orange-500 dark:text-orange-400',
  rose: 'text-rose-500 dark:text-rose-400',
  sky: 'text-sky-500 dark:text-sky-400',
  violet: 'text-violet-500 dark:text-violet-400',
} as const

export type IllustrationTone = keyof typeof TONES

/** The frame: a quiet panel with a soft accent glow and a fading dot grid. */
export function Illustration({
  children,
  className,
  height = 180,
  tone,
}: {
  children: ReactNode
  className?: string
  height?: number
  tone: IllustrationTone
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none relative w-full shrink-0 overflow-hidden rounded-lg border border-foreground/[0.06] bg-foreground/[0.025]',
        TONES[tone],
        className
      )}
      style={{ aspectRatio: `320 / ${height}` }}
    >
      <div className="absolute -top-1/2 left-1/2 h-full w-3/4 -translate-x-1/2 rounded-full bg-current opacity-[0.13] blur-3xl" />
      <div className="absolute inset-0 [background-image:radial-gradient(var(--color-foreground)_0.75px,transparent_0.75px)] [background-size:14px_14px] opacity-[0.09] [mask-image:linear-gradient(to_bottom,black,transparent)]" />
      <svg className="relative size-full" fill="none" viewBox={`0 0 320 ${height}`}>
        {children}
      </svg>
    </div>
  )
}

/** A card: the theme's card colour with a hairline edge. */
export function Surface(props: SVGProps<SVGRectElement>) {
  return (
    <rect
      className="fill-card stroke-foreground/15"
      rx={5}
      strokeWidth={1}
      vectorEffect="non-scaling-stroke"
      {...props}
    />
  )
}

/** An accent-tinted area; `strength` is its opacity. */
export function Tint({ strength, ...props }: SVGProps<SVGRectElement> & { strength: number }) {
  return <rect className="fill-current" fillOpacity={strength} rx={3} {...props} />
}

const BAR_TONES = {
  accent: 'fill-current',
  ink: 'fill-foreground/70',
  line: 'fill-foreground/15',
} as const

/** A line of text as a rounded bar: `ink` for headings, `line` for body copy. */
export function Bar({
  h = 3,
  tone = 'line',
  ...props
}: Omit<SVGProps<SVGRectElement>, 'height'> & { h?: number; tone?: keyof typeof BAR_TONES }) {
  return <rect className={BAR_TONES[tone]} height={h} rx={h / 2} {...props} />
}

/** A connector that eases from one point to another and ends in an arrowhead. */
export function Arrow({
  dashed = false,
  from: [x1, y1],
  to: [x2, y2],
}: {
  dashed?: boolean
  from: [number, number]
  to: [number, number]
}) {
  const mid = (x1 + x2) / 2
  return (
    <g
      className="stroke-foreground/35"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.25}
    >
      <path
        d={`M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
        strokeDasharray={dashed ? '2.5 3' : undefined}
      />
      <path d={`M${x2 - 4} ${y2 - 3}L${x2} ${y2}L${x2 - 4} ${y2 + 3}`} />
    </g>
  )
}

/** A rectangle in scene units. */
export type Box = { x: number; y: number; w: number; h: number }

/** A photo: an accent tint with a sun and two hills. */
export function Picture({ x, y, w, h, strength = 0.22 }: Box & { strength?: number }) {
  const base = y + h
  return (
    <g>
      <Tint x={x} y={y} width={w} height={h} strength={strength} rx={2.5} />
      <circle
        className="fill-current"
        cx={x + w * 0.72}
        cy={y + h * 0.3}
        fillOpacity={0.55}
        r={Math.min(w, h) * 0.1}
      />
      <path
        className="fill-current"
        d={`M${x} ${base}L${x + w * 0.32} ${y + h * 0.5}L${x + w * 0.55} ${base}Z`}
        fillOpacity={0.45}
      />
      <path
        className="fill-current"
        d={`M${x + w * 0.3} ${base}L${x + w * 0.62} ${y + h * 0.42}L${x + w} ${base}Z`}
        fillOpacity={0.7}
      />
    </g>
  )
}

/** A short caption in the scene, such as an aspect ratio. */
export function Caption({
  accent = false,
  children,
  className,
  ...props
}: SVGProps<SVGTextElement> & { accent?: boolean }) {
  return (
    <text
      className={cn(
        'font-mono text-[7px] font-medium',
        accent ? 'fill-current' : 'fill-foreground/50',
        className
      )}
      {...props}
    >
      {children}
    </text>
  )
}

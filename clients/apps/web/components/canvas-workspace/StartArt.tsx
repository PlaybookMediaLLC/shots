import type { ReactNode } from 'react'
import {
  Arrow,
  Bar,
  type Box,
  Caption,
  Illustration,
  type IllustrationTone,
  Picture,
  Surface,
  Tint,
} from '@/components/platform-ui/illustration'

/** A product screenshot: a window with a sidebar, a heading and a chart. */
function Screenshot({ x, y, w, h }: Box) {
  const side = w * 0.22
  return (
    <g>
      <Surface height={h} rx={3.5} width={w} x={x} y={y} />
      <line
        className="stroke-foreground/10"
        vectorEffect="non-scaling-stroke"
        x1={x}
        x2={x + w}
        y1={y + 7}
        y2={y + 7}
      />
      {[3.5, 7, 10.5].map((dx) => (
        <circle className="fill-foreground/20" cx={x + dx + 1} cy={y + 3.5} key={dx} r={1.1} />
      ))}
      <rect
        className="fill-foreground/[0.06]"
        height={h - 14}
        rx={1.5}
        width={side}
        x={x + 3.5}
        y={y + 10.5}
      />
      <Bar h={2.5} tone="ink" width={w * 0.34} x={x + side + 7} y={y + 11} />
      <Bar h={2} width={w * 0.24} x={x + side + 7} y={y + 16} />
      <Tint
        height={Math.max(h - 25, 4)}
        rx={1.5}
        strength={0.24}
        width={w - side - 11}
        x={x + side + 7}
        y={y + 21}
      />
    </g>
  )
}

/** An announcement artboard: headline, supporting line and button beside a screenshot. */
function Announcement({ x, y, w, h }: Box) {
  const top = y + h * 0.24
  return (
    <g>
      <Surface height={h} width={w} x={x} y={y} />
      <Tint height={h} rx={5} strength={0.1} width={w} x={x} y={y} />
      <Bar h={4.5} tone="ink" width={w * 0.34} x={x + 8} y={top} />
      <Bar h={4.5} tone="ink" width={w * 0.24} x={x + 8} y={top + 8} />
      <Bar width={w * 0.3} x={x + 8} y={top + 18} />
      <Tint height={7} rx={3.5} strength={1} width={w * 0.17} x={x + 8} y={top + 26} />
      <Screenshot h={h * 0.68} w={w * 0.44} x={x + w * 0.5} y={y + h * 0.16} />
    </g>
  )
}

/** A design adapted to its frame: picture above copy when tall, beside it when wide. */
function Creative({ x, y, w, h }: Box) {
  const wide = w > h * 1.3
  if (wide)
    return (
      <g>
        <Surface height={h} width={w} x={x} y={y} />
        <Bar h={4} tone="ink" width={w * 0.34} x={x + 7} y={y + h * 0.3} />
        <Bar h={4} tone="ink" width={w * 0.24} x={x + 7} y={y + h * 0.3 + 7} />
        <Bar width={w * 0.3} x={x + 7} y={y + h * 0.3 + 16} />
        <Picture h={h - 14} w={w * 0.44} x={x + w * 0.5} y={y + 7} />
      </g>
    )
  const pad = Math.max(5, w * 0.1)
  const picture = h * 0.48
  return (
    <g>
      <Surface height={h} width={w} x={x} y={y} />
      <Picture h={picture} w={w - pad * 2} x={x + pad} y={y + pad} />
      <Bar h={4} tone="ink" width={(w - pad * 2) * 0.8} x={x + pad} y={y + pad + picture + 7} />
      <Bar h={4} tone="ink" width={(w - pad * 2) * 0.55} x={x + pad} y={y + pad + picture + 14} />
      <Bar width={(w - pad * 2) * 0.7} x={x + pad} y={y + pad + picture + 23} />
    </g>
  )
}

/** A mouse pointer. */
function Pointer({ x, y }: { x: number; y: number }) {
  return (
    <path
      className="fill-foreground stroke-card"
      d={`M${x} ${y}l0 13l3.4-3l2.6 5.6l2.2-1l-2.6-5.4l4.6-.4Z`}
      strokeLinejoin="round"
      strokeWidth={1}
    />
  )
}

/** Selection handles around a box. */
function Selection({ x, y, w, h }: Box) {
  return (
    <g>
      <rect
        className="stroke-current"
        height={h}
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
        width={w}
        x={x}
        y={y}
      />
      {[
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
      ].map(([cx, cy]) => (
        <rect
          className="fill-card stroke-current"
          height={4}
          key={`${cx}-${cy}`}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          width={4}
          x={cx - 2}
          y={cy - 2}
        />
      ))}
    </g>
  )
}

/** Each screenshot becomes its own announcement. */
function ScreenshotsScene() {
  return (
    <>
      {[32, 100].map((y) => (
        <g key={y}>
          <Screenshot h={50} w={86} x={26} y={y} />
          <Arrow from={[120, y + 25]} to={[166, y + 25]} />
          <Announcement h={62} w={118} x={176} y={y - 6} />
        </g>
      ))}
    </>
  )
}

/** A release's own feature line and screenshot, quoted into an announcement. */
function FeatureScene() {
  const rows = [
    { width: 70, y: 66 },
    { width: 82, y: 84 },
    { width: 60, y: 102 },
  ]
  return (
    <>
      <Surface height={128} width={124} x={22} y={26} />
      <Tint height={11} rx={5.5} strength={0.18} width={26} x={32} y={36} />
      <Caption accent className="font-semibold" textAnchor="middle" x={45} y={43.5}>
        v2.4
      </Caption>
      <Bar h={4} tone="ink" width={52} x={64} y={39.5} />
      <line
        className="stroke-foreground/10"
        vectorEffect="non-scaling-stroke"
        x1={22}
        x2={146}
        y1={55}
        y2={55}
      />
      <Tint height={16} rx={4} strength={0.14} width={114} x={27} y={76} />
      <rect
        className="stroke-current"
        height={16}
        rx={4}
        strokeOpacity={0.5}
        vectorEffect="non-scaling-stroke"
        width={114}
        x={27}
        y={76}
      />
      {rows.map(({ width, y }, index) => (
        <g key={y}>
          <circle
            className={index === 1 ? 'fill-current' : 'fill-foreground/25'}
            cx={36}
            cy={y + 1.75}
            r={2}
          />
          <Bar h={3.5} tone={index === 1 ? 'ink' : 'line'} width={width} x={44} y={y} />
        </g>
      ))}
      <Picture h={22} strength={0.3} w={34} x={34} y={120} />
      <Tint height={22} strength={0.1} width={34} x={74} y={120} />
      <Arrow dashed from={[143, 84]} to={[178, 70]} />
      <Surface height={112} width={116} x={182} y={34} />
      <Tint height={112} rx={5} strength={0.1} width={116} x={182} y={34} />
      <text className="fill-current font-serif text-[28px] leading-none" x={190} y={66}>
        “
      </text>
      <Bar h={5} tone="ink" width={82} x={192} y={68} />
      <Bar h={5} tone="ink" width={52} x={192} y={77} />
      <Bar width={70} x={192} y={88} />
      <Picture h={40} strength={0.3} w={96} x={192} y={98} />
    </>
  )
}

/** A gallery of layouts, one being picked. */
function TemplateScene() {
  const layouts: ((box: Box) => ReactNode)[] = [
    (box) => <Announcement {...box} />,
    ({ x, y, w, h }) => (
      <g>
        <Surface height={h} width={w} x={x} y={y} />
        <Tint height={h} rx={5} strength={0.22} width={w} x={x} y={y} />
        <Bar h={5} tone="ink" width={w * 0.6} x={x + w * 0.2} y={y + h * 0.32} />
        <Bar h={5} tone="ink" width={w * 0.4} x={x + w * 0.3} y={y + h * 0.32 + 8} />
        <Bar width={w * 0.5} x={x + w * 0.25} y={y + h * 0.32 + 19} />
      </g>
    ),
    ({ x, y, w, h }) => (
      <g>
        <Surface height={h} width={w} x={x} y={y} />
        <Tint height={h - 12} strength={0.08} width={w / 2 - 9} x={x + 6} y={y + 6} />
        <Picture h={h - 12} w={w / 2 - 9} x={x + w / 2 + 3} y={y + 6} />
        <line
          className="stroke-foreground/30"
          vectorEffect="non-scaling-stroke"
          x1={x + w / 2}
          x2={x + w / 2}
          y1={y + 3}
          y2={y + h - 3}
        />
        <circle
          className="fill-card stroke-foreground/30"
          cx={x + w / 2}
          cy={y + h / 2}
          r={4}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    ),
    ({ x, y, w, h }) => (
      <g>
        <Surface height={h} width={w} x={x} y={y} />
        {[0, 1, 2].map((step) => {
          const cx = x + w * (0.2 + step * 0.3)
          return (
            <g key={step}>
              <circle
                className="fill-current"
                cx={cx}
                cy={y + h * 0.38}
                fillOpacity={step ? 0.3 : 1}
                r={6}
              />
              <Bar h={2.5} width={w * 0.2} x={cx - w * 0.1} y={y + h * 0.62} />
              <Bar h={2.5} width={w * 0.14} x={cx - w * 0.07} y={y + h * 0.62 + 5} />
            </g>
          )
        })}
      </g>
    ),
    ({ x, y, w, h }) => (
      <g>
        <rect className="fill-foreground/85" height={h} rx={5} width={w} x={x} y={y} />
        {[0, 1, 2, 3, 4].map((line) => (
          <g key={line}>
            <Bar
              h={2.5}
              tone="accent"
              width={10 + (line % 2) * 6}
              x={x + 8 + (line % 3) * 6}
              y={y + 10 + line * 8}
            />
            <rect
              className="fill-background/40"
              height={2.5}
              rx={1.25}
              width={[30, 22, 36, 18, 26][line]}
              x={x + 24 + (line % 3) * 6}
              y={y + 10 + line * 8}
            />
          </g>
        ))}
      </g>
    ),
    ({ x, y, h }) => (
      <g>
        <Creative h={h} w={30} x={x} y={y} />
        <Creative h={34} w={34} x={x + 36} y={y + h - 34} />
        <Tint height={h - 40} strength={0.14} width={36} x={x + 36} y={y} />
      </g>
    ),
  ]
  return (
    <>
      {layouts.map((layout, index) => {
        const box = { h: 54, w: 80, x: 28 + (index % 3) * 92, y: 29 + Math.floor(index / 3) * 68 }
        return <g key={index}>{layout(box)}</g>
      })}
      <rect
        className="stroke-current"
        height={60}
        rx={7}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        width={86}
        x={117}
        y={26}
      />
      <circle className="fill-current" cx={201} cy={28} r={6} />
      <path
        className="stroke-white"
        d="M198.3 28.2l1.8 1.8 3.4-3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.4}
      />
      <Pointer x={182} y={66} />
    </>
  )
}

/** The five slides of a launch, one shown large. */
function LaunchScene() {
  const glyphs: ((box: Box) => ReactNode)[] = [
    ({ x, y, w, h }) => (
      <g>
        <circle
          className="stroke-foreground/40"
          cx={x + w / 2}
          cy={y + h / 2 - 2}
          r={6}
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
        />
        <Bar h={2} width={14} x={x + w / 2 - 7} y={y + h - 7} />
      </g>
    ),
    ({ x, y, w, h }) => <Screenshot h={h - 10} w={w - 12} x={x + 6} y={y + 5} />,
    ({ x, y, h }) => (
      <g>
        {[0, 1, 2].map((column) => (
          <Tint
            height={h - 14}
            key={column}
            strength={0.3}
            width={9}
            x={x + 7 + column * 11.5}
            y={y + 7}
          />
        ))}
      </g>
    ),
    ({ x, y, w, h }) => (
      <path
        className="stroke-current"
        d={`M${x + 7} ${y + h - 7}L${x + 17} ${y + h - 13}L${x + 25} ${y + h - 10}L${x + w - 7} ${y + 7}`}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    ),
    ({ x, y, w, h }) => (
      <g>
        <Bar h={2.5} width={22} x={x + w / 2 - 11} y={y + 8} />
        <Tint height={7} rx={3.5} strength={1} width={20} x={x + w / 2 - 10} y={y + h - 13} />
      </g>
    ),
  ]
  return (
    <>
      <Announcement h={106} w={240} x={40} y={16} />
      {glyphs.map((glyph, index) => {
        const box = { h: 28, w: 44, x: 40 + index * 49, y: 134 }
        return (
          <g key={index}>
            <Surface
              {...(index === 1 ? { className: 'fill-card stroke-current', strokeWidth: 1.5 } : {})}
              height={box.h}
              width={box.w}
              x={box.x}
              y={box.y}
            />
            {glyph(box)}
          </g>
        )
      })}
    </>
  )
}

/** The approved creative stays locked; its copy is the one you edit. */
function CampaignScene() {
  return (
    <>
      <Creative h={120} w={100} x={28} y={30} />
      <circle className="fill-current" cx={128} cy={30} r={8} />
      <path
        className="stroke-white"
        d="M124.5 30.3l2.4 2.4 4.6-4.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
      />
      <g className="fill-foreground/45">
        <rect height={7} rx={1.5} width={9} x={36} y={139} />
      </g>
      <path
        className="stroke-foreground/45"
        d="M38 139.5v-2.5a2.5 2.5 0 0 1 5 0v2.5"
        strokeWidth={1.25}
      />
      <Arrow from={[138, 92]} to={[182, 92]} />
      <g className="stroke-foreground/40" strokeWidth={1.25}>
        <rect height={10} rx={2} width={8} x={155} y={72} />
        <rect className="fill-card" height={10} rx={2} width={8} x={158} y={75} />
      </g>
      <Creative h={120} w={100} x={192} y={30} />
      <Selection h={18} w={70} x={198} y={92} />
      <rect className="fill-current" height={9} width={1.25} x={252} y={94} />
      <Pointer x={262} y={104} />
    </>
  )
}

/** A screenshot editor project, copied into the canvas as one artboard. */
function ProjectScene() {
  return (
    <>
      <Surface height={84} width={116} x={22} y={36} />
      <Tint height={76} rx={3} strength={0.32} width={108} x={26} y={40} />
      <Screenshot h={52} w={80} x={40} y={52} />
      <Surface height={14} rx={7} width={74} x={22} y={128} />
      <Caption textAnchor="middle" x={59} y={137.5}>
        Editor project
      </Caption>
      <Arrow from={[144, 80]} to={[176, 80]} />
      <rect
        className="stroke-foreground/20"
        height={136}
        rx={8}
        strokeDasharray="3 3"
        vectorEffect="non-scaling-stroke"
        width={116}
        x={184}
        y={22}
      />
      <Caption accent x={194} y={51}>
        16:9 artboard
      </Caption>
      <rect className="fill-card" height={54} rx={2} width={96} x={194} y={56} />
      <Tint height={54} rx={2} strength={0.32} width={96} x={194} y={56} />
      <Screenshot h={38} w={66} x={209} y={64} />
      <Selection h={54} w={96} x={194} y={56} />
      <Surface height={13} rx={6.5} width={58} x={213} y={134} />
      {[0, 1, 2, 3].map((dot) => (
        <circle className="fill-foreground/30" cx={225 + dot * 11} cy={140.5} key={dot} r={1.8} />
      ))}
    </>
  )
}

/** Every format of a Story Set, side by side as artboards. */
function StorySetScene() {
  const formats = [
    { h: 75, label: '9:16', w: 42, x: 14 },
    { h: 70, label: '4:5', w: 56, x: 66 },
    { h: 64, label: '1:1', w: 64, x: 132 },
    { h: 56, label: '16:9', w: 100, x: 206 },
  ]
  return (
    <>
      <Caption accent className="text-[8px] font-semibold" textAnchor="middle" x={160} y={34}>
        Story Set
      </Caption>
      <path
        className="stroke-current"
        d="M35 52v-6h250v6"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeOpacity={0.45}
        vectorEffect="non-scaling-stroke"
      />
      {formats.map(({ h, label, w, x }) => (
        <g key={label}>
          <Caption x={x} y={142 - h - 5}>
            {label}
          </Caption>
          <Creative h={h} w={w} x={x} y={142 - h} />
        </g>
      ))}
    </>
  )
}

const SCENES = {
  campaign: { Scene: CampaignScene, tone: 'emerald' },
  feature: { Scene: FeatureScene, tone: 'violet' },
  launch: { Scene: LaunchScene, tone: 'orange' },
  project: { Scene: ProjectScene, tone: 'sky' },
  screenshots: { Scene: ScreenshotsScene, tone: 'blue' },
  'story-set': { Scene: StorySetScene, tone: 'rose' },
  template: { Scene: TemplateScene, tone: 'amber' },
} satisfies Record<string, { Scene: () => ReactNode; tone: IllustrationTone }>

/** What a way to start a canvas makes, drawn for its card on New canvas. */
export function StartArt({ className, start }: { className?: string; start: keyof typeof SCENES }) {
  const { Scene, tone } = SCENES[start]
  return (
    <Illustration className={className} tone={tone}>
      <Scene />
    </Illustration>
  )
}

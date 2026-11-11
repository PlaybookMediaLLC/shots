import type { ReactNode } from 'react'
import {
  Arrow,
  Bar,
  Caption,
  Illustration,
  type IllustrationTone,
  Picture,
  Play,
  Surface,
  Tint,
} from '@/components/platform-ui/illustration'

/** A post card on the right of a scene: avatar, two lines and a time. */
function Post({ x, y, time, w = 118 }: { x: number; y: number; time: string; w?: number }) {
  return (
    <g>
      <Surface height={32} width={w} x={x} y={y} />
      <circle className="fill-current" cx={x + 11} cy={y + 11} fillOpacity={0.35} r={5} />
      <Bar h={3} tone="ink" width={30} x={x + 20} y={y + 7.5} />
      <Bar width={w - 52} x={x + 20} y={y + 15} />
      <Bar width={w - 70} x={x + 20} y={y + 21.5} />
      <Tint height={9} rx={4.5} strength={0.15} width={24} x={x + w - 30} y={y + 18} />
      <Caption accent textAnchor="middle" x={x + w - 18} y={y + 24.5}>
        {time}
      </Caption>
    </g>
  )
}

/** Pasted copy split at blank lines into one post each. */
function TextScene() {
  const paragraphs = [
    { y: 29, widths: [96, 88, 54] },
    { y: 73, widths: [92, 70, 80] },
    { y: 117, widths: [98, 84, 40] },
  ]
  return (
    <>
      <Surface height={128} width={118} x={22} y={16} />
      {paragraphs.map(({ y, widths }) =>
        widths.map((width, line) => (
          <Bar key={`${y}-${line}`} width={width} x={32} y={y + line * 7} />
        ))
      )}
      <rect className="fill-current" height={8} width={1.25} x={73} y={129.5} />
      {paragraphs.map(({ y }, index) => (
        <g key={y}>
          <Arrow from={[146, y + 8]} to={[174, y + 8]} />
          <Post time={['9:00', '12:30', '17:00'][index]} x={180} y={y - 8} />
        </g>
      ))}
    </>
  )
}

/** A stack of videos, each becoming a captioned, timed post. */
function VideoScene() {
  return (
    <>
      {[-11, 11, 0].map((angle) => (
        <g key={angle} opacity={angle ? 0.75 : 1} transform={`rotate(${angle} 78 120)`}>
          <Surface height={84} width={48} x={54} y={36} />
          <Tint height={76} strength={angle ? 0.18 : 0.3} width={40} x={58} y={40} />
          <Play cx={78} cy={78} r={angle ? 5 : 7} />
          {angle ? null : (
            <>
              <Bar width={32} x={62} y={108} />
              <Bar tone="accent" width={13} x={62} y={108} />
            </>
          )}
        </g>
      ))}
      <rect className="fill-foreground" height={13} rx={6.5} width={30} x={94} y={22} />
      <Caption className="fill-background font-semibold" textAnchor="middle" x={109} y={31}>
        ×100
      </Caption>
      <Arrow from={[124, 80]} to={[164, 80]} />
      {['9:00', '12:30', '17:00'].map((time, index) => {
        const y = 26 + index * 40
        return (
          <g key={time}>
            <Surface height={30} width={128} x={170} y={y} />
            <Tint height={20} strength={0.3} width={14} x={176} y={y + 5} />
            <Play cx={183} cy={y + 15} r={3.5} />
            <Bar h={3} tone="ink" width={52} x={198} y={y + 9} />
            <Bar width={40} x={198} y={y + 17} />
            <Tint height={10} rx={5} strength={0.15} width={26} x={266} y={y + 10} />
            <Caption accent textAnchor="middle" x={279} y={y + 17}>
              {time}
            </Caption>
          </g>
        )
      })}
    </>
  )
}

/** A folder of images becoming a carousel post, or one post per image. */
function ImageScene() {
  return (
    <>
      <path
        className="fill-current"
        d="M24 46a4 4 0 0 1 4-4h28l8 8h70a4 4 0 0 1 4 4v80a4 4 0 0 1-4 4H28a4 4 0 0 1-4-4Z"
        fillOpacity={0.2}
      />
      {[
        { angle: -9, x: 36 },
        { angle: 6, x: 82 },
        { angle: -2, x: 58 },
      ].map(({ angle, x }) => (
        <g key={x} transform={`rotate(${angle} ${x + 22} 80)`}>
          <Surface height={42} width={44} x={x} y={40} />
          <Picture h={34} w={36} x={x + 4} y={44} />
        </g>
      ))}
      <rect
        className="fill-current"
        fillOpacity={0.38}
        height={66}
        rx={5}
        width={114}
        x={24}
        y={72}
      />
      <Bar className="fill-card" h={3} width={36} x={34} y={124} />
      <Arrow from={[144, 86]} to={[172, 86]} />
      <Surface height={112} opacity={0.5} width={110} x={190} y={16} />
      <Surface height={112} opacity={0.75} width={114} x={184} y={22} />
      <Surface height={116} width={118} x={178} y={28} />
      <circle className="fill-current" cx={189} cy={39} fillOpacity={0.35} r={5} />
      <Bar h={3} tone="ink" width={30} x={198} y={37.5} />
      <Picture h={60} w={102} x={186} y={50} />
      {[0, 1, 2, 3].map((dot) => (
        <circle
          className={dot ? 'fill-foreground/20' : 'fill-current'}
          cx={226 + dot * 7}
          cy={118}
          key={dot}
          r={1.8}
        />
      ))}
      <Bar width={84} x={186} y={128} />
      <Bar width={56} x={186} y={135} />
    </>
  )
}

/** One frame of a grid video: a headline above four labelled images. */
function GridFrame({
  x,
  y,
  w,
  h,
  faded = false,
}: {
  x: number
  y: number
  w: number
  h: number
  faded?: boolean
}) {
  const tile = (w - 20) / 2
  const top = y + (faded ? 20 : 24)
  return (
    <g opacity={faded ? 0.6 : 1}>
      <Surface height={h} rx={7} width={w} x={x} y={y} />
      <Bar h={faded ? 3 : 4} tone="ink" width={w * 0.7} x={x + 8} y={y + 8} />
      <Bar h={faded ? 3 : 4} tone="ink" width={w * 0.46} x={x + 8} y={y + (faded ? 13 : 15)} />
      {[0, 1, 2, 3].map((index) => {
        const tx = x + 8 + (index % 2) * (tile + 4)
        const ty = top + Math.floor(index / 2) * (tile + 8)
        return (
          <g key={index}>
            <Tint
              height={tile}
              strength={[0.22, 0.4, 0.32, 0.5][index]}
              width={tile}
              x={tx}
              y={ty}
            />
            <Bar h={2.5} width={tile * 0.7} x={tx} y={ty + tile + 2.5} />
          </g>
        )
      })}
      <Bar h={2.5} width={w - 16} x={x + 8} y={y + h - 8} />
      <Bar h={2.5} tone="accent" width={(w - 16) * 0.45} x={x + 8} y={y + h - 8} />
    </g>
  )
}

/** Vertical six-second videos laid out as a headline above a 2×2 grid. */
function GridScene() {
  return (
    <>
      <GridFrame faded h={100} w={56} x={52} y={34} />
      <GridFrame faded h={100} w={56} x={212} y={34} />
      <GridFrame h={128} w={72} x={124} y={18} />
      <Tint height={12} rx={6} strength={1} width={22} x={180} y={10} />
      <Caption className="fill-white font-semibold" textAnchor="middle" x={191} y={18.5}>
        6s
      </Caption>
    </>
  )
}

/** A file's outline with a folded corner. */
function File({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <g>
      <path
        className="fill-card stroke-foreground/20"
        d={`M${x + 3} ${y}h13l8 8v19a3 3 0 0 1-3 3H${x + 3}a3 3 0 0 1-3-3V${y + 3}a3 3 0 0 1 3-3Z`}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="stroke-foreground/20"
        d={`M${x + 16} ${y}v8h8`}
        vectorEffect="non-scaling-stroke"
      />
      {children}
    </g>
  )
}

/** Rows of a CSV and loose files, each becoming a post. */
function MixedScene() {
  const columns = ['caption', 'media', 'time']
  return (
    <>
      <Surface height={84} width={124} x={22} y={16} />
      <Tint height={14} rx={0} strength={0.16} width={123} x={22.5} y={16.5} />
      {columns.map((column, index) => (
        <Caption accent key={column} x={28 + index * 41} y={25.5}>
          {column}
        </Caption>
      ))}
      {[30, 44, 58, 72, 86].map((y) => (
        <line
          className="stroke-foreground/10"
          key={y}
          vectorEffect="non-scaling-stroke"
          x1={22}
          x2={146}
          y1={y}
          y2={y}
        />
      ))}
      {[63, 104].map((x) => (
        <line
          className="stroke-foreground/10"
          key={x}
          vectorEffect="non-scaling-stroke"
          x1={x}
          x2={x}
          y1={16}
          y2={100}
        />
      ))}
      {[34.5, 48.5, 62.5, 76.5, 90.5].map((y, row) => (
        <g key={y}>
          <Bar width={[30, 24, 32, 20, 28][row]} x={28} y={y + 1} />
          <Bar width={[22, 26, 18, 24, 20][row]} x={69} y={y + 1} />
          <Bar width={[26, 20, 28, 22, 24][row]} x={110} y={y + 1} />
        </g>
      ))}
      <File x={24} y={110}>
        <Picture h={12} strength={0.3} w={16} x={28} y={122} />
      </File>
      <File x={58} y={110}>
        <path className="fill-current" d="M67 121l9 5-9 5Z" fillOpacity={0.8} />
      </File>
      <File x={92} y={110}>
        <Caption accent className="text-[6px] font-bold" x={95} y={130}>
          PDF
        </Caption>
      </File>
      <path
        className="fill-current"
        d="M126 116a3 3 0 0 1 3-3h7l3 3h8a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3h-18a3 3 0 0 1-3-3Z"
        fillOpacity={0.45}
      />
      <Arrow from={[154, 80]} to={[178, 80]} />
      {['9:00', '12:30', '17:00'].map((time, index) => (
        <Post key={time} time={time} w={114} x={184} y={24 + index * 40} />
      ))}
    </>
  )
}

const SCENES = {
  grid: { Scene: GridScene, tone: 'rose' },
  images: { Scene: ImageScene, tone: 'amber' },
  mixed: { Scene: MixedScene, tone: 'emerald' },
  text: { Scene: TextScene, tone: 'blue' },
  videos: { Scene: VideoScene, tone: 'violet' },
} satisfies Record<string, { Scene: () => ReactNode; tone: IllustrationTone }>

/** What a kind of batch turns into, drawn for its card on Bulk tools. */
export function BatchKindArt({ kind }: { kind: keyof typeof SCENES }) {
  const { Scene, tone } = SCENES[kind]
  return (
    <Illustration height={160} tone={tone}>
      <Scene />
    </Illustration>
  )
}

'use client'

import * as React from 'react'
import { syncTokenKeys, toKeyedTokens, type KeyedTokensInfo } from '@shikijs/magic-move/core'
import type { ThemedToken } from 'shiki/core'
import { lineDiff } from '@/lib/code-studio/diff'
import {
  activeFile,
  type CodeDocument,
  type CodeFile,
  type CodeStyle,
} from '@/lib/code-studio/document'
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, windowHeight } from '@/lib/code-studio/layout'
import { frameAt, morphTokens, placeTokens, typedLengths } from '@/lib/code-studio/timeline'
import {
  CodeScene,
  gutterWidth,
  lookFor,
  rowStyle,
  Tokens,
  useHighlighted,
  type Look,
} from './CodeScene'

const plain = (file: CodeFile | undefined) =>
  !!file && file.tape === undefined && file.base === undefined

const widths = new Map<string, number>()

/** A monospace font's character width at the code size, measured once it has loaded. */
function charWidth(font: string): number {
  const cached = widths.get(font)
  if (cached) return cached
  const context = window.document.createElement('canvas').getContext('2d')
  if (!context) return CODE_FONT_SIZE * 0.6
  context.font = `${CODE_FONT_SIZE}px ${font}`
  const width = context.measureText('M'.repeat(100)).width / 100
  if (window.document.fonts.check(context.font)) widths.set(font, width)
  return width
}

type Pair = { from: KeyedTokensInfo; to: KeyedTokensInfo }
const pairs = new WeakMap<ThemedToken[][], WeakMap<ThemedToken[][], Pair>>()

/**
 * Keyed tokens for a pair of states, matched once per pair of highlighted
 * line arrays (which the highlight cache keeps stable) and reused every frame.
 */
function matched(
  from: CodeFile,
  fromLines: ThemedToken[][],
  to: CodeFile,
  toLines: ThemedToken[][]
): Pair {
  const known = pairs.get(fromLines)?.get(toLines)
  if (known) return known
  const pair = syncTokenKeys(
    toKeyedTokens(from.code, fromLines, 'a'),
    toKeyedTokens(to.code, toLines, 'b')
  )
  if (!pairs.has(fromLines)) pairs.set(fromLines, new WeakMap())
  pairs.get(fromLines)!.set(toLines, pair)
  return pair
}

/** Tokens moving from one state of a file to the next. */
function MorphBody({
  from,
  to,
  style,
  look,
  progress,
}: {
  from: CodeFile
  to: CodeFile
  style: CodeStyle
  look: Look
  progress: number
}) {
  const fromLines = useHighlighted(from.code, from.lang)
  const toLines = useHighlighted(to.code, to.lang)
  const pair = matched(from, fromLines, to, toLines)
  const tokens = morphTokens(placeTokens(pair.from.tokens), placeTokens(pair.to.tokens), progress)
  const before = from.code.split('\n').length
  const after = to.code.split('\n').length
  const rows = before + (after - before) * progress
  const gutter = style.lineNumbers ? gutterWidth(Math.max(before, after)) : 0
  const width = charWidth(look.font)
  return (
    <div
      style={{
        position: 'relative',
        height: rows * CODE_LINE_HEIGHT,
        fontFamily: look.font,
        fontSize: CODE_FONT_SIZE,
      }}
    >
      {style.lineNumbers
        ? Array.from({ length: Math.max(before, after) }, (_, index) => (
            <span
              key={index}
              style={{
                position: 'absolute',
                top: index * CODE_LINE_HEIGHT,
                left: 0,
                width: gutter - 16,
                textAlign: 'right',
                lineHeight: `${CODE_LINE_HEIGHT}px`,
                color: look.muted,
                opacity:
                  index < Math.min(before, after) ? 1 : index < after ? progress : 1 - progress,
              }}
            >
              {index + 1}
            </span>
          ))
        : null}
      {tokens.map((token) => (
        <span
          key={token.key}
          style={{
            position: 'absolute',
            top: token.line * CODE_LINE_HEIGHT,
            left: gutter + token.col * width,
            lineHeight: `${CODE_LINE_HEIGHT}px`,
            whiteSpace: 'pre',
            color: token.color,
            opacity: token.opacity,
          }}
        >
          {token.content}
        </span>
      ))}
    </div>
  )
}

/** A file being typed over its previous state: new lines fill in, character by character. */
function TypeBody({
  before,
  file,
  style,
  look,
  progress,
}: {
  before: string
  file: CodeFile
  style: CodeStyle
  look: Look
  progress: number
}) {
  const tokens = useHighlighted(file.code, file.lang)
  const text = file.code.split('\n')
  const shown = typedLengths(before, file.code, progress)
  const added = new Set(
    lineDiff(before, file.code)
      .filter((row) => row.kind === 'add')
      .map((row) => (row as { after: number }).after - 1)
  )
  const cursor = text.findIndex((line, index) => added.has(index) && shown[index]! < line.length)
  const last = cursor === -1 ? -1 : cursor
  const gutter = style.lineNumbers ? gutterWidth(text.length) : 0
  return (
    <div>
      {text.map((line, index) => {
        if (added.has(index) && last !== -1 && index > last) return null
        let budget = shown[index]!
        const visible = (tokens[index] ?? []).flatMap((token) => {
          if (budget <= 0) return []
          const content = token.content.slice(0, budget)
          budget -= token.content.length
          return [{ ...token, content }]
        })
        return (
          <div key={index} style={{ ...rowStyle(look) }}>
            {style.lineNumbers ? (
              <span
                style={{
                  width: gutter,
                  paddingRight: 16,
                  textAlign: 'right',
                  color: look.muted,
                  flexShrink: 0,
                }}
              >
                {index + 1}
              </span>
            ) : null}
            <span>
              <Tokens tokens={visible} />
              {index === last ? (
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 2,
                    height: CODE_LINE_HEIGHT - 6,
                    verticalAlign: 'middle',
                    background: 'var(--code-foreground)',
                  }}
                />
              ) : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Props of {@link AnimatedScene}. */
export type AnimatedSceneProps = {
  document: CodeDocument
  /** Milliseconds from the start of the video. */
  time: number
  size: { width: number; height: number }
  logoUrl?: string
}

/**
 * The project as a video frame at `time`: a slide holding, typing in, its
 * tokens morphing from the previous slide, or crossfading from it.
 */
export const AnimatedScene = React.forwardRef<HTMLDivElement, AnimatedSceneProps>(
  function AnimatedScene({ document, time, size, logoUrl }, ref) {
    const frame = frameAt(document, time)
    const slide = document.slides[frame.slide]!
    const style = document.style
    const common = { document, size, logoUrl, caption: true, slideIndex: frame.slide }
    if (frame.transition === 'type') {
      const previous = frame.from === null ? null : document.slides[frame.from]!
      const typeable = slide.panes.every((pane) => plain(activeFile(pane)))
      if (typeable)
        return (
          <CodeScene
            ref={ref}
            {...common}
            time={frame.local}
            paneBody={(pane, index) => {
              const file = activeFile(pane)
              const prior = previous?.panes[index] ? activeFile(previous.panes[index]!) : undefined
              return (
                <TypeBody
                  before={prior && plain(prior) ? prior.code : ''}
                  file={file}
                  style={style}
                  look={lookFor(style, style.frame === 'terminal')}
                  progress={frame.progress}
                />
              )
            }}
          />
        )
    }
    if (frame.transition === 'morph' && frame.from !== null) {
      const previous = document.slides[frame.from]!
      const morphable =
        previous.panes.length === slide.panes.length &&
        slide.panes.every(
          (pane, index) => plain(activeFile(pane)) && plain(activeFile(previous.panes[index]!))
        )
      if (morphable) {
        const rows = (index: number, of: typeof slide) =>
          activeFile(of.panes[index]!).code.split('\n').length
        const height = Math.max(
          ...slide.panes.map((_, index) => {
            const before = rows(index, previous)
            return windowHeight(style, before + (rows(index, slide) - before) * frame.progress)
          })
        )
        return (
          <CodeScene
            ref={ref}
            {...common}
            time={frame.local}
            windowHeight={height}
            paneBody={(pane, index) => (
              <MorphBody
                from={activeFile(previous.panes[index]!)}
                to={activeFile(pane)}
                style={style}
                look={lookFor(style, style.frame === 'terminal')}
                progress={frame.progress}
              />
            )}
          />
        )
      }
    }
    if (frame.from !== null && frame.transition !== 'cut')
      return (
        <CodeScene
          ref={ref}
          {...common}
          time={frame.local}
          overlay={
            <div style={{ opacity: 1 - frame.progress }}>
              <CodeScene
                document={document}
                slideIndex={frame.from}
                size={size}
                logoUrl={logoUrl}
                caption
              />
            </div>
          }
        />
      )
    return <CodeScene ref={ref} {...common} time={frame.local} />
  }
)

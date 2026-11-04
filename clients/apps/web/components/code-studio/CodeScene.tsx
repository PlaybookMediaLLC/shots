'use client'

import * as React from 'react'
import type { ThemedToken } from 'shiki/core'
import {
  frameBackgroundStyle,
  resolveCodeBackground,
} from '@/components/code-image/code-backgrounds'
import {
  FONTS,
  WINDOW_SURFACE_DARK,
  WINDOW_SURFACE_LIGHT,
} from '@/components/code-image/code-themes'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { resolveCodeTheme } from '@/lib/code-studio/brand-theme'
import { lineDiff, splitRows } from '@/lib/code-studio/diff'
import {
  activeFile,
  type CodeDocument,
  type CodeFile,
  type CodePane,
  type CodeSlide,
  type CodeStyle,
  type LineRange,
} from '@/lib/code-studio/document'
import {
  cachedLines,
  highlightLines,
  paletteVariables,
  plainLines,
} from '@/lib/code-studio/highlight'
import {
  CAPTION_HEIGHT,
  CODE_FONT_SIZE,
  CODE_LINE_HEIGHT,
  CODE_PADDING_X,
  CODE_PADDING_Y,
  FOOTER_HEIGHT,
  PANE_GAP,
  TITLE_BAR_HEIGHT,
  hasTitleBar,
  paneWidth,
  slideSize,
} from '@/lib/code-studio/layout'
import { TAPE_PROMPT, screenAt, screenLines } from '@/lib/code-studio/tape'
import { FileIcon } from './file-icon'

const INTER = 'Inter, "Inter Fallback", Arial, Helvetica, sans-serif'

/**
 * Highlighted lines for code: synchronous once highlighted (exports warm the
 * cache first), plain lines until the grammar is ready.
 */
export function useHighlighted(code: string, lang: string): ThemedToken[][] {
  const [, loaded] = React.useReducer((count: number) => count + 1, 0)
  const hit = cachedLines(code, lang)
  React.useEffect(() => {
    if (cachedLines(code, lang)) return
    let live = true
    void highlightLines(code, lang).then(
      () => live && loaded(),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [code, lang])
  return hit ?? plainLines(code)
}

/** The line-number column's width for a number of lines. */
export const gutterWidth = (lines: number) => String(lines).length * 9 + 16

const inRanges = (ranges: LineRange[] | undefined, line: number) =>
  !!ranges?.some(([start, end]) => line >= start && line <= end)

/** What the editor can change directly on the scene. */
export type SceneEditing = {
  paneId: string
  onCodeChange: (paneId: string, fileId: string, code: string) => void
  onSelectTab?: (paneId: string, fileId: string) => void
  /** Clicking a line number; `extend` keeps the range anchor (Shift). */
  onLineClick?: (paneId: string, fileId: string, line: number, extend: boolean) => void
  selection?: { paneId: string; fileId: string; range: LineRange } | null
}

/** How the scene is drawn: colors and the window surface. */
export type Look = {
  dark: boolean
  font: string
  accent: string
  muted: string
  surface: string
  ring: string
}

/** Colors, font and surface for a style; terminals are always dark. */
export function lookFor(style: CodeStyle, terminal: boolean): Look {
  const dark = style.dark || terminal
  const theme = resolveCodeTheme(style)
  return {
    dark,
    font: (FONTS.find((font) => font.id === style.font) ?? FONTS[0]).css,
    accent: theme.dark.keyword ?? theme.to,
    muted: dark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.32)',
    surface:
      style.frame === 'none'
        ? 'transparent'
        : terminal
          ? 'rgba(10, 10, 12, 0.94)'
          : dark
            ? WINDOW_SURFACE_DARK
            : WINDOW_SURFACE_LIGHT,
    ring: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
  }
}

/** Highlighted tokens of one line. */
export function Tokens({ tokens }: { tokens: ThemedToken[] | undefined }) {
  if (!tokens?.length) return <>{'​'}</>
  return (
    <>
      {tokens.map((token, index) => (
        <span
          key={index}
          style={{
            color: token.color,
            fontStyle: token.fontStyle && token.fontStyle & 1 ? 'italic' : undefined,
            fontWeight: token.fontStyle && token.fontStyle & 2 ? 600 : undefined,
          }}
        >
          {token.content}
        </span>
      ))}
    </>
  )
}

/** One code row's box. */
export const rowStyle = (look: Look): React.CSSProperties => ({
  height: CODE_LINE_HEIGHT,
  lineHeight: `${CODE_LINE_HEIGHT}px`,
  fontFamily: look.font,
  fontSize: CODE_FONT_SIZE,
  whiteSpace: 'pre',
  display: 'flex',
})

function Gutter({
  label,
  look,
  width,
  onClick,
  selected,
}: {
  label: string
  look: Look
  width: number
  onClick?: (event: React.MouseEvent) => void
  selected?: boolean
}) {
  const style: React.CSSProperties = {
    width,
    flexShrink: 0,
    textAlign: 'right',
    paddingRight: 16,
    color: selected ? look.accent : look.muted,
    userSelect: 'none',
    fontFamily: look.font,
    fontSize: CODE_FONT_SIZE,
    lineHeight: `${CODE_LINE_HEIGHT}px`,
  }
  if (!onClick) return <span style={style}>{label}</span>
  return (
    <Button
      variant="custom"
      size={null}
      type="button"
      aria-label={`Select line ${label}`}
      onClick={onClick}
      className="justify-end rounded-none p-0 hover:opacity-100"
      style={{ ...style, height: CODE_LINE_HEIGHT, cursor: 'pointer' }}
    >
      {label}
    </Button>
  )
}

/** A file's lines with emphasis, line numbers, annotations and an optional editing overlay. */
function CodeLines({
  file,
  pane,
  look,
  style,
  editing,
}: {
  file: CodeFile
  pane: CodePane
  look: Look
  style: CodeStyle
  editing?: SceneEditing
}) {
  const lines = useHighlighted(file.code, file.lang)
  const count = file.code.split('\n').length
  const gutter = style.lineNumbers ? gutterWidth(count) : 0
  const marks = file.marks
  const focusing = !!marks?.focus.length
  const selected = editing?.selection?.fileId === file.id ? editing.selection.range : null
  const canEdit = editing?.paneId === pane.id
  const markers = (file.annotations ?? []).filter((note) => note.kind === 'marker')
  return (
    <div style={{ position: 'relative' }}>
      {Array.from({ length: count }, (_, index) => {
        const line = index + 1
        const highlighted =
          inRanges(marks?.highlight, line) || inRanges(selected ? [selected] : [], line)
        return (
          <div
            key={index}
            style={{
              ...rowStyle(look),
              margin: `0 -${CODE_PADDING_X}px`,
              padding: `0 ${CODE_PADDING_X}px`,
              background: highlighted
                ? `color-mix(in srgb, ${look.accent} 16%, transparent)`
                : undefined,
              boxShadow: highlighted ? `inset 3px 0 0 ${look.accent}` : undefined,
              opacity: focusing && !inRanges(marks?.focus, line) ? 0.32 : 1,
              filter: inRanges(marks?.blur, line) ? 'blur(4px)' : undefined,
              transition: 'opacity 200ms, background-color 200ms',
            }}
          >
            {style.lineNumbers ? (
              <Gutter
                label={String(line)}
                look={look}
                width={gutter}
                selected={highlighted}
                onClick={
                  editing?.onLineClick
                    ? (event) => editing.onLineClick!(pane.id, file.id, line, event.shiftKey)
                    : undefined
                }
              />
            ) : null}
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <Tokens tokens={lines[index]} />
            </span>
          </div>
        )
      })}
      {(file.annotations ?? []).map((note) => {
        const top = (Math.min(note.line, count) - 1) * CODE_LINE_HEIGHT
        if (note.kind === 'marker')
          return (
            <span
              key={note.id}
              aria-label={`Marker ${markers.indexOf(note) + 1}${note.text ? `: ${note.text}` : ''}`}
              style={{
                position: 'absolute',
                right: 0,
                top: top + 2,
                height: CODE_LINE_HEIGHT - 4,
                minWidth: CODE_LINE_HEIGHT - 4,
                padding: '0 6px',
                borderRadius: 999,
                background: look.accent,
                color: '#fff',
                fontFamily: INTER,
                fontSize: 11,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              {markers.indexOf(note) + 1}
              {note.text ? <span style={{ fontWeight: 500 }}>{note.text}</span> : null}
            </span>
          )
        return (
          <span
            key={note.id}
            style={{
              position: 'absolute',
              right: 0,
              top: top - 4,
              maxWidth: '45%',
              display: 'flex',
              alignItems: 'center',
              fontFamily: INTER,
              fontSize: 12,
              lineHeight: 1.35,
            }}
          >
            <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden style={{ flexShrink: 0 }}>
              <path
                d="M22 6H4M8 1 3 6l5 5"
                stroke={look.accent}
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
            <span
              style={{
                background: look.accent,
                color: '#fff',
                padding: '5px 10px',
                borderRadius: 8,
                boxShadow: '0 6px 20px -6px rgba(0,0,0,0.5)',
              }}
            >
              {note.text || 'Note'}
            </span>
          </span>
        )
      })}
      {canEdit ? (
        <Textarea
          value={file.code}
          onChange={(event) => editing!.onCodeChange(pane.id, file.id, event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return
            event.preventDefault()
            const target = event.currentTarget
            const { selectionStart: start, selectionEnd: end } = target
            const next = `${file.code.slice(0, start)}  ${file.code.slice(end)}`
            editing!.onCodeChange(pane.id, file.id, next)
            requestAnimationFrame(() => {
              target.selectionStart = target.selectionEnd = start + 2
            })
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Code editor"
          data-code-editor
          className="absolute inset-y-0 right-0 min-h-0 resize-none rounded-none border-none bg-transparent p-0 shadow-none outline-none [field-sizing:fixed] focus-visible:ring-0 dark:bg-transparent"
          style={{
            left: gutter,
            color: 'transparent',
            WebkitTextFillColor: 'transparent',
            caretColor: look.dark ? '#fff' : '#000',
            fontFamily: look.font,
            fontSize: CODE_FONT_SIZE,
            lineHeight: `${CODE_LINE_HEIGHT}px`,
            whiteSpace: 'pre',
            overflow: 'hidden',
          }}
        />
      ) : null}
    </div>
  )
}

const DIFF_COLORS = {
  add: { line: 'rgba(46, 160, 67, 0.18)', sign: '#3fb950' },
  del: { line: 'rgba(248, 81, 73, 0.18)', sign: '#f85149' },
}

/** A file shown as the change from its base: unified, or before and after side by side. */
function DiffLines({ file, look, style }: { file: CodeFile; look: Look; style: CodeStyle }) {
  const before = useHighlighted(file.base ?? '', file.lang)
  const after = useHighlighted(file.code, file.lang)
  const rows = lineDiff(file.base ?? '', file.code)
  const sign = (kind: 'add' | 'del' | 'same') => (
    <span
      style={{
        width: 18,
        flexShrink: 0,
        color: kind === 'same' ? look.muted : DIFF_COLORS[kind].sign,
        userSelect: 'none',
      }}
    >
      {kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}
    </span>
  )
  const row = (
    key: React.Key,
    kind: 'add' | 'del' | 'same',
    number: number | undefined,
    tokens: ThemedToken[] | undefined
  ) => (
    <div
      key={key}
      style={{
        ...rowStyle(look),
        margin: `0 -${CODE_PADDING_X}px`,
        padding: `0 ${CODE_PADDING_X}px`,
        background: kind === 'same' ? undefined : DIFF_COLORS[kind].line,
      }}
    >
      {style.lineNumbers ? (
        <Gutter label={number ? String(number) : ''} look={look} width={44} />
      ) : null}
      {sign(kind)}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <Tokens tokens={tokens} />
      </span>
    </div>
  )
  if (file.diff === 'split')
    return (
      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: CODE_PADDING_X * 2 }}
      >
        {splitRows(rows).map((pair, index) => (
          <React.Fragment key={index}>
            {pair.before
              ? row(
                  `b${index}`,
                  pair.kind === 'same' ? 'same' : 'del',
                  pair.before,
                  before[pair.before - 1]
                )
              : row(`b${index}`, 'same', undefined, [])}
            {pair.after
              ? row(
                  `a${index}`,
                  pair.kind === 'same' ? 'same' : 'add',
                  pair.after,
                  after[pair.after - 1]
                )
              : row(`a${index}`, 'same', undefined, [])}
          </React.Fragment>
        ))}
      </div>
    )
  return (
    <div>
      {rows.map((entry, index) =>
        entry.kind === 'del'
          ? row(index, 'del', entry.before, before[entry.before - 1])
          : row(index, entry.kind, entry.after, after[entry.after - 1])
      )}
    </div>
  )
}

/** A terminal screen: commands after the prompt, output below them. */
function TerminalLines({ file, look, time }: { file: CodeFile; look: Look; time?: number }) {
  const rows = time === undefined ? screenLines(file.tape ?? '') : screenAt(file.tape ?? '', time)
  return (
    <div>
      {rows.map((text, index) => {
        const command = text.startsWith(TAPE_PROMPT)
        const last = index === rows.length - 1
        return (
          <div key={index} style={rowStyle(look)}>
            {command ? (
              <>
                <span style={{ color: 'var(--code-token-function)' }}>{TAPE_PROMPT}</span>
                <span style={{ color: 'var(--code-foreground)' }}>
                  {text.slice(TAPE_PROMPT.length)}
                </span>
              </>
            ) : (
              <span style={{ color: 'var(--code-token-comment)' }}>{text || '​'}</span>
            )}
            {last && time !== undefined ? (
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: '0.6em',
                  height: CODE_LINE_HEIGHT - 6,
                  marginTop: 3,
                  background: 'var(--code-foreground)',
                  opacity: Math.floor(time / 530) % 2 ? 0 : 0.8,
                }}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function TitleBar({
  pane,
  style,
  look,
  editing,
}: {
  pane: CodePane
  style: CodeStyle
  look: Look
  editing?: SceneEditing
}) {
  const terminal = style.frame === 'terminal'
  const file = activeFile(pane)
  const tabs = pane.files.length > 1
  const title = style.title || file.name || (terminal ? 'zsh' : 'untitled')
  const textColor = look.dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)'
  return (
    <div
      style={{
        height: TITLE_BAR_HEIGHT,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 18px',
        boxShadow: `0 1px 0 ${look.ring}`,
        fontFamily: INTER,
        fontSize: 12,
        color: textColor,
      }}
    >
      {['#ff5f57', '#febc2e', '#28c840'].map((color) => (
        <span
          key={color}
          style={{ width: 12, height: 12, borderRadius: '50%', background: color, flexShrink: 0 }}
        />
      ))}
      {tabs ? (
        <div style={{ display: 'flex', gap: 2, marginLeft: 12, minWidth: 0, overflow: 'hidden' }}>
          {pane.files.map((tab) => {
            const active = tab.id === file.id
            const content = (
              <>
                <FileIcon name={tab.name} lang={tab.lang} size={13} />
                <span style={{ whiteSpace: 'nowrap' }}>{tab.name || 'untitled'}</span>
              </>
            )
            const tabStyle: React.CSSProperties = {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 10px',
              borderRadius: 7,
              color: active ? (look.dark ? '#fff' : '#000') : textColor,
              background: active
                ? look.dark
                  ? 'rgba(255,255,255,0.08)'
                  : 'rgba(0,0,0,0.06)'
                : 'transparent',
              fontSize: 12,
            }
            return editing?.onSelectTab ? (
              <Button
                key={tab.id}
                variant="custom"
                size={null}
                type="button"
                onClick={() => editing.onSelectTab!(pane.id, tab.id)}
                aria-pressed={active}
                style={tabStyle}
              >
                {content}
              </Button>
            ) : (
              <span key={tab.id} style={tabStyle}>
                {content}
              </span>
            )
          })}
        </div>
      ) : (
        <span
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            whiteSpace: 'nowrap',
          }}
        >
          {file.name && !terminal ? <FileIcon name={file.name} lang={file.lang} size={13} /> : null}
          {title}
        </span>
      )}
    </div>
  )
}

/** One window: chrome and the active file, as code, a diff or a terminal. */
export function PaneWindow({
  pane,
  slide,
  style,
  editing,
  time,
  body,
}: {
  pane: CodePane
  slide: Pick<CodeSlide, 'panes'>
  style: CodeStyle
  editing?: SceneEditing
  time?: number
  /** Replaces the file's lines, as a transition does. */
  body?: React.ReactNode
}) {
  const file = activeFile(pane)
  const terminal = style.frame === 'terminal' || file.tape !== undefined
  const look = lookFor(style, terminal)
  const content =
    body ??
    (file.tape !== undefined ? (
      <TerminalLines file={file} look={look} time={time} />
    ) : file.base !== undefined ? (
      <DiffLines file={file} look={look} style={style} />
    ) : (
      <CodeLines file={file} pane={pane} look={look} style={style} editing={editing} />
    ))
  return (
    <div
      data-pane={pane.id}
      style={{
        width: paneWidth(style, slide),
        borderRadius: style.frame === 'none' ? 0 : 12,
        overflow: 'hidden',
        background: look.surface,
        boxShadow:
          style.frame === 'none'
            ? undefined
            : `inset 0 0 0 1px ${look.ring}, 0 20px 60px -10px rgba(0,0,0,0.5), 0 8px 20px -8px rgba(0,0,0,0.4)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {hasTitleBar(style) ? (
        <TitleBar pane={pane} style={style} look={look} editing={editing} />
      ) : null}
      <div style={{ padding: `${CODE_PADDING_Y}px ${CODE_PADDING_X}px`, flex: 1 }}>{content}</div>
    </div>
  )
}

/** The attribution footer: logo or initial, name and handle. */
function Footer({ style, logoUrl }: { style: CodeStyle; logoUrl?: string }) {
  const { name, handle } = style.footer
  const color = style.dark ? '#ffffff' : '#111111'
  return (
    <div
      style={{
        height: FOOTER_HEIGHT,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 12,
        fontFamily: INTER,
        color,
        width: style.width,
      }}
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          style={{ height: 32, width: 'auto', maxWidth: 120, objectFit: 'contain' }}
          crossOrigin="anonymous"
        />
      ) : name ? (
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255,255,255,0.18)',
            fontWeight: 700,
          }}
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
        {name ? <strong style={{ fontSize: 14 }}>{name}</strong> : null}
        {handle ? <span style={{ fontSize: 13, opacity: 0.75 }}>{handle}</span> : null}
      </span>
    </div>
  )
}

/** Props of {@link CodeScene}. */
export type CodeSceneProps = {
  document: CodeDocument
  slideIndex: number
  /** A fixed output size; content is centered in it. Defaults to the slide's own size. */
  size?: { width: number; height: number }
  /** Draw the slide caption under the windows, as videos do. */
  caption?: boolean
  /** Milliseconds into the slide, for terminals and transitions. */
  time?: number
  editing?: SceneEditing
  /** The footer logo's URL, already resolved from its asset. */
  logoUrl?: string
  /** Replaces each pane's body, for transitions. */
  paneBody?: (pane: CodePane, index: number) => React.ReactNode | undefined
  /** Replaces the window height during a transition. */
  windowHeight?: number
  /** Drawn over the slide, as a crossfade's outgoing slide is. */
  overlay?: React.ReactNode
}

/**
 * One slide of a code project, drawn exactly as it exports. Its size is
 * arithmetic (see lib/code-studio/layout.ts), so the editor, PNG, carousel
 * pages and video frames match.
 */
export const CodeScene = React.forwardRef<HTMLDivElement, CodeSceneProps>(function CodeScene(
  { document, slideIndex, size, caption, time, editing, logoUrl, paneBody, windowHeight, overlay },
  ref
) {
  const style = document.style
  const slide = document.slides[slideIndex] ?? document.slides[0]!
  const theme = resolveCodeTheme(style)
  const anyTerminal =
    style.frame === 'terminal' || slide.panes.some((pane) => activeFile(pane).tape !== undefined)
  const palette = style.dark || anyTerminal ? theme.dark : theme.light
  const box = size ?? slideSize(document, slideIndex)
  const background = style.showBackground
    ? frameBackgroundStyle(
        true,
        resolveCodeBackground(style.background, theme, style.dark),
        style.dark
      )
    : {}
  return (
    <div
      ref={ref}
      data-code-scene
      style={{
        ...background,
        ...paletteVariables(palette),
        width: box.width,
        height: box.height,
        padding: style.padding,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        color: palette.foreground,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: PANE_GAP,
          alignItems: 'stretch',
          height: windowHeight,
          transition: windowHeight === undefined ? 'height 200ms' : undefined,
        }}
      >
        {slide.panes.map((pane, index) => (
          <PaneWindow
            key={pane.id}
            pane={pane}
            slide={slide}
            style={style}
            editing={editing}
            time={time}
            body={paneBody?.(pane, index)}
          />
        ))}
      </div>
      {style.footer.show ? <Footer style={style} logoUrl={logoUrl} /> : null}
      {caption && slide.caption ? (
        <div
          style={{
            height: CAPTION_HEIGHT,
            width: style.width,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            fontFamily: INTER,
            fontSize: 22,
            fontWeight: 600,
            textAlign: 'center',
            color: style.dark ? '#fff' : '#111',
            textShadow: style.dark ? '0 2px 12px rgba(0,0,0,0.45)' : undefined,
          }}
        >
          {slide.caption}
        </div>
      ) : null}
      {overlay ? <div style={{ position: 'absolute', inset: 0 }}>{overlay}</div> : null}
    </div>
  )
})

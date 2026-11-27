'use client'

import { useEffect, type CSSProperties } from 'react'
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import shellSession from 'react-syntax-highlighter/dist/esm/languages/prism/shell-session'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import dracula from 'react-syntax-highlighter/dist/esm/styles/prism/dracula'
import duotoneDark from 'react-syntax-highlighter/dist/esm/styles/prism/duotone-dark'
import github from 'react-syntax-highlighter/dist/esm/styles/prism/ghcolors'
import gruvboxDark from 'react-syntax-highlighter/dist/esm/styles/prism/gruvbox-dark'
import materialLight from 'react-syntax-highlighter/dist/esm/styles/prism/material-light'
import nightOwl from 'react-syntax-highlighter/dist/esm/styles/prism/night-owl'
import nord from 'react-syntax-highlighter/dist/esm/styles/prism/nord'
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light'
import synthwave84 from 'react-syntax-highlighter/dist/esm/styles/prism/synthwave84'
import vs from 'react-syntax-highlighter/dist/esm/styles/prism/vs'
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus'
import { CODE_LINE_HEIGHT, CODE_THEMES, codeMetrics, normalizeCode } from '@/lib/frames/code'
import { loadCodeFont } from '@/lib/frames/load-code-font'
import type { CodeContent, CodeLanguage, CodeTheme } from '@/lib/frames/schema'
import { googleFontCss } from '@/lib/typography/google-fonts'

/**
 * Code drawn as a screen: Prism highlighting (react-syntax-highlighter's
 * Prism build), line numbers, and the chosen theme and font, scaled so the
 * text fills the screen. Layout comes from the code itself
 * ({@link codeMetrics}), so the editor, previews, and exports all match.
 */

const GRAMMARS: Record<Exclude<CodeLanguage, 'text'>, unknown> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  docker,
  go,
  graphql,
  java,
  javascript,
  json,
  jsx,
  kotlin,
  markdown,
  markup,
  php,
  powershell,
  python,
  ruby,
  rust,
  'shell-session': shellSession,
  sql,
  swift,
  toml,
  tsx,
  typescript,
  yaml,
}
for (const [name, grammar] of Object.entries(GRAMMARS))
  SyntaxHighlighter.registerLanguage(name, grammar)

type PrismStyle = Record<string, CSSProperties>

const STYLES: Record<CodeTheme, PrismStyle> = {
  dracula,
  'duotone-dark': duotoneDark,
  github,
  'gruvbox-dark': gruvboxDark,
  'material-light': materialLight,
  'night-owl': nightOwl,
  nord,
  'one-dark': oneDark,
  'one-light': oneLight,
  synthwave84,
  vs,
  'vsc-dark-plus': vscDarkPlus,
}

/** The theme's text color, for plain text and line numbers. */
function themeTextColor(style: PrismStyle): string {
  const color = style['code[class*="language-"]']?.color ?? style['pre[class*="language-"]']?.color
  return typeof color === 'string' ? color : '#d4d4d4'
}

/** Code filling a `width` × `height` screen. */
export function CodeScreen({
  content,
  height,
  width,
}: {
  content: CodeContent
  height: number
  width: number
}) {
  useEffect(() => {
    void loadCodeFont(content)
  }, [content])

  const metrics = codeMetrics(content)
  // Fit the text block inside the screen, keeping its shape.
  const fontSize = Math.max(1, Math.min(width / metrics.widthEm, height / metrics.heightEm))
  const style = STYLES[content.theme]
  const text = themeTextColor(style)
  const { background } = CODE_THEMES[content.theme]
  const font = googleFontCss(content.font)
  const code = normalizeCode(content.code)

  return (
    <div
      data-code-screen={content.theme}
      style={{
        background,
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        width: '100%',
      }}
    >
      <SyntaxHighlighter
        codeTagProps={{
          style: {
            fontFamily: font,
            fontSize: 'inherit',
            lineHeight: 'inherit',
            textShadow: 'none',
          },
        }}
        customStyle={{
          background: 'transparent',
          border: 0,
          borderRadius: 0,
          boxSizing: 'border-box',
          color: text,
          fontFamily: font,
          fontSize,
          height: '100%',
          lineHeight: CODE_LINE_HEIGHT,
          margin: 0,
          overflow: 'hidden',
          padding: `${content.padding}em`,
          textShadow: 'none',
          whiteSpace: 'pre',
          width: '100%',
        }}
        language={content.language}
        lineNumberStyle={{
          boxSizing: 'border-box',
          color: text,
          display: 'inline-block',
          minWidth: `${metrics.gutterEm}em`,
          opacity: 0.4,
          paddingRight: `${metrics.gutterEm > 0 ? 1.2 : 0}em`,
          textAlign: 'right',
          userSelect: 'none',
        }}
        showLineNumbers={content.lineNumbers}
        style={style}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

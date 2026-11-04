import type { Icon } from '@phosphor-icons/react'
import { FileCIcon } from '@phosphor-icons/react/dist/ssr/FileC'
import { FileCodeIcon } from '@phosphor-icons/react/dist/ssr/FileCode'
import { FileCppIcon } from '@phosphor-icons/react/dist/ssr/FileCpp'
import { FileCSharpIcon } from '@phosphor-icons/react/dist/ssr/FileCSharp'
import { FileCssIcon } from '@phosphor-icons/react/dist/ssr/FileCss'
import { FileHtmlIcon } from '@phosphor-icons/react/dist/ssr/FileHtml'
import { FileIniIcon } from '@phosphor-icons/react/dist/ssr/FileIni'
import { FileJsIcon } from '@phosphor-icons/react/dist/ssr/FileJs'
import { FileJsxIcon } from '@phosphor-icons/react/dist/ssr/FileJsx'
import { FileMdIcon } from '@phosphor-icons/react/dist/ssr/FileMd'
import { FilePyIcon } from '@phosphor-icons/react/dist/ssr/FilePy'
import { FileRsIcon } from '@phosphor-icons/react/dist/ssr/FileRs'
import { FileSqlIcon } from '@phosphor-icons/react/dist/ssr/FileSql'
import { FileSvgIcon } from '@phosphor-icons/react/dist/ssr/FileSvg'
import { FileTextIcon } from '@phosphor-icons/react/dist/ssr/FileText'
import { FileTsIcon } from '@phosphor-icons/react/dist/ssr/FileTs'
import { FileTsxIcon } from '@phosphor-icons/react/dist/ssr/FileTsx'
import { FileVueIcon } from '@phosphor-icons/react/dist/ssr/FileVue'
import { TerminalWindowIcon } from '@phosphor-icons/react/dist/ssr/TerminalWindow'

const BY_LANGUAGE: Record<string, Icon> = {
  c: FileCIcon,
  cpp: FileCppIcon,
  csharp: FileCSharpIcon,
  css: FileCssIcon,
  scss: FileCssIcon,
  html: FileHtmlIcon,
  toml: FileIniIcon,
  yaml: FileIniIcon,
  javascript: FileJsIcon,
  jsx: FileJsxIcon,
  markdown: FileMdIcon,
  python: FilePyIcon,
  rust: FileRsIcon,
  sql: FileSqlIcon,
  xml: FileSvgIcon,
  text: FileTextIcon,
  typescript: FileTsIcon,
  tsx: FileTsxIcon,
  vue: FileVueIcon,
  bash: TerminalWindowIcon,
  shellsession: TerminalWindowIcon,
}

/** A file's icon in a window tab, by its language. */
export function FileIcon({ lang, size = 14 }: { name?: string; lang: string; size?: number }) {
  const Glyph = BY_LANGUAGE[lang] ?? FileCodeIcon
  return <Glyph size={size} aria-hidden style={{ flexShrink: 0 }} />
}

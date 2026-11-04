/**
 * Scripted terminal recordings (RFC 053). A script uses VHS's `.tape`
 * commands for typing and timing, plus one Shots command, `Print`, for the
 * output a command shows. Nothing runs: the author writes the output, so a
 * recording is safe, deterministic and re-renders the same every time.
 */

/** The prompt each command line starts with. */
export const TAPE_PROMPT = '$ '
/** Rows a terminal keeps; older rows scroll away. */
export const TAPE_ROWS = 40
const DEFAULT_TYPING_MS = 50

/** One timed change to the screen. */
export type TapeEvent =
  | { at: number; op: 'type'; text: string }
  | { at: number; op: 'enter' }
  | { at: number; op: 'backspace' }
  | { at: number; op: 'clear' }
  | { at: number; op: 'print'; text: string }
  | { at: number; op: 'interrupt' }

/** A compiled script: its events, length and anything it could not use. */
export type CompiledTape = { events: TapeEvent[]; duration: number; warnings: string[] }

/** Seconds by default, as VHS reads them; `ms` and `s` suffixes are explicit. */
export function parseDuration(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2] ?? 's'
  return Math.round(unit === 'ms' ? amount : unit === 'm' ? amount * 60_000 : amount * 1_000)
}

/** The text of a quoted argument, with \n and \t escapes. */
function quoted(rest: string): string | null {
  const match = /^(["'`])([\s\S]*)\1$/.exec(rest.trim())
  if (!match) return null
  return match[2]!
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\(["'`\\])/g, '$1')
}

const IGNORED = new Set(['Output', 'Require', 'Screenshot', 'Env'])
const UNSUPPORTED_SET = new Set([
  'Shell',
  'FontFamily',
  'LetterSpacing',
  'LineHeight',
  'Framerate',
  'PlaybackSpeed',
  'LoopOffset',
  'MarginFill',
  'Margin',
  'WindowBar',
  'WindowBarSize',
  'BorderRadius',
  'CursorBlink',
])

/** Compile a script into timed events. Unknown commands become warnings, never errors. */
export function compileTape(script: string): CompiledTape {
  const events: TapeEvent[] = []
  const warnings: string[] = []
  let at = 0
  let typing = DEFAULT_TYPING_MS
  let hidden = false
  const push = (event: TapeEvent) => events.push(event)
  const step = (ms: number) => {
    if (!hidden) at += ms
  }
  script.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const [head = '', ...restParts] = line.split(/\s+/)
    const rest = line.slice(head.length).trim()
    const [command, speed] = head.split('@')
    const count = Math.min(Math.max(Number.parseInt(restParts[0] ?? '1', 10) || 1, 1), 200)
    const where = `Line ${index + 1}`
    switch (command) {
      case 'Type': {
        const text = quoted(rest)
        if (text === null) {
          warnings.push(`${where}: Type needs quoted text.`)
          return
        }
        const each = speed ? (parseDuration(speed) ?? typing) : typing
        for (const character of text) {
          step(each)
          push({ at, op: 'type', text: character })
        }
        return
      }
      case 'Print': {
        const text = quoted(rest)
        if (text === null) warnings.push(`${where}: Print needs quoted text.`)
        else push({ at, op: 'print', text })
        return
      }
      case 'Enter':
        for (let i = 0; i < count; i++) {
          step(typing)
          push({ at, op: 'enter' })
        }
        return
      case 'Backspace':
        for (let i = 0; i < count; i++) {
          step(typing)
          push({ at, op: 'backspace' })
        }
        return
      case 'Space':
      case 'Tab':
        for (let i = 0; i < count; i++) {
          step(typing)
          push({ at, op: 'type', text: command === 'Space' ? ' ' : '  ' })
        }
        return
      case 'Ctrl+L':
        push({ at, op: 'clear' })
        return
      case 'Ctrl+C':
        push({ at, op: 'interrupt' })
        return
      case 'Sleep': {
        const ms = parseDuration(rest)
        if (ms === null) warnings.push(`${where}: Sleep needs a time such as 500ms or 2s.`)
        else step(Math.min(ms, 60_000))
        return
      }
      case 'Hide':
        hidden = true
        return
      case 'Show':
        hidden = false
        return
      case 'Set': {
        const [setting = '', value = ''] = [restParts[0], restParts.slice(1).join(' ')]
        if (setting === 'TypingSpeed') {
          const ms = parseDuration(value)
          if (ms === null) warnings.push(`${where}: TypingSpeed needs a time such as 50ms.`)
          else typing = Math.min(Math.max(ms, 1), 2_000)
        } else if (!['FontSize', 'Width', 'Height', 'Padding', 'Theme'].includes(setting)) {
          if (!UNSUPPORTED_SET.has(setting))
            warnings.push(`${where}: Set ${setting} is not supported.`)
        }
        return
      }
      default:
        if (IGNORED.has(command ?? '')) return
        warnings.push(`${where}: ${command} is not supported; nothing is run.`)
    }
  })
  return { events, duration: at, warnings }
}

/** Apply events to a screen of rows. */
function applyEvents(events: TapeEvent[]): string[] {
  let rows = [TAPE_PROMPT]
  // Output replaces the bare prompt Enter left, then a fresh prompt follows it.
  for (const event of events) {
    const last = rows.length - 1
    switch (event.op) {
      case 'type':
        rows[last] += event.text
        break
      case 'backspace':
        if (rows[last]!.length > TAPE_PROMPT.length || !rows[last]!.startsWith(TAPE_PROMPT))
          rows[last] = rows[last]!.slice(0, -1)
        break
      case 'enter':
        rows.push(TAPE_PROMPT)
        break
      case 'interrupt':
        rows[last] += '^C'
        rows.push(TAPE_PROMPT)
        break
      case 'clear':
        rows = [TAPE_PROMPT]
        break
      case 'print': {
        const output = event.text.split('\n')
        if (rows[last] === TAPE_PROMPT) rows.splice(last, 1, ...output, TAPE_PROMPT)
        else rows.push(...output, TAPE_PROMPT)
        break
      }
    }
  }
  return rows.slice(-TAPE_ROWS)
}

/** The screen at a time, in milliseconds from the start. */
export function screenAt(script: string, time: number): string[] {
  const { events } = compileTape(script)
  return applyEvents(events.filter((event) => event.at <= time))
}

/** The final screen, which a still image shows. */
export function screenLines(script: string): string[] {
  return applyEvents(compileTape(script).events)
}

/** A starter script for a new terminal. */
export const EXAMPLE_TAPE = `# Typed commands follow VHS; Print shows the output you choose.
Set TypingSpeed 60ms
Type "npm create shots@latest"
Sleep 300ms
Enter
Print "✔ Project created in ./shots-demo\\n✔ Dependencies installed"
Sleep 1s
Type "npm run dev"
Enter
Print "  ▲ Ready on http://localhost:3000"
Sleep 2s`

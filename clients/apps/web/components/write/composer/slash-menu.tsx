'use client'

import * as React from 'react'
import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { SlashKit } from '@shots/platejs-editor/plugins'
import { PlateElement, type PlateElementProps } from '@shots/platejs-editor/platejs/react'
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from '@shots/platejs-editor/ui'
import { useKeys } from '../shortcuts'
import { useRefine } from './refine'
import {
  type Command,
  type CommandGroup,
  ComposerCommandsContext,
  commandsFor,
  rankCommands,
  recentCommands,
  rememberCommand,
} from './commands'

const GROUPS: readonly CommandGroup[] = ['AI', 'Post', 'Insert', 'Snippets']

/** A command's row: icon, label and hint, how it publishes, and its keys. */
export function CommandRow({ command }: { command: Command }) {
  const keys = useKeys()
  const Icon = command.icon
  return (
    <>
      <Icon aria-hidden className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{command.label}</span>
        {command.hint ? (
          <span className="block truncate text-caption text-muted-foreground">{command.hint}</span>
        ) : null}
      </span>
      {command.badge ? (
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-label text-muted-foreground">
          {command.badge}
        </span>
      ) : null}
      {command.shortcut ? (
        <kbd className="shrink-0 rounded-sm border border-border px-1 font-sans text-label text-muted-foreground">
          {keys.label(command.shortcut)}
        </kbd>
      ) : null}
    </>
  )
}

/**
 * The slash menu: "/" at the start of a line or after a space opens Write's
 * commands for the platform being edited. Typing filters; Enter or Tab runs
 * the highlighted row; Escape leaves "/query" as text; Backspace on an empty
 * query removes the "/"; a space right after "/" types a plain slash.
 */
function SlashMenu(props: PlateElementProps) {
  const { editor, element } = props
  const composer = React.useContext(ComposerCommandsContext)
  const ai = useRefine()
  const [query, setQuery] = React.useState('')
  const [recent] = React.useState(recentCommands)
  const commands = composer ? commandsFor({ ...composer, ai, editor }) : []
  const typed = query.trim()
  const ranked = rankCommands(commands, typed, recent)
  const run = (command: Command) => {
    rememberCommand(command.id)
    command.run()
  }
  const rows = (items: Command[], prefix: string) =>
    items.map((command) => (
      <InlineComboboxItem
        className="gap-2.5 py-1.5 [&_svg]:size-5"
        key={`${prefix}-${command.id}`}
        onClick={() => run(command)}
        value={command.id}
      >
        <CommandRow command={command} />
      </InlineComboboxItem>
    ))
  // With nothing typed, the ranking starts with the recent commands still on offer.
  const recentCount = typed
    ? 0
    : recent.slice(0, 5).filter((id) => commands.some((command) => command.id === id)).length
  const recentRows = ranked.slice(0, recentCount)
  return (
    <PlateElement {...props} as="span" className="rounded-sm bg-accent px-0.5 text-accent-foreground">
      <InlineCombobox
        closeOnSpace="empty"
        element={element}
        filter={false}
        setValue={setQuery}
        trigger="/"
        value={query}
      >
        <InlineComboboxInput aria-label="Command" />
        <InlineComboboxContent aria-label="Commands" variant="slash">
          {typed ? (
            ranked.length ? (
              rows(ranked, 'match')
            ) : ai ? (
              <InlineComboboxItem
                className="gap-2.5 py-1.5 [&_svg]:size-5"
                onClick={() => ai.run({ action: 'custom', prompt: typed, scope: 'post' })}
                value="ai-query"
              >
                <SparkleIcon aria-hidden className="shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate">Ask AI: {typed}</span>
              </InlineComboboxItem>
            ) : (
              <InlineComboboxEmpty>No commands match “{typed}”</InlineComboboxEmpty>
            )
          ) : (
            <>
              {recentRows.length ? (
                <InlineComboboxGroup>
                  <InlineComboboxGroupLabel>Recent</InlineComboboxGroupLabel>
                  {rows(recentRows, 'recent')}
                </InlineComboboxGroup>
              ) : null}
              {GROUPS.map((group) => {
                const items = ranked.slice(recentCount).filter((command) => command.group === group)
                return items.length ? (
                  <InlineComboboxGroup key={group}>
                    <InlineComboboxGroupLabel>{group}</InlineComboboxGroupLabel>
                    {rows(items, group)}
                  </InlineComboboxGroup>
                ) : null
              })}
            </>
          )}
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  )
}

/** Replaces the kit's document slash menu in Write's editor. */
export const SlashMenuPlugin = SlashKit[1].withComponent(SlashMenu)

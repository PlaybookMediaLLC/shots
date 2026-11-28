#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { spawn } from 'node:child_process'
import { parseCommand, selectLines, USAGE } from '../lib/args.js'
import { ShotsClient } from '../lib/client.js'
import { DEFAULT_ORIGIN, resolveCredentials, saveConfig } from '../lib/config.js'

const CODE_LIMIT = 100_000

async function main() {
  const parsed = parseCommand(process.argv.slice(2))
  if (parsed.command === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  if (parsed.command === 'setup') {
    const origin = parsed.options.origin || process.env.SHOTS_ORIGIN?.trim() || DEFAULT_ORIGIN
    const client = new ShotsClient(origin, parsed.options.key)
    const info = await client.whoami()
    await saveConfig({ apiKey: parsed.options.key, origin: client.origin })
    if (parsed.options.json) {
      process.stdout.write(`${JSON.stringify({ configured: true, ...info }, null, 2)}\n`)
      return
    }
    process.stdout.write(
      `Connected to ${info.workspace.name} (${info.workspace.slug}) at ${client.origin}.\n` +
        `Scopes: ${(info.key.scopes ?? []).join(', ') || 'none'}\n`
    )
    return
  }

  const credentials = await resolveCredentials()
  const client = new ShotsClient(credentials.origin, credentials.apiKey)

  switch (parsed.command) {
    case 'whoami': {
      const info = await client.whoami()
      if (parsed.options.json) {
        process.stdout.write(`${JSON.stringify(info, null, 2)}\n`)
      } else {
        process.stdout.write(
          `Workspace: ${info.workspace.name} (${info.workspace.slug})\n` +
            `Key: ${info.key.name ?? info.key.start ?? info.key.id}\n` +
            `Scopes: ${(info.key.scopes ?? []).join(', ') || 'none'}\n`
        )
      }
      return
    }
    case 'accounts:list': {
      const result = await client.listSocialSets()
      if (parsed.options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        return
      }
      const sets = result.items ?? []
      for (const set of sets) {
        process.stdout.write(`${set.name} (${set.id})\n`)
        for (const account of set.accounts ?? []) {
          process.stdout.write(
            `  - ${account.id}  ${account.platform}  ${account.handle ?? account.displayName ?? ''}\n`
          )
        }
      }
      return
    }
    case 'posts:list': {
      const result = await client.listScheduledPosts()
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    case 'posts:create': {
      const idempotencyKey = parsed.options.idempotencyKey || `cli_${randomUUID()}`
      const payload = {
        channelConnectionIds: parsed.options.accounts,
        posts: parsed.options.texts.map((text) => ({ text })),
        ...(parsed.options.publishNow ? { publishNow: true } : {}),
        ...(parsed.options.scheduledFor ? { scheduledFor: parsed.options.scheduledFor } : {}),
        ...(parsed.options.queue ? { queue: true } : {}),
      }
      const result = await client.createPost(payload, idempotencyKey)
      process.stdout.write(`${JSON.stringify({ idempotencyKey, ...result }, null, 2)}\n`)
      return
    }
    case 'drafts:list': {
      const result = await client.listDrafts()
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    case 'releases:list': {
      const result = await client.listReleases()
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    case 'code': {
      const options = parsed.options
      const code = selectLines(await readFile(options.file, 'utf8'), options.lines)
      if (code.length > CODE_LIMIT || code.includes('\u0000'))
        throw new Error('Choose a text file or line range under 100,000 characters.')
      const name = basename(options.file)
      const project = await client.createCodeProject({
        files: [{ name, code }],
        name: options.name ?? (options.lines ? `${name}:${options.lines[0]}-${options.lines[1]}` : name),
        ...(options.theme ? { theme: options.theme } : {}),
        ...(options.aspect ? { aspect: options.aspect } : {}),
        dark: options.dark,
      })
      process.stdout.write(`${project.url}\n`)
      if (options.png) {
        await writeFile(options.png, await client.renderPng(project.id, { scale: options.scale }))
        process.stdout.write(`Saved ${options.png}\n`)
      }
      if (options.open) {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
        spawn(opener, [project.url], { detached: true, stdio: 'ignore' }).unref()
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs, selectLines, USAGE } from '../lib/args.js'
import { ShotsClient } from '../lib/client.js'

const CODE_LIMIT = 100_000

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const options = parseArgs(argv)
  const code = selectLines(await readFile(options.file, 'utf8'), options.lines)
  if (code.length > CODE_LIMIT || code.includes('\u0000'))
    throw new Error('Choose a text file or line range under 100,000 characters.')
  const client = new ShotsClient(process.env.SHOTS_ORIGIN ?? 'https://shots.playbookmedia.io', process.env.SHOTS_API_KEY ?? '')
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

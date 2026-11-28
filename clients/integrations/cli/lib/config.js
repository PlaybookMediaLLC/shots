import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_ORIGIN = 'https://shots.playbookmedia.io'

/**
 * Canonical user config file path (`$XDG_CONFIG_HOME/shots/config.json` or
 * `~/.config/shots/config.json`).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function defaultConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(base, 'shots', 'config.json')
}

/**
 * Load stored CLI credentials if present.
 * @param {string} [configPath]
 * @returns {Promise<{ apiKey?: string, origin?: string }>}
 */
export async function loadConfig(configPath = defaultConfigPath()) {
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return {
      ...(typeof parsed.apiKey === 'string' && parsed.apiKey.trim()
        ? { apiKey: parsed.apiKey.trim() }
        : {}),
      ...(typeof parsed.origin === 'string' && parsed.origin.trim()
        ? { origin: parsed.origin.trim() }
        : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Persist CLI credentials atomically with owner-only permissions (`0600` file, `0700` dir).
 * @param {{ apiKey: string, origin: string }} config
 * @param {string} [configPath]
 */
export async function saveConfig(config, configPath = defaultConfigPath()) {
  const dir = dirname(configPath)
  await mkdir(dir, { mode: 0o700, recursive: true })
  const payload = JSON.stringify(
    {
      apiKey: config.apiKey.trim(),
      origin: config.origin.trim(),
    },
    null,
    2
  )
  const tempPath = join(dir, `.config-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(tempPath, `${payload}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await chmod(tempPath, 0o600).catch(() => {})
    await rename(tempPath, configPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

/**
 * Resolve effective origin and API key. Environment variables always override
 * stored config so CI and cron jobs work cleanly.
 * @param {{ configPath?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export async function resolveCredentials(options = {}) {
  const env = options.env ?? process.env
  const stored = await loadConfig(options.configPath ?? defaultConfigPath(env))
  return {
    apiKey: env.SHOTS_API_KEY?.trim() || stored.apiKey || '',
    origin: env.SHOTS_ORIGIN?.trim() || stored.origin || DEFAULT_ORIGIN,
  }
}

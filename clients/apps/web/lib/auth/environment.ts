import { z } from 'zod'

const authEnvironmentSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_API_KEY: z.string().min(1).optional(),
  BETTER_AUTH_API_URL: z.string().url().optional(),
  BETTER_AUTH_KV_URL: z.string().url().optional(),
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
  PLATFORM_AUTH_LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
  PLATFORM_AUTH_LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
  PLATFORM_AUTH_TWITTER_CLIENT_ID: z.string().min(1).optional(),
  PLATFORM_AUTH_TWITTER_CLIENT_SECRET: z.string().min(1).optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
})

const developmentSecret = 'development-only-better-auth-secret-change-before-production'

export type SocialProviderCredentials = {
  clientId: string
  clientSecret: string
}

export function getAuthEnvironment() {
  return authEnvironmentSchema.parse({
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_API_KEY: process.env.BETTER_AUTH_API_KEY,
    BETTER_AUTH_API_URL: process.env.BETTER_AUTH_API_URL,
    BETTER_AUTH_KV_URL: process.env.BETTER_AUTH_KV_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
    PLATFORM_AUTH_LINKEDIN_CLIENT_ID: process.env.PLATFORM_AUTH_LINKEDIN_CLIENT_ID,
    PLATFORM_AUTH_LINKEDIN_CLIENT_SECRET: process.env.PLATFORM_AUTH_LINKEDIN_CLIENT_SECRET,
    PLATFORM_AUTH_TWITTER_CLIENT_ID: process.env.PLATFORM_AUTH_TWITTER_CLIENT_ID,
    PLATFORM_AUTH_TWITTER_CLIENT_SECRET: process.env.PLATFORM_AUTH_TWITTER_CLIENT_SECRET,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  })
}

export function getAuthBaseUrl(): string {
  const environment = getAuthEnvironment()
  return environment.BETTER_AUTH_URL ?? environment.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
}

export function getAuthSecret(): string {
  return getAuthEnvironment().BETTER_AUTH_SECRET ?? developmentSecret
}

export function getFounderHubMcpUrl(): string | undefined {
  const configured = process.env.FOUNDER_HUB_MCP_URL
  if (!configured) return undefined
  const url = new URL(configured)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/mcp'
  ) {
    throw new Error(
      'FOUNDER_HUB_MCP_URL must be an HTTPS /mcp URL, or loopback HTTP for development.'
    )
  }
  return url.toString()
}

export function getTrustedOrigins(): string[] {
  const configuredOrigins = getAuthEnvironment().BETTER_AUTH_TRUSTED_ORIGINS
  return (
    configuredOrigins
      ?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [getAuthBaseUrl()]
  )
}

export function getSocialProviderCredentials(
  provider: 'GITHUB' | 'GOOGLE' | 'MICROSOFT' | 'LINKEDIN' | 'TWITTER'
): SocialProviderCredentials | undefined {
  const environment = getAuthEnvironment()
  const prefix =
    provider === 'LINKEDIN' || provider === 'TWITTER'
      ? (`PLATFORM_AUTH_${provider}` as const)
      : provider
  const clientId = environment[`${prefix}_CLIENT_ID`]
  const clientSecret = environment[`${prefix}_CLIENT_SECRET`]
  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

export function assertAuthEnvironment(): void {
  if (process.env.NODE_ENV === 'production' && !getAuthEnvironment().BETTER_AUTH_SECRET) {
    throw new Error('BETTER_AUTH_SECRET is required in production.')
  }
}

export function getBetterAuthInfrastructure() {
  const environment = getAuthEnvironment()
  if (!environment.BETTER_AUTH_API_KEY) {
    return undefined
  }

  return {
    apiKey: environment.BETTER_AUTH_API_KEY,
    apiUrl: environment.BETTER_AUTH_API_URL,
    kvUrl: environment.BETTER_AUTH_KV_URL,
  }
}

import { apiKey } from '@better-auth/api-key'
import { dash } from '@better-auth/infra'
import { scim } from '@better-auth/scim'
import { sso } from '@better-auth/sso'
import { betterAuth } from 'better-auth'
import { admin, twoFactor } from 'better-auth/plugins'
import { workspaceOrganizationPlugin } from './workspace-organization-plugin'
import { backendAuthAdapter } from './backend-adapter'
import {
  getAuthBaseUrl,
  getAuthSecret,
  getBetterAuthInfrastructure,
  getSocialProviderCredentials,
  getTrustedOrigins,
} from './environment'
import {
  sendChangeEmailConfirmation,
  sendInvitationEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from './transactional-email'
import { assertSignInMethodAvailable, isPasswordAuthEnabled } from './methods'
import { organizationHooks } from './organization-hooks'
import { betterAuthOrganizationRoles } from './permissions'
import { testHooksAllowed } from '@/lib/e2e-hooks'

const google = getSocialProviderCredentials('GOOGLE')
const github = getSocialProviderCredentials('GITHUB')
const microsoft = getSocialProviderCredentials('MICROSOFT')
const linkedin = getSocialProviderCredentials('LINKEDIN')
const twitter = getSocialProviderCredentials('TWITTER')
const infrastructure = getBetterAuthInfrastructure()
const requireEmailVerification =
  process.env.NODE_ENV === 'production' && process.env.AUTH_REQUIRE_EMAIL_VERIFICATION !== 'false'
const passwordAuthEnabled = isPasswordAuthEnabled()

assertSignInMethodAvailable()

const socialProviders = {
  ...(google ? { google } : {}),
  ...(github ? { github } : {}),
  ...(microsoft ? { microsoft } : {}),
  ...(linkedin ? { linkedin } : {}),
  ...(twitter
    ? {
        twitter: {
          ...twitter,
          mapProfileToUser: (profile: { data: { email?: string } }) => {
            // The upstream provider falls back to a username if email access is absent.
            // A username is not a sign-in address and must never enter account linking.
            if (!profile.data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.data.email))
              throw new Error(
                'X did not provide a confirmed email address. Use another sign-in method.'
              )
            return { email: profile.data.email }
          },
        },
      }
    : {}),
}

export const auth = betterAuth({
  baseURL: getAuthBaseUrl(),
  database: backendAuthAdapter,
  emailAndPassword: {
    autoSignIn: process.env.NODE_ENV !== 'production',
    enabled: passwordAuthEnabled,
    minPasswordLength: 12,
    requireEmailVerification,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ url, user }) =>
      sendPasswordResetEmail({ actionUrl: url, to: user.email }),
  },
  emailVerification: {
    sendOnSignIn: true,
    sendVerificationEmail: async ({ url, user }) =>
      sendVerificationEmail({ actionUrl: url, to: user.email }),
  },
  plugins: [
    admin({ adminRoles: [], defaultRole: 'user' }),
    workspaceOrganizationPlugin({
      disableOrganizationDeletion: true,
      invitationExpiresIn: 7 * 24 * 60 * 60,
      organizationHooks,
      requireEmailVerificationOnInvitation: requireEmailVerification,
      roles: betterAuthOrganizationRoles,
      sendInvitationEmail: async ({ invitation, organization, inviter }) => {
        const invitationUrl = new URL('/accept-invitation', getAuthBaseUrl())
        invitationUrl.searchParams.set('invitationId', invitation.id)
        // The invitation row already exists by this point, and it can be
        // accepted from the members screen without the email. Letting a
        // mail failure propagate would fail the whole invite request and
        // leave an invitation the caller believes was never created.
        try {
          await sendInvitationEmail({
            acceptUrl: invitationUrl.toString(),
            inviterName: inviter.user.name || inviter.user.email,
            organizationName: organization.name,
            to: invitation.email,
          })
        } catch (error) {
          console.error('Invitation email delivery failed.', {
            invitationId: invitation.id,
            organizationId: organization.id,
            reason: error instanceof Error ? error.message : 'unknown',
          })
        }
      },
    }),
    apiKey({
      defaultPrefix: 'ss_',
      enableSessionForAPIKeys: false,
      permissions: {
        defaultPermissions: {
          artifact: ['read'],
          asset: ['write'],
          release: ['create'],
          source: ['write'],
          upload: ['sign'],
        },
      },
      rateLimit: { enabled: true, maxRequests: 60, timeWindow: 60_000 },
      references: 'organization',
    }),
    twoFactor({
      accountLockout: { durationSeconds: 900, maxFailedAttempts: 10 },
      issuer: 'Shots',
      trustDeviceMaxAge: 30 * 24 * 60 * 60,
    }),
    sso({
      domainVerification: { enabled: true },
      organizationProvisioning: { defaultRole: 'member' },
      providersLimit: 3,
    }),
    scim({
      canGenerateToken: ({ organizationId }) => Boolean(organizationId),
      linkExistingUsers: { requireExistingOrgMembership: true },
      providerOwnership: { enabled: true },
      requiredRole: ['owner'],
      storeSCIMToken: 'hashed',
    }),
    ...(infrastructure ? [dash(infrastructure)] : []),
  ],
  // Better Auth rate limits /sign-in, /sign-up and the password and email
  // change routes to 3 requests per 10 seconds per client address, and that
  // limit is what kept the two-factor and invitation flows — which sign in
  // several times in a few seconds on purpose — off the production build.
  // Every browser test already carries its own x-forwarded-for, the header
  // the limiter keys on, so raising the ceiling for an end-to-end stack
  // isolates nothing less than before. Deployed builds keep the default.
  ...(testHooksAllowed()
    ? {
        rateLimit: {
          customRules: {
            '/sign-in/*': { window: 10, max: 100 },
            '/sign-up/*': { window: 10, max: 100 },
            '/change-password': { window: 10, max: 100 },
            '/change-email': { window: 10, max: 100 },
            '/two-factor/*': { window: 10, max: 100 },
          },
        },
      }
    : {}),
  secret: getAuthSecret(),
  // A database-backed session must be checked on every request so a removed
  // member cannot keep using a signed cookie cache until it expires.
  session: { cookieCache: { enabled: false }, freshAge: 15 * 60 },
  socialProviders,
  trustedOrigins: getTrustedOrigins(),
  // Changing the sign-in email (RFC 024): a verified address confirms the
  // change first, then the new address is verified before it takes effect.
  user: {
    changeEmail: {
      enabled: true,
      sendChangeEmailConfirmation: async ({ url, user }) =>
        sendChangeEmailConfirmation({ actionUrl: url, to: user.email }),
    },
  },
})

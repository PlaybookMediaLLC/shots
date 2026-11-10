import { apiKey } from '@better-auth/api-key'
import { dash } from '@better-auth/infra'
import { oauthProvider } from '@better-auth/oauth-provider'
import { scim } from '@better-auth/scim'
import { sso } from '@better-auth/sso'
import { betterAuth } from 'better-auth'
import { admin, jwt, twoFactor } from 'better-auth/plugins'
import { workspaceOrganizationPlugin } from './workspace-organization-plugin'
import { backendAuthAdapter } from './backend-adapter'
import { refreshOAuthToken } from './oauth-refresh'
import {
  getAuthBaseUrl,
  getAuthSecret,
  getFounderHubMcpUrl,
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
import { serviceBackend } from '@/lib/backend/sdk'

const google = getSocialProviderCredentials('GOOGLE')
const github = getSocialProviderCredentials('GITHUB')
const microsoft = getSocialProviderCredentials('MICROSOFT')
const linkedin = getSocialProviderCredentials('LINKEDIN')
const twitter = getSocialProviderCredentials('TWITTER')
const infrastructure = getBetterAuthInfrastructure()
const founderHubAudience = new URL('/api/founder-hub', getAuthBaseUrl()).toString()
const founderHubMcp = getFounderHubMcpUrl()
const connectorScopes = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'founder-hub:meetings:read',
]
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

const provider = betterAuth({
  baseURL: getAuthBaseUrl(),
  database: backendAuthAdapter,
  disabledPaths: ['/token'],
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
    jwt({
      jwks: { keyPairConfig: { alg: 'ES256' } },
      jwt: {
        issuer: new URL('/api/auth', getAuthBaseUrl()).toString(),
        audience: founderHubMcp ? [founderHubAudience, founderHubMcp] : founderHubAudience,
      },
    }),
    oauthProvider({
      loginPage: '/sign-in',
      consentPage: '/founder-hub/consent',
      allowPublicClientPrelogin: true,
      signup: { page: '/sign-up' },
      scopes: [
        'openid',
        'profile',
        'email',
        'offline_access',
        'founder-hub',
        'founder-hub:meetings:read',
      ],
      grantTypes: ['authorization_code', 'refresh_token'],
      validAudiences: founderHubMcp ? [founderHubAudience, founderHubMcp] : [founderHubAudience],
      accessTokenExpiresIn: 300,
      codeExpiresIn: 600,
      allowDynamicClientRegistration: !!founderHubMcp,
      allowUnauthenticatedClientRegistration: !!founderHubMcp,
      clientRegistrationDefaultScopes: connectorScopes,
      clientRegistrationAllowedScopes: connectorScopes,
      clientPrivileges: async () => false,
      customAccessTokenClaims: async ({ user }) => {
        if (!user) throw new Error('Founder Hub requires a user.')
        const profile = await serviceBackend().getFounderHubProfile(user.id)
        const paid = profile.workspaces.some(
          (workspace) =>
            workspace.features['workspace:paid'] &&
            !workspace.deniedPermissions.includes('workspace:read')
        )
        return {
          account_user_id: profile.accountUserId,
          email: profile.user.email,
          entitlements: paid ? ['hyprnote_pro'] : [],
          subscription_status: paid ? 'active' : null,
        }
      },
    }),
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

export const auth = {
  ...provider,
  handler: (request: Request) => refreshOAuthToken(request, provider.handler),
}

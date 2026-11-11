import path from 'node:path'
import publicImages from './lib/assets/public-images.json'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

type Redirect = Awaited<ReturnType<NonNullable<NextConfig['redirects']>>>[number]

/** Pages that moved to their section's address; bookmarks and sent links keep working. */
const NAVIGATION_MOVES: Pick<Redirect, 'source' | 'destination' | 'has'>[] = [
  {
    source: '/write/settings',
    has: [{ type: 'query', key: 'set', value: '(?<set>[\\w-]+)' }],
    destination: '/settings/publishing-brands/:set/scheduling',
  },
  { source: '/write/settings', destination: '/settings/publishing-brands' },
  { source: '/write/plan', destination: '/publish/calendar' },
  { source: '/write/deliveries', destination: '/campaigns/deliveries' },
  { source: '/write/:path*', destination: '/publish/:path*' },
  { source: '/link-preview', destination: '/publish/link-checks' },
  { source: '/workspace/social-sets/:path*', destination: '/settings/publishing-brands/:path*' },
  { source: '/workspace/:path*', destination: '/settings/:path*' },
  {
    source: '/library',
    has: [{ type: 'query', key: 'view', value: 'templates' }],
    destination: '/create',
  },
  { source: '/projects', destination: '/library' },
  { source: '/assets', destination: '/library?view=assets' },
]

const nextConfig: NextConfig = {
  distDir: process.env.PLATFORM_NEXT_DIST_DIR || '.next',
  typescript: { tsconfigPath: process.env.PLATFORM_NEXT_TSCONFIG_PATH || 'tsconfig.json' },
  output: 'standalone',
  // The repository root, so the web can import the media limits the Go
  // backend embeds (server/internal/medialimits/limits.json).
  outputFileTracingRoot: path.join(process.cwd(), '../../..'),
  reactCompiler: true,
  // The vendored editor ships TypeScript source (packages/platejs-editor).
  transpilePackages: ['@shots/platejs-editor'],
  poweredByHeader: false,
  allowedDevOrigins: process.env.PLATFORM_ALLOWED_DEV_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  images: {
    remotePatterns: [
      {
        // R2 custom domain (new)
        protocol: 'https',
        hostname: 'assets.screenshot-studio.com',
      },
    ],
  },

  // Enable SharedArrayBuffer for multi-threaded FFmpeg WASM
  // Requires Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy
  // Only applied to editor routes — applying globally breaks YouTube embeds on landing page
  async headers() {
    return [
      {
        source: '/r2-assets/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
      // Security and SEO headers for all pages
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          ...(process.env.NODE_ENV === 'production'
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }]
            : []),
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
          },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      // Share embeds exist to be framed by other sites (blogs, docs). The
      // catch-all above forbids framing, so these routes override it.
      ...['/s/:token/embed', '/:locale/s/:token/embed'].map((source) => ({
        source,
        headers: [
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors *; object-src 'none'; base-uri 'self'",
          },
        ],
      })),
      // /home and /editor stay out of cross-origin isolation: it blocks the
      // non-isolated /render frame that draws their exports and previews.
      // Cross-origin isolation lets the background remover run ONNX WASM
      // multi-threaded. credentialless still allows the Hugging Face model fetch.
      {
        source: '/:locale(es|fr|de|ja|pt|ko|zh)?/remove-background',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
      // Same isolation as the editor, so the video compressor gets the
      // multi-threaded FFmpeg core instead of the much slower single thread.
      {
        source: '/:locale(es|fr|de|ja|pt|ko|zh)?/compress-video',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
      // An isolated page also requires compatible headers on its module worker.
      // The unbundled FFmpeg worker (see lib/export/ffmpeg-encoder.ts) is a
      // module worker too, so it needs the same header.
      {
        source: '/ffmpeg/:path*',
        headers: [{ key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' }],
      },
      {
        source: '/_next/static/:path*',
        headers: [{ key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' }],
      },
    ]
  },

  // Permanent redirects for SEO (301)
  async redirects() {
    return [
      ...(process.env.NEXT_PUBLIC_R2_PUBLIC_URL
        ? Object.entries(publicImages).map(([source, key]) => ({
            source: source.replace(/[():*+?]/g, '\\$&'),
            destination: `/r2-assets/${key.split('/').map(encodeURIComponent).join('/')}`,
            permanent: false,
          }))
        : []),
      ...NAVIGATION_MOVES.flatMap((move) => [
        { ...move, permanent: true },
        {
          ...move,
          source: `/:locale(es|fr|de|ja|pt|ko|zh)${move.source}`,
          destination: `/:locale${move.destination}`,
          permanent: true,
        },
      ]),
      {
        source: '/features/background-remover',
        destination: '/remove-background',
        permanent: true,
      },
      // Preserve old query-bearing editor links; plain /home now resumes platform work.
      ...['project', 'editor', 'storeProject'].map((key) => ({
        source: '/home',
        has: [{ type: 'query' as const, key }],
        destination: '/',
        permanent: true,
      })),
      {
        source: '/free-screenshot-editor',
        destination: '/features/screenshot-beautifier',
        permanent: true,
      },
      {
        source: '/:locale(es|fr|de|ja|pt|ko|zh)/free-screenshot-editor',
        destination: '/:locale/features/screenshot-beautifier',
        permanent: true,
      },
      {
        source: '/free-screenshot-editor-online',
        destination: '/features/screenshot-beautifier',
        permanent: true,
      },
      {
        source: '/free-screenshot-studio/:path*',
        destination: '/features/screenshot-beautifier',
        permanent: true,
      },
      {
        source: '/blog/:slug*',
        destination: '/guides/:slug*',
        permanent: true,
      },
    ]
  },

  // Proxy R2 assets through same origin to avoid CORS issues
  // (especially critical for canvas capture during video export)
  // Also proxy PostHog through same origin to bypass ad blockers
  async rewrites() {
    const r2Url = process.env.NEXT_PUBLIC_R2_PUBLIC_URL
    return [
      // LLMs.txt — serve markdown to AI agents
      {
        source: '/llms.txt',
        destination: '/api/llms',
      },
      {
        source: '/llms-full.txt',
        destination: '/api/llms-full',
      },
      {
        source: '/openapi.json',
        destination: '/api/openapi',
      },
      {
        source: '/.well-known/openapi.json',
        destination: '/api/openapi',
      },
      // PostHog reverse proxy — static assets must come first
      {
        source: '/svc/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/svc/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
      // R2 asset proxy
      ...(r2Url
        ? [
            {
              source: '/r2-assets/:path*',
              destination: `${r2Url}/:path*`,
            },
          ]
        : []),
    ]
  },

  // REQUIRED for react-konva
  webpack: (config, { isServer }) => {
    config.externals = [...(config.externals || []), { canvas: 'canvas' }]
    // WebRTC co-editing is off (RFC 013); keep y-webrtc and its public
    // signaling defaults out of the bundle.
    config.resolve.alias = {
      ...config.resolve.alias,
      'y-webrtc$': path.join(process.cwd(), 'lib/collab/y-webrtc-disabled.ts'),
    }
    if (!isServer) {
      // The background-removal client must not bundle Node-only inference backends.
      config.resolve.alias = {
        ...config.resolve.alias,
        sharp$: false,
        'onnxruntime-node$': false,
      }
    }
    return config
  },
}

export default withNextIntl(nextConfig)

import type { Metadata } from 'next'
import { CodeEmbed } from '@/components/code-studio/CodeEmbed'
import { shareView } from '@/lib/sharing/page'

type EmbedPageProps = { params: Promise<{ token: string }> }

export const metadata: Metadata = { robots: { follow: false, index: false } }

/** A published design alone, for iframes: no title, no chrome. */
export default async function ShareEmbedPage({ params }: EmbedPageProps) {
  const { token } = await params
  const view = await shareView(token)
  if (view.kind !== 'visible') {
    return (
      <main className="grid min-h-dvh place-items-center bg-neutral-950 p-4 text-center text-sm text-neutral-400">
        {view.kind === 'gone'
          ? 'This shared design is not available.'
          : 'This design is shared with a workspace only.'}
      </main>
    )
  }
  const { link } = view
  if (link.code)
    return (
      <main className="grid min-h-dvh place-items-center overflow-auto bg-transparent">
        <CodeEmbed code={link.code} title={link.title} />
      </main>
    )
  return (
    <main className="grid h-dvh place-items-center overflow-hidden bg-transparent">
      {link.mediaType.startsWith('video/') ? (
        <video
          aria-label={link.altText ?? link.title}
          className="h-full w-full object-contain"
          controls
          playsInline
          poster={link.posterMediaType ? `/api/share/${token}/media?variant=poster` : undefined}
          src={`/api/share/${token}/media`}
        />
      ) : (
        <a className="h-full w-full" href={`/s/${token}`} rel="noopener noreferrer" target="_blank">
          <img
            alt={link.altText ?? link.title}
            className="h-full w-full object-contain"
            src={`/api/share/${token}/media`}
          />
        </a>
      )}
    </main>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { appOrigin, shareView } from '@/lib/sharing/page'
import { shareMediaUrl, shareUrl } from '@/lib/sharing/schema'

type SharePageProps = { params: Promise<{ token: string }> }

/** Open Graph and X card tags, so the link previews as its image wherever it is pasted. */
export async function generateMetadata({ params }: SharePageProps): Promise<Metadata> {
  const { token } = await params
  const view = await shareView(token)
  const robots = { follow: false, index: false }
  if (view.kind !== 'visible') return { robots, title: 'Shared design' }
  const { link } = view
  const origin = appOrigin()
  const isVideo = link.mediaType.startsWith('video/')
  const image = isVideo
    ? link.posterMediaType
      ? shareMediaUrl(origin, token, 'poster')
      : null
    : shareMediaUrl(origin, token)
  const images = image
    ? [
        {
          alt: link.altText ?? link.title,
          height: link.height ?? undefined,
          url: image,
          width: link.width ?? undefined,
        },
      ]
    : []
  return {
    description: link.description ?? undefined,
    openGraph: {
      description: link.description ?? undefined,
      images,
      title: link.title,
      type: isVideo ? 'video.other' : 'website',
      url: shareUrl(origin, token),
      ...(isVideo ? { videos: [{ type: link.mediaType, url: shareMediaUrl(origin, token) }] } : {}),
    },
    robots,
    title: link.title,
    twitter: {
      card: 'summary_large_image',
      description: link.description ?? undefined,
      images,
      title: link.title,
    },
  }
}

/** A published design: the image or video, its title and description. */
export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params
  const view = await shareView(token)
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-neutral-950 px-4 py-10 text-neutral-100">
      {view.kind === 'gone' ? (
        <section className="max-w-md text-center">
          <h1 className="text-xl font-semibold">This link is not available</h1>
          <p className="mt-2 text-sm text-neutral-400">
            It does not exist, has expired, or was turned off by its owner.
          </p>
        </section>
      ) : view.kind === 'members-only' ? (
        <section className="max-w-md text-center">
          <h1 className="text-xl font-semibold">Shared with a workspace</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Only members of the workspace that shared this can open it. Sign in, and switch to that
            workspace if you belong to several.
          </p>
          <Link
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-white px-4 text-ui-lg font-medium text-neutral-900"
            href={`/sign-in?callbackURL=${encodeURIComponent(`/s/${token}`)}`}
          >
            Sign in
          </Link>
        </section>
      ) : (
        <>
          <figure className="flex w-full max-w-5xl flex-col items-center gap-4">
            {view.link.mediaType.startsWith('video/') ? (
              <video
                aria-label={view.link.altText ?? view.link.title}
                className="max-h-[78dvh] w-auto max-w-full rounded-xl shadow-2xl"
                controls
                height={view.link.height ?? undefined}
                playsInline
                poster={
                  view.link.posterMediaType ? `/api/share/${token}/media?variant=poster` : undefined
                }
                src={`/api/share/${token}/media`}
                width={view.link.width ?? undefined}
              />
            ) : (
              <img
                alt={view.link.altText ?? view.link.title}
                className="max-h-[78dvh] w-auto max-w-full rounded-xl shadow-2xl"
                height={view.link.height ?? undefined}
                src={`/api/share/${token}/media`}
                width={view.link.width ?? undefined}
              />
            )}
            <figcaption className="max-w-2xl text-center">
              <h1 className="text-lg font-semibold">{view.link.title}</h1>
              {view.link.description ? (
                <p className="mt-1 whitespace-pre-line text-sm text-neutral-400">
                  {view.link.description}
                </p>
              ) : null}
            </figcaption>
          </figure>
          <Link className="text-xs text-neutral-500 hover:text-neutral-300" href="/">
            Made with Shots
          </Link>
        </>
      )}
    </main>
  )
}

import { CodeIcon } from '@/components/platform-shell/icons'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'

const CHANGE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull\/\d+|commit\/[0-9a-f]{7,40})\/?$/i

/** The release's pull requests and commits that Code Studio can import. */
export function releaseChanges(sourceUrls: readonly string[]): string[] {
  return [...new Set(sourceUrls.filter((url) => CHANGE.test(url)))].slice(0, 12)
}

/**
 * Campaign Visuals › Code highlights: open a change from the release in Code
 * Studio to turn it into a code visual for this campaign. Nothing is read
 * from GitHub until the member imports it there.
 */
export function CodeHighlights({
  campaignId,
  sourceUrls,
}: {
  campaignId: string
  sourceUrls: readonly string[]
}) {
  const changes = releaseChanges(sourceUrls)
  const studio = (url?: string) =>
    `/create/code?${new URLSearchParams({ campaign: campaignId, ...(url ? { import: url } : {}) })}`
  return (
    <section aria-labelledby="code-highlights" className="rounded-xl border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="code-highlights" className="flex items-center gap-2 text-base font-medium">
            <CodeIcon size={18} aria-hidden /> Code highlights
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Show what changed: turn a pull request or commit into a diff, a carousel or a short
            video, then add it to this campaign from Code Studio&apos;s Export menu.
          </p>
        </div>
        <ButtonLink href={studio()} variant="outline" size="sm">
          Open Code Studio
        </ButtonLink>
      </div>
      {changes.length ? (
        <ul className="mt-4 divide-y rounded-lg border">
          {changes.map((url) => (
            <li key={url} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="truncate font-mono text-xs">
                {url.replace('https://github.com/', '')}
              </span>
              <ButtonLink href={studio(url)} variant="ghost" size="sm">
                Make a code visual
              </ButtonLink>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

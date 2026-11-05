import { Metadata } from 'next'
import Link from 'next/link'
import { Navigation } from '@/components/landing/Navigation'
import { Footer } from '@/components/landing/Footer'

export const metadata: Metadata = {
  title: 'Data deletion',
  description: 'What happens when you ask Meta to delete the data Shots holds for your account.',
  robots: { index: false },
}

const CONTACT_EMAIL = 'team@playbookmedia.io'

export default async function DataDeletionPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>
}) {
  const { code } = await searchParams
  const confirmationCode = typeof code === 'string' && /^[A-Z2-7]{1,64}$/.test(code) ? code : null
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Navigation />
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-6 pb-16 pt-28 sm:pb-24">
        <h1 className="text-3xl font-semibold">Data deletion</h1>
        {confirmationCode ? (
          <p className="leading-relaxed text-muted-foreground">
            Your confirmation code is{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">{confirmationCode}</code>.
            Quote it if you contact us about this request.
          </p>
        ) : null}
        <p className="leading-relaxed text-muted-foreground">
          When you remove Shots from your Instagram or Threads account, or ask Meta to delete your
          data, Shots acts on the request as soon as it receives it.
        </p>
        <ul className="list-disc space-y-2 pl-6 leading-relaxed text-muted-foreground">
          <li>The account is disconnected in every workspace that connected it.</li>
          <li>Posts waiting to publish on the account are cancelled.</li>
          <li>Its stored tokens, account name, username, and profile picture are erased.</li>
        </ul>
        <p className="leading-relaxed text-muted-foreground">
          Posts already published and their records stay with the workspace that created them. To
          ask about anything else we hold, email{' '}
          <Link
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-foreground underline underline-offset-4"
          >
            {CONTACT_EMAIL}
          </Link>
          .
        </p>
      </main>
      <Footer brandName="Shots" />
    </div>
  )
}

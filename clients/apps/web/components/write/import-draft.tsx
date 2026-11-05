'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { draftsApi } from '@/lib/content-drafts/client'
import { importedBody, importedPosts } from '@/lib/write/import-text'

/** Review a URL's text before creating a workspace draft. Navigation itself never mutates. */
export function ImportDraft({
  text: initial,
  socialSetId,
}: {
  text: string
  socialSetId?: string
}) {
  const [text, setText] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const router = useRouter()
  let posts: string[] = []
  let problem = ''
  try {
    posts = importedPosts(text)
  } catch (error) {
    problem = (error as Error).message
  }
  return (
    <form
      className="mx-auto grid w-full max-w-xl gap-3 p-6"
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy || problem || !posts.length) return
        setBusy(true)
        setError('')
        try {
          const draft = await draftsApi.create({ socialSetId, body: importedBody(posts) })
          router.replace(`/publish/${draft.id}`)
        } catch (error) {
          setError(error instanceof Error ? error.message : 'The draft could not be created.')
          setBusy(false)
        }
      }}
    >
      <h1 className="font-medium">Import draft</h1>
      <p className="text-sm text-muted-foreground">
        Review this text before saving it to your profile. A line containing --- or four
        newlines separates posts.
      </p>
      <Textarea
        aria-label="Imported draft text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={10}
      />
      <p role="status">
        {posts.length} {posts.length === 1 ? 'post' : 'posts'}
      </p>
      {problem || error ? <p role="alert">{problem || error}</p> : null}
      <Button disabled={busy || Boolean(problem) || !posts.length} type="submit">
        {busy ? 'Creating…' : 'Create draft'}
      </Button>
    </form>
  )
}

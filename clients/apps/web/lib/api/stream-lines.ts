import { z } from 'zod'
import type { AssistantStreamLine } from '@/lib/api/contracts/ai'

/** Sends one line to the browser. */
const sendSchema = z.custom<(line: AssistantStreamLine) => void>()

/** A byte stream of lines; writing after the browser leaves does nothing. */
function lineStream() {
  const encoder = new TextEncoder()
  let sink!: ReadableStreamDefaultController<Uint8Array>
  let open = true
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      sink = controller
    },
    cancel: () => {
      open = false
    },
  })
  return {
    body,
    close: () => {
      if (open) sink.close()
      open = false
    },
    write: (line: AssistantStreamLine) => {
      if (open) sink.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
    },
  }
}

function streamFailureDetails(error: unknown) {
  const statusCode =
    error &&
    typeof error === 'object' &&
    'statusCode' in error &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : undefined
  const name = error instanceof Error ? error.name : 'unknown'
  const message =
    error instanceof Error && error.name === 'AssistantRefusal'
      ? error.message
      : error instanceof Error && error.name === 'WorkspaceQuotaError'
        ? 'You have used all AI credits for this period. Add credits in Billing to continue.'
        : 'The assistant stopped before it finished. Try again.'
  return { message, name, statusCode }
}

/**
 * Answer with the lines `run` sends, as newline-delimited JSON. A failure
 * before the first line rejects, so the route can still answer with a status;
 * a later one becomes the stream's last line.
 */
export async function streamLines(
  run: (send: z.infer<typeof sendSchema>) => Promise<void>
): Promise<Response> {
  const lines = lineStream()
  const first = Promise.withResolvers<void>()
  let sent = false
  const send = (line: AssistantStreamLine) => {
    sent = true
    lines.write(line)
    first.resolve()
  }
  const done = run(send)
    .catch((error: unknown) => {
      if (!sent) throw error
      const { message, name, statusCode } = streamFailureDetails(error)
      console.error('Assistant turn failed mid-stream.', { name, statusCode })
      send({ error: message, type: 'error' })
    })
    .finally(lines.close)
  await Promise.race([first.promise, done])
  return new Response(lines.body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/x-ndjson; charset=utf-8',
    },
  })
}

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
      console.error('Assistant turn failed mid-stream.', {
        reason: error instanceof Error ? error.message : 'unknown',
      })
      send({ error: 'The assistant stopped before it finished. Try again.', type: 'error' })
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

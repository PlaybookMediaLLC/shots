import { createServer, type Server } from 'node:net'

/**
 * Just enough Redis for the rate limiter in a test: every script answers "first
 * call in the window", and every other command answers OK.
 */
export async function fakeRedis(): Promise<{ server: Server; url: string }> {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (let command = readCommand(buffer); command; command = readCommand(buffer)) {
        buffer = buffer.subarray(command.length)
        socket.write(command.name === 'EVAL' ? '*2\r\n:1\r\n:60000\r\n' : '+OK\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { server, url: `redis://127.0.0.1:${address.port}` }
}

/** The first whole command (an array of bulk strings) in the buffer, if one has arrived. */
function readCommand(buffer: Buffer) {
  let at = 0
  const line = () => {
    const end = buffer.indexOf('\r\n', at)
    if (end < 0) return null
    const text = buffer.toString('utf8', at, end)
    at = end + 2
    return text
  }
  const count = Number(line()?.slice(1))
  if (!count) return null
  let name = ''
  for (let index = 0; index < count; index += 1) {
    const size = line()
    if (size === null) return null
    const length = Number(size.slice(1))
    if (buffer.length < at + length + 2) return null
    if (index === 0) name = buffer.toString('utf8', at, at + length).toUpperCase()
    at += length + 2
  }
  return { length: at, name }
}

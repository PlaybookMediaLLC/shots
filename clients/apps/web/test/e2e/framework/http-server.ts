import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export type HttpMockRequest = {
  body: string
  headers: IncomingHttpHeaders
  method: string
  url: string
}

export type HttpMockResponse = {
  body?: unknown
  headers?: Record<string, string>
  rawBody?: Buffer | string
  status?: number
}

type HttpMockHandler = (request: HttpMockRequest) => HttpMockResponse | Promise<HttpMockResponse>

export type HttpMockServer = {
  calls: readonly HttpMockRequest[]
  close: () => Promise<void>
  containerUrl: string
  url: string
}

async function getRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startHttpMockServer(
  handler: HttpMockHandler,
  port?: number
): Promise<HttpMockServer> {
  const calls: HttpMockRequest[] = []
  const server = createServer(async (request, response) => {
    const body = await getRequestBody(request)
    const call = {
      body,
      headers: request.headers,
      method: request.method ?? 'GET',
      url: request.url ?? '/',
    }
    calls.push(call)
    const result = await handler(call)
    response.writeHead(result.status ?? 200, {
      'content-type': 'application/json',
      ...result.headers,
    })
    response.end(result.rawBody ?? JSON.stringify(result.body ?? {}))
  })

  // Dual stack also serves localhost when DNS returns ::1 before 127.0.0.1.
  await new Promise<void>((resolve) => server.listen(port ?? 0, resolve))
  const address = server.address() as AddressInfo
  return {
    calls,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
    containerUrl: `http://host.docker.internal:${address.port}`,
    url: `http://127.0.0.1:${address.port}`,
  }
}

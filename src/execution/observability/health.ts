import { createServer, type Server } from 'node:http'

export interface HealthServer {
  port: number
  setReady(ready: boolean): void
  close(): Promise<void>
}

export async function startHealthServer(port: number): Promise<HealthServer> {
  let isReady = false

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'GET' && url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.method === 'GET' && url.startsWith('/ready')) {
      if (isReady) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ready' }))
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'not_ready' }))
      }
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  const boundPort = (server.address() as { port: number }).port

  return {
    port: boundPort,
    setReady(ready: boolean) {
      isReady = ready
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close(err => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  }
}

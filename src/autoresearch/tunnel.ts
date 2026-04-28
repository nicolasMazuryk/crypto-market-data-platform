import '../config/env.js'
import net from 'net'
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'

const REMOTE_HOST = process.env.REMOTE_SERVER_HOST
if (!REMOTE_HOST) throw new Error('REMOTE_SERVER_HOST is not set in environment')
const REMOTE_CH_HTTP_PORT = 8123
const LOCAL_TUNNEL_PORT = 18123
const SSH_KEY = path.join(process.env.HOME ?? '/root', '.ssh', 'nicolas')
const SSH_USER = 'nicolas'

const READY_TIMEOUT_MS = 10_000
const RECONNECT_INITIAL_DELAY_MS = 2_000
const RECONNECT_MAX_DELAY_MS = 60_000

const SSH_ARGS = [
  '-N',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ExitOnForwardFailure=yes',
  '-o',
  'ServerAliveInterval=30',
  '-o',
  'ServerAliveCountMax=3',
  '-i',
  SSH_KEY,
  '-L',
  `${String(LOCAL_TUNNEL_PORT)}:127.0.0.1:${String(REMOTE_CH_HTTP_PORT)}`,
  `${SSH_USER}@${REMOTE_HOST}`,
]

export interface TunnelHandle {
  localPort: number
  close: () => void
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isPortReachable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1')
    sock.setTimeout(500)
    sock.on('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => {
      resolve(false)
    })
    sock.on('timeout', () => {
      sock.destroy()
      resolve(false)
    })
  })
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    function attempt(): void {
      void isPortReachable(port).then(ok => {
        if (ok) {
          resolve()
          return
        }
        if (Date.now() > deadline) {
          reject(new Error(`Tunnel port ${String(port)} not ready after ${String(timeoutMs)}ms`))
          return
        }
        setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

function spawnSsh(): { proc: ChildProcess; procExit: Promise<void> } {
  const proc = spawn('ssh', SSH_ARGS, { detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
  const procExit = new Promise<void>(resolve => {
    proc.on('close', () => {
      resolve()
    })
    proc.on('error', () => {
      resolve()
    })
  })
  return { proc, procExit }
}

/**
 * Open an SSH tunnel forwarding localhost:LOCAL_TUNNEL_PORT -> REMOTE_HOST:CLICKHOUSE_HTTP_PORT.
 * If the port is already reachable (existing tunnel), returns a no-op handle.
 * Automatically reconnects with exponential backoff if the tunnel drops.
 */
export async function startTunnel(): Promise<TunnelHandle> {
  if (await isPortReachable(LOCAL_TUNNEL_PORT)) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return { localPort: LOCAL_TUNNEL_PORT, close: () => {} }
  }

  const state = { closed: false, proc: null as ChildProcess | null, exit: null as Promise<void> | null }
  // Function call defeats TypeScript's flow narrowing of state.closed inside the async IIFE.
  const isClosed = (): boolean => state.closed

  // Initial launch — must succeed before we return the handle.
  const { proc: firstProc, procExit: firstExit } = spawnSsh()
  state.proc = firstProc
  state.exit = firstExit
  try {
    await Promise.race([
      waitForPort(LOCAL_TUNNEL_PORT, READY_TIMEOUT_MS),
      firstExit.then(() => {
        throw new Error('SSH process exited before tunnel was ready')
      }),
    ])
  } catch (err) {
    try {
      firstProc.kill()
    } catch {
      /* ignore */
    }
    throw err
  }

  // Background supervision loop: restart the tunnel if it dies unexpectedly.
  void (async () => {
    let retryMs = RECONNECT_INITIAL_DELAY_MS
    while (!isClosed()) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await state.exit!
      if (isClosed()) break

      console.error('[autoresearch] SSH tunnel disconnected; reconnecting...')
      await sleep(retryMs)
      if (isClosed()) break

      const { proc, procExit } = spawnSsh()
      state.proc = proc
      state.exit = procExit

      try {
        await Promise.race([
          waitForPort(LOCAL_TUNNEL_PORT, READY_TIMEOUT_MS),
          procExit.then(() => {
            throw new Error('SSH process exited before tunnel was ready')
          }),
        ])
        console.error('[autoresearch] SSH tunnel reconnected')
        retryMs = RECONNECT_INITIAL_DELAY_MS
      } catch {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        retryMs = Math.min(retryMs * 2, RECONNECT_MAX_DELAY_MS)
        console.error(`[autoresearch] SSH tunnel reconnect failed; retrying in ${String(retryMs / 1000)}s`)
      }
    }
  })()

  return {
    localPort: LOCAL_TUNNEL_PORT,
    close: () => {
      state.closed = true
      try {
        state.proc?.kill()
      } catch {
        /* ignore */
      }
    },
  }
}

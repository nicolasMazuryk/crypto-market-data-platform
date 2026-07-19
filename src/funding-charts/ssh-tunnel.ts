import net from 'net'
import { spawn } from 'child_process'
import os from 'os'

export interface SshTunnel {
  localPort: number
  close: () => void
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('could not get free port'))
        return
      }
      const port = addr.port
      server.close(() => {
        resolve(port)
      })
    })
  })
}

function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`SSH tunnel on port ${port.toString()} not ready after ${timeoutMs.toString()}ms`))
          return
        }
        setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

export async function openSshTunnel(opts: {
  sshHost: string
  sshUser?: string
  sshKey?: string
  remotePort: number
}): Promise<SshTunnel> {
  const { sshHost, remotePort } = opts
  const sshUser = opts.sshUser ?? os.userInfo().username
  const sshKey = opts.sshKey ?? `${os.homedir()}/.ssh/id_rsa`

  const localPort = await getFreePort()

  const proc = spawn(
    'ssh',
    [
      '-i',
      sshKey,
      '-L',
      `127.0.0.1:${localPort.toString()}:127.0.0.1:${remotePort.toString()}`,
      '-N',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      `${sshUser}@${sshHost}`,
    ],
    { stdio: 'ignore' }
  )

  proc.on('error', err => {
    throw new Error(`SSH tunnel process error: ${err.message}`)
  })

  await waitForPort(localPort)

  return {
    localPort,
    close: () => {
      proc.kill()
    },
  }
}

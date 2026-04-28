import { EventEmitter } from 'events'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const connectMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  spawn: spawnMock,
}))

vi.mock('net', () => ({
  default: { connect: connectMock },
}))

describe('startTunnel', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnMock.mockReset()
    connectMock.mockReset()
    process.env.REMOTE_SERVER_HOST = '203.0.113.10'
  })

  it('spawns ssh detached so terminal SIGINT does not kill the tunnel during graceful shutdown', async () => {
    spawnMock.mockReturnValue(new EventEmitter())

    let connectAttempt = 0
    connectMock.mockImplementation(() => {
      connectAttempt++
      const socket = new EventEmitter() as EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>
        destroy: ReturnType<typeof vi.fn>
      }
      socket.setTimeout = vi.fn()
      socket.destroy = vi.fn()

      if (connectAttempt === 1) {
        setImmediate(() => socket.emit('error', new Error('not ready')))
      } else {
        setImmediate(() => socket.emit('connect'))
      }

      return socket
    })

    const { startTunnel } = await import('../tunnel.js')

    const tunnel = await startTunnel()
    tunnel.close()

    expect(spawnMock).toHaveBeenCalledWith(
      'ssh',
      expect.any(Array),
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
    )
  })
})

import { describe, expect, it, vi } from 'vitest'

import { createShadowPrivateWsAdapter } from './shadow.js'

describe('createShadowPrivateWsAdapter', () => {
  it('connect() and disconnect() resolve without throwing', async () => {
    const adapter = createShadowPrivateWsAdapter('binance')
    await expect(adapter.connect()).resolves.toBeUndefined()
    await expect(adapter.disconnect()).resolves.toBeUndefined()
  })

  it('never fires any events', async () => {
    const adapter = createShadowPrivateWsAdapter('bitget')
    const eventSpy = vi.fn()
    adapter.events.on('order', eventSpy)
    adapter.events.on('position', eventSpy)
    adapter.events.on('balance', eventSpy)
    adapter.events.on('fundingFee', eventSpy)
    adapter.events.on('connectionState', eventSpy)
    await adapter.connect()
    await adapter.disconnect()
    expect(eventSpy).not.toHaveBeenCalled()
  })

  it('exposes the correct exchange', () => {
    expect(createShadowPrivateWsAdapter('okx').exchange).toBe('okx')
  })
})

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { parseGateMultiFile } from '../parsers/gate-orderbook-multi.js'

describe('parseGateMultiFile', () => {
  it('parses multiple files in chronological order with shared book state', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-multi-'))

    try {
      const firstHour = path.join(tmpDir, 'BTC_USDT-2026010100.csv.gz')
      const secondHour = path.join(tmpDir, 'BTC_USDT-2026010101.csv.gz')

      await fs.writeFile(
        firstHour,
        gzipSync(
          [
            '1764460800,set,2.0000,100,1,0',
            '1764460800,set,2.1000,-100,2,0',
            '1764460801,make,2.0000,50,3,0',
            '1764464400,take,2.1000,-100,4,0',
          ].join('\n')
        )
      )

      await fs.writeFile(
        secondHour,
        gzipSync(['1764464400,set,2.2000,-120,5,0', '1764464401,make,2.0500,20,6,0'].join('\n'))
      )

      const output = []
      for await (const event of parseGateMultiFile([secondHour, firstHour])) {
        output.push(event)
      }

      expect(output).toHaveLength(4)
      expect(output[0]).toMatchObject({ timestampMs: 1764460800000, bid: 2, ask: 2.1 })
      expect(output[1]).toMatchObject({ timestampMs: 1764460801000, bid: 2, ask: 2.1 })
      expect(output[2]).toMatchObject({ timestampMs: 1764464400000, bid: null, ask: 2.2 })
      expect(output[3]).toMatchObject({ timestampMs: 1764464401000, bid: 2.05, ask: 2.2 })

      await expect(fs.access(firstHour)).rejects.toBeTruthy()
      await expect(fs.access(secondHour)).rejects.toBeTruthy()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

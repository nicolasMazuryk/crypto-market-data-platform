import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { downloadFile, downloadFiles } from '../downloaders/download.js'

interface TestServer {
  url: string
  close: () => Promise<void>
}

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<TestServer> {
  const server = http.createServer(handler)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server address')
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    },
  }
}

describe('download utilities', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true })
    }

    tempDirs.length = 0
  })

  it('downloads a file and returns the written size', async () => {
    const server = await withServer((_request, response) => {
      response.statusCode = 200
      response.end('hello world')
    })

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-ok-'))
    tempDirs.push(tempDir)

    try {
      const outputPath = path.join(tempDir, 'sample.txt')
      const size = await downloadFile(`${server.url}/sample.txt`, outputPath, {
        maxRetries: 1,
        backoffBaseMs: 1,
        backoffMaxMs: 5,
      })

      expect(size).toBe(11)
      await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('hello world')
    } finally {
      await server.close()
    }
  })

  it('retries on 5xx responses before succeeding', async () => {
    let hits = 0
    const server = await withServer((_request, response) => {
      hits += 1

      if (hits < 3) {
        response.statusCode = 500
        response.end('temporary')
        return
      }

      response.statusCode = 200
      response.end('ok')
    })

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-retry-'))
    tempDirs.push(tempDir)

    try {
      const outputPath = path.join(tempDir, 'retry.txt')
      const size = await downloadFile(`${server.url}/retry.txt`, outputPath, {
        maxRetries: 5,
        backoffBaseMs: 1,
        backoffMaxMs: 5,
      })

      expect(size).toBe(2)
      expect(hits).toBe(3)
    } finally {
      await server.close()
    }
  })

  it('fails immediately on 404 without retrying', async () => {
    let hits = 0
    const server = await withServer((_request, response) => {
      hits += 1
      response.statusCode = 404
      response.end('missing')
    })

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-404-'))
    tempDirs.push(tempDir)

    try {
      const outputPath = path.join(tempDir, 'missing.txt')

      await expect(
        downloadFile(`${server.url}/missing.txt`, outputPath, {
          maxRetries: 5,
          backoffBaseMs: 1,
          backoffMaxMs: 5,
        })
      ).rejects.toThrow('File not found (404)')

      expect(hits).toBe(1)
      await expect(fs.access(outputPath)).rejects.toBeTruthy()
    } finally {
      await server.close()
    }
  })

  it('fails on timeout and cleans up partial files', async () => {
    const server = await withServer((_request, response) => {
      setTimeout(() => {
        response.statusCode = 200
        response.end('late-response')
      }, 200)
    })

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-timeout-'))
    tempDirs.push(tempDir)

    try {
      const outputPath = path.join(tempDir, 'timeout.txt')
      await expect(
        downloadFile(`${server.url}/timeout.txt`, outputPath, {
          maxRetries: 0,
          timeoutMs: 20,
        })
      ).rejects.toThrow()

      await expect(fs.access(outputPath)).rejects.toBeTruthy()
    } finally {
      await server.close()
    }
  })

  it('downloads multiple files and aggregates size', async () => {
    const server = await withServer((request, response) => {
      if (request.url === '/one.csv.gz') {
        response.statusCode = 200
        response.end('abc')
        return
      }

      response.statusCode = 200
      response.end('defgh')
    })

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-multi-'))
    tempDirs.push(tempDir)

    try {
      const result = await downloadFiles([`${server.url}/one.csv.gz`, `${server.url}/two.csv.gz`], tempDir, {
        maxRetries: 1,
        backoffBaseMs: 1,
        backoffMaxMs: 5,
        concurrency: 2,
      })

      expect(result.filePaths).toHaveLength(2)
      expect(result.totalSizeBytes).toBe(8)
    } finally {
      await server.close()
    }
  })

  it('skips missing files when configured and keeps successful downloads', async () => {
    const server = await withServer((request, response) => {
      if (request.url === '/missing.csv.gz') {
        response.statusCode = 404
        response.end('missing')
        return
      }

      response.statusCode = 200
      response.end('ok')
    })

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-skip-404-'))
    tempDirs.push(tempDir)

    try {
      const result = await downloadFiles([`${server.url}/missing.csv.gz`, `${server.url}/ok.csv.gz`], tempDir, {
        maxRetries: 1,
        backoffBaseMs: 1,
        backoffMaxMs: 5,
        concurrency: 2,
        skipNotFound: true,
      })

      expect(result.filePaths).toHaveLength(1)
      expect(path.basename(result.filePaths[0] ?? '')).toBe('ok.csv.gz')
      expect(result.totalSizeBytes).toBe(2)
    } finally {
      await server.close()
    }
  })

  it('preserves URL order while downloading concurrently', async () => {
    const server = await withServer((request, response) => {
      if (request.url === '/slow.csv.gz') {
        setTimeout(() => {
          response.statusCode = 200
          response.end('slow')
        }, 60)
        return
      }

      setTimeout(() => {
        response.statusCode = 200
        response.end('fast')
      }, 10)
    })

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-order-'))
    tempDirs.push(tempDir)

    try {
      const result = await downloadFiles([`${server.url}/slow.csv.gz`, `${server.url}/fast.csv.gz`], tempDir, {
        maxRetries: 1,
        backoffBaseMs: 1,
        backoffMaxMs: 5,
        concurrency: 2,
      })

      expect(path.basename(result.filePaths[0] ?? '')).toBe('slow.csv.gz')
      expect(path.basename(result.filePaths[1] ?? '')).toBe('fast.csv.gz')
      expect(result.totalSizeBytes).toBe(8)
    } finally {
      await server.close()
    }
  })
})

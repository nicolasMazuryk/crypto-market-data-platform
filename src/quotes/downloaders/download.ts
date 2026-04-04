import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { DownloadResult } from './types.js'

interface DownloadOptions {
  readonly maxRetries?: number
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
  readonly timeoutMs?: number
  readonly onInfo?: (message: string) => void
}

interface DownloadFilesOptions extends DownloadOptions {
  readonly concurrency?: number
  readonly skipNotFound?: boolean
}

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_BACKOFF_BASE_MS = 1_000
const DEFAULT_BACKOFF_MAX_MS = 30_000
const DEFAULT_TIMEOUT_MS = 300_000

class DownloadNotFoundError extends Error {
  readonly url: string

  constructor(url: string) {
    super(`File not found (404): ${url}`)
    this.name = 'DownloadNotFoundError'
    this.url = url
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

function extensionFromUrl(url: string): string {
  const parsed = new URL(url)
  return path.basename(parsed.pathname)
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function isRetriableError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true
  }

  if (!(error instanceof Error)) {
    return false
  }

  return error.name === 'TypeError' || error.message.toLowerCase().includes('network')
}

function isNotFoundError(error: unknown): error is DownloadNotFoundError {
  return error instanceof DownloadNotFoundError
}

function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt)
  const jitter = Math.floor(Math.random() * Math.floor(exponential * 0.25))
  return Math.min(maxMs, exponential + jitter)
}

export async function downloadFile(url: string, destPath: string, options: DownloadOptions = {}): Promise<number> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  await fs.mkdir(path.dirname(destPath), { recursive: true })

  let attempt = 0
  while (attempt <= maxRetries) {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    const tempPath = `${destPath}.part-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`

    try {
      const response = await fetch(url, {
        signal: controller.signal,
      })

      if (response.status === 404) {
        throw new DownloadNotFoundError(url)
      }

      if (!response.ok) {
        throw new Error(`Download failed with status ${String(response.status)}: ${url}`)
      }

      if (!response.body) {
        throw new Error(`Download response has no body: ${url}`)
      }

      const writeStream = createWriteStream(tempPath)
      await pipeline(Readable.fromWeb(response.body as never), writeStream)
      await fs.rename(tempPath, destPath)

      const stat = await fs.stat(destPath)
      return stat.size
    } catch (error: unknown) {
      await fs.rm(tempPath, { force: true })

      const shouldRetry =
        attempt < maxRetries &&
        ((error instanceof Error && /status (5\d\d)/.test(error.message)) || isRetriableError(error))

      if (!shouldRetry) {
        if (error instanceof Error) {
          throw error
        }

        throw new Error(String(error))
      }

      const delayMs = retryDelayMs(attempt, backoffBaseMs, backoffMaxMs)
      options.onInfo?.(`Download retry ${String(attempt + 1)}/${String(maxRetries)} in ${String(delayMs)}ms for ${url}`)
      await sleep(delayMs)
      attempt += 1
      continue
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error(`Exceeded retry limit while downloading ${url}`)
}

export async function downloadFiles(
  urls: string[],
  destDir: string,
  options: DownloadFilesOptions = {}
): Promise<DownloadResult> {
  await fs.mkdir(destDir, { recursive: true })

  if (urls.length === 0) {
    return {
      filePaths: [],
      totalSizeBytes: 0,
    }
  }

  const filePaths: (string | undefined)[] = Array.from({ length: urls.length })
  const fileSizes: number[] = Array.from({ length: urls.length }, () => 0)
  let nextIndex = 0
  const skipNotFound = options.skipNotFound ?? false

  const workerCount = Math.max(1, Math.min(options.concurrency ?? 1, urls.length))

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const currentIndex = nextIndex
      nextIndex += 1

      if (currentIndex >= urls.length) {
        return
      }

      const url = urls[currentIndex]
      if (!url) {
        throw new Error(`Download URL missing at index ${String(currentIndex)}`)
      }

      const filename = extensionFromUrl(url)
      const destPath = path.join(destDir, filename)
      let fileSize: number
      try {
        fileSize = await downloadFile(url, destPath, options)
      } catch (error: unknown) {
        if (skipNotFound && isNotFoundError(error)) {
          options.onInfo?.(`Skipping missing file (404): ${url}`)
          continue
        }

        throw error
      }

      filePaths[currentIndex] = destPath
      fileSizes[currentIndex] = fileSize
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  const finalizedFilePaths = skipNotFound
    ? filePaths.filter((filePath): filePath is string => filePath !== undefined)
    : filePaths.map((filePath, index) => {
        if (!filePath) {
          throw new Error(`Downloaded file missing for index ${String(index)}`)
        }

        return filePath
      })

  return {
    filePaths: finalizedFilePaths,
    totalSizeBytes: fileSizes.reduce((total, size) => total + size, 0),
  }
}

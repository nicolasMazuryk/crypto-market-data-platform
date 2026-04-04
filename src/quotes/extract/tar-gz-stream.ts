import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

async function waitForExit(processId: ChildProcessWithoutNullStreams, filePath: string): Promise<void> {
  const stderrChunks: string[] = []

  processId.stderr.setEncoding('utf8')
  processId.stderr.on('data', (chunk: unknown) => {
    if (typeof chunk === 'string') {
      stderrChunks.push(chunk)
      return
    }

    if (Buffer.isBuffer(chunk)) {
      stderrChunks.push(chunk.toString('utf8'))
    }
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    processId.once('error', reject)
    processId.once('close', resolve)
  })

  if (exitCode !== 0) {
    const stderr = stderrChunks.join('').trim()
    throw new Error(`Failed to extract tar.gz file ${filePath}: ${stderr || `exit code ${String(exitCode)}`}`)
  }
}

export async function* readTarGzipLines(filePath: string): AsyncIterable<string> {
  const tarProcess = spawn('tar', ['-xOf', filePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams

  const lineReader = createInterface({
    input: tarProcess.stdout,
    crlfDelay: Infinity,
  })

  for await (const line of lineReader) {
    yield line
  }

  await waitForExit(tarProcess, filePath)
}

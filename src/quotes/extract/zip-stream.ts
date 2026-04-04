import { createInterface } from 'node:readline'

import unzipper from 'unzipper'

export async function* readZipLines(filePath: string): AsyncIterable<string> {
  const archive = await unzipper.Open.file(filePath)
  const firstFile = archive.files.find(file => file.type === 'File')
  if (!firstFile) {
    throw new Error(`ZIP archive has no files: ${filePath}`)
  }

  const lineReader = createInterface({
    input: firstFile.stream(),
    crlfDelay: Infinity,
  })

  for await (const line of lineReader) {
    yield line
  }
}

export async function readFirstZipEntryBuffer(filePath: string): Promise<Buffer> {
  const archive = await unzipper.Open.file(filePath)
  const firstFile = archive.files.find(file => file.type === 'File')
  if (!firstFile) {
    throw new Error(`ZIP archive has no files: ${filePath}`)
  }

  return firstFile.buffer()
}

export async function readFirstZipEntryPath(filePath: string): Promise<string> {
  const archive = await unzipper.Open.file(filePath)
  const firstFile = archive.files.find(file => file.type === 'File')
  if (!firstFile) {
    throw new Error(`ZIP archive has no files: ${filePath}`)
  }

  return firstFile.path
}

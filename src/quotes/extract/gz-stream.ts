import fs from 'node:fs'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'

export async function* readGzipLines(filePath: string): AsyncIterable<string> {
  const input = fs.createReadStream(filePath).pipe(createGunzip())
  const lineReader = createInterface({
    input,
    crlfDelay: Infinity,
  })

  for await (const line of lineReader) {
    yield line
  }
}

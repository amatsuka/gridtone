import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** SHA-256 содержимого файла, hex. Читает потоком, чтобы не держать файл в памяти. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

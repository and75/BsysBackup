import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

/** SHA-256 dell'intero file. Con `signal` la lettura si interrompe a metà file, senza aspettarne la fine. */
export function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash: Hash = createHash("sha256");
    const stream = createReadStream(path, { signal });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** SHA-256 dei primi `bytes` del file: basta a escludere la maggior parte dei file diversi senza leggerli tutti */
export async function hashHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally {
    await handle.close();
  }
}

import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let tmpSeq = 0;

/** Write via tmp file + rename in the same directory (atomic on POSIX filesystems). */
export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}${(++tmpSeq).toString(36)}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Re-reads a file only when its mtime or size changed (persona files are read every turn). */
export class MtimeCache {
  #entries = new Map<string, { mtimeMs: number; size: number; text: string }>();

  async read(path: string): Promise<string | null> {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(path);
    } catch {
      this.#entries.delete(path);
      return null;
    }
    const hit = this.#entries.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = await readText(path);
    if (text === null) {
      this.#entries.delete(path);
      return null;
    }
    this.#entries.set(path, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  }

  /** Drop entries under a directory prefix (restart). */
  clear(prefix?: string): void {
    if (!prefix) return this.#entries.clear();
    for (const k of this.#entries.keys()) if (k.startsWith(prefix)) this.#entries.delete(k);
  }
}

/** Disk-backed staging in the Origin Private File System, so large downloads never sit in RAM. */

const ROOT = 'vdh';

async function root(): Promise<FileSystemDirectoryHandle> {
  const base = await navigator.storage.getDirectory();
  return base.getDirectoryHandle(ROOT, { create: true });
}

export async function jobDir(jobId: string): Promise<FileSystemDirectoryHandle> {
  return (await root()).getDirectoryHandle(jobId, { create: true });
}

export interface StageFile {
  write(chunk: Uint8Array): Promise<void>;
  /** Bytes written so far. */
  readonly bytes: number;
  /** Finish writing and return the file. */
  finish(): Promise<File>;
  abort(): Promise<void>;
}

export async function createStageFile(jobId: string, name: string): Promise<StageFile> {
  const dir = await jobDir(jobId);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  let bytes = 0;
  return {
    get bytes() {
      return bytes;
    },
    async write(chunk) {
      // Copy to a plain ArrayBuffer-backed view: a SharedArrayBuffer view is not accepted by write().
      await writable.write(chunk as Uint8Array<ArrayBuffer>);
      bytes += chunk.byteLength;
    },
    async finish() {
      await writable.close();
      return handle.getFile();
    },
    async abort() {
      await writable.abort().catch(() => undefined);
    },
  };
}

export async function removeJobDir(jobId: string): Promise<void> {
  try {
    await (await root()).removeEntry(jobId, { recursive: true });
  } catch {
    // Already gone.
  }
}

/** Remove everything left behind by a previous (crashed or closed) offscreen document. */
export async function purgeAll(): Promise<void> {
  try {
    const base = await navigator.storage.getDirectory();
    await base.removeEntry(ROOT, { recursive: true });
  } catch {
    // Nothing to purge.
  }
}

/** Free space in the browser's storage quota, or undefined when the browser does not say. */
export async function freeBytes(): Promise<number | undefined> {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return quota !== undefined && usage !== undefined ? quota - usage : undefined;
  } catch {
    return undefined;
  }
}

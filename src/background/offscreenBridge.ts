import type { DownloadRequest } from '@/types/download';
import type { OffscreenCommand, OffscreenPlan } from '@/types/messages';

const PATH = 'offscreen/offscreen.html';

async function exists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(PATH)],
  });
  return contexts.length > 0;
}

let creating: Promise<void> | undefined;

/** The offscreen document hosts segment downloading and FFmpeg.wasm (a service worker cannot create blob URLs). */
export async function ensureOffscreen(): Promise<void> {
  if (await exists()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: PATH,
      reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS],
      justification: 'Assemble downloaded media segments into a file and run local FFmpeg.wasm conversions.',
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}

export async function offscreenAlive(): Promise<boolean> {
  return exists();
}

export async function closeOffscreen(): Promise<void> {
  if (await exists()) await chrome.offscreen.closeDocument();
}

export async function runInOffscreen(
  jobId: string,
  request: DownloadRequest,
  plan: OffscreenPlan,
): Promise<void> {
  await ensureOffscreen();
  const cmd: OffscreenCommand = { channel: 'vdown-offscreen', type: 'run-job', jobId, request, plan };
  await chrome.runtime.sendMessage(cmd);
}

export async function cancelInOffscreen(jobId: string): Promise<void> {
  if (!(await exists())) return;
  const cmd: OffscreenCommand = { channel: 'vdown-offscreen', type: 'cancel-job', jobId };
  try {
    await chrome.runtime.sendMessage(cmd);
  } catch {
    // The document may be closing; the job is being cancelled anyway.
  }
}

/** Finish a live recording and save what it has (the user pressed Stop). */
export async function stopInOffscreen(jobId: string): Promise<void> {
  if (!(await exists())) return;
  const cmd: OffscreenCommand = { channel: 'vdown-offscreen', type: 'stop-job', jobId };
  try {
    await chrome.runtime.sendMessage(cmd);
  } catch {
    // The document may be closing.
  }
}

/** Tell the offscreen document it can free the staged file and blob URL for this job. */
export async function releaseInOffscreen(jobId: string): Promise<void> {
  if (!(await exists())) return;
  const cmd: OffscreenCommand = { channel: 'vdown-offscreen', type: 'release-job', jobId };
  try {
    await chrome.runtime.sendMessage(cmd);
  } catch {
    // ignore
  }
}

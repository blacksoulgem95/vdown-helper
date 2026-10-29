/**
 * The port to the desktop app (Chrome native messaging, host `io.github.blacksoulgem95.vdownhelper`). It is opened
 * when a job needs the app, closed again once none does, and every message the app sends is checked before it is
 * believed (`parseAppMessage`). Jobs are handed over with what the background derived from its own scan: the request,
 * the Referer/Origin it would replay itself, and the cookies of the origins the user granted, for that job only.
 */
import {
  DESKTOP_KEY,
  HOST_NAME,
  PROTOCOL_VERSION,
  cookieHeader,
  parseAppMessage,
  sanitizeDesktop,
} from '@/lib/desktop';
import { replayHeadersFor } from '@/lib/replay';
import { log, parseUrl } from '@/lib/security';
import type { DownloadJob, JobErrorCode, JobStage } from '@/types/download';
import type { AppMessage, DesktopSettings, DesktopStatus } from '@/types/desktop';
import { isActive } from '@/lib/queue';
import { getJob, listJobs } from './jobStore';

/** The relay may have to start the app first: give it time to answer. */
const HELLO_TIMEOUT_MS = 20_000;
const ANSWER_TIMEOUT_MS = 20_000;
/** Close the port this long after the last job the app runs for us ended (the open port keeps the worker alive). */
const IDLE_CLOSE_MS = 15_000;

let port: chrome.runtime.Port | undefined;
let hello: { appVersion: string; ffmpeg: string | null } | undefined;
let connecting: Promise<boolean> | undefined;
let lastError: string | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let handler: (m: AppMessage) => Promise<void> = async () => undefined;
/** Jobs waiting for the app to accept (or refuse) them. */
const answers = new Map<string, (m: AppMessage) => void>();

/** The runner's handler for what the app reports about jobs. */
export function onAppMessage(h: (m: AppMessage) => Promise<void>): void {
  handler = h;
}

export async function loadDesktop(): Promise<DesktopSettings> {
  try {
    return sanitizeDesktop((await chrome.storage.local.get(DESKTOP_KEY))[DESKTOP_KEY]);
  } catch {
    return sanitizeDesktop(undefined);
  }
}

const has = (p: chrome.permissions.Permissions) =>
  chrome.permissions.contains(p) as unknown as Promise<boolean>;

function post(msg: Record<string, unknown>): boolean {
  if (!port) return false;
  try {
    port.postMessage({ v: PROTOCOL_VERSION, ...msg });
    return true;
  } catch {
    return false;
  }
}

function dispatch(m: AppMessage): void {
  const id = 'jobId' in m ? m.jobId : undefined;
  if ((m.type === 'accepted' || m.type === 'error') && id && answers.has(id)) {
    answers.get(id)?.(m);
    answers.delete(id);
    return;
  }
  if (m.type === 'needs-cookies') {
    void sendCookies(m.jobId);
    return;
  }
  handler(m).catch((e: unknown) => log.error('desktop event failed:', e));
}

/** Open the port and greet the app; false when it cannot be reached (not installed, not allowed, not answering). */
export async function connectDesktop(): Promise<boolean> {
  if (port && hello) return true;
  if (connecting) return connecting;
  connecting = (async () => {
    if (!(await has({ permissions: ['nativeMessaging'] }))) {
      lastError = 'permission';
      return false;
    }
    let p: chrome.runtime.Port;
    try {
      p = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'connect failed';
      return false;
    }
    port = p;
    const greeted = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), HELLO_TIMEOUT_MS);
      p.onMessage.addListener((raw: unknown) => {
        const m = parseAppMessage(raw);
        if (!m) return log.warn('desktop app: a message this version does not understand');
        if (m.type === 'hello') {
          hello = { appVersion: m.appVersion, ffmpeg: m.ffmpeg };
          clearTimeout(timer);
          return resolve(true);
        }
        dispatch(m);
      });
      p.onDisconnect.addListener(() => {
        lastError = chrome.runtime.lastError?.message ?? 'disconnected';
        if (port === p) {
          port = undefined;
          hello = undefined;
        }
        clearTimeout(timer);
        resolve(false);
        for (const [jobId, answer] of answers)
          answer({ type: 'error', jobId, code: 'desktop', message: lastError });
        answers.clear();
      });
    });
    post({ type: 'hello', extVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
    const ok = await greeted;
    if (!ok && port === p) {
      p.disconnect();
      port = undefined;
    }
    if (ok) lastError = undefined;
    return ok;
  })();
  try {
    return await connecting;
  } finally {
    connecting = undefined;
  }
}

/** The cookies of the origins this job was granted, as `Cookie` headers. Nothing without the cookies permission. */
async function cookiesFor(origins: string[]): Promise<Array<{ origin: string; header: string }>> {
  if (origins.length === 0 || !(await has({ permissions: ['cookies'] }))) return [];
  const out: Array<{ origin: string; header: string }> = [];
  for (const origin of origins) {
    const url = parseUrl(`${origin}/`);
    if (!url || !(url.protocol === 'https:' || url.protocol === 'http:')) continue;
    // reading a site's cookies needs access to that site, which only the user grants
    if (!(await has({ origins: [`${url.origin}/*`] }))) continue;
    const header = cookieHeader(await chrome.cookies.getAll({ url: url.href }));
    if (header) out.push({ origin: url.origin, header });
  }
  return out;
}

/** The app asked again (it restarted and keeps no cookies): only for a job it runs for us, and its granted origins. */
async function sendCookies(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job?.viaDesktop) return;
  post({ type: 'cookies', jobId, cookies: await cookiesFor(job.request.credentialedOrigins ?? []) });
}

export type HandOver = { ok: true; stages: JobStage[] } | { ok: false; code: JobErrorCode; message: string };

/** Hand a job to the app and wait for it to accept or refuse it. */
export async function handOver(job: DownloadJob): Promise<HandOver> {
  if (idleTimer) clearTimeout(idleTimer);
  if (!(await connectDesktop()))
    return { ok: false, code: 'desktop', message: lastError ?? 'The desktop app did not answer' };
  const req = job.request;
  const replay = replayHeadersFor(req.replay?.frameUrl);
  const answer = new Promise<AppMessage>((resolve) => {
    answers.set(job.id, resolve);
    setTimeout(() => {
      if (answers.delete(job.id))
        resolve({ type: 'error', jobId: job.id, code: 'desktop', message: 'The desktop app did not answer' });
    }, ANSWER_TIMEOUT_MS);
  });
  const sent = post({
    type: 'run-job',
    jobId: job.id,
    request: req,
    headers: { ...(replay ?? {}), userAgent: navigator.userAgent },
    cookies: await cookiesFor(req.credentialedOrigins ?? []),
  });
  if (!sent) {
    answers.delete(job.id);
    return { ok: false, code: 'desktop', message: 'The desktop app is not connected' };
  }
  const m = await answer;
  if (m.type === 'accepted') return { ok: true, stages: m.stages };
  return m.type === 'error'
    ? { ok: false, code: m.code, message: m.message }
    : { ok: false, code: 'desktop', message: 'Unexpected answer' };
}

/** Pause, resume, cancel or stop a job the app runs. */
export async function controlInDesktop(
  jobId: string,
  action: 'pause' | 'resume' | 'cancel' | 'stop',
): Promise<boolean> {
  return (await connectDesktop()) && post({ type: action, jobId });
}

/** Ask the app where these jobs are (after the worker restarted); the answer arrives as a `status` message. */
export async function askStatus(jobIds: string[]): Promise<boolean> {
  if (jobIds.length === 0) return true;
  return (await connectDesktop()) && post({ type: 'status', jobIds });
}

const busy = async () => (await listJobs()).some((j) => j.viaDesktop && isActive(j));

/** Close the port a little after no job needs the app any more, so the worker can sleep. */
export async function releaseIfIdle(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  if (!port || (await busy())) return;
  idleTimer = setTimeout(() => {
    void (async () => {
      if (await busy()) return;
      port?.disconnect();
      port = undefined;
      hello = undefined;
    })();
  }, IDLE_CLOSE_MS);
}

/** For the options page: on, reachable, and which app and ffmpeg answered. */
export async function desktopStatus(): Promise<DesktopStatus> {
  const s = await loadDesktop();
  if (!s.enabled) return { enabled: false, connected: false };
  const connected = await connectDesktop();
  if (connected) await releaseIfIdle();
  return {
    enabled: true,
    connected,
    ...(hello ? { appVersion: hello.appVersion, ffmpeg: hello.ffmpeg } : {}),
    ...(connected || !lastError ? {} : { error: lastError }),
  };
}

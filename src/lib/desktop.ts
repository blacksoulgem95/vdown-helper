/**
 * The desktop app link, the parts without Chrome APIs: the settings, which downloads go to the app, the messages it
 * sends (checked before anything is believed), and the Cookie header handed over for one job. Protocol: docs/desktop.md.
 */
import type { Plan } from './compat';
import type { DownloadRequest, JobErrorCode, JobProgress, JobStage } from '@/types/download';
import type { AppJobStatus, AppMessage, DesktopRouting, DesktopSettings } from '@/types/desktop';

/** The native messaging host the app registers with the browser. */
export const HOST_NAME = 'io.github.blacksoulgem95.vdownhelper';
export const PROTOCOL_VERSION = 1;
export const DESKTOP_KEY = 'desktop';
export const DEFAULT_DESKTOP: DesktopSettings = { enabled: false, routing: 'streams' };
export const ROUTINGS: readonly DesktopRouting[] = ['never', 'streams', 'always'];

export function sanitizeDesktop(raw: unknown): DesktopSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    enabled: r['enabled'] === true,
    routing: ROUTINGS.includes(r['routing'] as DesktopRouting)
      ? (r['routing'] as DesktopRouting)
      : DEFAULT_DESKTOP.routing,
  };
}

/** Media only the page holds (and ZIPs of page files, and subtitles) are never handed over. */
export function canHandOver(req: DownloadRequest): boolean {
  return !req.held && !req.zip && !req.capture && !req.record && !req.subtitle;
}

/**
 * Whether a download goes to the desktop app: when it is on, for what the routing setting names, or when the user
 * pressed "Send to desktop app" on the card.
 */
export function routeToDesktop(
  req: DownloadRequest,
  plan: Pick<Plan, 'requiresFfmpeg'>,
  settings: DesktopSettings,
  explicit: boolean,
): boolean {
  if (!settings.enabled || !canHandOver(req)) return false;
  if (explicit) return true;
  switch (settings.routing) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'streams':
      return req.isHls || req.isDash === true || plan.requiresFfmpeg;
  }
}

/** A `Cookie` header from the browser's cookies, leaving out any that could not be sent as they are. */
export function cookieHeader(cookies: ReadonlyArray<{ name: string; value: string }>): string {
  const safe = (s: string) => !/[;\r\n\0]/.test(s);
  return cookies
    .filter((c) => c.name !== '' && safe(c.name) && safe(c.value))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

const STAGES: readonly JobStage[] = [
  'detected',
  'preparing',
  'downloading',
  'recording',
  'merging',
  'encoding',
  'completed',
  'failed',
  'cancelled',
];
const CODES: readonly JobErrorCode[] = [
  'cors',
  'http-error',
  'network',
  'protected',
  'too-large',
  'out-of-memory',
  'ffmpeg',
  'decrypt',
  'chrome-download',
  'capture',
  'interrupted',
  'invalid',
  'desktop',
  'unknown',
];
const PROGRESS_KEYS = [
  'fraction',
  'bytesDone',
  'bytesTotal',
  'bytesPerSecond',
  'etaSeconds',
  'unitsDone',
  'unitsTotal',
  'elapsedSec',
] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const stage = (v: unknown): JobStage | undefined =>
  STAGES.includes(v as JobStage) ? (v as JobStage) : undefined;
const stages = (v: unknown): JobStage[] | undefined =>
  Array.isArray(v) && v.every((s) => stage(s)) ? (v as JobStage[]) : undefined;
const code = (v: unknown): JobErrorCode =>
  CODES.includes(v as JobErrorCode) ? (v as JobErrorCode) : 'unknown';

/** Only the known numeric fields, each a finite number (and a fraction between 0 and 1). */
function progress(v: unknown): JobProgress {
  const out: JobProgress = {};
  if (!isObj(v)) return out;
  for (const k of PROGRESS_KEYS) {
    const n = num(v[k]);
    if (n !== undefined && n >= 0) out[k] = k === 'fraction' ? Math.min(1, n) : n;
  }
  return out;
}

function jobStatus(v: unknown): AppJobStatus | undefined {
  if (!isObj(v)) return undefined;
  const jobId = str(v['jobId']);
  const s = v['stage'] === 'gone' ? 'gone' : stage(v['stage']);
  if (!jobId || !s) return undefined;
  const out: AppJobStatus = { jobId, stage: s };
  if (typeof v['paused'] === 'boolean') out.paused = v['paused'];
  if (isObj(v['progress'])) out.progress = progress(v['progress']);
  const st = stages(v['stages']);
  if (st) out.stages = st;
  const path = str(v['path']);
  if (path) out.path = path;
  const bytes = num(v['bytes']);
  if (bytes !== undefined) out.bytes = bytes;
  if (isObj(v['error']))
    out.error = { code: code(v['error']['code']), message: str(v['error']['message']) ?? '' };
  return out;
}

/** A message from the app, or `undefined` when it is not one this version understands. */
export function parseAppMessage(raw: unknown): AppMessage | undefined {
  if (!isObj(raw) || raw['v'] !== PROTOCOL_VERSION) return undefined;
  const jobId = str(raw['jobId']);
  switch (raw['type']) {
    case 'hello': {
      const appVersion = str(raw['appVersion']);
      return appVersion ? { type: 'hello', appVersion, ffmpeg: str(raw['ffmpeg']) ?? null } : undefined;
    }
    case 'accepted': {
      const st = stages(raw['stages']);
      return jobId && st ? { type: 'accepted', jobId, stages: st } : undefined;
    }
    case 'stage': {
      const s = stage(raw['stage']);
      return jobId && s ? { type: 'stage', jobId, stage: s } : undefined;
    }
    case 'progress':
      return jobId ? { type: 'progress', jobId, progress: progress(raw['progress']) } : undefined;
    case 'done': {
      const path = str(raw['path']);
      if (!jobId || !path) return undefined;
      const bytes = num(raw['bytes']);
      return { type: 'done', jobId, path, ...(bytes === undefined ? {} : { bytes }) };
    }
    case 'error':
      return {
        type: 'error',
        ...(jobId ? { jobId } : {}),
        code: code(raw['code']),
        message: str(raw['message']) ?? '',
      };
    case 'cancelled':
      return jobId ? { type: 'cancelled', jobId } : undefined;
    case 'needs-cookies': {
      const origins = raw['origins'];
      return jobId && Array.isArray(origins) && origins.every((o) => typeof o === 'string')
        ? { type: 'needs-cookies', jobId, origins: origins as string[] }
        : undefined;
    }
    case 'status': {
      const jobs = Array.isArray(raw['jobs']) ? raw['jobs'].map(jobStatus) : undefined;
      return jobs?.every(Boolean) ? { type: 'status', jobs: jobs as AppJobStatus[] } : undefined;
    }
    default:
      return undefined;
  }
}

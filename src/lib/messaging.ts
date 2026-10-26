import { isExtensionPage } from './security';
import type { Envelope, RequestMap, RequestType, Result } from '@/types/messages';

/** Typed wrapper over chrome.runtime.sendMessage. Never throws: transport failures become `{ ok: false }`. */
export async function send<K extends RequestType>(
  type: K,
  payload: RequestMap[K]['req'],
): Promise<RequestMap[K]['res']> {
  const envelope: Envelope<K> = { channel: 'vdown', type, payload };
  try {
    const res = (await chrome.runtime.sendMessage(envelope)) as RequestMap[K]['res'] | undefined;
    if (!res || typeof res !== 'object' || typeof (res as { ok?: unknown }).ok !== 'boolean') {
      return { ok: false, error: 'No response from the background service' } as RequestMap[K]['res'];
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Message failed' } as RequestMap[K]['res'];
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 8192;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

const ACTIONS = ['cancel', 'retry', 'pause', 'resume', 'remove', 'stop'];
const MODES = ['video-audio', 'audio-only', 'video-only', 'original'];
const CONTAINERS = ['mp4', 'mkv', 'ts', 'original'];
const AUDIO = ['mp3', 'm4a', 'aac', 'wav'];
const BITRATES = [128, 192, 256, 320];

/** Runtime validation of untrusted message payloads (anything can message an extension from its own pages). */
const validators: { [K in RequestType]: (p: unknown) => p is RequestMap[K]['req'] } = {
  scan: (p): p is RequestMap['scan']['req'] => isObj(p) && isInt(p['tabId']),
  'add-url': (p): p is RequestMap['add-url']['req'] => isObj(p) && isInt(p['tabId']) && isStr(p['url']),
  'get-state': (p): p is RequestMap['get-state']['req'] => isObj(p) && isInt(p['tabId']),
  'inspect-variant': (p): p is RequestMap['inspect-variant']['req'] =>
    isObj(p) && isInt(p['tabId']) && isStr(p['url']) && (p['frameId'] === undefined || isInt(p['frameId'])),
  'start-download': (p): p is RequestMap['start-download']['req'] => {
    if (!isObj(p) || !isObj(p['request'])) return false;
    const r = p['request'];
    return (
      isStr(r['resourceId']) &&
      isStr(r['sourceUrl']) &&
      (r['audioUrl'] === undefined || isStr(r['audioUrl'])) &&
      isInt(r['tabId']) &&
      isStr(r['filename']) &&
      typeof r['subfolder'] === 'string' &&
      MODES.includes(r['mode'] as string) &&
      CONTAINERS.includes(r['container'] as string) &&
      AUDIO.includes(r['audioFormat'] as string) &&
      BITRATES.includes(r['audioBitrate'] as number) &&
      typeof r['isHls'] === 'boolean' &&
      (r['isDash'] === undefined || typeof r['isDash'] === 'boolean')
    );
  },
  'job-action': (p): p is RequestMap['job-action']['req'] =>
    isObj(p) && isStr(p['jobId']) && ACTIONS.includes(p['action'] as string),
  'clear-history': (p): p is RequestMap['clear-history']['req'] => isObj(p),
  'get-jobs': (p): p is RequestMap['get-jobs']['req'] => isObj(p),
  'set-observer': (p): p is RequestMap['set-observer']['req'] =>
    isObj(p) && typeof p['enabled'] === 'boolean',
  'sync-hook': (p): p is RequestMap['sync-hook']['req'] => isObj(p),
};

export function parseEnvelope(raw: unknown): Envelope | undefined {
  if (!isObj(raw) || raw['channel'] !== 'vdown' || typeof raw['type'] !== 'string') return undefined;
  const type = raw['type'] as RequestType;
  const validate = validators[type] as ((p: unknown) => boolean) | undefined;
  if (!validate || !validate(raw['payload'])) return undefined;
  return raw as unknown as Envelope;
}

export type Handler<K extends RequestType> = (
  payload: RequestMap[K]['req'],
  sender: chrome.runtime.MessageSender,
) => Promise<RequestMap[K]['res']>;

export type Handlers = { [K in RequestType]: Handler<K> };

/** Registers the single runtime.onMessage listener, rejecting malformed and foreign messages. */
export function registerHandlers(handlers: Handlers): void {
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    // Only this extension's own pages may drive it (no externally_connectable is declared).
    if (!isExtensionPage(sender)) return false;
    const envelope = parseEnvelope(raw);
    if (!envelope) return false;
    const handler = handlers[envelope.type] as Handler<RequestType>;
    handler(envelope.payload, sender).then(sendResponse, (e: unknown) =>
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : 'Internal error',
      } satisfies Result<never>),
    );
    return true; // async response
  });
}

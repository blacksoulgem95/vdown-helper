import {
  AudioLines,
  ChevronDown,
  Copy,
  Download,
  Film,
  KeyRound,
  Layers,
  Radio,
  ListMusic,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { useId, useState } from 'react';
import { formatBitrate, formatBytes, formatDuration, resolutionLabel } from '@/lib/media';
import { parseUrl, redactUrl } from '@/lib/security';
import { t } from '@/lib/i18n';
import type { MediaResource } from '@/types/media';
import { kindLabel, reasonText, statusBadge } from './labels';
import { Badge, Button, Notice, cx } from './ui';

/** Where page-held bytes come from, in words. */
export const heldSource = (r: MediaResource): string =>
  r.held?.kind === 'blob'
    ? t('sourceBlob')
    : r.held?.kind === 'stream'
      ? t('sourceStream')
      : t('sourceInline');

/** Short, token-free hint of where a resource lives, to tell apart cards that share a page title. */
function sourceHint(r: MediaResource): string {
  if (r.held) return heldSource(r);
  const u = parseUrl(r.url);
  if (!u) return '';
  const tail = u.pathname.split('/').filter(Boolean).slice(-2).join('/');
  const page = parseUrl(r.pageUrl);
  return `${u.hostname !== page?.hostname ? `${u.host} › ` : ''}${tail}`;
}

function FormatIcon({ r }: { r: MediaResource }) {
  const common = { size: 18, 'aria-hidden': true } as const;
  if (r.downloadability.status === 'protected') return <KeyRound {...common} />;
  if (r.kind === 'hls-master' || r.kind === 'hls-media') return <Layers {...common} />;
  if (r.kind === 'unsupported-playlist') return <ListMusic {...common} />;
  return r.mediaType === 'audio' ? <AudioLines {...common} /> : <Film {...common} />;
}

const DETECTION_KEY = {
  'dom-element': 'detectDomElement',
  'dom-source': 'detectDomSource',
  'dom-link': 'detectDomLink',
  'dom-track': 'detectDomTrack',
  'dom-image': 'detectDomImage',
  'dom-style': 'detectDomStyle',
  'dom-meta': 'detectDomMeta',
  performance: 'detectPerformance',
  network: 'detectNetwork',
  hook: 'detectHook',
  'manual-rescan': 'detectManual',
} as const;

export interface MediaCardProps {
  resource: MediaResource;
  busy?: boolean;
  feedback?: { tone: 'danger' | 'acid'; text: string };
  onDownload: (r: MediaResource) => void;
  onConfigure: (r: MediaResource) => void;
  onGrantAccess: (r: MediaResource) => void;
  /** MediaSource players are captured (the page plays the video through), not downloaded. */
  onCapture?: (r: MediaResource, speed: 'fast' | 'realtime') => void;
  /** MediaStreams are recorded until the user stops them. */
  onRecord?: (r: MediaResource) => void;
}

export function MediaCard({
  resource: r,
  busy,
  feedback,
  onDownload,
  onConfigure,
  onGrantAccess,
  onCapture,
  onRecord,
}: MediaCardProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const badge = statusBadge(r.downloadability);
  const ok = r.downloadability.status === 'downloadable';
  const res = resolutionLabel(r.height, r.width);
  const size =
    r.sizeBytes !== undefined
      ? `${r.sizeIsEstimate ? '≈ ' : ''}${formatBytes(r.sizeBytes)}`
      : t('sizeUnknown');
  const canGrant = r.downloadability.status === 'inaccessible' && r.downloadability.reason === 'cors';

  return (
    <li className="glass p-3" data-resource-id={r.id}>
      <div className="flex gap-3">
        <div
          className={cx(
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border',
            ok ? 'border-neon/35 text-neon' : 'border-white/12 text-muted',
          )}
        >
          <FormatIcon r={r} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-medium text-fg" title={r.title}>
            {r.title}
          </h3>
          <p className="mono truncate text-[10.5px] text-muted" title={redactUrl(r.url)}>
            {sourceHint(r)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge tone="neon">{r.format === 'unknown' ? '?' : r.format.toUpperCase()}</Badge>
            {res && <Badge tone="magenta">{res}</Badge>}
            <Badge>{kindLabel(r)}</Badge>
            {r.variants.length > 0 && <Badge>{t('variantsCount', r.variants.length)}</Badge>}
            <Badge tone={badge.tone}>{badge.text}</Badge>
          </div>
          <p className="mono mt-1.5 text-[11px] text-muted">
            <span className={r.sizeBytes === undefined ? 'text-muted' : 'text-fg/80'}>{size}</span>
            {r.durationSec ? <span> · {formatDuration(r.durationSec)}</span> : null}
            {r.bitrate ? <span> · {formatBitrate(r.bitrate)}</span> : null}
          </p>
        </div>
      </div>

      {!ok && (
        <p className="mt-2 text-[11px] leading-snug text-muted" id={`${panelId}-why`}>
          {reasonText(r.downloadability)}
        </p>
      )}
      {feedback && (
        <div className="mt-2">
          <Notice tone={feedback.tone} role={feedback.tone === 'danger' ? 'alert' : 'status'}>
            {feedback.text}
          </Notice>
        </div>
      )}

      {r.held?.kind === 'mse' || r.held?.kind === 'stream' ? (
        <div className="mt-2.5 space-y-2">
          {ok && r.held.kind === 'stream' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => onRecord?.(r)}
                disabled={busy}
                icon={<Radio size={13} aria-hidden="true" />}
              >
                {busy ? t('working') : t('recordStart')}
              </Button>
            </div>
          )}
          {ok && r.held.kind === 'stream' && (
            <p className="text-[10.5px] leading-snug text-muted">{t('recordHint')}</p>
          )}
          {ok && r.held.kind === 'mse' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => onCapture?.(r, 'fast')}
                disabled={busy}
                icon={<Download size={13} aria-hidden="true" />}
              >
                {busy ? t('working') : t('captureFast')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => onCapture?.(r, 'realtime')}
                disabled={busy}
                icon={<Radio size={13} aria-hidden="true" />}
              >
                {t('captureRealtime')}
              </Button>
            </div>
          )}
          {ok && r.held.kind === 'mse' && (
            <p className="text-[10.5px] leading-snug text-muted">{t('captureHint')}</p>
          )}
          <button
            type="button"
            className="mono inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] uppercase tracking-wider text-muted hover:text-neon"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
          >
            {t('details')}
            <ChevronDown
              size={12}
              aria-hidden="true"
              className={cx('transition-transform', open && 'rotate-180')}
            />
          </button>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-2">
          <Button
            variant="primary"
            onClick={() => onDownload(r)}
            disabled={!ok || busy}
            icon={<Download size={13} aria-hidden="true" />}
          >
            {busy ? t('working') : t('download')}
          </Button>
          {canGrant ? (
            <Button
              variant="secondary"
              onClick={() => onGrantAccess(r)}
              icon={<ShieldCheck size={13} aria-hidden="true" />}
            >
              {t('allowAccess')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => onConfigure(r)}
              disabled={!ok}
              icon={<Settings2 size={13} aria-hidden="true" />}
            >
              {t('configure')}
            </Button>
          )}
          <button
            type="button"
            className="mono ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] uppercase tracking-wider text-muted hover:text-neon"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
          >
            {t('details')}
            <ChevronDown
              size={12}
              aria-hidden="true"
              className={cx('transition-transform', open && 'rotate-180')}
            />
          </button>
        </div>
      )}

      {open && (
        <dl
          id={panelId}
          className="mono mt-3 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 border-t border-white/8 pt-3 text-[11px]"
        >
          <Row k={t('detailSource')} v={r.url ? redactUrl(r.url) : ''} />
          <Row k={t('detailDetectedBy')} v={r.detectedBy.map((m) => t(DETECTION_KEY[m])).join(', ')} />
          <Row k={t('detailStatus')} v={reasonText(r.downloadability)} />
          {r.mimeType && <Row k="MIME" v={r.mimeType} />}
          {r.codecs && <Row k={t('detailCodecs')} v={r.codecs} />}
          {r.frameRate && <Row k={t('detailFps')} v={String(r.frameRate)} />}
          {r.playlist?.segmentCount !== undefined && (
            <Row
              k={t('detailSegments')}
              v={`${r.playlist.segmentCount}${r.playlist.targetDuration ? ` · ${r.playlist.targetDuration}s` : ''}`}
            />
          )}
          {r.playlist && r.playlist.encryption.length > 0 && (
            <Row k={t('detailEncryption')} v={r.playlist.encryption.join(', ')} />
          )}
          {r.audioTracks.length > 0 && (
            <Row k={t('detailAudio')} v={r.audioTracks.map((a) => a.name).join(', ')} />
          )}
          {r.variants.length > 0 && (
            <>
              <dt className="text-muted">{t('detailVariants')}</dt>
              <dd className="space-y-0.5">
                {r.variants.map((v) => (
                  <div key={v.uri} className="text-fg/85">
                    {resolutionLabel(v.height, v.width) || '—'} ·{' '}
                    {formatBitrate(v.averageBandwidth ?? v.bandwidth)}
                    {v.codecs ? <span className="text-muted"> · {v.codecs}</span> : null}
                  </div>
                ))}
              </dd>
            </>
          )}
          <dt className="text-muted">URL</dt>
          <dd>
            {r.held ? (
              <span className="text-fg/85">{heldSource(r)}</span>
            ) : (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-neon hover:underline"
                onClick={() => void navigator.clipboard.writeText(r.url)}
              >
                <Copy size={11} aria-hidden="true" />
                {t('copyUrl')}
              </button>
            )}
          </dd>
        </dl>
      )}
    </li>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="break-all text-fg/85">{v}</dd>
    </>
  );
}

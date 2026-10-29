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
  MonitorDown,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { useId, useState } from 'react';
import { formatBitrate, formatBytes, formatDuration, resolutionLabel } from '@/lib/media';
import { parseUrl, redactUrl } from '@/lib/security';
import { t } from '@/lib/i18n';
import type { MediaResource } from '@/types/media';
import { cardHeadline, reasonText, statusBadge } from './labels';
import { Badge, Button, IconButton, Notice, cx } from './ui';

/** Where page-held bytes come from, in words. */
export const heldSource = (r: MediaResource): string =>
  r.held?.kind === 'mse'
    ? t('sourceMse')
    : r.held?.kind === 'blob'
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
  metadata: 'detectMetadata',
  'site-api': 'detectSiteApi',
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
  /** The one card the popup recommends: marked and set apart, so the right download is one click away. */
  best?: boolean;
  /** A player the page hook could not watch: allow its site (and turn the hook on) as needed, then reload. */
  onFixPlayer?: (r: MediaResource) => void;
  /** Hand this one to the desktop app (shown while the app is on). */
  onSendToDesktop?: (r: MediaResource) => void;
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
  best,
  onFixPlayer,
  onSendToDesktop,
}: MediaCardProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const badge = statusBadge(r.downloadability);
  // A live or event stream cannot be downloaded, but it can be recorded as it goes by.
  const liveRecordable =
    r.downloadability.status === 'downloadable' && r.downloadability.detail === 'live-recordable';
  const ok = r.downloadability.status === 'downloadable';
  const size = r.sizeBytes !== undefined ? `${r.sizeIsEstimate ? '≈ ' : ''}${formatBytes(r.sizeBytes)}` : '';
  // Only what is known, and only chips that change what the user can do.
  const meta = [
    size,
    r.durationSec ? formatDuration(r.durationSec) : '',
    r.bitrate ? formatBitrate(r.bitrate) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const subtitle = [r.title, sourceHint(r)].filter(Boolean).join(' · ');
  const canGrant = r.downloadability.status === 'inaccessible' && r.downloadability.reason === 'cors';
  const fix = r.downloadability.reason;
  const playerFix =
    !ok && (fix === 'mse-needs-hook' || fix === 'mse-needs-access' || fix === 'mse-needs-reload')
      ? fix
      : undefined;

  return (
    <li
      className={cx('glass p-3', best && 'border-magenta/45 shadow-[0_0_22px_rgba(255,43,214,0.12)]')}
      data-resource-id={r.id}
      data-best={best ? 'true' : undefined}
    >
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
          {(best || !ok) && (
            <div className="mb-1 flex flex-wrap items-center gap-1">
              {best && <Badge tone="magenta">{t('bestMatch')}</Badge>}
              {!ok && <Badge tone={badge.tone}>{badge.text}</Badge>}
            </div>
          )}
          <h3 className="mono truncate text-[13px] font-medium text-fg">{cardHeadline(r)}</h3>
          <p className="truncate text-[11px] text-muted" title={`${r.title} · ${redactUrl(r.url)}`}>
            {subtitle}
          </p>
          {meta && <p className="mono mt-1 text-[11px] text-fg/80">{meta}</p>}
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

      {r.held?.kind === 'mse' || r.held?.kind === 'stream' || liveRecordable ? (
        <div className="mt-2.5 space-y-2">
          {playerFix && onFixPlayer && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => onFixPlayer(r)}
                disabled={busy}
                icon={<ShieldCheck size={13} aria-hidden="true" />}
              >
                {playerFix === 'mse-needs-reload' ? t('reloadPage') : t('allowAndReload')}
              </Button>
            </div>
          )}
          {ok && (r.held?.kind === 'stream' || liveRecordable) && (
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
          {ok && (r.held?.kind === 'stream' || liveRecordable) && (
            <p className="text-[10.5px] leading-snug text-muted">
              {liveRecordable ? t('recordLiveHint') : t('recordHint')}
            </p>
          )}
          {ok && r.held?.kind === 'mse' && (
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
          {ok && r.held?.kind === 'mse' && (
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
          {onSendToDesktop && ok && !r.held && r.kind !== 'subtitle' && (
            <IconButton label={t('sendToDesktop')} onClick={() => onSendToDesktop(r)} disabled={busy}>
              <MonitorDown size={14} aria-hidden="true" />
            </IconButton>
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

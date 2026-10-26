import { t, type MessageKey } from '@/lib/i18n';
import type { DownloadJob, JobStage } from '@/types/download';
import type { Downloadability, MediaResource, ReasonCode } from '@/types/media';

type Tone = 'neon' | 'magenta' | 'acid' | 'muted' | 'danger';

export function statusBadge(d: Downloadability): { tone: Tone; text: string } {
  switch (d.status) {
    case 'downloadable':
      return { tone: 'acid', text: t('statusDownloadable') };
    case 'protected':
      return { tone: 'magenta', text: t('statusProtected') };
    case 'inaccessible':
      return { tone: 'danger', text: t('statusInaccessible') };
    case 'unsupported':
      return { tone: 'muted', text: t('statusUnsupported') };
    default:
      return { tone: 'muted', text: t('statusUnverified') };
  }
}

const REASONS: Record<ReasonCode, MessageKey> = {
  ok: 'reasonOk',
  'not-probed': 'reasonNotProbed',
  'blob-source': 'reasonBlob',
  drm: 'reasonDrm',
  'sample-aes': 'reasonSampleAes',
  eme: 'reasonEme',
  'dash-clearkey': 'reasonDashClearKey',
  'subtitle-unsupported': 'reasonSubtitleUnsupported',
  'too-large': 'reasonTooLarge',
  'mse-needs-hook': 'reasonMseNeedsHook',
  'mse-unrecordable': 'reasonMseUnrecordable',
  cors: 'reasonCors',
  'http-error': 'reasonHttp',
  network: 'reasonNetwork',
  dash: 'reasonDash',
  'plain-m3u': 'reasonPlainM3u',
  malformed: 'reasonMalformed',
  live: 'reasonLive',
  'unsafe-url': 'reasonUnsafe',
  'unsupported-format': 'reasonUnsupportedFormat',
  'aes-key-inaccessible': 'reasonKeyInaccessible',
  'no-segments': 'reasonNoSegments',
};

export function reasonText(d: Downloadability): string {
  const base = t(REASONS[d.reason]);
  if (d.reason === 'http-error' && d.detail) return `${base} (${d.detail})`;
  if (d.status === 'downloadable' && d.detail === 'aes-128') return t('reasonAes128');
  if (d.status === 'downloadable' && d.detail === 'headers-unreadable') return t('reasonHeadersUnreadable');
  if (d.status === 'downloadable' && d.detail === 'in-page-data') return t('reasonInPageData');
  if (d.status === 'downloadable' && d.detail === 'in-page-blob') return t('reasonInPageBlob');
  if (d.status === 'downloadable' && d.detail === 'mse-capturable') return t('reasonMseCapturable');
  if (d.status === 'downloadable' && d.detail === 'live-recordable') return t('reasonLiveRecordable');
  if (d.status === 'downloadable' && d.detail === 'stream-recordable') return t('reasonStreamRecordable');
  return base;
}

export function kindLabel(r: MediaResource): string {
  switch (r.kind) {
    case 'hls-master':
      return t('kindHlsMaster');
    case 'hls-media':
      return t('kindHlsMedia');
    case 'dash':
      return t('kindDashStream');
    case 'unsupported-playlist':
      return r.playlist?.playlistClass === 'm3u-plain'
        ? t('kindPlainM3u')
        : r.playlist?.playlistClass === 'dash'
          ? t('kindDash')
          : t('kindPlaylist');
    case 'blob':
      return r.held?.kind === 'stream' ? t('kindStream') : t('kindBlob');
    case 'image':
      return t('kindImage');
    case 'document':
      return t('kindDocument');
    case 'archive':
      return t('kindArchive');
    case 'asset':
      return t('kindAsset');
    case 'subtitle':
      return r.format === 'hls' || r.format === 'dash' ? t('kindSubtitleStream') : t('kindSubtitle');
    default:
      return t('kindFile');
  }
}

const STAGES: Record<JobStage, MessageKey> = {
  detected: 'stageDetected',
  preparing: 'stagePreparing',
  downloading: 'stageDownloading',
  merging: 'stageMerging',
  recording: 'stageRecording',
  encoding: 'stageEncoding',
  completed: 'stageCompleted',
  failed: 'stageFailed',
  cancelled: 'stageCancelled',
};
export const stageLabel = (s: JobStage): string => t(STAGES[s]);

export function jobErrorText(job: DownloadJob): string {
  const e = job.error;
  if (!e) return '';
  const map: Record<string, MessageKey> = {
    cors: 'jobErrCors',
    'http-error': 'jobErrHttp',
    network: 'jobErrNetwork',
    protected: 'errProtected',
    'too-large': 'issueTooLarge',
    'out-of-memory': 'jobErrMemory',
    ffmpeg: 'jobErrFfmpeg',
    decrypt: 'jobErrDecrypt',
    'chrome-download': 'jobErrChrome',
    interrupted: 'jobErrInterrupted',
    invalid: 'jobErrInvalid',
    capture: 'jobErrCapture',
  };
  if (e.code === 'too-large' && job.request.zip) return t('zipTooLarge');
  const key = map[e.code];
  const base = key ? t(key) : t('errGeneric');
  return e.code === 'http-error' ||
    e.code === 'chrome-download' ||
    e.code === 'ffmpeg' ||
    e.code === 'capture'
    ? `${base} (${e.message.slice(0, 120)})`
    : base;
}

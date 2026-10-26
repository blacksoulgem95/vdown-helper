import { FolderOpen, Pause, Play, RotateCcw, Save, Square, Trash2, X } from 'lucide-react';
import { formatBytes, formatDuration, formatSpeed } from '@/lib/media';
import { canRetry, canStop, isActive, isQueued, isTerminal } from '@/lib/queue';
import { t } from '@/lib/i18n';
import type { DownloadJob } from '@/types/download';
import { StageTrack } from './StageTrack';
import { jobErrorText } from './labels';
import { IconButton, ProgressBar, cx } from './ui';

export type JobAction = 'cancel' | 'retry' | 'pause' | 'resume' | 'open' | 'show' | 'remove' | 'stop';

function stats(job: DownloadJob): string {
  const p = job.progress;
  const parts: string[] = [];
  if (p.bytesDone !== undefined)
    parts.push(
      p.bytesTotal !== undefined
        ? `${formatBytes(p.bytesDone)} / ${formatBytes(p.bytesTotal)}`
        : formatBytes(p.bytesDone),
    );
  if (p.elapsedSec !== undefined) parts.unshift(formatDuration(p.elapsedSec));
  if (p.unitsTotal !== undefined && p.unitsDone !== undefined)
    parts.push(t('segmentsProgress', p.unitsDone, p.unitsTotal));
  const speed = formatSpeed(p.bytesPerSecond);
  if (speed && isActive(job) && !job.paused) parts.push(speed);
  if (p.etaSeconds !== undefined && isActive(job) && !job.paused)
    parts.push(`${t('eta')} ${formatDuration(p.etaSeconds)}`);
  return parts.join(' · ');
}

export function QueueItem({
  job,
  onAction,
}: {
  job: DownloadJob;
  onAction: (id: string, a: JobAction) => void;
}) {
  const active = isActive(job);
  const done = job.stage === 'completed';
  const tone =
    job.stage === 'failed'
      ? 'danger'
      : done
        ? 'acid'
        : job.stage === 'merging' || job.stage === 'encoding' || job.stage === 'recording'
          ? 'magenta'
          : 'neon';
  const pct = job.progress.fraction !== undefined ? `${Math.round(job.progress.fraction * 100)}%` : '';
  const s = stats(job);
  return (
    <li className="glass p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-fg" title={job.request.filename}>
            {job.request.filename}
          </p>
          <p className="mono mt-0.5 text-[10.5px] text-muted">
            {job.request.qualityLabel}
            {job.request.mode === 'audio-only' ? ` · ${job.request.audioFormat.toUpperCase()}` : ''}
            {job.attempts > 0 ? ` · ${t('attempt', job.attempts + 1)}` : ''}
          </p>
        </div>
        <span className={cx('mono shrink-0 text-[11px]', done ? 'text-acid' : 'text-neon')} aria-live="off">
          {job.paused ? t('paused') : pct}
        </span>
      </div>

      <div className="mt-2">
        <StageTrack stages={job.stages} current={job.stage} />
      </div>
      {!isTerminal(job) && !isQueued(job) && (
        <div className="mt-2">
          <ProgressBar
            fraction={job.progress.fraction}
            label={job.request.filename}
            tone={tone}
            paused={job.paused}
          />
        </div>
      )}
      {s && <p className="mono mt-1.5 text-[10.5px] text-muted">{s}</p>}
      {job.stage === 'failed' && (
        <p role="alert" className="mt-1.5 text-[11.5px] leading-snug text-danger">
          {jobErrorText(job)}
        </p>
      )}
      {done && job.skipped ? (
        <p role="status" className="mt-1.5 text-[11px] leading-snug text-magenta">
          {t('jobSkipped', job.skipped)}
        </p>
      ) : null}
      {done && job.filePath && (
        <p className="mono mt-1.5 truncate text-[10.5px] text-muted" title={job.filePath}>
          {job.filePath.split(/[\\/]/).pop()}
        </p>
      )}

      <div className="mt-2 flex items-center justify-end gap-0.5">
        {job.canPause &&
          active &&
          job.chromeDownloadId !== undefined &&
          (job.paused ? (
            <IconButton label={t('resume')} onClick={() => onAction(job.id, 'resume')}>
              <Play size={14} aria-hidden="true" />
            </IconButton>
          ) : (
            <IconButton label={t('pause')} onClick={() => onAction(job.id, 'pause')}>
              <Pause size={14} aria-hidden="true" />
            </IconButton>
          ))}
        {canStop(job) && (
          <IconButton label={t('jobStop')} onClick={() => onAction(job.id, 'stop')}>
            <Save size={14} aria-hidden="true" />
          </IconButton>
        )}
        {(active || isQueued(job)) && (
          <IconButton label={t('cancel')} onClick={() => onAction(job.id, 'cancel')}>
            <Square size={13} aria-hidden="true" />
          </IconButton>
        )}
        {canRetry(job) && (
          <IconButton label={t('retry')} onClick={() => onAction(job.id, 'retry')}>
            <RotateCcw size={14} aria-hidden="true" />
          </IconButton>
        )}
        {done && (
          <>
            <IconButton label={t('openFile')} onClick={() => onAction(job.id, 'open')}>
              <Play size={14} aria-hidden="true" />
            </IconButton>
            <IconButton label={t('showInFolder')} onClick={() => onAction(job.id, 'show')}>
              <FolderOpen size={14} aria-hidden="true" />
            </IconButton>
          </>
        )}
        {isTerminal(job) && (
          <IconButton label={t('remove')} onClick={() => onAction(job.id, 'remove')}>
            {job.stage === 'completed' ? (
              <X size={14} aria-hidden="true" />
            ) : (
              <Trash2 size={14} aria-hidden="true" />
            )}
          </IconButton>
        )}
      </div>
    </li>
  );
}

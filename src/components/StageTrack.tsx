import type { JobStage } from '@/types/download';
import { t } from '@/lib/i18n';
import { stageLabel } from './labels';
import { cx } from './ui';

/** The stages this job actually passes through, with the current one lit. Nothing is simulated. */
export function StageTrack({ stages, current }: { stages: JobStage[]; current: JobStage }) {
  const failed = current === 'failed' || current === 'cancelled';
  const idx = stages.indexOf(current);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5" aria-label={t('stagesLabel')}>
      {stages.map((s, i) => {
        const reached = !failed && idx >= i;
        const active = !failed && idx === i && current !== 'completed';
        return (
          <li key={s} className="flex items-center gap-1">
            {i > 0 && (
              <span
                aria-hidden="true"
                className={cx('text-[9px]', reached ? 'text-neon/70' : 'text-white/15')}
              >
                ›
              </span>
            )}
            <span
              aria-current={active ? 'step' : undefined}
              className={cx(
                'mono text-[9px] uppercase tracking-wider',
                active ? 'text-neon' : reached ? 'text-acid/90' : 'text-muted',
              )}
            >
              {stageLabel(s)}
            </span>
          </li>
        );
      })}
      {failed && (
        <li className="mono ml-1 text-[9px] uppercase tracking-wider text-danger">{stageLabel(current)}</li>
      )}
    </ol>
  );
}

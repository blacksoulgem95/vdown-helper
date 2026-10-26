import { FileText, Play, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { kindLabel, reasonText } from '@/components/labels';
import { Badge, Button, Notice, Panel, SelectField, TextField, Toggle } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { t } from '@/lib/i18n';
import { formatBytes, formatDuration } from '@/lib/media';
import { buildRequest, defaultChoices, planFromRequest, type Choices } from '@/lib/request';
import { parseUrl, redactUrl } from '@/lib/security';
import {
  inspectForChoices,
  issueText,
  originsNeedingAccess,
  requestAccess,
  startFromChoices,
  type Inspections,
} from '@/lib/uiActions';
import type { MediaResource } from '@/types/media';

/** Studio form for a subtitle: choose the output format and the file name. Subtitles are small text, nothing else to tune. */
export function SubtitleForm({ resource }: { resource: MediaResource }) {
  const { settings, loaded } = useSettings();
  const [choices, setChoices] = useState<Choices>(() => defaultChoices(resource, settings));
  const [initialised, setInitialised] = useState(false);
  const [inspections, setInspections] = useState<Inspections>({});
  const [origins, setOrigins] = useState<string[]>([]);
  const [granted, setGranted] = useState<boolean | undefined>();
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<{ tone: 'acid' | 'danger'; text: string } | undefined>();

  useEffect(() => {
    if (loaded && !initialised) {
      setChoices(defaultChoices(resource, settings));
      setInitialised(true);
    }
  }, [loaded, initialised, resource, settings]);

  const segmented = resource.format === 'hls' || resource.format === 'dash';
  const req = buildRequest(resource, settings, choices);
  const plan = planFromRequest(req, {
    maxMemoryMb: settings.maxMemoryMb,
    maxEncodeDurationSec: settings.maxEncodeDurationSec,
  });

  // A segmented subtitle stream lists segments on other URLs: learn which origins need access.
  useEffect(() => {
    if (!segmented) return;
    let alive = true;
    void inspectForChoices(resource, settings, choices, false).then((r) => {
      if (alive && r.ok) setInspections(r.inspections);
    });
    return () => {
      alive = false;
    };
    // The URLs involved do not change with the output format.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id]);
  useEffect(() => {
    let alive = true;
    void originsNeedingAccess(inspections, resource.pageUrl).then((missing) => {
      if (!alive) return;
      setOrigins(missing);
      setGranted(missing.length === 0);
    });
    return () => {
      alive = false;
    };
  }, [inspections, result, resource.pageUrl]);

  const set = (patch: Partial<Choices>) => setChoices((c) => ({ ...c, ...patch }));
  const canKeep =
    segmented || resource.format === 'vtt' || resource.format === 'srt' || resource.format === 'ttml';
  const originalLabel = segmented
    ? t('subOutputOriginalStitched')
    : `${t('subOutputOriginal')} (${resource.format.toUpperCase()})`;

  const onStart = async () => {
    setStarting(true);
    setResult(undefined);
    try {
      const out = await startFromChoices(resource, settings, choices, inspections);
      setResult(out.ok ? { tone: 'acid', text: t('queuedOk') } : { tone: 'danger', text: out.error });
    } finally {
      setStarting(false);
    }
  };

  const grant = async () => {
    const ok = await requestAccess(origins);
    setGranted(ok);
    if (!ok) setResult({ tone: 'danger', text: t('errAccessDenied') });
  };

  return (
    <div className="space-y-3">
      <Panel className="overflow-hidden">
        <div className="flex gap-3 p-3">
          <div className="flex h-[56px] w-[56px] shrink-0 items-center justify-center rounded-md border border-neon/20 text-neon/70">
            <FileText size={24} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13.5px] font-medium" title={resource.title}>
              {resource.title}
            </h2>
            <p className="mono truncate text-[11px] text-neon/80">{resource.host}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Badge tone="neon">{resource.format.toUpperCase()}</Badge>
              <Badge>{kindLabel(resource)}</Badge>
              {resource.language ? <Badge>{resource.language}</Badge> : null}
              {resource.durationSec ? <Badge>{formatDuration(resource.durationSec)}</Badge> : null}
              {resource.sizeBytes !== undefined ? <Badge>{formatBytes(resource.sizeBytes)}</Badge> : null}
            </div>
          </div>
        </div>
        <dl className="mono grid grid-cols-[84px_1fr] gap-x-3 gap-y-1 border-t border-white/8 px-3 py-2.5 text-[11px]">
          <dt className="text-muted">{t('detailSource')}</dt>
          <dd className="break-all text-fg/85">{redactUrl(resource.url)}</dd>
          <dt className="text-muted">{t('detailStatus')}</dt>
          <dd className="text-fg/85">{reasonText(resource.downloadability)}</dd>
        </dl>
      </Panel>

      <Panel className="space-y-3 p-3">
        <SelectField
          label={t('subOutput')}
          value={choices.subtitleOutput}
          onChange={(e) => set({ subtitleOutput: e.target.value as Choices['subtitleOutput'] })}
          hint={t('subOutputHint')}
          options={[
            { value: 'original', label: originalLabel, disabled: !canKeep },
            { value: 'srt', label: t('subOutputSrt') },
          ]}
        />
        <TextField
          label={t('studioFilename')}
          placeholder={req.filename.replace(/\.[^.]+$/, '')}
          value={choices.filename}
          maxLength={150}
          onChange={(e) => set({ filename: e.target.value })}
          hint={`${t('studioFinalName')}: ${req.filename}`}
        />
        <Toggle
          label={t('optAskWhere')}
          checked={choices.saveAs ?? settings.askWhereToSave}
          onChange={(v) => set({ saveAs: v })}
        />
      </Panel>

      <Panel className="space-y-2 p-3">
        <h3 className="label">{t('studioSummary')}</h3>
        <p className="mono text-[11.5px] text-fg/90">{t('pipeSubtitle')}</p>
        {!plan.valid && (
          <Notice tone="danger" role="alert">
            <span className="flex gap-1.5">
              <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
              <span>{plan.issues.map(issueText).join(' ')}</span>
            </span>
          </Notice>
        )}
      </Panel>

      {origins.length > 0 && granted === false && (
        <Notice tone="neon">
          <p>{t('studioAccessNeeded')}</p>
          <p className="mono mt-1 break-all text-[10.5px] text-fg/80">
            {origins.map((o) => parseUrl(o)?.host ?? o).join(', ')}
          </p>
          <div className="mt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void grant()}
              icon={<ShieldCheck size={13} aria-hidden="true" />}
            >
              {t('allowAccess')}
            </Button>
          </div>
        </Notice>
      )}

      {result && (
        <Notice tone={result.tone} role={result.tone === 'danger' ? 'alert' : 'status'}>
          {result.text}
        </Notice>
      )}

      <Button
        variant="primary"
        className="w-full"
        disabled={!plan.valid || starting || resource.downloadability.status !== 'downloadable'}
        onClick={() => void onStart()}
        icon={<Play size={14} aria-hidden="true" />}
      >
        {starting ? t('working') : t('studioStart')}
      </Button>
      <p className="pb-4 text-center text-[10.5px] text-muted">{t('studioNeverAuto')}</p>
    </div>
  );
}

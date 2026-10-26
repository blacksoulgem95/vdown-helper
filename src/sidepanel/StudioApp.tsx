import { AudioLines, Cpu, Film, Layers, Play, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Logo } from '@/components/Logo';
import { QueueItem, type JobAction } from '@/components/QueueItem';
import { kindLabel, reasonText } from '@/components/labels';
import { Badge, Button, Notice, Panel, SelectField, TextField, Toggle, cx } from '@/components/ui';
import { useJobs } from '@/hooks/useJobs';
import { useSettings } from '@/hooks/useSettings';
import { useStorageValue } from '@/hooks/useStorage';
import { bitrateOptions, type Plan } from '@/lib/compat';
import { t } from '@/lib/i18n';
import { formatBitrate, formatBytes, formatDuration, qualityTag, resolutionLabel } from '@/lib/media';
import { send } from '@/lib/messaging';
import { audioOptions, buildRequest, defaultChoices, planFromRequest, type Choices } from '@/lib/request';
import { redactUrl, parseUrl } from '@/lib/security';
import {
  inspectForChoices,
  issueText,
  openDownloadedFile,
  originsNeedingAccess,
  requestAccess,
  startFromChoices,
  describeError,
  type Inspections,
} from '@/lib/uiActions';
import type { DownloadJob, OutputMode, VideoContainer } from '@/types/download';
import type { MediaResource } from '@/types/media';
import type { TabState } from '@/types/messages';
import { SubtitleForm } from './SubtitleForm';

interface Selection {
  tabId: number;
  resourceId: string;
  at: number;
}

async function jobActionFromStudio(jobs: DownloadJob[], id: string, action: JobAction): Promise<void> {
  if (action === 'open' || action === 'show') {
    const job = jobs.find((j) => j.id === id);
    if (job) await openDownloadedFile(job, action);
    return;
  }
  await send('job-action', { jobId: id, action });
}

export function StudioApp() {
  const selection = useStorageValue<Selection | null>('session', 'studio:selection', null);
  const tabState = useStorageValue<TabState | null>('session', `tab:${selection?.tabId ?? -1}`, null);
  const resource = tabState?.resources.find((r) => r.id === selection?.resourceId);
  const jobs = useJobs();

  return (
    <div className="mx-auto min-h-screen max-w-[640px] px-3.5 py-3">
      <header className="mb-3 flex items-center gap-2.5">
        <Logo size={26} />
        <div className="min-w-0 flex-1">
          <h1 className="mono text-[13px] font-bold tracking-[0.1em]">{t('studioTitle')}</h1>
          <p className="label !text-[9px] !tracking-[0.2em]">{t('signature')}</p>
        </div>
      </header>

      {!resource ? (
        <Panel className="p-5 text-center">
          <p className="mono text-[12px] uppercase tracking-[0.14em]">{t('studioEmptyTitle')}</p>
          <p className="mx-auto mt-2 max-w-[320px] text-[12px] text-muted">{t('studioEmptyBody')}</p>
        </Panel>
      ) : // Re-mount when the selection changes so choices reset for the new resource.
      resource.kind === 'subtitle' ? (
        <SubtitleForm key={`${resource.id}:${selection?.at ?? 0}`} resource={resource} />
      ) : (
        <StudioForm key={`${resource.id}:${selection?.at ?? 0}`} resource={resource} />
      )}

      {jobs.length > 0 && (
        <section className="mt-4" aria-label={t('queue')}>
          <h2 className="label mb-1.5">
            {t('queue')} · {jobs.length}
          </h2>
          <ul className="space-y-2.5">
            {jobs.slice(0, 5).map((j) => (
              <QueueItem
                key={j.id}
                job={j}
                onAction={(id, a: JobAction) => void jobActionFromStudio(jobs, id, a)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const MODES: Array<{ mode: OutputMode; label: () => string; desc: () => string; icon: typeof Film }> = [
  { mode: 'video-audio', label: () => t('modeVideoAudio'), desc: () => t('modeVideoAudioDesc'), icon: Film },
  {
    mode: 'audio-only',
    label: () => t('modeAudioOnly'),
    desc: () => t('modeAudioOnlyDesc'),
    icon: AudioLines,
  },
  { mode: 'video-only', label: () => t('modeVideoOnly'), desc: () => t('modeVideoOnlyDesc'), icon: Layers },
  { mode: 'original', label: () => t('modeOriginal'), desc: () => t('modeOriginalDesc'), icon: Play },
];

function StudioForm({ resource }: { resource: MediaResource }) {
  const { settings, loaded } = useSettings();
  const [choices, setChoices] = useState<Choices>(() => defaultChoices(resource, settings));
  const [initialised, setInitialised] = useState(false);
  const [inspections, setInspections] = useState<Inspections>({});
  const [inspectError, setInspectError] = useState<string | undefined>();
  const [inspecting, setInspecting] = useState(false);
  const [granted, setGranted] = useState<boolean | undefined>();
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<{ tone: 'acid' | 'danger'; text: string } | undefined>();

  // Settings load asynchronously: apply the user's defaults once, before they touch anything.
  useEffect(() => {
    if (loaded && !initialised) {
      setChoices(defaultChoices(resource, settings));
      setInitialised(true);
    }
  }, [loaded, initialised, resource, settings]);

  const variant = resource.kind === 'hls-master' ? resource.variants[choices.variantIndex] : undefined;
  const audioOpts = audioOptions(resource, variant);
  const isHls = resource.kind === 'hls-master' || resource.kind === 'hls-media';
  const isSegmented = isHls || resource.kind === 'dash';

  // Which playlists will this choice read? Inspect them to learn duration, segments, encryption and origins.
  const draft = useMemo(() => buildRequest(resource, settings, choices), [resource, settings, choices]);
  useEffect(() => {
    if (!isSegmented) return;
    let alive = true;
    setInspecting(true);
    setInspectError(undefined);
    void inspectForChoices(resource, settings, choices, false).then((r) => {
      if (!alive) return;
      setInspecting(false);
      if (r.ok) setInspections(r.inspections);
      else {
        setInspections({});
        setInspectError(r.error);
      }
    });
    return () => {
      alive = false;
    };
    // Re-inspect only when the URLs involved change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id, draft.sourceUrl, draft.audioUrl]);

  const [origins, setOrigins] = useState<string[]>([]);
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

  const evaluate = (c: Choices): { plan: Plan; req: ReturnType<typeof buildRequest> } => {
    const req = buildRequest(resource, settings, c, inspections.video);
    if (inspections.audio?.live) req.live = true;
    return {
      plan: planFromRequest(req, {
        maxMemoryMb: settings.maxMemoryMb,
        maxEncodeDurationSec: settings.maxEncodeDurationSec,
      }),
      req,
    };
  };
  const { plan, req } = evaluate(choices);
  if (inspections.video?.protectedByDrm || inspections.audio?.protectedByDrm)
    plan.issues = [...new Set([...plan.issues, 'protected' as const])];
  const valid = plan.valid && !(inspections.video?.protectedByDrm || inspections.audio?.protectedByDrm);

  const set = (patch: Partial<Choices>) => setChoices((c) => ({ ...c, ...patch }));

  const modeOk = (mode: OutputMode) => evaluate({ ...choices, mode }).plan.valid;
  const containerOk = (container: VideoContainer) => evaluate({ ...choices, container }).plan.valid;
  const audioFormatOk = (audioFormat: Choices['audioFormat']) =>
    evaluate({ ...choices, audioFormat }).plan.valid;

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

  const estimated = req.estimatedBytes;
  const videoMode = choices.mode !== 'audio-only';
  const showBitrate = bitrateOptions(plan).length > 0;
  const duration = inspections.video?.durationSec ?? resource.durationSec;

  return (
    <div className="space-y-3">
      {/* Media */}
      <Panel className="overflow-hidden">
        <div className="flex gap-3 p-3">
          <div className="relative h-[72px] w-[116px] shrink-0 overflow-hidden rounded-md border border-neon/20 bg-void">
            {/* No remote poster: loading one would make the extension request an address the page chose. */}
            <div className="flex h-full w-full items-center justify-center text-neon/60">
              {resource.mediaType === 'audio' ? (
                <AudioLines size={26} aria-hidden="true" />
              ) : (
                <Film size={26} aria-hidden="true" />
              )}
            </div>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,rgba(0,0,0,0.18)_0_1px,transparent_1px_3px)]"
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13.5px] font-medium" title={resource.title}>
              {resource.title}
            </h2>
            <p className="mono truncate text-[11px] text-neon/80">{resource.host}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Badge tone="neon">{resource.format.toUpperCase()}</Badge>
              <Badge>{kindLabel(resource)}</Badge>
              {duration ? <Badge>{formatDuration(duration)}</Badge> : null}
            </div>
          </div>
        </div>
        <dl className="mono grid grid-cols-[84px_1fr] gap-x-3 gap-y-1 border-t border-white/8 px-3 py-2.5 text-[11px]">
          <dt className="text-muted">{t('detailSource')}</dt>
          <dd className="break-all text-fg/85">{redactUrl(resource.url)}</dd>
          <dt className="text-muted">{t('detailStatus')}</dt>
          <dd className="text-fg/85">{reasonText(resource.downloadability)}</dd>
          {isSegmented && (
            <>
              <dt className="text-muted">{t('studioPlaylist')}</dt>
              <dd className="text-fg/85">
                {inspecting
                  ? '…'
                  : inspections.video
                    ? [
                        t('segmentsCount', inspections.video.segmentCount),
                        formatDuration(inspections.video.durationSec),
                        inspections.video.fragmented ? 'fMP4' : 'MPEG-TS',
                        inspections.video.encryption.length
                          ? inspections.video.encryption.join('+')
                          : t('notEncrypted'),
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : '—'}
              </dd>
            </>
          )}
        </dl>
      </Panel>

      {inspectError && (
        <Notice tone="danger" role="alert">
          {describeError(`inspect:${inspectError.replace(/^inspect:/, '')}`)}
        </Notice>
      )}

      {/* Output mode */}
      <Panel className="p-3">
        <h3 className="label mb-2">{t('studioOutputMode')}</h3>
        <div role="radiogroup" aria-label={t('studioOutputMode')} className="grid grid-cols-2 gap-2">
          {MODES.map(({ mode, label, desc, icon: Icon }) => {
            const ok = modeOk(mode);
            const active = choices.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!ok && !active}
                onClick={() => set({ mode })}
                className={cx(
                  'rounded-md border p-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35',
                  active ? 'border-neon bg-neon/10' : 'border-white/12 hover:border-neon/40',
                )}
              >
                <span className="mono flex items-center gap-1.5 text-[11px] uppercase tracking-wider">
                  <Icon size={13} aria-hidden="true" className={active ? 'text-neon' : 'text-muted'} />
                  {label()}
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-muted">{desc()}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* Quality */}
      {(resource.kind === 'hls-master' || resource.kind === 'dash') &&
        resource.variants.length > 0 &&
        videoMode && (
          <Panel className="p-3">
            <h3 className="label mb-2">{t('studioVariants')}</h3>
            <div role="radiogroup" aria-label={t('studioVariants')} className="space-y-1.5">
              {resource.variants.map((v, i) => {
                const active = choices.variantIndex === i;
                return (
                  <button
                    key={v.uri}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() =>
                      set({
                        variantIndex: i,
                        audioIndex: audioOptions(resource, v).findIndex((a) => a.isDefault),
                      })
                    }
                    className={cx(
                      'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors',
                      active ? 'border-neon bg-neon/10' : 'border-white/12 hover:border-neon/40',
                    )}
                  >
                    <span className="mono w-[58px] shrink-0 text-[12px] font-bold">
                      {resolutionLabel(v.height, v.width) || '—'}
                    </span>
                    <span className="mono w-[60px] shrink-0 text-[10px] uppercase text-magenta">
                      {qualityTag(v.height)}
                    </span>
                    <span className="mono min-w-0 flex-1 truncate text-[10.5px] text-muted">
                      {[
                        formatBitrate(v.averageBandwidth ?? v.bandwidth),
                        v.frameRate ? `${v.frameRate} fps` : '',
                        v.codecs ?? '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                );
              })}
            </div>
          </Panel>
        )}

      {/* Audio track */}
      {audioOpts.length > 0 && choices.mode !== 'video-only' && (
        <Panel className="p-3">
          <SelectField
            label={t('studioAudioTrack')}
            value={String(choices.audioIndex)}
            onChange={(e) => set({ audioIndex: Number(e.target.value) })}
            options={audioOpts.map((a, i) => ({
              value: String(i),
              label: `${a.name}${a.language ? ` (${a.language})` : ''}${a.isDefault ? ' ★' : ''}`,
            }))}
            hint={choices.mode === 'audio-only' ? t('studioAudioTrackOnlyHint') : t('studioAudioTrackHint')}
          />
        </Panel>
      )}

      {/* Format */}
      <Panel className="space-y-3 p-3">
        {videoMode ? (
          <SelectField
            label={t('studioContainer')}
            value={choices.container}
            onChange={(e) => set({ container: e.target.value as VideoContainer })}
            options={[
              { value: 'original', label: t('containerOriginal') },
              { value: 'mp4', label: 'MP4', disabled: !containerOk('mp4') },
              { value: 'mkv', label: 'MKV', disabled: !containerOk('mkv') },
              ...(isHls ? [{ value: 'ts', label: 'TS', disabled: !containerOk('ts') }] : []),
            ]}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label={t('studioAudioFormat')}
              value={choices.audioFormat}
              onChange={(e) => set({ audioFormat: e.target.value as Choices['audioFormat'] })}
              options={(['mp3', 'm4a', 'aac', 'wav'] as const).map((f) => ({
                value: f,
                label: f.toUpperCase(),
                disabled: !audioFormatOk(f),
              }))}
            />
            {showBitrate ? (
              <SelectField
                label={t('optAudioBitrate')}
                value={String(choices.audioBitrate)}
                onChange={(e) => set({ audioBitrate: Number(e.target.value) as Choices['audioBitrate'] })}
                options={bitrateOptions(plan).map((b) => ({ value: String(b), label: `${b} kbps` }))}
              />
            ) : (
              <p className="mono self-end pb-2 text-[11px] text-muted">
                {plan.audio === 'copy' ? t('noBitrateCopy') : t('noBitrateLossless')}
              </p>
            )}
          </div>
        )}
        {videoMode && showBitrate && (
          <SelectField
            label={t('studioAudioReencode')}
            value={String(choices.audioBitrate)}
            onChange={(e) => set({ audioBitrate: Number(e.target.value) as Choices['audioBitrate'] })}
            options={bitrateOptions(plan).map((b) => ({ value: String(b), label: `${b} kbps` }))}
          />
        )}
      </Panel>

      {/* File name & destination */}
      <Panel className="space-y-3 p-3">
        <TextField
          label={t('studioFilename')}
          placeholder={req.filename.replace(/\.[^.]+$/, '')}
          value={choices.filename}
          maxLength={150}
          onChange={(e) => set({ filename: e.target.value })}
          hint={`${t('studioFinalName')}: ${req.filename}`}
        />
        <TextField
          label={t('optSubfolder')}
          placeholder="vdown"
          value={settings.subfolder}
          disabled
          hint={t('studioSubfolderHint')}
        />
        <Toggle
          label={t('optAskWhere')}
          checked={choices.saveAs ?? settings.askWhereToSave}
          onChange={(v) => set({ saveAs: v })}
        />
      </Panel>

      {/* Summary */}
      <Panel className="space-y-2 p-3">
        <h3 className="label">{t('studioSummary')}</h3>
        <p className="mono text-[11.5px] text-fg/90">{pipelineText(plan)}</p>
        <p className="mono text-[11px] text-muted">
          {t('studioEstimate')}: {estimated !== undefined ? `≈ ${formatBytes(estimated)}` : t('sizeUnknown')}
          {estimated !== undefined && plan.audio === 'transcode' ? ` (${t('studioEstimateNote')})` : ''}
        </p>
        {plan.requiresFfmpeg && (
          <Notice tone="magenta">
            <span className="flex gap-1.5">
              <Cpu size={14} className="mt-px shrink-0" aria-hidden="true" />
              <span>{t('studioFfmpegWarning', settings.maxMemoryMb)}</span>
            </span>
          </Notice>
        )}
        {!valid && (
          <Notice tone="danger" role="alert">
            <span className="flex gap-1.5">
              <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
              <span>{plan.issues.map(issueText).join(' ')}</span>
            </span>
          </Notice>
        )}
      </Panel>

      {/* Access */}
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
        disabled={!valid || starting || inspecting || resource.downloadability.status !== 'downloadable'}
        onClick={() => void onStart()}
        icon={<Play size={14} aria-hidden="true" />}
      >
        {starting ? t('working') : t('studioStart')}
      </Button>
      <p className="pb-4 text-center text-[10.5px] text-muted">{t('studioNeverAuto')}</p>
    </div>
  );
}

function pipelineText(plan: Plan): string {
  switch (plan.pipeline) {
    case 'native':
    case 'file-staged':
      return t('pipeNative');
    case 'hls-concat':
      return t('pipeConcat');
    case 'hls-ffmpeg-copy':
    case 'file-ffmpeg-copy':
      return t('pipeFfmpegCopy');
    case 'ffmpeg-transcode':
      return plan.video === 'copy' && plan.audio === 'transcode'
        ? t('pipeTranscodeAudio')
        : t('pipeTranscode');
    case 'subtitle':
      return t('pipeSubtitle');
    case 'zip':
      return t('pipeZip');
    case 'capture':
      return t('pipeCapture');
    case 'record':
      return t('pipeRecord');
    case 'live':
      return t('pipeLive');
  }
}

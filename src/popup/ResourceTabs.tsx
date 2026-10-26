import { Archive } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FileCard } from '@/components/FileCard';
import { MediaCard } from '@/components/MediaCard';
import { Tabs, type TabDef } from '@/components/Tabs';
import { Button, Notice, SelectField } from '@/components/ui';
import { t } from '@/lib/i18n';
import { groupResources } from '@/lib/resources';
import {
  TAB_ORDER,
  activeTab,
  groupByFrame,
  imageMeetsMinimum,
  isFileTab,
  splitByTab,
  type TabKey,
} from '@/lib/tabs';
import { IMAGE_MIN_CHOICES } from '@/lib/settings';
import type { MediaResource } from '@/types/media';
import type { Settings } from '@/types/settings';

type Feedback = { tone: 'danger' | 'acid'; text: string };

/** Items rendered per tab before "show more": a page can list hundreds of images. */
const PAGE = 40;
/** Individual downloads one click may queue. */
const MAX_BULK = 50;

const TAB_LABEL: Record<TabKey, () => string> = {
  video: () => t('tabVideo'),
  audio: () => t('tabAudio'),
  subtitles: () => t('tabSubtitles'),
  images: () => t('tabImages'),
  files: () => t('tabFiles'),
  assets: () => t('tabAssets'),
};

export interface ResourceTabsProps {
  resources: readonly MediaResource[];
  settings: Settings;
  busy: string | undefined;
  feedback: Record<string, Feedback>;
  onDownload: (r: MediaResource) => void;
  onConfigure: (r: MediaResource) => void;
  onGrantAccess: (r: MediaResource) => void;
  /** Queue several resources; resolves with how many were queued and how many could not be. */
  onBulk: (list: MediaResource[]) => Promise<{ queued: number; failed: number }>;
  /** Pack several files into one ZIP. */
  onZip: (list: MediaResource[]) => Promise<{ ok: true } | { ok: false; error: string }>;
  onMinImage: (px: number) => void;
}

/** Everything found on the page, by type, with counts, frame grouping, selection and the image size filter. */
export function ResourceTabs(props: ResourceTabsProps) {
  const { resources, settings, busy, feedback } = props;
  const [chosen, setChosen] = useState<TabKey | undefined>();
  const [shown, setShown] = useState<Partial<Record<TabKey, number>>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkNote, setBulkNote] = useState<Feedback | undefined>();
  const [bulkBusy, setBulkBusy] = useState(false);

  const split = useMemo(() => splitByTab(resources), [resources]);
  const counts = Object.fromEntries(TAB_ORDER.map((k) => [k, split[k].length])) as Record<TabKey, number>;
  const tab = activeTab(counts, chosen);
  const hiddenImages =
    tab === 'images' ? split.images.filter((r) => !imageMeetsMinimum(r, settings.imageMinPx)).length : 0;
  const items = useMemo(
    () =>
      tab === 'images' ? split.images.filter((r) => imageMeetsMinimum(r, settings.imageMinPx)) : split[tab],
    [split, tab, settings.imageMinPx],
  );
  const limit = shown[tab] ?? PAGE;
  const visible = items.slice(0, limit);
  const downloadable = items.filter((r) => r.downloadability.status === 'downloadable');
  const picked = items.filter((r) => selected.has(r.id));

  const tabs: Array<TabDef<TabKey>> = TAB_ORDER.filter((k) => counts[k] > 0).map((k) => ({
    key: k,
    label: TAB_LABEL[k](),
    count: counts[k],
  }));

  const toggle = (r: MediaResource) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });

  const bulk = async () => {
    setBulkBusy(true);
    setBulkNote(undefined);
    try {
      const out = await props.onBulk(picked.slice(0, MAX_BULK));
      setBulkNote(
        out.failed > 0
          ? { tone: 'danger', text: `${t('bulkQueued', out.queued)} ${t('bulkFailed', out.failed)}` }
          : { tone: 'acid', text: t('bulkQueued', out.queued) },
      );
      setSelected(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  const zip = async () => {
    setBulkBusy(true);
    setBulkNote(undefined);
    try {
      const out = await props.onZip(picked);
      setBulkNote(out.ok ? { tone: 'acid', text: t('queuedOk') } : { tone: 'danger', text: out.error });
      if (out.ok) setSelected(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  const list = (
    <div className="space-y-3">
      {tab === 'images' && (
        <div>
          <SelectField
            label={t('imageMinLabel')}
            value={String(settings.imageMinPx)}
            onChange={(e) => props.onMinImage(Number(e.target.value))}
            options={IMAGE_MIN_CHOICES.map((px) => ({
              value: String(px),
              label: px === 0 ? t('imageMinAny') : t('imageMinPx', px),
            }))}
          />
          {hiddenImages > 0 && (
            <p className="mt-1 text-[10.5px] text-muted">{t('imagesHidden', hiddenImages)}</p>
          )}
        </div>
      )}

      {isFileTab(tab) && downloadable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set(downloadable.slice(0, MAX_BULK).map((r) => r.id)))}
          >
            {t('selectAll')}
          </Button>
          {picked.length > 0 && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                {t('selectNone')}
              </Button>
              <Button variant="primary" size="sm" disabled={bulkBusy} onClick={() => void bulk()}>
                {t('downloadSelected', picked.length)}
              </Button>
              {picked.length > 1 && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={bulkBusy}
                  title={t('zipHint')}
                  onClick={() => void zip()}
                  icon={<Archive size={12} aria-hidden="true" />}
                >
                  {t('zipButton', picked.length)}
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {bulkNote && (
        <Notice tone={bulkNote.tone} role={bulkNote.tone === 'danger' ? 'alert' : 'status'}>
          {bulkNote.text}
        </Notice>
      )}

      {items.length === 0 ? (
        <p className="py-4 text-center text-[11.5px] text-muted">{t('tabEmpty')}</p>
      ) : (
        <ul className="space-y-3" aria-label={TAB_LABEL[tab]()}>
          {groupByFrame(visible).map((frame, _i, all) => (
            <li key={frame.frameId} className="list-none">
              {all.length > 1 && (
                <p className="label mb-1.5 truncate" data-frame-id={frame.frameId}>
                  {frame.frameId === 0
                    ? t('frameTop')
                    : t('frameEmbedded', frame.host || `#${frame.frameId}`)}
                </p>
              )}
              {isFileTab(tab) ? (
                <ul className="space-y-1.5">
                  {frame.items.map((r) => (
                    <FileCard
                      key={r.id}
                      resource={r}
                      selected={selected.has(r.id)}
                      busy={busy === r.id}
                      {...(feedback[r.id] ? { feedback: feedback[r.id] as Feedback } : {})}
                      onToggle={toggle}
                      onDownload={props.onDownload}
                    />
                  ))}
                </ul>
              ) : (
                <ul className="space-y-2.5">
                  {groupResources(frame.items).map((g) => (
                    <li key={g.key} className="list-none">
                      {g.items.length > 1 && (
                        <p className="label mb-1.5 flex items-center justify-between">
                          <span className="truncate">{g.title}</span>
                          <span>{g.items.length}</span>
                        </p>
                      )}
                      <ul className="space-y-2.5">
                        {g.items.map((r) => (
                          <MediaCard
                            key={r.id}
                            resource={r}
                            busy={busy === r.id}
                            {...(feedback[r.id] ? { feedback: feedback[r.id] as Feedback } : {})}
                            onDownload={props.onDownload}
                            onConfigure={props.onConfigure}
                            onGrantAccess={props.onGrantAccess}
                          />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {items.length > visible.length && (
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => setShown((cur) => ({ ...cur, [tab]: limit + PAGE }))}
        >
          {t('showMore', Math.min(PAGE, items.length - visible.length))}
        </Button>
      )}
    </div>
  );

  // One kind of thing needs no tab strip.
  if (tabs.length <= 1) return list;
  return (
    <Tabs tabs={tabs} active={tab} onChange={setChosen} label={t('tabsLabel')}>
      {list}
    </Tabs>
  );
}

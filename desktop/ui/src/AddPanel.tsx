import { Download, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Notice, Panel, SelectField, TextField } from '@/components/ui';
import { t } from '@/lib/i18n';
import { formatBitrate, formatDuration, resolutionLabel } from '@/lib/media';
import type { OutputMode } from '@/types/download';
import { api, asEngineError, type Choice, type Probed } from './api';
import { errorText } from './errors';
import { td } from './i18n';

function kindText(kind: string): string {
  switch (kind) {
    case 'hls-master':
      return t('kindHlsMaster');
    case 'hls-media':
      return t('kindHlsMedia');
    case 'dash':
      return t('kindDashStream');
    default:
      return t('kindFile');
  }
}

const MODES: Array<{ value: OutputMode; label: () => string }> = [
  { value: 'video-audio', label: () => t('modeVideoAudio') },
  { value: 'audio-only', label: () => t('modeAudioOnly') },
  { value: 'video-only', label: () => t('modeVideoOnly') },
];

/** Paste an address, see what it is (qualities, live, protected), pick, and queue it. */
export function AddPanel({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [probed, setProbed] = useState<{ url: string; result: Probed; choice: Choice }>();
  const [msg, setMsg] = useState<{ tone: 'acid' | 'danger'; text: string }>();

  const describe = async (address: string, choice: Choice) => {
    setBusy(true);
    setMsg(undefined);
    try {
      setProbed({ url: address, result: await api.probe(address, choice), choice });
    } catch (e) {
      setProbed(undefined);
      setMsg({ tone: 'danger', text: errorText(asEngineError(e)) });
    } finally {
      setBusy(false);
    }
  };

  const check = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) void describe(url.trim(), {});
  };

  const choose = (patch: Choice) => {
    if (probed) void describe(probed.url, { ...probed.choice, ...patch });
  };

  const add = async () => {
    if (!probed) return;
    setBusy(true);
    try {
      await api.add(probed.url, probed.choice);
      setMsg({ tone: 'acid', text: td('added') });
      setProbed(undefined);
      setUrl('');
      onAdded();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(asEngineError(e)) });
    } finally {
      setBusy(false);
    }
  };

  const r = probed?.result;
  return (
    <Panel className="p-4">
      <form onSubmit={check} className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            label={td('urlLabel')}
            placeholder={td('urlPlaceholder')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            data-testid="url"
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={busy || !url.trim()}
          icon={<Search size={13} aria-hidden="true" />}
          data-testid="check"
        >
          {busy && !probed ? td('checking') : td('check')}
        </Button>
      </form>

      {msg && (
        <div className="mt-3" data-testid="add-message">
          <Notice tone={msg.tone} role={msg.tone === 'danger' ? 'alert' : 'status'}>
            {msg.text}
          </Notice>
        </div>
      )}

      {r && (
        <div className="mt-4 space-y-3" data-testid="probed">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg" title={r.title}>
              {r.title}
            </p>
            <Badge tone="neon">{kindText(r.kind)}</Badge>
            {r.live && <Badge tone="magenta">{t('liveTag')}</Badge>}
            {r.durationSec !== undefined && <Badge>{formatDuration(r.durationSec)}</Badge>}
          </div>
          {r.encryption === 'aes-128' && <Notice tone="acid">{t('reasonAes128')}</Notice>}
          {r.live && <Notice tone="magenta">{td('liveNote')}</Notice>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {r.variants.length > 0 && (
              <SelectField
                label={td('quality')}
                value={String(r.variant ?? 0)}
                disabled={busy}
                onChange={(e) => choose({ variant: Number(e.target.value) })}
                data-testid="quality"
                options={r.variants.map(([height, bandwidth], i) => ({
                  value: String(i),
                  label: [resolutionLabel(height ?? undefined), formatBitrate(bandwidth)]
                    .filter(Boolean)
                    .join(' · '),
                }))}
              />
            )}
            {!r.live && (
              <SelectField
                label={t('studioOutputMode')}
                value={probed.choice.mode ?? r.request.mode}
                disabled={busy}
                onChange={(e) => choose({ mode: e.target.value as OutputMode })}
                data-testid="mode"
                options={MODES.map((m) => ({ value: m.value, label: m.label() }))}
              />
            )}
          </div>
          <p className="mono truncate text-[11px] text-muted" title={r.request.filename}>
            {td('fileName')}: <span data-testid="filename">{r.request.filename}</span>
          </p>
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void add()}
              icon={<Download size={13} aria-hidden="true" />}
              data-testid="add"
            >
              {t('download')}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

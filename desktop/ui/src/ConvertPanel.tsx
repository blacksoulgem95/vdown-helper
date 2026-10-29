import { FilePlus2, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button, IconButton, Notice, Panel, SelectField, TextField } from '@/components/ui';
import {
  api,
  asEngineError,
  type AudioChoice,
  type Container,
  type Encode,
  type Encoder,
  type Encoders,
  type Preset,
  type VideoCodec,
} from './api';
import { errorText } from './errors';
import { td } from './i18n';

const CUSTOM = 'custom';

const PRESET_NAMES: Record<string, () => string> = {
  compatible: () => td('presetCompatible'),
  smaller: () => td('presetSmaller'),
  phone: () => td('presetPhone'),
  web: () => td('presetWeb'),
  archive: () => td('presetArchive'),
};

const PRESET_HINTS: Record<string, () => string> = {
  compatible: () => td('presetCompatibleHint'),
  smaller: () => td('presetSmallerHint'),
  phone: () => td('presetPhoneHint'),
  web: () => td('presetWebHint'),
  archive: () => td('presetArchiveHint'),
};

const CODEC_NAMES: Record<VideoCodec, () => string> = {
  h264: () => 'H.264',
  h265: () => 'H.265 (HEVC)',
  av1: () => 'AV1',
  vp9: () => 'VP9',
  copy: () => td('codecCopy'),
};

const ENCODER_NAMES: Record<Encoder, () => string> = {
  software: () => td('encoderSoftware'),
  nvenc: () => 'NVIDIA NVENC',
  qsv: () => 'Intel Quick Sync',
  amf: () => 'AMD AMF',
  videotoolbox: () => 'Apple VideoToolbox',
  vaapi: () => 'VAAPI',
};

/** Why an encode cannot be done, from `vdh-core`'s codes (and `unavailable`: not on this machine). */
const PROBLEMS: Record<string, () => string> = {
  'encoder-codec': () => td('encProblemEncoder'),
  unavailable: () => td('encProblemUnavailable'),
  'copy-resize': () => td('encProblemCopyResize'),
  quality: () => td('encProblemQuality'),
  bitrate: () => td('encProblemBitrate'),
  size: () => td('encProblemSize'),
  'audio-bitrate': () => td('encProblemAudioBitrate'),
  'container-codec': () => td('encProblemContainerCodec'),
  'container-audio': () => td('encProblemContainerAudio'),
};

const HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const AUDIO_KBPS = [96, 128, 160, 192, 256, 320];

/** `encoder` makes `codec` on this machine (a copy needs no encoder). */
const works = (encoders: Encoders | undefined, codec: VideoCodec, encoder: Encoder) =>
  codec === 'copy' || Boolean(encoders?.video.some((v) => v.codec === codec && v.encoder === encoder));

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Re-encode files: finished downloads (from the history) and files chosen on disk, with a preset or the user's own
 * codec, encoder, quality, size and audio. Only encoders that work on this machine are offered; the app checks the
 * encode again. The originals are never changed: the new files go next to the downloads.
 */
export function ConvertPanel({
  inputs,
  onInputs,
  onQueued,
}: {
  inputs: string[];
  onInputs: (next: string[]) => void;
  onQueued: () => void;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [encoders, setEncoders] = useState<Encoders>();
  const [preset, setPreset] = useState('compatible');
  const [encode, setEncode] = useState<Encode>();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'acid' | 'danger'; text: string }>();

  useEffect(() => {
    void api.presets().then((p) => {
      setPresets(p);
      setEncode((e) => e ?? p[0]?.encode);
    });
    void api.encoders().then(setEncoders);
  }, []);

  const available = (codec: VideoCodec, encoder: Encoder) => works(encoders, codec, encoder);

  useEffect(() => {
    if (!encode) return;
    let current = true;
    void api.checkEncode(encode).then((code) => {
      if (!current) return;
      if (code) setProblem(code);
      else if (encoders && !works(encoders, encode.codec, encode.encoder)) setProblem('unavailable');
      else setProblem(null);
    });
    return () => {
      current = false;
    };
  }, [encode, encoders]);

  const codecs = useMemo(() => {
    const found = new Set(encoders?.video.map((v) => v.codec));
    return (['h264', 'h265', 'av1', 'vp9'] as const).filter((c) => found.has(c));
  }, [encoders]);

  if (!encode) return null;

  const change = (patch: Partial<Encode>) => {
    setPreset(CUSTOM);
    setEncode({ ...encode, ...patch });
  };

  const choosePreset = (id: string) => {
    setPreset(id);
    const p = presets.find((x) => x.id === id);
    if (p) setEncode(p.encode);
  };

  const chooseCodec = (codec: VideoCodec) => {
    if (codec === 'copy') {
      change({ codec, maxHeight: undefined });
      return;
    }
    // keep the encoder when it can make this codec here; otherwise the software one
    const encoder = available(codec, encode.encoder) ? encode.encoder : 'software';
    change({ codec, encoder });
  };

  const chooseAudio = (codec: AudioChoice['codec']) => {
    const kbps = 'kbps' in encode.audio ? encode.audio.kbps : 160;
    change({ audio: codec === 'aac' || codec === 'opus' ? { codec, kbps } : { codec } });
  };

  const addFiles = async () => {
    try {
      const picked = await api.pickFiles();
      onInputs([...inputs, ...picked.filter((p) => !inputs.includes(p))]);
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(asEngineError(e)) });
    }
  };

  const start = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      const label = preset === CUSTOM ? undefined : PRESET_NAMES[preset]?.();
      await api.reencode(inputs, encode, label);
      setMsg({ tone: 'acid', text: td('encQueued', inputs.length) });
      onInputs([]);
      onQueued();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(asEngineError(e)) });
    } finally {
      setBusy(false);
    }
  };

  const hardware = encoders?.video.filter((v) => v.codec === encode.codec) ?? [];
  const copy = encode.codec === 'copy';
  const q = encode.quality;
  return (
    <Panel className="space-y-4 p-4">
      <div data-testid="convert">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-medium text-fg">{td('encFiles')}</h2>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void addFiles()}
            icon={<FilePlus2 size={12} aria-hidden="true" />}
            data-testid="add-files"
          >
            {td('encAddFiles')}
          </Button>
        </div>
        {inputs.length === 0 ? (
          <p className="py-3 text-[12px] text-muted" data-testid="convert-empty">
            {td('encNoFiles')}
          </p>
        ) : (
          <ul className="mt-2 space-y-1" data-testid="convert-inputs">
            {inputs.map((path) => (
              <li key={path} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1">
                <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-fg" title={path}>
                  {baseName(path)}
                </span>
                <IconButton
                  label={td('encRemoveFile', baseName(path))}
                  onClick={() => onInputs(inputs.filter((p) => p !== path))}
                >
                  <X size={13} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField
          label={td('encPreset')}
          value={preset}
          onChange={(e) => choosePreset(e.target.value)}
          data-testid="preset"
          {...(PRESET_HINTS[preset] ? { hint: PRESET_HINTS[preset]() } : {})}
          options={[
            ...presets.map((p) => ({ value: p.id, label: PRESET_NAMES[p.id]?.() ?? p.id })),
            { value: CUSTOM, label: td('presetCustom') },
          ]}
        />
        <SelectField
          label={td('encContainer')}
          value={encode.container}
          onChange={(e) => change({ container: e.target.value as Container })}
          data-testid="container"
          options={[
            { value: 'mp4', label: 'MP4' },
            { value: 'mkv', label: 'MKV (Matroska)' },
            { value: 'webm', label: 'WebM' },
          ]}
        />
        <SelectField
          label={td('encCodec')}
          value={encode.codec}
          onChange={(e) => chooseCodec(e.target.value as VideoCodec)}
          data-testid="codec"
          options={[...codecs, 'copy' as const].map((c) => ({ value: c, label: CODEC_NAMES[c]() }))}
        />
        {!copy && (
          <SelectField
            label={td('encEncoder')}
            value={encode.encoder}
            onChange={(e) => change({ encoder: e.target.value as Encoder })}
            data-testid="encoder"
            {...(encoders === undefined ? { hint: td('encDetecting') } : {})}
            options={(hardware.length ? hardware.map((v) => v.encoder) : [encode.encoder]).map((x) => ({
              value: x,
              label: ENCODER_NAMES[x](),
            }))}
          />
        )}
        {!copy && (
          <SelectField
            label={td('encQuality')}
            value={q.kind}
            onChange={(e) =>
              change({
                quality:
                  e.target.value === 'bitrate' ? { kind: 'bitrate', kbps: 4000 } : { kind: 'crf', value: 23 },
              })
            }
            data-testid="quality-kind"
            options={[
              { value: 'crf', label: td('encQualityCrf') },
              { value: 'bitrate', label: td('encQualityBitrate') },
            ]}
          />
        )}
        {!copy && (
          <TextField
            label={q.kind === 'crf' ? td('encCrf') : td('encKbps')}
            hint={q.kind === 'crf' ? td('encCrfHint') : undefined}
            type="number"
            inputMode="numeric"
            min={q.kind === 'crf' ? 0 : 100}
            max={q.kind === 'crf' ? 51 : 200000}
            value={q.kind === 'crf' ? q.value : q.kbps}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (!Number.isFinite(n) || n < 0) return;
              change({
                quality: q.kind === 'crf' ? { kind: 'crf', value: n } : { kind: 'bitrate', kbps: n },
              });
            }}
            data-testid="quality-value"
          />
        )}
        {!copy && (
          <SelectField
            label={td('encSize')}
            value={String(encode.maxHeight ?? 0)}
            onChange={(e) => {
              const h = Number(e.target.value);
              change({ maxHeight: h > 0 ? h : undefined });
            }}
            data-testid="size"
            options={[
              { value: '0', label: td('encSizeOriginal') },
              ...HEIGHTS.map((h) => ({ value: String(h), label: td('encSizeUpTo', h) })),
            ]}
          />
        )}
        <SelectField
          label={td('encAudio')}
          value={encode.audio.codec}
          onChange={(e) => chooseAudio(e.target.value as AudioChoice['codec'])}
          data-testid="audio"
          options={[
            { value: 'copy', label: td('encAudioCopy') },
            ...(encoders?.aac === false ? [] : [{ value: 'aac', label: 'AAC' }]),
            ...(encoders?.opus === false ? [] : [{ value: 'opus', label: 'Opus' }]),
            { value: 'none', label: td('encAudioNone') },
          ]}
        />
        {'kbps' in encode.audio && (
          <SelectField
            label={td('encAudioKbps')}
            value={String(encode.audio.kbps)}
            onChange={(e) => {
              const kbps = Number(e.target.value);
              if (encode.audio.codec === 'aac' || encode.audio.codec === 'opus')
                change({ audio: { codec: encode.audio.codec, kbps } });
            }}
            data-testid="audio-kbps"
            options={AUDIO_KBPS.map((k) => ({ value: String(k), label: `${k} kbit/s` }))}
          />
        )}
      </div>

      {problem && (
        <Notice tone="danger" role="alert">
          <span data-testid="encode-problem" data-code={problem}>
            {PROBLEMS[problem]?.() ?? td('encProblemEncoder')}
          </span>
        </Notice>
      )}
      {msg && (
        <div data-testid="convert-message">
          <Notice tone={msg.tone} role={msg.tone === 'danger' ? 'alert' : 'status'}>
            {msg.text}
          </Notice>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted">{td('encOriginalsKept')}</p>
        <Button
          variant="primary"
          disabled={busy || inputs.length === 0 || problem !== null}
          onClick={() => void start()}
          icon={<Wand2 size={13} aria-hidden="true" />}
          data-testid="reencode"
        >
          {td('encStart', inputs.length)}
        </Button>
      </div>
    </Panel>
  );
}

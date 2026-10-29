import { FolderOpen, Save } from 'lucide-react';
import { useState } from 'react';
import { Button, Notice, SelectField, TextField, Toggle } from '@/components/ui';
import { api, asEngineError, type AppSettings, type SettingsView } from './api';
import { errorText } from './errors';
import { td } from './i18n';

const whole = (v: string, fallback: number) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** The app's settings. Nothing changes until Save; the app checks every value again. */
export function SettingsPanel({ view, onSaved }: { view: SettingsView; onSaved: (v: SettingsView) => void }) {
  const [s, setS] = useState<AppSettings>(view.settings);
  const [msg, setMsg] = useState<{ tone: 'acid' | 'danger'; text: string }>();
  const set = (patch: Partial<AppSettings>) => {
    setS((cur) => ({ ...cur, ...patch }));
    setMsg(undefined);
  };

  const pick = async () => {
    const folder = await api.pickFolder();
    if (folder) set({ outDir: folder });
  };

  const save = async () => {
    try {
      const next = await api.saveSettings(s);
      setS(next.settings);
      onSaved(next);
      setMsg({ tone: 'acid', text: td('saved') });
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(asEngineError(e)) });
    }
  };

  return (
    <div className="space-y-4" data-testid="settings">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            label={td('setFolder')}
            hint={td('setFolderHint', view.defaultOutDir)}
            value={s.outDir}
            placeholder={view.defaultOutDir}
            onChange={(e) => set({ outDir: e.target.value })}
            spellCheck={false}
          />
        </div>
        <Button
          onClick={() => void pick()}
          icon={<FolderOpen size={13} aria-hidden="true" />}
          className="mb-5"
        >
          {td('choose')}
        </Button>
      </div>
      {s.outDir && (
        <Button variant="ghost" size="sm" onClick={() => set({ outDir: '' })}>
          {td('useDefault')}
        </Button>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TextField
          label={td('setJobs')}
          type="number"
          min={1}
          max={8}
          value={s.maxJobs}
          onChange={(e) => set({ maxJobs: whole(e.target.value, s.maxJobs) })}
        />
        <TextField
          label={td('setSegments')}
          type="number"
          min={1}
          max={16}
          value={s.segments}
          onChange={(e) => set({ segments: whole(e.target.value, s.segments) })}
        />
        <TextField
          label={td('setRate')}
          hint={td('setRateHint')}
          type="number"
          min={0}
          value={s.rateKbps}
          onChange={(e) => set({ rateKbps: whole(e.target.value, s.rateKbps) })}
        />
      </div>
      <TextField
        label={td('setWindow')}
        hint={td('setWindowHint')}
        value={s.window}
        placeholder="Mon-Fri 22:00-06:00"
        onChange={(e) => set({ window: e.target.value })}
        spellCheck={false}
      />
      <div className="rule" />
      <Toggle
        label={td('setHistory')}
        description={td('setHistoryHint')}
        checked={s.history}
        onChange={(history) => set({ history })}
      />
      <Toggle
        label={td('setNotifications')}
        checked={s.notifications}
        onChange={(notifications) => set({ notifications })}
      />
      <Toggle
        label={td('setCloseToTray')}
        checked={s.closeToTray}
        onChange={(closeToTray) => set({ closeToTray })}
      />
      <Toggle
        label={td('setStartAtLogin')}
        checked={s.startAtLogin}
        onChange={(startAtLogin) => set({ startAtLogin })}
      />
      <SelectField
        label={td('setLanguage')}
        value={s.language}
        onChange={(e) => set({ language: e.target.value as AppSettings['language'] })}
        options={[
          { value: 'auto', label: td('langAuto') },
          { value: 'en', label: 'English' },
          { value: 'it', label: 'Italiano' },
        ]}
      />
      {msg && (
        <Notice tone={msg.tone} role={msg.tone === 'danger' ? 'alert' : 'status'}>
          {msg.text}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => void save()} icon={<Save size={13} aria-hidden="true" />}>
          {td('save')}
        </Button>
      </div>
    </div>
  );
}

import { Link2, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Notice } from '@/components/ui';
import { api, type Registered } from './api';
import { td } from './i18n';

/** Which browsers the extension can hand downloads over from, and a way to write the link again. */
export function BrowserLink() {
  const [browsers, setBrowsers] = useState<Registered[]>();
  const [repaired, setRepaired] = useState(false);
  useEffect(() => {
    void api.browserLink().then(setBrowsers);
  }, []);

  const repair = async () => {
    setBrowsers(await api.repairBrowserLink());
    setRepaired(true);
  };

  return (
    <section className="space-y-3" data-testid="browser-link">
      <div className="rule" />
      <h2 className="mono flex items-center gap-2 text-[12px] uppercase tracking-[0.16em] text-neon">
        <Link2 size={13} aria-hidden="true" />
        {td('linkTitle')}
      </h2>
      <p className="text-[12px] text-muted">{td('linkHint')}</p>
      {browsers && browsers.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {browsers.map((b) => (
            <li key={b.location} title={b.location}>
              <Badge tone="acid">{b.browser}</Badge>
            </li>
          ))}
        </ul>
      )}
      {browsers && browsers.length === 0 && <Notice tone="magenta">{td('linkNone')}</Notice>}
      {repaired && (
        <Notice tone="acid" role="status">
          {td('linkRepaired')}
        </Notice>
      )}
      <Button onClick={() => void repair()} icon={<Wrench size={13} aria-hidden="true" />}>
        {td('linkRepair')}
      </Button>
    </section>
  );
}

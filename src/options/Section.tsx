import type { ReactNode } from 'react';
import { Panel } from '@/components/ui';

/** One group of settings on the options page. */
export function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <Panel className="p-5">
      <h2 className="mono text-[12px] uppercase tracking-[0.16em] text-neon">{title}</h2>
      {hint && <p className="mt-1 text-[12px] text-muted">{hint}</p>}
      <div className="rule my-3" />
      <div className="space-y-4">{children}</div>
    </Panel>
  );
}

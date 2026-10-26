import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './ui';

export interface TabDef<K extends string> {
  key: K;
  label: string;
  count: number;
}

/** Accessible tab strip (WAI-ARIA tabs pattern: arrow keys, Home/End, roving tabindex). The panel is the caller's. */
export function Tabs<K extends string>({
  tabs,
  active,
  onChange,
  label,
  children,
}: {
  tabs: ReadonlyArray<TabDef<K>>;
  active: K;
  onChange: (key: K) => void;
  label: string;
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const move = (to: number) => {
    const next = tabs[(to + tabs.length) % tabs.length];
    if (!next) return;
    onChange(next.key);
    refs.current.get(next.key)?.focus();
  };
  const onKey = (e: KeyboardEvent, index: number) => {
    if (e.key === 'ArrowRight') move(index + 1);
    else if (e.key === 'ArrowLeft') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(tabs.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div>
      <div role="tablist" aria-label={label} className="mb-2.5 flex gap-1 border-b border-white/8">
        {tabs.map((tab, i) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                if (el) refs.current.set(tab.key, el);
                else refs.current.delete(tab.key);
              }}
              id={`${base}-tab-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={(e) => onKey(e, i)}
              className={cx(
                'mono -mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[10.5px] uppercase tracking-[0.12em] transition-colors',
                selected ? 'border-neon text-neon' : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {tab.label}
              <span className={cx('rounded px-1 text-[10px]', selected ? 'bg-neon/15' : 'bg-white/8')}>
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`}>
        {children}
      </div>
    </div>
  );
}

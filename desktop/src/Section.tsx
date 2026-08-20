import { useState, type ReactNode } from 'react';

/**
 * A sidebar section that can be folded away.
 *
 * The state is per-section in localStorage rather than in React state alone:
 * a sidebar that forgets what you collapsed is one you have to collapse every
 * launch, which is worse than not being collapsible.
 *
 * Collapsed sections keep their count visible. Hiding both the contents and any
 * indication of how much is in there turns the sidebar into a memory test.
 */
export function Section({ title, count, storageKey, action, children }: {
  title: string;
  count?: number;
  storageKey: string;
  /** Rendered on the right of the header — a "new folder" button and the like.
   *  Kept out of the toggle so clicking it does not also fold the section. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => localStorage.getItem(storageKey) !== 'closed');

  const toggle = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem(storageKey, next ? 'open' : 'closed');
  };

  return (
    <>
      <h2 className="section">
        <button className="section-toggle" onClick={toggle} aria-expanded={open}>
          <span className="section-twisty">{open ? '▾' : '▸'}</span>
          <span>{title}</span>
          {!open && count !== undefined && <span className="section-count">{count}</span>}
        </button>
        {action}
      </h2>
      {open && children}
    </>
  );
}

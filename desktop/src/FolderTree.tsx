import { useState } from 'react';
import type { Folder } from '@kb/core';

/**
 * The user's own organisation. It is derived from note paths and stored
 * nowhere, which means an empty folder cannot exist on disk — a folder is real
 * once a note is filed into it. `pending` carries the ones the user has just
 * made and not yet written to, so creating a folder and then a note in it feels
 * ordinary rather than like a trick.
 */
export function FolderTree({ root, pending, selected, onSelect }: {
  root: Folder;
  pending: string[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const merged = withPending(root, pending);
  return <>{merged.children.map((f) => <Node key={f.path} folder={f} selected={selected} onSelect={onSelect} depth={0} />)}</>;
}

function Node({ folder, selected, onSelect, depth }: {
  folder: Folder; selected: string | null; onSelect: (p: string) => void; depth: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = folder.children.length > 0;
  return (
    <>
      <div className="row" style={{ paddingLeft: depth * 12 }}>
        <button className="twisty" aria-hidden={!hasChildren}
                onClick={() => setOpen((o) => !o)}
                style={{ visibility: hasChildren ? 'visible' : 'hidden' }}>
          {open ? '▾' : '▸'}
        </button>
        <button className="tag" aria-selected={selected === folder.path}
                onClick={() => onSelect(folder.path)}>
          <span>{folder.name}</span>
          <span className="count">{folder.count || ''}</span>
        </button>
      </div>
      {open && folder.children.map((c) =>
        <Node key={c.path} folder={c} selected={selected} onSelect={onSelect} depth={depth + 1} />)}
    </>
  );
}

function withPending(root: Folder, pending: string[]): Folder {
  if (!pending.length) return root;
  const clone = (f: Folder): Folder => ({ ...f, children: f.children.map(clone) });
  const out = clone(root);
  for (const path of pending) {
    let node = out;
    let acc = '';
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      let next = node.children.find((c) => c.name === part);
      if (!next) {
        next = { name: part, path: acc, children: [], count: 0 };
        node.children.push(next);
        node.children.sort((a, b) => a.name.localeCompare(b.name));
      }
      node = next;
    }
  }
  return out;
}

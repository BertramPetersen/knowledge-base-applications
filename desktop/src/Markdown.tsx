import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '@kb/core';

/** Tokens become React elements. Untrusted text never becomes markup, so there
 *  is no innerHTML anywhere in the reading path. */
function renderInline(nodes: Inline[], onOpen: (id: string) => void, exists: (id: string) => boolean): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return <Fragment key={i}>{n.v}</Fragment>;
      case 'strong': return <strong key={i}>{renderInline(n.v, onOpen, exists)}</strong>;
      case 'em': return <em key={i}>{renderInline(n.v, onOpen, exists)}</em>;
      case 'code': return <code key={i}>{n.v}</code>;
      case 'link':
        return <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">{n.v}</a>;
      case 'wikilink': {
        const ok = exists(n.target);
        return (
          <button key={i} className="wikilink" data-broken={!ok}
                  title={ok ? n.target : `Missing: ${n.target}`}
                  onClick={() => ok && onOpen(n.target)}>
            {n.label}
          </button>
        );
      }
    }
  });
}

function renderBlock(b: Block, key: number, onOpen: (id: string) => void, exists: (id: string) => boolean): ReactNode {
  switch (b.t) {
    case 'h': {
      const H = `h${Math.min(b.level + 1, 6)}` as 'h2';
      return <H key={key}>{renderInline(b.v, onOpen, exists)}</H>;
    }
    case 'p': return <p key={key}>{renderInline(b.v, onOpen, exists)}</p>;
    case 'quote': return <blockquote key={key}>{b.v.map((c, i) => renderBlock(c, i, onOpen, exists))}</blockquote>;
    case 'code': return <pre key={key}><code>{b.v}</code></pre>;
    case 'hr': return <hr key={key} />;
    case 'list': {
      const L = b.ordered ? 'ol' : 'ul';
      return <L key={key}>{b.items.map((it, i) => <li key={i}>{renderInline(it, onOpen, exists)}</li>)}</L>;
    }
  }
}

export function Markdown({ source, onOpen, exists }: {
  source: string;
  onOpen: (id: string) => void;
  exists: (id: string) => boolean;
}) {
  return <div className="prose">{parseMarkdown(source).map((b, i) => renderBlock(b, i, onOpen, exists))}</div>;
}

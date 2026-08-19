import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from './markdown.ts';
import { linkLabel } from './vault.ts';

type Ctx = {
  onOpen: (id: string) => void;
  /** Turns a link target into a note id, or null when nothing answers to it. */
  resolve: (target: string) => string | null;
};

/** Tokens become React elements. Untrusted text never becomes markup, so there
 *  is no innerHTML anywhere in the reading path. */
function renderInline(nodes: Inline[], ctx: Ctx): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return <Fragment key={i}>{n.v}</Fragment>;
      case 'strong': return <strong key={i}>{renderInline(n.v, ctx)}</strong>;
      case 'em': return <em key={i}>{renderInline(n.v, ctx)}</em>;
      case 'code': return <code key={i}>{n.v}</code>;
      case 'link':
        return <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">{n.v}</a>;
      case 'wikilink': {
        // The target is a path, so an un-aliased link would otherwise read as
        // `raw/2026-08-12-the-engineering-....md` mid-sentence. Show the name.
        const id = ctx.resolve(n.target);
        return (
          <button key={i} className="wikilink" data-broken={!id}
                  title={id ?? `Missing: ${n.target}`}
                  onClick={() => id && ctx.onOpen(id)}>
            {n.label ?? linkLabel(n.target)}
          </button>
        );
      }
    }
  });
}

function renderBlock(b: Block, key: number, ctx: Ctx): ReactNode {
  switch (b.t) {
    case 'h': {
      const H = `h${Math.min(b.level + 1, 6)}` as 'h2';
      return <H key={key}>{renderInline(b.v, ctx)}</H>;
    }
    case 'p': return <p key={key}>{renderInline(b.v, ctx)}</p>;
    case 'quote': return <blockquote key={key}>{b.v.map((c, i) => renderBlock(c, i, ctx))}</blockquote>;
    case 'code': return <pre key={key}><code>{b.v}</code></pre>;
    case 'hr': return <hr key={key} />;
    case 'list': {
      const L = b.ordered ? 'ol' : 'ul';
      return <L key={key}>{b.items.map((it, i) => <li key={i}>{renderInline(it, ctx)}</li>)}</L>;
    }
  }
}

export function Markdown({ source, onOpen, resolve }: { source: string } & Ctx) {
  const ctx = { onOpen, resolve };
  return <div className="prose">{parseMarkdown(source).map((b, i) => renderBlock(b, i, ctx))}</div>;
}

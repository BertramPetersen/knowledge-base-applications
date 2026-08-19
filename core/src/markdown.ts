/**
 * A small markdown parser producing tokens, not HTML.
 *
 * Tokens rather than an HTML string because the content here is not all typed by
 * the user: it is written by an LLM and arrives over sync. Rendering tokens into
 * framework elements means there is never a point where untrusted text becomes
 * markup, so the whole class of injection bugs cannot occur.
 *
 * It also handles `[[wikilinks]]`, which no general markdown library does, and
 * those are the vault's primary structure.
 */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: Inline[] }
  | { t: 'em'; v: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string }
  | { t: 'wikilink'; target: string; label: string };

export type Block =
  | { t: 'h'; level: number; v: Inline[] }
  | { t: 'p'; v: Inline[] }
  | { t: 'quote'; v: Block[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'code'; v: string; lang?: string }
  | { t: 'hr' };

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };

  for (let i = 0; i < src.length; ) {
    const rest = src.slice(i);

    const wiki = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(rest);
    if (wiki) {
      flush();
      out.push({ t: 'wikilink', target: wiki[1], label: wiki[2] || wiki[1] });
      i += wiki[0].length; continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      out.push({ t: 'link', v: link[1], href: link[2] });
      i += link[0].length; continue;
    }
    const code = /^`([^`]+)`/.exec(rest);
    if (code) { flush(); out.push({ t: 'code', v: code[1] }); i += code[0].length; continue; }

    const strong = /^\*\*([^*]+)\*\*/.exec(rest) ?? /^__([^_]+)__/.exec(rest);
    if (strong) { flush(); out.push({ t: 'strong', v: parseInline(strong[1]) }); i += strong[0].length; continue; }

    const em = /^\*([^*]+)\*/.exec(rest) ?? /^_([^_]+)_/.exec(rest);
    if (em) { flush(); out.push({ t: 'em', v: parseInline(em[1]) }); i += em[0].length; continue; }

    const bare = /^https?:\/\/\S+/.exec(rest);
    if (bare) { flush(); out.push({ t: 'link', v: bare[0], href: bare[0] }); i += bare[0].length; continue; }

    buf += src[i]; i++;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim() || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: 'code', v: body.join('\n'), lang });
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ t: 'h', level: h[1].length, v: parseInline(h[2]) }); i++; continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { blocks.push({ t: 'hr' }); i++; continue; }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', v: parseMarkdown(body.join('\n')) });
      continue;
    }

    const bullet = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        // continuation lines belong to the item above
        let text = m[2]; i++;
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]))
          text += ' ' + lines[i++].trim();
        items.push(parseInline(text));
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,6}\s|>|```|\s*([-*+]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push({ t: 'p', v: parseInline(para.join(' ')) });
  }

  return blocks;
}

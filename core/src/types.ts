/** A note's identity is its vault-relative path. Never derive it from the title:
 *  titles change when the text is edited, and links point at paths. */
export type NoteId = string;

export interface Note {
  id: NoteId;
  /** The prose, with any trailing `## Related` section removed. */
  body: string;
  /** First line, truncated. Display only — nothing keys off it. */
  title: string;
  tags: string[];
  created?: string;
  enrichedAt?: string;
  source?: string;
  url?: string;
  locator?: string;
  captureId?: string;
  captureImage?: string;
  /** Outgoing wikilinks, as they appeared. */
  links: { to: NoteId; alias?: string }[];
  /** Frontmatter keys the app does not model, preserved verbatim on write. */
  extra: Record<string, string>;
}

export interface Tag {
  name: string;
  description?: string;
  kind: 'topic' | 'medium';
}

export interface Wiki {
  tag: string;
  overview: string;
  sourceCount?: number;
  refreshedAt?: string;
}

export interface Vault {
  notes: Map<NoteId, Note>;
  tags: Map<string, Tag>;
  wikis: Map<string, Wiki>;
  /** Reverse link graph: note id -> ids of notes linking to it. */
  backlinks: Map<NoteId, NoteId[]>;
}

/**
 * The only thing platform-specific about reading a vault. Desktop implements it
 * over the real filesystem; mobile implements it over whatever the sync left in
 * IndexedDB. Everything else in core is shared because it goes through this.
 */
export interface VaultSource {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  remove?(path: string): Promise<void>;
}

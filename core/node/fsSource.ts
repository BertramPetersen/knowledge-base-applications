// Desktop's VaultSource: the real filesystem. Mobile will supply a different one
// backed by whatever the delta sync left in IndexedDB.
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { VaultSource } from '../src/types.ts';

export function fsSource(root: string): VaultSource {
  const walk = async (dir: string): Promise<string[]> =>
    (await Promise.all((await readdir(dir, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.'))
      .map(async (e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : p.endsWith('.md') ? [relative(root, p)] : [];
      }))).flat();
  return {
    list: () => walk(root),
    read: (p) => readFile(join(root, p), 'utf8'),
    write: async (p, c) => writeFile(join(root, p), c),
    remove: async (p) => rm(join(root, p)),
  };
}

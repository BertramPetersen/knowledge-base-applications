/**
 * The local copy of the vault.
 *
 * A phone is offline often and on a slow link the rest of the time, so the app
 * reads from here and never from the network. Sync is a background job that
 * refills this; the UI does not wait on it and does not break without it.
 */
import type { VaultSource } from '@kb/core';

const DB = 'kb';
const VERSION = 1;

export interface Cached {
  path: string;
  /** The blob hash this text came from; absent for a local edit not yet pushed. */
  sha?: string;
  text: string;
  /** Set when written locally and not yet accepted by the remote. */
  dirty?: boolean;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = async <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

export const getFile = (path: string) => tx<Cached | undefined>('files', 'readonly', (s) => s.get(path));
export const allFiles = () => tx<Cached[]>('files', 'readonly', (s) => s.getAll());
export const putCached = (f: Cached) => tx('files', 'readwrite', (s) => s.put(f) as IDBRequest<IDBValidKey>);
export const removeFile = (path: string) => tx('files', 'readwrite', (s) => s.delete(path) as unknown as IDBRequest<undefined>);

export const getMeta = <T>(key: string) => tx<T | undefined>('meta', 'readonly', (s) => s.get(key));
export const setMeta = <T>(key: string, value: T) =>
  tx('meta', 'readwrite', (s) => s.put(value, key) as IDBRequest<IDBValidKey>);

/**
 * A VaultSource over the cache, so `core` loads a vault on the phone through
 * exactly the code path it uses on the desktop. Writes land locally and are
 * marked dirty; pushing them is sync's job, not the editor's.
 */
export const cachedVault = (): VaultSource => ({
  list: async () => (await allFiles()).map((f) => f.path),
  read: async (path) => (await getFile(path))?.text ?? '',
  write: async (path, content) => {
    const existing = await getFile(path);
    await putCached({ path, sha: existing?.sha, text: content, dirty: true });
  },
  remove: removeFile,
});

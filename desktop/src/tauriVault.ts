import { invoke } from '@tauri-apps/api/core';
import type { VaultSource, RunGit } from '@kb/core';

/** Desktop's VaultSource — the real filesystem, through Rust. Mobile will
 *  implement the same interface over IndexedDB and reuse everything else. */
export const tauriVault = (vault: string): VaultSource => ({
  list: () => invoke('list_notes', { vault }),
  read: (path) => invoke('read_note', { vault, path }),
  write: (path, content) => invoke('write_note', { vault, path, content }),
  remove: (path) => invoke('delete_note', { vault, path }),
});

export const tauriGit = (vault: string): RunGit =>
  (args) => invoke('run_git', { vault, args });

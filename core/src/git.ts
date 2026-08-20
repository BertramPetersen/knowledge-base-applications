/**
 * The sync layer, replacing the Obsidian Git plugin.
 *
 * Shells out to system git rather than using a JS/Rust git implementation. macOS
 * ships git, and it already resolves credentials through the keychain — so there
 * is no auth code to write, and no second place for tokens to live.
 *
 * Platform-agnostic in shape: it takes a `run` function, so the Tauri shell
 * supplies process execution and this stays testable without one.
 */
export type RunGit = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface SyncResult {
  pulled: number;
  pushed: boolean;
  committed: string | null;
  conflict: boolean;
  message: string;
}

export class VaultGit {
  // Written out rather than as constructor parameter properties: core is
  // exercised directly with `node --experimental-strip-types`, and strip-only
  // mode cannot handle them. A file that only runs after a bundler is a file
  // that cannot be tested without one.
  private run: RunGit;
  private branch: string;

  constructor(run: RunGit, branch = 'main') {
    this.run = run;
    this.branch = branch;
  }

  private async git(...args: string[]) {
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout.trim();
  }

  head = () => this.git('rev-parse', 'HEAD');

  async isDirty(): Promise<boolean> {
    return (await this.git('status', '--porcelain')).length > 0;
  }

  async changedFiles(): Promise<string[]> {
    return (await this.git('status', '--porcelain'))
      .split('\n').filter(Boolean).map((l) => l.slice(3).trim());
  }

  /**
   * Commit whatever is in the working tree.
   *
   * The enrichment job writes to this same repo every two hours, so a commit
   * here is routine rather than exceptional — the message should say what
   * changed locally, not pretend to be a considered checkpoint.
   */
  async commit(message: string): Promise<string | null> {
    if (!(await this.isDirty())) return null;
    await this.git('add', '-A');
    await this.git('commit', '-m', message);
    return this.head();
  }

  /**
   * Pull, then push. Always in that order.
   *
   * The remote moves without us — the enrichment job pushes on its own schedule
   * — so a push that has not first pulled will be rejected, and doing it the
   * other way round is the single most common way this kind of sync breaks.
   *
   * --autostash lets a pull happen with a dirty tree, which matters because the
   * user is typing while this runs.
   */
  async sync(message: string): Promise<SyncResult> {
    const before = await this.head();
    let conflict = false;
    let pulledCount = 0;

    const committed = await this.commit(message);

    try {
      const out = await this.git('pull', '--rebase', '--autostash', 'origin', this.branch);
      pulledCount = (out.match(/^\s*\S+\s+\|/gm) ?? []).length;
    } catch (e) {
      // A rebase conflict leaves the repo mid-operation. Abort and hand back a
      // clean tree: an app silently sitting in a conflicted rebase is worse than
      // one that says it could not sync.
      await this.run(['rebase', '--abort']).catch(() => {});
      return {
        pulled: 0, pushed: false, committed, conflict: true,
        message: `Sync paused: ${(e as Error).message}. Local work is committed and safe.`,
      };
    }

    let pushed = false;
    if (committed || (await this.aheadCount()) > 0) {
      await this.git('push', 'origin', this.branch);
      pushed = true;
    }

    const after = await this.head();
    return {
      pulled: pulledCount, pushed, committed, conflict,
      message: before === after && !pushed ? 'Up to date' : 'Synced',
    };
  }

  private async aheadCount(): Promise<number> {
    try {
      return Number(await this.git('rev-list', '--count', `origin/${this.branch}..HEAD`)) || 0;
    } catch { return 0; }
  }

  /** Files changed between two commits — how the UI shows what the pipeline did. */
  async changedBetween(from: string, to = 'HEAD'): Promise<string[]> {
    return (await this.git('diff', '--name-only', `${from}..${to}`)).split('\n').filter(Boolean);
  }

  /**
   * Recent commits with the files they touched.
   *
   * One `git log` rather than a log plus a diff per commit: the record
   * separators keep it parseable, and this runs on every app launch.
   */
  async recent(limit = 60): Promise<import('./activity.ts').Commit[]> {
    // \x1e between commits, \x1f between fields — bytes that cannot occur in a
    // commit message, unlike any punctuation that looked safe until it wasn't.
    const out = await this.git(
      'log', `-${limit}`, '--name-status', '--date=iso-strict',
      '--pretty=format:\x1e%H\x1f%an <%ae>\x1f%aI\x1f%s');
    return out.split('\x1e').filter((c) => c.trim()).map((chunk) => {
      const [header, ...lines] = chunk.split('\n');
      const [sha, author, at, message] = header.split('\x1f');
      return {
        sha, author, at, message,
        files: lines.filter(Boolean).map((l) => {
          const [status, ...rest] = l.split('\t');
          return { path: rest[rest.length - 1], status: status[0] as 'A' | 'M' | 'D' };
        }).filter((f) => f.path),
      };
    });
  }
}

/**
 * Debounced auto-sync, matching the behaviour we already know works: wait for
 * typing to stop, then commit and push. Every keystroke restarts the timer, so
 * a paragraph produces one commit rather than forty.
 */
export function autoSync(git: VaultGit, intervalMs: number,
                         onResult: (r: SyncResult) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = async () => {
    try { onResult(await git.sync(`vault: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`)); }
    catch (e) { onResult({ pulled: 0, pushed: false, committed: null, conflict: false, message: `Sync failed: ${(e as Error).message}` }); }
  };
  return {
    touch() { clearTimeout(timer); timer = setTimeout(fire, intervalMs); },
    now: fire,
    stop() { clearTimeout(timer); },
  };

}

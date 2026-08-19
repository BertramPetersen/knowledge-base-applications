import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Stamps the built asset list into the service worker.
 *
 * Without it the worker can only cache what it happens to intercept, and it
 * registers after the first page has already fetched its scripts — so the app
 * shell survives going offline but the application does not, until a second
 * online visit. The filenames are content-hashed and only known here.
 */
function precache(): Plugin {
  return {
    name: 'kb-precache',
    apply: 'build',
    closeBundle() {
      const out = 'dist';
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else files.push('./' + relative(out, full).split('\\').join('/'));
        }
      };
      walk(out);
      const assets = files.filter((f) => f !== './sw.js' && !f.endsWith('.webmanifest'));
      const sw = join(out, 'sw.js');
      const build = String(Date.now());
      writeFileSync(sw, readFileSync(sw, 'utf8')
        .replace('__PRECACHE__', JSON.stringify(['./', ...assets]))
        .replace('__BUILD__', build));
      this.info(`precaching ${assets.length + 1} entries as kb-shell-${build}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), precache()],
  // Relative, so the build works under a subpath (GitHub Pages) as well as at a
  // domain root without a rebuild.
  base: './',
  server: { port: 1421, host: true },
});

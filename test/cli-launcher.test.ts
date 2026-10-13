/** Regression test: the bin launcher must boot the built CLI on any OS.
 * Guards the Windows ERR_UNSUPPORTED_ESM_URL_SCHEME fix (dynamic import of a
 * file URL, not a bare absolute path). Requires `npm run build` first. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', '..');

describe('cli launcher (bin/autoslave.js)', () => {
  it('--help exits 0 and prints usage with the real version', () => {
    const launcher = path.join(ROOT, 'bin', 'autoslave.js');
    const built = path.join(ROOT, 'dist', 'src', 'cli', 'index.js');
    if (!fs.existsSync(built)) {
      console.log('skipped: dist not built');
      return;
    }
    const out = execFileSync(process.execPath, [launcher, '--help'], { encoding: 'utf8', cwd: ROOT });
    const version = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    assert.ok(out.includes(`autoslave ${version}`), `version header missing in: ${out.slice(0, 120)}`);
    assert.ok(out.includes('autoslave run --task'), 'run usage missing');
  });

  it('launcher delegates via file URL (no ESM scheme error)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'autoslave.js'), 'utf8');
    assert.ok(src.includes('pathToFileURL'), 'launcher must convert the entry path with pathToFileURL');
    assert.ok(!/await import\(built\)/.test(src), 'launcher must not import a bare path');
  });
});

#!/usr/bin/env node
// AutoSlave CLI entry point. Delegates to the built daemon client in dist/.
// (Full CLI arrives in Phase 2; this stub exists so the `autoslave`
// executable name is verified on this machine from day one.)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(`autoslave ${pkgVersion()}`);
  process.exit(0);
}

const built = path.join(root, 'dist', 'cli', 'index.js');
if (existsSync(built)) {
  await import(built);
} else {
  console.error('autoslave: daemon CLI not built yet (Phase 2). Run `npm run build` once src/cli exists.');
  console.error(`autoslave ${pkgVersion()} — see CONTEXT.md for the project roadmap.`);
  process.exit(2);
}

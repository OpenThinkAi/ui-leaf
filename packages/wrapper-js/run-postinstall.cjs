#!/usr/bin/env node
'use strict';
// Guards against running before dist/ is built in the dev monorepo.
// In published npm tarballs, dist/postinstall.js is always present (built by CI).
const { existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const script = join(__dirname, 'dist', 'postinstall.js');
if (!existsSync(script)) {
  console.log('ui-leaf: dist not built yet — skipping postinstall (run `bun run build` first)');
  process.exit(0);
}
execFileSync(process.execPath, [script], { stdio: 'inherit' });

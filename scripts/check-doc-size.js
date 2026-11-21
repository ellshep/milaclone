#!/usr/bin/env node
// Fails when an agent-instruction file or the backlog grows past its word cap. These are
// loaded into AI sessions, so every extra line costs context and buries the
// rules that matter. Trim before raising a cap.
const fs = require('node:fs');
const path = require('node:path');

const CAPS = {
  'CLAUDE.md': 1500,
  'public/CLAUDE.md': 1500,
  'addons/voice/CLAUDE.md': 1500,
  'scripts/CLAUDE.md': 1500,
  'docs/backlog.md': 2000,
};

let failed = false;
for (const [file, cap] of Object.entries(CAPS)) {
  const words = fs
    .readFileSync(path.join(__dirname, '..', file), 'utf8')
    .split(/\s+/)
    .filter(Boolean).length;
  const ok = words <= cap;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: ${words}/${cap} words`);
}
if (failed) {
  console.error('\nTrim the file: keep only rules that cause bugs when missed (see CLAUDE.md "How we work").');
  process.exit(1);
}

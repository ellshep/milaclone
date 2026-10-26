import fs from 'node:fs';

// state.js caches DOM nodes at import time, so load index.html's markup first (scripts stripped).
const html = fs.readFileSync('public/index.html', 'utf8'); // vitest runs from the repo root;
document.body.innerHTML = html
  .replace(/^[\s\S]*<body[^>]*>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');

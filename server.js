'use strict';

const express = require('express');
const path = require('path');
const { DB_FILE } = require('./db');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HOST || '0.0.0.0';

// Bundle the TipTap editor (public/js/editor.js + its npm deps) into
// public/vendor/editor.js. Cards import() it the first time a note is edited.
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, 'public/js/editor.js')],
  outfile: path.join(__dirname, 'public/vendor/editor.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  logLevel: 'warning',
});

const app = express();
// The generic handler can also reach public/uploads (e.g. via an encoded URL), so
// it applies the same upload safety headers to anything it resolves in there.
const routes = require('./routes');
app.use(routes);
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: routes.setUploadHeaders }));

app.listen(PORT, HOST, () => {
  console.log(`\n  Canvas board running at http://${HOST}:${PORT}`);
  console.log(`  Data stored in ${DB_FILE}\n`);
});

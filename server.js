'use strict';

const express = require('express');
const path = require('path');
const { DB_FILE } = require('./db');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '5mb' }));
// The generic handler can also reach public/uploads (e.g. via an encoded URL), so
// it applies the same upload safety headers to anything it resolves in there.
const routes = require('./routes');
app.use(routes);
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: routes.setUploadHeaders }));

app.listen(PORT, HOST, () => {
  console.log(`\n  Canvas board running at http://${HOST}:${PORT}`);
  console.log(`  Data stored in ${DB_FILE}\n`);
});

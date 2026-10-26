'use strict';

const express = require('express');
const path = require('path');
const { DB_FILE } = require('./db');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '5mb' }));
// Routes first: they serve /uploads with safety headers before the generic static handler.
app.use(require('./routes'));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, HOST, () => {
  console.log(`\n  Canvas board running at http://${HOST}:${PORT}`);
  console.log(`  Data stored in ${DB_FILE}\n`);
});

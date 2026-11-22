// Test harness: the real board and the real MCP add-on, started as processes
// on free ports with a throwaway DATA_DIR. Used by the node tests and the
// Playwright page test.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MCP = fileURLToPath(new URL('../../mcp/src/server.js', import.meta.url));
const TOKEN = 'agent-test-token-0123456789';

const freePort = () =>
  new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const waitFor = async url => {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(url).then(
        r => r.status < 500,
        () => false
      )
    )
      return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('not up: ' + url);
};

export async function startStack() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
  const [bp, mp] = [await freePort(), await freePort()];
  const boardUrl = `http://127.0.0.1:${bp}`;
  const mcpUrl = `http://127.0.0.1:${mp}/mcp`;
  const procs = [
    spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(bp), HOST: '127.0.0.1' },
      stdio: 'ignore',
    }),
    spawn(process.execPath, [MCP], {
      env: { ...process.env, PORT: String(mp), HOST: '127.0.0.1', MCP_TOKEN: TOKEN, BOARD_URL: boardUrl },
      stdio: 'ignore',
    }),
  ];
  await waitFor(boardUrl + '/api/health');
  await waitFor(mcpUrl); // 401 without a token: up

  const api = async (method, p, body) => {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return (await fetch(boardUrl + p, opts)).json();
  };
  const items = async id => (await api('GET', '/api/canvas/' + id)).items;
  /** A new board under Home, optionally open to agents and with an agent card. Returns its id. */
  const board = async (title, { allow = false, agent } = {}) => {
    const { rootCanvasId } = await api('GET', '/api/root');
    const id = (await api('POST', '/api/item', { canvasId: rootCanvasId, type: 'board', data: { title } })).data
      .childCanvasId;
    if (allow) await api('PATCH', '/api/canvas/' + id, { agentAccess: true });
    if (agent) await api('POST', '/api/item', { canvasId: id, type: 'agent', x: 0, y: 0, data: agent });
    return id;
  };
  const stop = () => {
    for (const p of procs) p.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { boardUrl, mcpUrl, token: TOKEN, api, items, board, stop };
}

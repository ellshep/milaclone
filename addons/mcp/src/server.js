#!/usr/bin/env node
// milaclone's MCP server (docs/agent-addon.md W2). Two ways in:
//
//   node src/server.js           streamable HTTP on PORT (default 8787) at /mcp,
//                                behind `Authorization: Bearer $MCP_TOKEN`
//   node src/server.js --stdio   stdio, for Claude Code / Claude Desktop on the
//                                same machine (no token: it's a local process)
//
// Either way it talks to the board at BOARD_URL (default http://127.0.0.1:4321)
// through its public HTTP API. HTTP runs stateless: each POST gets its own
// server instance, so there is no session to keep.

import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Board } from './board.js';
import { registerTools } from './tools.js';

const BODY_MAX = 1024 * 1024;

export function createServer(board, agent = null) {
  const server = new McpServer({ name: 'milaclone', version: '1.0.0' });
  registerTools(server, board, agent);
  return server;
}

const reply = (res, status, error) =>
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error }));

// Read on every request, so an unset token always refuses rather than leaving it open.
function authorized(req, token) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const given = Buffer.from(m ? m[1].trim() : '');
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > BODY_MAX) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The HTTP handler; `token` is read per request through `getToken`. */
export function httpHandler(board, getToken = () => process.env.MCP_TOKEN || '') {
  return async (req, res) => {
    if (new URL(req.url, 'http://x').pathname !== '/mcp') return reply(res, 404, 'not found');
    const token = getToken();
    if (!token) return reply(res, 503, 'MCP server disabled: MCP_TOKEN is not set');
    if (!authorized(req, token)) return reply(res, 401, 'unauthorized');
    if (req.method !== 'POST') return reply(res, 405, 'stateless server: POST only');
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return reply(res, 400, 'bad JSON body: ' + e.message);
    }
    // The agent service (W3) names the agent card it acts for, for the write log (A21).
    const agent = typeof req.headers['x-agent-id'] === 'string' ? req.headers['x-agent-id'].slice(0, 100) : null;
    const server = createServer(board, agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error(JSON.stringify({ event: 'mcp.error', error: e.message }));
      if (!res.headersSent) reply(res, 500, 'internal error');
    }
  };
}

async function main() {
  const board = new Board(process.env.BOARD_URL || 'http://127.0.0.1:4321');
  if (process.argv.includes('--stdio')) {
    await createServer(board).connect(new StdioServerTransport());
    return;
  }
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '0.0.0.0';
  http.createServer(httpHandler(board)).listen(port, host, () => {
    console.error(JSON.stringify({ event: 'mcp.listening', port, token: !!process.env.MCP_TOKEN }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

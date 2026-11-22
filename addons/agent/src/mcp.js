// The board, through the MCP add-on (docs/agent-addon.md A9: the MCP server is
// the only way an agent touches the board). One client per agent, so the MCP's
// write log names the agent card (X-Agent-Id, A21).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class ToolError extends Error {}

export async function connect(url, token, agentId = null) {
  const client = new Client({ name: 'milaclone-agent', version: '1.0.0' });
  const headers = { Authorization: `Bearer ${token}` };
  if (agentId) headers['X-Agent-Id'] = agentId;
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  const { tools } = await client.listTools();
  return {
    tools,
    /** Calls a tool; returns its JSON (or text), throws ToolError on a refusal. */
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content && r.content[0] && r.content[0].text) || '';
      if (r.isError) throw new ToolError(text);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => client.close(),
  };
}

// Model providers (docs/agent-addon.md A5, A11). `anthropic` runs the SDK's
// Tool Runner; `fake` is deterministic, for tests and smoke runs. OpenAI,
// Gemini and local models come later, following the voice pipeline's llm.py.
//
// A provider is `async ({ agent, system, messages, tools }) => { text, usage, toolCalls }`.

import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';

const MAX_TOKENS = 16000;
const MAX_ITERATIONS = 20;
// Models that take the server-side refusal fallback (the API picks the fallback model).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** `clientOptions` go to the SDK client (tests pass a fake `fetch`). */
export function anthropicProvider(apiKey, clientOptions = {}) {
  let client;
  return async ({ agent, system, messages, tools }) => {
    client = client || new Anthropic({ apiKey, ...clientOptions });
    let toolCalls = 0;
    const runner = client.beta.messages.toolRunner({
      model: agent.model,
      max_tokens: MAX_TOKENS,
      max_iterations: MAX_ITERATIONS,
      // Persona and rules first and frozen, so they cache (A12).
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      tools: tools.map(t =>
        betaTool({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          run: args => {
            toolCalls++;
            return t.run(args);
          },
        })
      ),
      output_config: { effort: EFFORTS.has(agent.effort) ? agent.effort : 'medium' },
      ...(FALLBACK_MODELS.has(agent.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    });
    const usage = { input: 0, output: 0 };
    let last;
    for await (const message of runner) {
      last = message;
      usage.input += message.usage.input_tokens || 0;
      usage.output += message.usage.output_tokens || 0;
    }
    if (!last || last.stop_reason === 'refusal') throw new Error('the model declined this request');
    const text = last.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    return { text, usage, toolCalls };
  };
}

/**
 * No network. Replies "Fake reply to: <request>"; a request starting "add "
 * also makes a note with the rest, through create_item when the agent has it.
 */
export async function fakeProvider({ system, messages, tools }) {
  const prompt = String(messages[messages.length - 1].content);
  const request = (/<request>\n([\s\S]*?)\n<\/request>/.exec(prompt) || [])[1] || '';
  const boardId = (/\(board id ([^)]+)\)/.exec(system) || [])[1];
  const create = tools.find(t => t.name === 'create_item');
  let toolCalls = 0;
  if (create && /^add /i.test(request)) {
    await create.run({ board_id: boardId, type: 'note', data: { text: request.slice(4) } });
    toolCalls++;
  }
  return { text: `Fake reply to: ${request}`, usage: { input: 0, output: 0 }, toolCalls };
}

// The Anthropic provider's Tool Runner wiring, against a fake fetch (no key, no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicProvider } from '../src/providers.js';

const message = (content, stop) => ({
  id: 'msg_' + stop,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20 },
});

test('runs the tool the model asks for and returns the final text', async () => {
  const bodies = [];
  const replies = [
    message([{ type: 'tool_use', id: 'tu_1', name: 'get_board_outline', input: { board_id: 'c_1' } }], 'tool_use'),
    message([{ type: 'text', text: 'Two cards.' }], 'end_turn'),
  ];
  const fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies.shift()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const ran = [];
  const provider = anthropicProvider('sk-test', { fetch, maxRetries: 0 });
  const out = await provider({
    agent: { model: 'claude-opus-5-5', effort: 'low' },
    system: 'You are Clerk.',
    messages: [{ role: 'user', content: 'How many cards?' }],
    tools: [
      {
        name: 'get_board_outline',
        description: 'Outline',
        inputSchema: { type: 'object', properties: { board_id: { type: 'string' } }, required: ['board_id'] },
        run: async args => {
          ran.push(args);
          return 'Board "Desk", 2 cards';
        },
      },
    ],
  });
  assert.deepEqual(out, { text: 'Two cards.', usage: { input: 200, output: 40 }, toolCalls: 1 });
  assert.deepEqual(ran, [{ board_id: 'c_1' }]);
  const [first, second] = bodies;
  assert.equal(first.model, 'claude-opus-5-5');
  assert.deepEqual(first.output_config, { effort: 'low' });
  assert.equal(first.fallbacks, 'default');
  assert.deepEqual(first.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(first.cache_control, { type: 'ephemeral' }); // the tool loop reads from cache too
  assert.equal(first.tools[0].name, 'get_board_outline');
  const result = second.messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.match(JSON.stringify(result.content), /2 cards/);
});

test('a refusal is an error', async () => {
  const fetch = async () =>
    new Response(JSON.stringify(message([], 'refusal')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const provider = anthropicProvider('sk-test', { fetch, maxRetries: 0 });
  await assert.rejects(
    provider({
      agent: { model: 'claude-haiku-5-5' },
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
    }),
    /declined/
  );
});

test('a reply cut short says why', async () => {
  const fetch = async () =>
    new Response(JSON.stringify(message([{ type: 'text', text: 'Half an ans' }], 'max_tokens')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const provider = anthropicProvider('sk-test', { fetch, maxRetries: 0 });
  const out = await provider({
    agent: { model: 'claude-haiku-5-5' },
    system: 's',
    messages: [{ role: 'user', content: 'x' }],
    tools: [],
  });
  assert.equal(out.text, 'Half an ans\n\n(stopped: the reply reached the 16000-token limit)');
});

// The Worker's request checks and intent handling, run in Node against a
// certificate chain made up for the test (never Amazon's).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as x509 from '@peculiar/x509';
import { handle } from '../src/worker.js';
import { checkCertUrl, clearChainCache, VerifyError } from '../src/verify.js';

const ALG = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
};
const CERT_URL = 'https://s3.amazonaws.com/echo.api/echo-api-cert-test.pem';
const SKILL_ID = 'amzn1.ask.skill.test';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY = 86400000;

let pki;
async function makeChain({ san = 'echo-api.amazon.com', notBefore = NOW - DAY, notAfter = NOW + DAY, signer } = {}) {
  const caKeys = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const leafKeys = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Test Root',
    notBefore: new Date(NOW - 10 * DAY),
    notAfter: new Date(NOW + 10 * DAY),
    signingAlgorithm: ALG,
    keys: caKeys,
  });
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=echo-api.amazon.com',
    issuer: ca.subject,
    notBefore: new Date(notBefore),
    notAfter: new Date(notAfter),
    signingAlgorithm: ALG,
    publicKey: leafKeys.publicKey,
    signingKey: signer || caKeys.privateKey,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: san }])],
  });
  return { pem: leaf.toString('pem') + '\n' + ca.toString('pem'), leafKeys };
}

test.before(async () => {
  pki = await makeChain();
});
test.beforeEach(() => clearChainCache());

const ENV = { SKILL_ID, INGEST_URL: 'https://alexa-ingest.example.com/ingest/text', INGEST_API_TOKEN: 'ingest-token' };

function alexaBody(request, { appId = SKILL_ID, timestamp = new Date(NOW).toISOString() } = {}) {
  return JSON.stringify({
    version: '1.0',
    session: { application: { applicationId: appId } },
    context: { System: { application: { applicationId: appId } } },
    request: { requestId: 'r1', timestamp, locale: 'en-US', ...request },
  });
}
const intent = (name, task) => ({
  type: 'IntentRequest',
  intent: { name, slots: task === undefined ? {} : { task: { name: 'task', value: task } } },
});

async function sign(body, keys = pki.leafKeys) {
  const sig = await crypto.subtle.sign(ALG, keys.privateKey, new TextEncoder().encode(body));
  return Buffer.from(sig).toString('base64');
}

// Sends a signed request through the Worker. `ingest` answers the forwarded call.
async function send(body, { env = ENV, pem = pki.pem, headers, ingest, signature, certStatus = 200 } = {}) {
  const calls = { cert: 0, ingest: [] };
  const fetcher = async (url, init) => {
    if (String(url).startsWith('https://s3.amazonaws.com/')) {
      calls.cert++;
      return new Response(pem, { status: certStatus });
    }
    calls.ingest.push({ url: String(url), init });
    if (!ingest) return Response.json({ status: 'done', created: [{ title: 'x' }], speech: 'Added x.' });
    return ingest(url, init);
  };
  const req = new Request('https://milaclone-alexa.example.workers.dev/', {
    method: 'POST',
    headers: headers || {
      'Content-Type': 'application/json',
      SignatureCertChainUrl: CERT_URL,
      'Signature-256': signature ?? (await sign(body)),
    },
    body,
  });
  const res = await handle(req, env, { fetcher, now: NOW });
  return { status: res.status, body: await res.json(), calls };
}
const said = r => r.body.response.outputSpeech.text;

test('adds the spoken task through the pipeline and reads back its answer', async () => {
  const r = await send(alexaBody(intent('AddTaskIntent', 'buy printer ink tomorrow')), {
    env: { ...ENV, CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: 'secret' },
    ingest: () =>
      Response.json({ status: 'done', created: [{ title: 'Buy printer ink' }], speech: 'Added Buy printer ink.' }),
  });
  assert.equal(r.status, 200);
  assert.equal(said(r), 'Added Buy printer ink.');
  assert.equal(r.body.response.shouldEndSession, true);
  assert.equal(r.calls.ingest.length, 1);
  const call = r.calls.ingest[0];
  assert.equal(call.url, ENV.INGEST_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'manual');
  assert.deepEqual(JSON.parse(call.init.body), { text: 'buy printer ink tomorrow', source: 'alexa' });
  assert.equal(call.init.headers.Authorization, 'Bearer ingest-token');
  assert.equal(call.init.headers['CF-Access-Client-Id'], 'id.access');
  assert.equal(call.init.headers['CF-Access-Client-Secret'], 'secret');
});

test('sends no Access headers when no service token is set, and caps long text', async () => {
  const r = await send(alexaBody(intent('AddTaskIntent', 'a'.repeat(600))));
  assert.equal('CF-Access-Client-Id' in r.calls.ingest[0].init.headers, false);
  assert.equal(JSON.parse(r.calls.ingest[0].init.body).text.length, 500);
});

test('says so when the pipeline fails, never that the task was added', async () => {
  const body = alexaBody(intent('AddTaskIntent', 'buy milk'));
  let r = await send(body, { ingest: () => new Response('nope', { status: 500 }) });
  assert.match(said(r), /wasn't added/);
  r = await send(body, { ingest: () => new Response(null, { status: 302, headers: { Location: 'https://login' } }) });
  assert.match(said(r), /wasn't added/);
  r = await send(body, {
    ingest: () => {
      throw new DOMException('timed out', 'TimeoutError');
    },
  });
  assert.match(said(r), /couldn't reach/);
  r = await send(body, { ingest: () => new Response('not json') });
  assert.match(said(r), /couldn't confirm/);
  r = await send(body, { ingest: () => Response.json({ status: 'done' }) });
  assert.match(said(r), /couldn't confirm/);
});

test('launch, help, stop, fallback and an empty task never call the pipeline', async () => {
  let r = await send(alexaBody({ type: 'LaunchRequest' }));
  assert.equal(said(r), 'What should I add?');
  assert.equal(r.body.response.shouldEndSession, false);
  assert.ok(r.body.response.reprompt);
  assert.equal(r.calls.ingest.length, 0);

  r = await send(alexaBody(intent('AMAZON.HelpIntent')));
  assert.match(said(r), /add buy printer ink/);
  assert.equal(r.body.response.shouldEndSession, false);

  for (const name of ['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent']) {
    r = await send(alexaBody(intent(name)));
    assert.equal(said(r), 'Okay.');
    assert.equal(r.body.response.shouldEndSession, true);
  }

  r = await send(alexaBody(intent('AMAZON.FallbackIntent')));
  assert.match(said(r), /didn't catch/);
  assert.equal(r.calls.ingest.length, 0);

  for (const task of [undefined, '   ']) {
    r = await send(alexaBody(intent('AddTaskIntent', task)));
    assert.equal(said(r), 'What should I add?');
    assert.equal(r.calls.ingest.length, 0);
  }

  r = await send(alexaBody({ type: 'SessionEndedRequest', reason: 'USER_INITIATED' }));
  assert.deepEqual(r.body, { version: '1.0', response: {} });
  r = await send(alexaBody({ type: 'AudioPlayer.PlaybackStarted' }));
  assert.match(said(r), /can't do that/);
});

test('refuses another skill, a wrong signature and a tampered body', async () => {
  const body = alexaBody(intent('AddTaskIntent', 'buy milk'));
  let r = await send(alexaBody(intent('AddTaskIntent', 'buy milk'), { appId: 'amzn1.ask.skill.other' }));
  assert.equal(r.status, 400);
  assert.equal(r.calls.ingest.length, 0);

  r = await send(body, { signature: await sign(body.replace('buy milk', 'buy gold')) });
  assert.equal(r.status, 400);
  r = await send(body, { signature: 'not base64 !!!' });
  assert.equal(r.status, 400);
  const other = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  r = await send(body, { signature: await sign(body, other) });
  assert.equal(r.status, 400);
  assert.equal(r.calls.ingest.length, 0);

  r = await send('{not json', {});
  assert.equal(r.status, 400);
});

test('refuses missing headers and certificate URLs that are not Amazon’s', async () => {
  const body = alexaBody(intent('AddTaskIntent', 'buy milk'));
  const signature = await sign(body);
  let r = await send(body, { headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  r = await send(body, { headers: { 'Signature-256': signature } });
  assert.equal(r.status, 400);
  assert.equal(r.calls.cert, 0);
  for (const url of [
    'http://s3.amazonaws.com/echo.api/cert.pem',
    'https://evil.example.com/echo.api/cert.pem',
    'https://s3.amazonaws.com.evil.example/echo.api/cert.pem',
    'https://s3.amazonaws.com/other/cert.pem',
    'https://s3.amazonaws.com/echo.api/../other/cert.pem',
    'https://s3.amazonaws.com:8443/echo.api/cert.pem',
    'https://user:pw@s3.amazonaws.com/echo.api/cert.pem',
  ]) {
    r = await send(body, { headers: { SignatureCertChainUrl: url, 'Signature-256': signature } });
    assert.equal(r.status, 400, url);
    assert.equal(r.calls.cert, 0, url);
  }
  assert.equal(checkCertUrl('https://S3.amazonaws.com:443/echo.api/x.pem'), 'https://s3.amazonaws.com/echo.api/x.pem');
  assert.throws(() => checkCertUrl(undefined), VerifyError);
});

test('refuses a stale request and bad certificates', async () => {
  const stale = alexaBody(intent('AddTaskIntent', 'x'), { timestamp: new Date(NOW - 151_000).toISOString() });
  assert.equal((await send(stale)).status, 400);
  const fresh = alexaBody(intent('AddTaskIntent', 'x'), { timestamp: new Date(NOW - 100_000).toISOString() });
  assert.equal((await send(fresh)).status, 200);
  assert.equal((await send(alexaBody(intent('AddTaskIntent', 'x'), { timestamp: 'never' }))).status, 400);

  const body = alexaBody(intent('AddTaskIntent', 'x'));
  const cases = {
    'wrong name': await makeChain({ san: 'echo-api.example.com' }),
    expired: await makeChain({ notBefore: NOW - 3 * DAY, notAfter: NOW - DAY }),
    'not yet valid': await makeChain({ notBefore: NOW + DAY, notAfter: NOW + 2 * DAY }),
    'not signed by its issuer': await makeChain({
      signer: (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])).privateKey,
    }),
  };
  for (const [name, chain] of Object.entries(cases)) {
    clearChainCache();
    const r = await send(body, { pem: chain.pem, signature: await sign(body, chain.leafKeys) });
    assert.equal(r.status, 400, name);
    assert.equal(r.calls.ingest.length, 0, name);
  }
  clearChainCache();
  assert.equal((await send(body, { pem: 'garbage' })).status, 400);
  assert.equal((await send(body, { pem: '' })).status, 400);
  assert.equal((await send(body, { certStatus: 404 })).status, 400);
});

test('fetches the certificate once and reuses it', async () => {
  const body = alexaBody({ type: 'LaunchRequest' });
  assert.equal((await send(body)).calls.cert, 1);
  assert.equal((await send(body)).calls.cert, 0);
});

test('refuses other methods, an unconfigured Worker and callers over the rate limit', async () => {
  const get = await handle(new Request('https://w.example/'), ENV, {});
  assert.equal(get.status, 404);
  const body = alexaBody({ type: 'LaunchRequest' });
  assert.equal((await send(body, { env: { ...ENV, SKILL_ID: '' } })).status, 503);
  assert.equal((await send(body, { env: { ...ENV, INGEST_API_TOKEN: undefined } })).status, 503);

  const keys = [];
  const limiter = ok => ({
    limit: async ({ key }) => {
      keys.push(key);
      return { success: ok };
    },
  });
  let r = await send(body, { env: { ...ENV, RATE_LIMITER: limiter(false) } });
  assert.equal(r.status, 429);
  assert.equal(r.calls.cert, 0);
  r = await send(body, { env: { ...ENV, RATE_LIMITER: limiter(true) } });
  assert.equal(r.status, 200);
  assert.deepEqual(keys, ['unknown', 'unknown']);
});

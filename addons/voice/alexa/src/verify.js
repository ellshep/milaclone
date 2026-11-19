// Proves a request really came from Alexa, following Amazon's rules for a
// skill hosted as a web service:
//   1. the SignatureCertChainUrl header points at Amazon's certificate bucket;
//   2. the certificate fetched from it is in date, names echo-api.amazon.com,
//      and each certificate in the chain is signed by the next;
//   3. the Signature-256 header is that certificate's RSA-SHA256 signature of
//      the raw request body;
//   4. the request's timestamp is at most 150 seconds old.
// The chain's root isn't checked against a root store: the chain is fetched
// over TLS from Amazon's own bucket, which only Amazon can write to.

import * as x509 from '@peculiar/x509';

const CERT_HOST = 's3.amazonaws.com';
const CERT_PATH = '/echo.api/';
const SAN = 'echo-api.amazon.com';
const MAX_AGE_MS = 150_000;
const MAX_BODY = 200_000;
const SIGN = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

export class VerifyError extends Error {}
const fail = msg => {
  throw new VerifyError(msg);
};

export function checkCertUrl(raw) {
  let url;
  try {
    url = new URL(raw || '');
  } catch {
    fail('SignatureCertChainUrl is missing or not a URL');
  }
  if (url.protocol !== 'https:') fail('certificate URL is not https');
  if (url.hostname.toLowerCase() !== CERT_HOST) fail('certificate URL host is not ' + CERT_HOST);
  if (url.port && url.port !== '443') fail('certificate URL port is not 443');
  if (!url.pathname.startsWith(CERT_PATH)) fail('certificate URL path is not under ' + CERT_PATH);
  if (url.username || url.password) fail('certificate URL has credentials');
  return url.href;
}

// Parsed chains by URL, kept for the life of the Worker instance. Amazon
// reuses one URL until it rotates the certificate, and dates are re-checked
// on every request.
const chainCache = new Map();

async function loadChain(url, fetcher) {
  if (chainCache.has(url)) return chainCache.get(url);
  const res = await fetcher(url);
  if (!res.ok) fail('could not fetch the signing certificate (HTTP ' + res.status + ')');
  const pem = await res.text();
  let certs;
  try {
    certs = x509.PemConverter.decode(pem).map(der => new x509.X509Certificate(der));
  } catch {
    fail('signing certificate is not valid PEM');
  }
  if (!certs.length) fail('signing certificate chain is empty');
  for (let i = 0; i < certs.length - 1; i++) {
    const ok = await certs[i].verify({ publicKey: certs[i + 1].publicKey, signatureOnly: true });
    if (!ok) fail('signing certificate chain is broken');
  }
  const san = certs[0].getExtension(x509.SubjectAlternativeNameExtension);
  const names = san ? san.names.items.filter(n => n.type === 'dns').map(n => n.value.toLowerCase()) : [];
  if (!names.includes(SAN)) fail('signing certificate is not for ' + SAN);
  const key = await certs[0].publicKey.export(SIGN, ['verify']);
  const chain = { certs, key };
  if (chainCache.size > 20) chainCache.clear();
  chainCache.set(url, chain);
  return chain;
}

export function clearChainCache() {
  chainCache.clear();
}

function fromBase64(s) {
  let bin;
  try {
    bin = atob(s || '');
  } catch {
    fail('signature is not base64');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Returns the parsed request body, or throws VerifyError.
export async function verifyAlexaRequest(request, { fetcher = fetch, now = Date.now() } = {}) {
  const signature = request.headers.get('Signature-256');
  if (!signature) fail('Signature-256 header is missing');
  const url = checkCertUrl(request.headers.get('SignatureCertChainUrl'));

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY) fail('request body is too large');

  const { certs, key } = await loadChain(url, fetcher);
  for (const c of certs) {
    if (now < c.notBefore.getTime() || now > c.notAfter.getTime()) fail('signing certificate is out of date');
  }
  const ok = await crypto.subtle.verify(SIGN, key, fromBase64(signature), body);
  if (!ok) fail('signature does not match the request body');

  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    fail('request body is not JSON');
  }
  const ts = Date.parse(json?.request?.timestamp);
  if (Number.isNaN(ts) || Math.abs(now - ts) > MAX_AGE_MS) fail('request timestamp is too old');
  return json;
}

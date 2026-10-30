// Sends one test message to the dashboard exactly the way the server mod does, using a
// mcstats-chat.properties file, and says what went wrong if it doesn't get through.
//
//   node scripts/test-chat-ingest.mjs                 # reads ./mcstats-chat.properties
//   node scripts/test-chat-ingest.mjs path/to/file    # or another copy (e.g. the server's)
//   node scripts/test-chat-ingest.mjs --check         # checks the keys without storing anything
//
// Secrets are never printed; only their length and first/last characters.

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const check = args.includes('--check');
const file = args.find((a) => !a.startsWith('--')) || 'mcstats-chat.properties';

let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`Can't read ${file}: ${e.message}`);
  process.exit(1);
}

// Roughly how Java's Properties reads it (good enough for this file: no line continuations).
const problems = [];
if (raw.startsWith('﻿')) {
  problems.push('the file starts with a byte-order mark; mod 1.0.0 then misreads the first key (1.0.1 copes)');
  raw = raw.slice(1);
}
if (raw.includes('\r')) problems.push('the file has Windows line endings (harmless)');
const props = {};
for (const line of raw.split(/\r?\n/)) {
  const t = line.replace(/^\s+/, '');
  if (!t || t[0] === '#' || t[0] === '!') continue;
  const m = t.match(/^([^=:\s]+)\s*[=:\s]\s*(.*)$/);
  if (m) props[m[1]] = m[2].trim();
  else props[t.trim()] = '';
}

const mask = (v) => (!v ? '(blank)' : v.length <= 8 ? `(${v.length} chars)` : `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`);
const known = ['url', 'token', 'access_client_id', 'access_client_secret', 'system_messages'];
for (const k of Object.keys(props)) if (!known.includes(k)) problems.push(`unknown key "${k}" (typo?)`);
for (const k of ['url', 'token', 'access_client_id', 'access_client_secret']) {
  const v = props[k] || '';
  if (/^["'].*["']$/.test(v)) problems.push(`${k} is wrapped in quotes; the quotes become part of the value`);
  if (/[^\x21-\x7e]/.test(v)) problems.push(`${k} contains spaces or unusual characters (bad paste?)`);
}
const { url = '', token = '', access_client_id: id = '', access_client_secret: secret = '' } = props;
if (id && !id.endsWith('.access')) problems.push('access_client_id should end in ".access"');
if (url && !/\/api\/ingest\/chat\/?$/.test(url)) problems.push('url should end in /api/ingest/chat');

console.log(`File: ${file}`);
console.log(`  url                   ${url ? url.replace(/^(https?:\/\/)[^/]+/, '$1<host>') : '(blank)'}`);
console.log(`  token                 ${mask(token)}`);
console.log(`  access_client_id      ${mask(id)}`);
console.log(`  access_client_secret  ${mask(secret)}`);
for (const p of problems) console.log(`  ! ${p}`);
if (!url || !token) {
  console.error('\nurl and token are required; the mod sends nothing without them.');
  process.exit(1);
}

const events = check ? [] : [{
  id: `test-${randomBytes(6).toString('hex')}`,
  ts: Date.now(),
  kind: 'server',
  text: 'Test message from scripts/test-chat-ingest.mjs',
}];
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'mcstats-chat/test-script',
};
if (id) {
  headers['CF-Access-Client-Id'] = id;
  headers['CF-Access-Client-Secret'] = secret;
}

let res, body;
try {
  // The mod's HTTP client doesn't follow redirects either.
  res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ events }), redirect: 'manual' });
  body = await res.text();
} catch (e) {
  console.error(`\nCouldn't reach the dashboard: ${e.cause?.code || e.cause?.message || e.message}`);
  process.exit(1);
}

const s = res.status;
console.log(`\nHTTP ${s}`);
const verdict =
  s >= 200 && s < 300
    ? check
      ? 'OK: Access and the token both accept this file. Nothing was stored.'
      : `OK: stored ${body}. A "Test message" line should now be on the Chat log page.`
    : s === 401 ? 'Got past Access, but token doesn\'t match the Worker\'s CHAT_INGEST_TOKEN secret.'
    : s === 503 ? 'Got past Access, but the Worker has no CHAT_INGEST_TOKEN secret.'
    : s === 403 ? 'Cloudflare Access refused it: the access_client_id/secret aren\'t a service token allowed by a Service Auth policy on this app.'
    : s >= 300 && s < 400
      ? `Cloudflare Access redirected it to the login page${id ? ' (the service token wasn\'t accepted)' : ' (no access_client_id given)'}.`
    : s === 404 ? 'Wrong url: it should end in /api/ingest/chat.'
    : s === 400 ? `The dashboard rejected the data: ${body.slice(0, 200)}`
    : `Unexpected answer: ${body.slice(0, 200)}`;
console.log(verdict);
process.exit(s >= 200 && s < 300 ? 0 : 1);

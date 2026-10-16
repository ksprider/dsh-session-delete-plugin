/**
 * HTTP round-trip test for the plugin's host half.
 *
 * The other tests call `deleteSessionStorage()` directly. This one drives the
 * plugin exactly as the browser does: it mounts the real plugin on a fake
 * Cordis context, takes the route spec the plugin registered, serves it with
 * `node:http` using the same Fetch-shaped `Request`/`Response` objects the
 * Harness connection bridge uses, and then performs real `fetch()` calls
 * against it.
 *
 * Everything happens under a throwaway `DSH_HOME` in the OS temp directory.
 *
 * Run:
 *   node tests/verify-route.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../index.js';

const home = join(tmpdir(), `dsh-route-test-${String(Date.now())}`);
const cwd = '/Users/me/http test';
const sid = 'session-http-1';
process.env.DSH_HOME = home;

// ── Lay out one stored conversation in the Host's real on-disk shape ──────
const dir = join(home, 'sessions', plugin.projectKey(cwd), plugin.encodeSegment(sid));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(4096));
writeFileSync(join(dir, 'session.lock'), '');
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions');
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(cacheDir, `${sid}.json`), JSON.stringify({ v: 1 }));

// ── Mount the plugin on a fake ctx and capture the route it registers ────
let route;
const ctx = {
  effect(fn) {
    fn();
    return () => {};
  },
  connection: { fetch: { register: (spec) => ((route = spec), () => {}) } },
  get: (name) => (name === 'agents' ? { get: () => undefined } : name === 'sessions' ? { get: () => undefined } : undefined),
};
plugin.apply(ctx);

assert.ok(route, 'plugin registered a route');
assert.equal(route.path, '/api/dsh-session-delete');
assert.deepEqual(route.methods, ['POST']);
assert.equal(route.requestBody, 'buffered');

// ── Serve that handler through node:http, as the connection bridge does ──
const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url}`;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    ...(body === undefined ? {} : { body }),
  });
  const response = await route.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** POST a JSON body to the plugin route and return { status, json }. */
async function call(body, contentType = 'application/json') {
  const response = await fetch(`${base}${route.path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  let json;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

try {
  // 1. Wrong method is refused.
  const getResponse = await fetch(`${base}${route.path}`);
  assert.equal(getResponse.status, 405, 'GET is refused with 405');
  assert.equal(getResponse.headers.get('content-type')?.includes('application/json'), true, 'even the 405 is JSON');
  console.log('GET -> 405 JSON           OK');

  // 2. Malformed JSON body is refused, not crashed.
  let r = await call('not json at all');
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'invalid-body');
  console.log('malformed body -> 400     OK', JSON.stringify(r.json));

  // 3. A path-bearing id is refused before any path is built.
  r = await call(JSON.stringify({ sessionId: '../../etc/passwd' }));
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'invalid-session-id');
  console.log('traversal id -> 400       OK', JSON.stringify(r.json));

  // 4. Unknown conversation.
  r = await call(JSON.stringify({ sessionId: 'session-does-not-exist' }));
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'session-not-found');
  console.log('unknown id -> 404         OK', JSON.stringify(r.json));

  // 5. The real thing: files present, then deleted through the HTTP surface.
  const beforeExists = (await import('node:fs')).existsSync(dir);
  assert.equal(beforeExists, true, 'log dir exists before the call');
  r = await call(JSON.stringify({ sessionId: sid }));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.sessionId, sid);
  assert.equal(r.json.freedBytes, 4096 + 7);
  assert.ok(Array.isArray(r.json.removed) && r.json.removed.length === 2, 'reports both removed artifacts');
  assert.equal((await import('node:fs')).existsSync(dir), false, 'log dir gone');
  assert.equal((await import('node:fs')).existsSync(join(cacheDir, `${sid}.json`)), false, 'cache gone');
  console.log('delete -> 200             OK freed', r.json.freedBytes, 'bytes, removed', r.json.removed.length, 'paths');

  // 6. Idempotence: the same call again is now a clean not-found (not a 500).
  r = await call(JSON.stringify({ sessionId: sid }));
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'session-not-found');
  console.log('repeat delete -> 404      OK', JSON.stringify(r.json));

  // 7. A body with no sessionId at all.
  r = await call(JSON.stringify({}));
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'invalid-session-id');
  console.log('missing sessionId -> 400  OK');
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

console.log('route round-trip checks passed');

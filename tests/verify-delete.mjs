/**
 * Behaviour test for the plugin's Host half.
 *
 * Runs entirely inside a throwaway `DSH_HOME` under the OS temp directory, so
 * it never touches real conversations.
 *
 * Run:
 *   node tests/verify-delete.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../index.js';

const home = join(tmpdir(), `dsh-delete-test-${String(Date.now())}`);
const cwd = '/Users/me/my project';
const sid = 'session-abc-123';

const bucket = join(home, 'sessions', plugin.projectKey(cwd));
const dir = join(bucket, plugin.encodeSegment(sid));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048));
writeFileSync(join(dir, 'session.lock'), '');
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions');
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(cacheDir, `${sid}.json`), JSON.stringify({ v: 1 }));

/** Minimal Host context stand-in: live agents and the session registry. */
const ctx = (live, knownCwd) => ({
  get(name) {
    if (name === 'agents') return { get: (id) => (live && id === sid ? { id } : undefined) };
    if (name === 'sessions') return { get: (id) => (knownCwd === undefined ? undefined : { header: { id, cwd: knownCwd } }) };
    return undefined;
  },
});

process.env.DSH_HOME = home;

// 1. A live conversation is refused and nothing is removed.
let result = await plugin.deleteSessionStorage(ctx(true, cwd), sid);
assert.equal(result.ok, false);
assert.equal(result.code, 'session-live');
assert.ok(existsSync(dir), 'a live refusal must not delete anything');
console.log('live refusal       OK ->', result.code);

// 2. A path-bearing id is refused before any path is built.
result = await plugin.deleteSessionStorage(ctx(false, cwd), '../etc/passwd');
assert.equal(result.ok, false);
assert.equal(result.code, 'invalid-session-id');
console.log('bad id refusal     OK ->', result.code);

// 3. An unknown id reports not-found.
result = await plugin.deleteSessionStorage(ctx(false, cwd), 'session-nope');
assert.equal(result.ok, false);
assert.equal(result.code, 'session-not-found');
console.log('not-found          OK ->', result.code);

// 4. Happy path with a known cwd: both artifacts go, size is reported.
result = await plugin.deleteSessionStorage(ctx(false, cwd), sid);
assert.equal(result.ok, true);
assert.equal(result.freedBytes, 2048 + 7);
assert.ok(!existsSync(dir), 'log dir must be removed');
assert.ok(!existsSync(join(cacheDir, `${sid}.json`)), 'cache row must be removed');
console.log('delete with cwd    OK -> freed', result.freedBytes, 'bytes');

// 5. Happy path without a header: the workspace-bucket scan finds the log.
const scanned = join(home, 'sessions', '--some-other-project--', sid);
mkdirSync(scanned, { recursive: true });
writeFileSync(join(scanned, 'session.v4.jsonl.zstd'), Buffer.alloc(100));
writeFileSync(join(cacheDir, `${sid}.json`), '{}');
result = await plugin.deleteSessionStorage(ctx(false, undefined), sid);
assert.equal(result.ok, true);
assert.equal(result.freedBytes, 102);
assert.ok(!existsSync(scanned));
console.log('delete via scan    OK -> freed', result.freedBytes, 'bytes');

// 6. The Harness home follows DSH_HOME.
assert.equal(plugin.resolveHome(), home);
console.log('DSH_HOME honoured  OK');

rmSync(home, { recursive: true, force: true });
console.log('all delete-path checks passed');

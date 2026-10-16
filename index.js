/**
 * Host half of the "delete conversation" plugin.
 *
 * The browser half renders a Delete row in the sidebar session menu and calls
 * the authenticated route below. Deletion is a storage-level operation: the
 * Harness session-persistence seam is append-only (it has no delete), so the
 * route removes the two artifacts a persisted conversation owns:
 *
 *   <DSH_HOME>/sessions/<workspaceKey>/<sessionId>/   the append-only log dir
 *   <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json   the
 *                                                     title/list cache row
 *
 * A live (currently attached) conversation is refused: its agent may still
 * append to the log, so removing the file under it would lose data. Archive it
 * first, or delete it after it is no longer open.
 *
 * @module @local/dsh-session-delete
 */

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';

/** Authenticated route the browser half posts to. */
const DELETE_ROUTE = '/api/dsh-session-delete';

/**
 * Resolve the Harness home the running Host uses.
 *
 * `DSH_HOME` is resolved by the launcher and inherited by this process, so the
 * environment is authoritative; `~/.dsh` is the documented default.
 *
 * @returns absolute Harness home path.
 */
export function resolveHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

/**
 * Encode one path segment exactly as the JSONL persistence backend does.
 *
 * Copied from the Host's `encodeSegment`: `.`/`..` are escaped, `[A-Za-z0-9._-]`
 * survives, and every other UTF-16 code unit becomes `~XXXX` (upper-case hex,
 * four digits). Session ids are normally UUID-shaped, but re-deriving the name
 * instead of assuming it keeps us aligned with whatever the Host wrote.
 *
 * @param raw - the session id as stored in the header.
 * @returns the filesystem-safe segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Build the Host's readable per-project session directory name.
 *
 * Copied from the Host's `projectKey`: `/`, `\` and `:` collapse into single
 * `-` runs, unsafe code units use the same `~XXXX` escape, leading dashes are
 * stripped (an all-separator path becomes `root`) and the readable part is
 * truncated to 251 characters.
 *
 * @param cwd - the conversation's working directory from its session header.
 * @returns the directory name, or undefined when `cwd` is unusable.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root';
  return `--${trimmed.slice(0, 251)}--`;
}

/**
 * Every filesystem artifact one conversation owns.
 *
 * @param home - Harness home.
 * @param sessionId - exact conversation id.
 * @param cwd - the conversation's working directory, when known.
 * @returns candidate paths.
 */
export function sessionArtifacts(home, sessionId, cwd) {
  const sessionsRoot = join(home, 'sessions');
  const cachePath = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  const key = projectKey(cwd);
  const logDirs = [];
  if (key !== undefined) logDirs.push(join(sessionsRoot, key, encodeSegment(sessionId)));
  return { sessionsRoot, cachePath, logDirs };
}

/**
 * Locate the conversation's log directory by searching every workspace bucket.
 *
 * A conversation that no longer appears in the list has no header to read, so
 * the last resort is a scan of the workspace buckets. Rejecting anything but
 * "the bucket directly contains a directory named exactly `sessionId`" keeps
 * the delete inside the sessions root.
 *
 * @param sessionsRoot - `<DSH_HOME>/sessions`.
 * @param sessionId - exact conversation id.
 * @returns the log directory, or undefined when none exists.
 */
export async function findLogDirs(sessionsRoot, sessionId) {
  let buckets;
  try {
    buckets = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
  const encoded = encodeSegment(sessionId);
  const names = encoded === sessionId ? [sessionId] : [encoded, sessionId];
  const found = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    for (const name of names) {
      const candidate = join(sessionsRoot, bucket.name, name);
      let info;
      try {
        info = await stat(candidate);
      } catch {
        continue;
      }
      if (info.isDirectory()) found.push(candidate);
    }
  }
  return found;
}

/**
 * Directory size, best effort; a partial answer never fails a delete.
 *
 * @param path - directory to measure.
 * @returns byte count, or 0 when it cannot be measured.
 */
export async function directoryBytes(path) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += await directoryBytes(child);
      else total += (await stat(child)).size;
    } catch {
      /* a file that vanished mid-walk contributes nothing */
    }
  }
  return total;
}

/**
 * Refuse a path that is not strictly inside the sessions root.
 *
 * @param root - `<DSH_HOME>/sessions`.
 * @param candidate - path about to be removed.
 * @returns true when the candidate is one of the root's descendants.
 */
export function insideRoot(root, candidate) {
  const normalizedRoot = resolve(root) + sep;
  return resolve(candidate).startsWith(normalizedRoot);
}

/**
 * Delete one conversation's storage, refusing live conversations.
 *
 * @param ctx - Host plugin context (uses `agents` for the live check).
 * @param sessionId - exact conversation id from the sidebar row.
 * @returns a JSON-serializable result the browser half reports.
 */
export async function deleteSessionStorage(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || /[/\\]/.test(sessionId)) {
    return { ok: false, code: 'invalid-session-id', status: 400, message: 'A session id is required.' };
  }

  const agents = ctx.get('agents');
  const live = agents?.get(sessionId);
  if (live !== undefined) {
    return {
      ok: false,
      code: 'session-live',
      status: 409,
      message: 'This conversation is still open. Archive it or switch to another conversation, then delete it.',
    };
  }

  const home = resolveHome();
  const sessions = ctx.get('sessions');
  const known = sessions?.get(sessionId);
  const cwd = known?.header?.cwd;
  const { sessionsRoot, cachePath, logDirs } = sessionArtifacts(home, sessionId, cwd);

  const candidates = [];
  for (const dir of logDirs) if (existsSync(dir)) candidates.push(dir);
  if (candidates.length === 0) {
    for (const dir of await findLogDirs(sessionsRoot, sessionId)) candidates.push(dir);
  }
  const hasCache = existsSync(cachePath);

  if (candidates.length === 0 && !hasCache) {
    return { ok: false, code: 'session-not-found', status: 404, message: 'No stored conversation with that id was found.' };
  }

  let freed = 0;
  const removed = [];
  for (const dir of candidates) {
    if (!insideRoot(sessionsRoot, dir)) {
      return { ok: false, code: 'refused-path', status: 500, message: `Refusing to delete a path outside the sessions directory: ${dir}` };
    }
    freed += await directoryBytes(dir);
    await rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  if (hasCache) {
    try {
      freed += (await stat(cachePath)).size;
    } catch {
      /* size is informational only */
    }
    await rm(cachePath, { force: true });
    removed.push(cachePath);
  }

  return { ok: true, sessionId, freedBytes: freed, removed };
}

/**
 * Answer one authenticated request from the browser half.
 *
 * @param ctx - Host plugin context.
 * @param request - authenticated request.
 * @returns JSON response.
 */
async function handleRequest(ctx, request) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  if (request.method !== 'POST') return json(405, { ok: false, code: 'method-not-allowed', message: 'Use POST.' });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, code: 'invalid-body', message: 'Expected a JSON body.' });
  }
  const sessionId = payload?.sessionId;
  const result = await deleteSessionStorage(ctx, sessionId);
  if (result.ok) return json(200, result);
  return json(result.status ?? 500, result);
}

export const name = 'session-delete';
export const inject = ['connection', 'agents', 'sessions'];

/**
 * Register the delete route for this Host lifetime.
 *
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: DELETE_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleRequest(ctx, request),
      }),
    'session-delete: /api/dsh-session-delete',
  );
}

export default { name, inject, apply };

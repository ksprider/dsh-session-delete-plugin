/**
 * Checks the plugin's path re-derivation against the Host's own
 * projectKey/encodeSegment, read straight out of the installed Harness bundle.
 *
 * The Harness install is located through, in order:
 *   $DSH_APP_ASAR, $DSH_HOME/../app.asar (unlikely), the macOS default path.
 *
 * Run:
 *   node tests/verify-plugin.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const APP_ASAR =
  process.env.DSH_APP_ASAR ??
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

/**
 * Read one file out of the Harness asar by its internal path.
 *
 * The asar layout is a Pickle header: two UInt32 length words, the JSON index,
 * then the file data. Reading it directly keeps the test self-contained on a
 * fresh machine (no dependency on any earlier extraction).
 *
 * @param internalPath - asar-internal path of the file.
 * @returns the file's UTF-8 text.
 */
function readFromAsar(internalPath) {
  const archive = readFileSync(APP_ASAR);
  const jsonLength = archive.readUInt32LE(4);
  const raw = archive.subarray(16, 16 + jsonLength).toString('utf8');
  // The header region is padded after the JSON document; cut at its final brace
  // instead of trusting the declared length to land exactly on the last byte.
  const header = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
  let node = header;
  for (const segment of internalPath.split('/')) {
    node = node?.files?.[segment];
    if (node === undefined) throw new Error(`asar has no entry: ${internalPath}`);
  }
  // File data starts right after the two Pickle length words plus the header.
  const offset = 8 + jsonLength + Number(node.offset);
  return archive.subarray(offset, offset + node.size).toString('utf8');
}

/** The Host's shipped JSONL backend: the authority for both path functions. */
function hostSource() {
  return readFromAsar('dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js');
}

/** Pull one `function name(...) { ... }` body out of the Host bundle text. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `host bundle has no function ${name}`);
  let depth = 0;
  let index = source.indexOf('{', start);
  const open = index;
  for (; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const text = source.slice(start, index + 1);
  // eslint-disable-next-line no-new-func -- evaluating a read-only extracted copy
  return new Function(`${text}; return ${name};`)();
}

const hostProjectKey = extractFunction(hostSource(), 'projectKey');
const hostEncodeSegment = extractFunction(hostSource(), 'encodeSegment');

const mine = await import('../index.js');

const cwds = [
  '/Users/me/work',
  '/Users/me/work/deep-project',
  '/',
  '',
  '/Users/me/my project/子目录',
  'C:\\Users\\me\\work',
  '/a//b///c',
  '/Users/me/we~ird~name',
  '/Users/me/' + 'x'.repeat(400),
  '/tmp/.hidden/..',
];

for (const cwd of cwds) {
  const expected = cwd === '' ? undefined : hostProjectKey(cwd);
  const actual = mine.projectKey(cwd);
  assert.equal(actual, expected, `projectKey(${JSON.stringify(cwd)})`);
}

const ids = [
  'session-353fc04a-37bb-4079-aa48-499a4e05f709',
  '1251d733-cf41-4eb5-abbc-342ddf5b1e9a',
  '..',
  '.',
  'we~ird id/with:chars',
  'ünïcode-会话',
];

for (const id of ids) {
  assert.equal(mine.encodeSegment(id), hostEncodeSegment(id), `encodeSegment(${JSON.stringify(id)})`);
}

// End-to-end path shape for a representative install.
const home = '/home/user/.dsh';
const artifacts = mine.sessionArtifacts(home, 'session-abc', '/home/user/projects/my project');
assert.equal(
  artifacts.logDirs[0],
  '/home/user/.dsh/sessions/--home-user-projects-my~0020project--/session-abc',
  'log dir shape (a space in the path is escaped as ~0020, as the Host does)',
);
assert.equal(
  artifacts.cachePath,
  '/home/user/.dsh/storages/session_projcache/sessions/session-abc.json',
  'cache path shape',
);

// The traversal guard must reject anything outside the sessions root.
assert.equal(mine.insideRoot('/h/sessions', '/h/sessions/--a--/b'), true);
assert.equal(mine.insideRoot('/h/sessions', '/h/sessions'), false);
assert.equal(mine.insideRoot('/h/sessions', '/h/other/b'), false);
assert.equal(mine.insideRoot('/h/sessions', '/h/sessions/../../etc'), false);

console.log(`projectKey/encodeSegment match the Host on ${cwds.length + ids.length} inputs; guards hold`);

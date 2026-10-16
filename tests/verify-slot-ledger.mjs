/**
 * Integration test: registers the plugin into the REAL shipped slot ledger.
 *
 * The GUI's slot system is `@deepseek-ai/dsh-client-ui-slots`, which is a
 * dependency-free ESM module. This test extracts it from the installed Harness
 * asar, declares the sidebar session-menu child slot exactly as the shipped
 * `ui-workspace` package does, and then runs the plugin's own client half
 * against that ledger. Ledger errors (undeclared slot, duplicate id, missing
 * `id` on a list slot) therefore fail the test the same way they would fail
 * the real page.
 *
 * Run:
 *   node tests/verify-slot-ledger.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const SLOTS_INTERNAL = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js';
const CACHE = '/tmp/y/dsh__node_modules__@deepseek-ai__dsh-client-ui-slots__lib__index.js';

/**
 * Read one file out of the installed asar (Pickle header + JSON index).
 * @param internalPath - asar-internal path.
 * @returns the file's UTF-8 text.
 */
function readFromAsar(internalPath) {
  const archive = readFileSync(APP_ASAR);
  const jsonLength = archive.readUInt32LE(4);
  const raw = archive.subarray(16, 16 + jsonLength).toString('utf8');
  const header = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
  let node = header;
  for (const segment of internalPath.split('/')) {
    node = node?.files?.[segment];
    if (node === undefined) throw new Error(`asar has no entry: ${internalPath}`);
  }
  const offset = 8 + jsonLength + Number(node.offset);
  return archive.subarray(offset, offset + node.size).toString('utf8');
}

/** The slots core source, from the extracted cache or straight from the asar. */
function slotsSource() {
  try {
    return readFileSync(CACHE, 'utf8');
  } catch {
    return readFromAsar(SLOTS_INTERNAL);
  }
}

/** Stage the slots core as a real ESM module and import it. */
async function loadSlotCore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-slots-'));
  const file = join(dir, 'slots.mjs');
  writeFileSync(file, slotsSource());
  return import(pathToFileURL(file).href);
}

const slots = await loadSlotCore();
assert.equal(typeof slots.SlotCore, 'function', 'shipped slots module exports SlotCore');
assert.equal(typeof slots.standardHookPropName, 'function');

const core = new slots.SlotCore();

// ── The shipped declaration chain, verbatim from the client bundles ───────
// 1. ui-renderer owns the root slot; 2. ui-sidebar declares `sidebar.workspaces`
// as its child; 3. ui-workspace declares the session-menu list as its child.
const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
const menuOpenStateFactory = (_standard, state) => () => state;
core.register(
  { name: 'root', children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } },
  () => null,
);
core.register(
  {
    name: 'sidebar.workspaces',
    children: {
      'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
      [MENU_SLOT]: {
        kind: 'list',
        scope: 'root',
        inject: { hooks: { menuOpenState: menuOpenStateFactory } },
      },
    },
  },
  () => null,
);

// The shipped ui-workspace rows, so ordering is exercised against real peers.
const shipped = [
  { id: 'pin', order: 100 },
  { id: 'rename', order: 200 },
  { id: 'fork', order: 300 },
  { id: 'archive', order: 400 },
];
for (const row of shipped) core.register({ name: MENU_SLOT, ...row }, () => null);
assert.deepEqual(
  core.entriesOfSlot(MENU_SLOT).map((e) => e.options.id),
  ['pin', 'rename', 'fork', 'archive'],
  'baseline is the shipped menu',
);

// ── Mount the plugin's client half against the real ledger ────────────────
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
let captured;
globalThis.window = { __ModuleLoader__: { load: (entry) => (captured = entry) } };
globalThis.document = {
  head: { appendChild() {}, append() {} },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  querySelector: () => null,
};
new Function('window', 'document', bundle)(globalThis.window, globalThis.document);
const plugin = captured.factory((spec) => {
  const table = {
    react: { createElement: () => ({}), useState: (v) => [v, () => {}], useCallback: (f) => f, useMemo: (f) => f() },
    'react/jsx-runtime': { jsx: () => ({}), jsxs: () => ({}), Fragment: Symbol('F') },
  };
  assert.ok(table[spec], `unexpected require: ${spec}`);
  return table[spec];
});

const effects = [];
const dictionaries = [];
const ctx = {
  effect(fn, label) {
    effects.push(label);
    fn();
    return () => {};
  },
  locale: {
    register(ns, dicts) {
      dictionaries.push({ ns, locales: Object.keys(dicts) });
      return () => {};
    },
    bind: (ns) => (key) => `${ns}.${key}`,
  },
  sessions: { refresh: async () => {} },
  slots: {
    // Faithful to the real façade: inject runs the callback when the
    // declaration already exists, and returns the callback's disposer.
    inject(ownerKey, callback) {
      assert.ok(core.specDynamic(ownerKey), `slot not declared: ${ownerKey}`);
      return callback();
    },
    register: (declaration, component) => core.register(declaration, component),
  },
};
plugin.apply(ctx);

// ── Assertions on the real ledger ─────────────────────────────────────────
const ids = core.entriesOfSlot(MENU_SLOT).map((e) => e.options.id);
assert.deepEqual(ids, ['pin', 'rename', 'fork', 'archive', 'session-delete'], 'row lands last (order 500)');

const entry = core.entriesOfSlot(MENU_SLOT).find((e) => e.options.id === 'session-delete');
assert.ok(entry, 'plugin entry exists on the ledger');
assert.equal(entry.options.order, 500);
assert.equal(entry.locale, 'session-delete', 'entry declares its own locale namespace');
assert.equal(typeof entry.component, 'function');
assert.equal(typeof entry.inject, 'function');

// The declared hook must be reachable through the real naming rule.
const spec = core.specDynamic(MENU_SLOT);
const hookName = slots.standardHookPropName('menuOpenState');
assert.equal(hookName, 'useMenuOpenState', 'hook prop naming matches what the component destructures');
assert.equal(typeof spec.inject.hooks.menuOpenState, 'function');

// The injected face is what the component consumes.
const face = entry.inject();
assert.equal(typeof face.refreshSessions, 'function', 'inject exposes sessions.refresh()');
assert.equal(typeof face.t, 'function', 'inject exposes a translator');

// Disposal removes exactly this row and leaves the shipped menu intact.
const dispose = core.register({ name: MENU_SLOT, id: 'session-delete-temp', order: 600 }, () => null);
assert.equal(core.entriesOfSlot(MENU_SLOT).length, 6);
dispose();
assert.deepEqual(core.entriesOfSlot(MENU_SLOT).map((e) => e.options.id), ids, 'disposal is surgical');

// A duplicate id at the same priority is a ledger error — and the plugin is
// the only registrant of its own id, so this must throw.
assert.throws(
  () => core.register({ name: MENU_SLOT, id: 'session-delete', order: 500 }, () => null),
  /already has an entry with id "session-delete"/,
  'the ledger rejects a duplicate id',
);
// Registering into an undeclared slot throws (guards against a typo in the slot name).
assert.throws(
  () => core.register({ name: 'sidebar.workspaces.session.menu.items', id: 'x' }, () => null),
  /is not declared/,
);

// Locale + effects were registered by the plugin.
assert.deepEqual(dictionaries, [{ ns: 'session-delete', locales: ['zh', 'en'] }]);
assert.ok(effects.some((l) => String(l).includes('dictionaries')), 'registers dictionaries under an effect');

console.log('slot-ledger integration OK');
console.log('  menu rows      :', ids.join(' -> '));
console.log('  entry          : id=session-delete order=500 locale=session-delete');
console.log('  hook           :', hookName, '(declared by the sidebar, consumed by the entry)');
console.log('  effects        :', effects.join(' | '));
console.log('  ledger guards  : duplicate id + undeclared slot both throw');

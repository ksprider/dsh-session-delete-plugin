/**
 * Minimal stand-in for the GUI's browser module loader: it supplies the same
 * frozen module table, stubs the browser globals the bundle touches, and
 * captures what the plugin registers — so the client half can be executed
 * without a browser.
 *
 * Run:
 *   node tests/verify-client.mjs [path/to/client.js]
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Default to this package's own bundle; pass a path to check a served copy.
const bundlePath = process.argv[2] ?? new URL('../client.js', import.meta.url).pathname;
const source = readFileSync(bundlePath, 'utf8');

// --- browser stubs -------------------------------------------------------
const styleTags = [];
globalThis.document = {
  head: { appendChild: (t) => styleTags.push(t), append: (t) => styleTags.push(t) },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  querySelector: () => null,
};
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: Symbol('Fragment'),
};
// The plugin uses the classic runtime (React.createElement) for elements and
// the automatic runtime (jsx/jsxs) for composition; model both the same way.
const jsxRuntime = {
  jsx: (type, props) => ({ type, props: props ?? {}, children: props?.children }),
  jsxs: (type, props) => ({ type, props: props ?? {}, children: props?.children }),
  Fragment: React.Fragment,
};
const moduleTable = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  '@deepseek-ai/cordis': {},
  '@deepseek-ai/dsh-client-store': {},
  '@deepseek-ai/dsh-client-ui-slots': {},
};

// --- loader stub ---------------------------------------------------------
let captured;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
};

// Evaluate the bundle exactly as the page would.
new Function('window', 'document', 'fetch', 'console', source)(
  globalThis.window,
  globalThis.document,
  async () => ({ json: async () => ({ ok: true }) }),
  console,
);

assert.ok(captured, 'bundle did not register a module');
assert.equal(captured.id, '@local/dsh-session-delete');
assert.equal(typeof captured.factory, 'function');

const plugin = captured.factory((spec) => {
  const mod = moduleTable[spec];
  assert.ok(mod !== undefined, `bundle required an unseeded module: ${spec}`);
  return mod;
});
assert.ok(plugin && typeof plugin.apply === 'function', 'factory must return a plugin with apply()');
assert.deepEqual(plugin.inject, ['slots', 'sessions', 'locale'], 'client inject services');

// --- mount on a fake client ctx -----------------------------------------
const effects = [];
const injectionCalls = [];
const registrations = [];
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
    bind: (ns) => (key, params) => `${ns}.${key}${params ? JSON.stringify(params) : ''}`,
  },
  sessions: { refresh: async () => {} },
  slots: {
    // ctx.slots.inject(key, factory) returns a *callback*; that callback
    // registers when the owning declaration exists (the template form).
    inject(ownerKey, factory) {
      injectionCalls.push(ownerKey);
      const contribution = factory();
      assert.equal(typeof contribution, 'function', 'inject factory must return a registration callback');
      contribution();
      return () => {};
    },
    register(declaration, component) {
      registrations.push({ declaration, component });
      return () => {};
    },
  },
};

plugin.apply(ctx);

assert.deepEqual(dictionaries, [{ ns: 'session-delete', locales: ['zh', 'en'] }]);
assert.deepEqual(injectionCalls, ['sidebar.workspaces.session.menu.item'], 'injects exactly the sidebar session menu slot');
assert.equal(registrations.length, 1, 'exactly one slot registration');
const { declaration, component } = registrations[0];
assert.equal(declaration.name, 'sidebar.workspaces.session.menu.item');
assert.equal(declaration.id, 'session-delete');
assert.equal(declaration.locale, 'session-delete');
assert.equal(typeof declaration.inject, 'function');
assert.equal(typeof component, 'function');

// Injected face
const face = declaration.inject();
assert.equal(typeof face.refreshSessions, 'function');
assert.equal(typeof face.t, 'function');
assert.equal(face.t('label'), 'session-delete.label');

// Render the component with the props the Host would pass.
let rendered;
globalThis.window.confirm = () => false;
rendered = component({
  sessionId: 'session-abc',
  displayTitle: '示例对话',
  useMenuOpenState: () => [true, () => {}],
  ...face,
});
assert.equal(rendered.type, 'div');
assert.ok(Array.isArray(rendered.children), 'row renders a children array');
const button = rendered.children[0];
assert.ok(button && button.type === 'button', 'first child is the menu button');
assert.equal(button.type, 'button');
assert.equal(button.props.role, 'menuitem', 'the host menu keyboard walk needs role=menuitem');
assert.equal(button.props.disabled, false);
assert.equal(typeof button.props.onClick, 'function');
const label = button.children[1];
assert.ok(label, 'button has an icon + label');
assert.equal(label.props.className, 'dsh-session-delete-label');
assert.equal(label.children, 'session-delete.label');
assert.ok(styleTags.length >= 1, 'stylesheet inserted');
assert.ok(String(styleTags[0].textContent).includes('.dsh-session-delete-item'));

console.log('client bundle OK');
console.log('  module id        :', captured.id);
console.log('  inject           :', JSON.stringify(plugin.inject));
console.log('  effects          :', effects.join(' | '));
console.log('  locale namespace :', dictionaries[0].ns, dictionaries[0].locales.join('+'));
console.log('  slot             :', declaration.name, '/ id', declaration.id, '/ order', declaration.order);
console.log('  rendered row     :', button.type, 'role=' + button.props.role, 'label=' + JSON.stringify(label.children));

// ── Packaging guards ──────────────────────────────────────────────────────
// These catch the mistakes that would let a published bundle install cleanly
// and yet never appear in the GUI.
const root = dirname(new URL('../package.json', import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// 1. The browser module id must equal the package name: the Host's client
//    module registry matches the Loader row's package name against the
//    manifest name and drops the bundle when they differ.
assert.equal(
  captured.id,
  manifest.name,
  `browser module id "${captured.id}" must equal package name "${manifest.name}" ` +
    '(otherwise the Host never serves the client bundle and the menu row never appears)',
);
console.log('  package name     : matches module id (' + manifest.name + ')');

// 2. Every path the manifest advertises must exist, or a git install ships broken.
const resolveEntry = (entry) => {
  if (!entry.includes('*')) return existsSync(join(root, entry)) ? [entry] : [];
  const dir = join(root, dirname(entry));
  const pattern = new RegExp('^' + entry.split('/').pop().replace('.', '\\.').replace('*', '.*') + '$');
  return existsSync(dir) ? readdirSync(dir).filter((name) => pattern.test(name)) : [];
};
const missing = [];
for (const entry of manifest.files ?? []) {
  if (resolveEntry(entry).length === 0) missing.push(entry);
}
assert.deepEqual(missing, [], `package.json "files" entries missing on disk: ${missing.join(', ')}`);
console.log('  declared files   : all present (' + (manifest.files ?? []).length + ' entries)');

// 3. The bundle patch must point at a real file and insert this package's row.
assert.equal(typeof manifest.dsh?.bundle?.patch, 'string');
assert.equal(existsSync(join(root, manifest.dsh.bundle.patch)), true, 'bundle patch file exists');
const patch = readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8');
const patchedNames = [...patch.matchAll(/name:\s*['"]?([^'"\s]+)/g)].map((m) => m[1]);
assert.ok(
  patchedNames.includes(manifest.name),
  `bundle patch must insert a row named "${manifest.name}" (found: ${patchedNames.join(', ') || 'none'})`,
);
console.log('  bundle patch     : inserts row "' + manifest.name + '"');

// 4. The client declaration must be well formed for the web platform.
assert.equal(manifest.dsh?.client?.platform, 'web', 'dsh.client.platform must be "web"');
assert.equal(typeof manifest.exports?.['./client'], 'string', 'exports["./client"] is required');
console.log('  dsh.client       : platform=web, ./client export present');

/**
 * Interaction test for the plugin's client half.
 *
 * `verify-client.mjs` checks registration and one render. This test drives the
 * whole click path with a stateful React stand-in so the wiring between the
 * menu row, the confirmation, the host request, the list refresh, and the menu
 * dismissal is exercised as one flow:
 *
 *   open menu -> row rendered -> click -> confirm -> POST -> refresh -> close
 *
 * It also pins the failure path: a rejected delete must surface a message, keep
 * the menu open, and must not refresh the list.
 *
 * Run:
 *   node tests/verify-interaction.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// ── Browser stubs ─────────────────────────────────────────────────────────
const styleTags = [];
globalThis.document = {
  head: {
    appendChild: (tag) => styleTags.push(tag),
    append: (tag) => styleTags.push(tag),
  },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  querySelector: () => null,
};

/**
 * Stateful React stand-in.
 *
 * Hook state is keyed by call position and *persists across render passes*,
 * exactly like React's positional hook slots. `__beginPass()` rewinds the
 * cursor so the next render reads slot 0 again while keeping the stored values,
 * so `rerender()` shows what the real UI would show after a state update.
 */
function createReact() {
  const hookState = [];
  let cursor = 0;
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.length <= 1 ? children[0] : children,
    }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in hookState)) {
        hookState[index] = typeof initial === 'function' ? initial() : initial;
      }
      const set = (next) => {
        hookState[index] = typeof next === 'function' ? next(hookState[index]) : next;
      };
      return [hookState[index], set];
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    /** Rewind the positional cursor at the start of a render pass. */
    __beginPass: () => {
      cursor = 0;
    },
    /** Snapshot of stored hook state, for assertions and debugging. */
    __state: () => hookState.slice(),
  };
}

// ── Capture and execute the bundle ────────────────────────────────────────
let captured;
globalThis.window = { __ModuleLoader__: { load: (entry) => (captured = entry) } };
new Function('window', 'document', bundle)(globalThis.window, globalThis.document);

let React;
const plugin = captured.factory((spec) => {
  if (spec === 'react') {
    React = createReact();
    return React;
  }
  if (spec === 'react/jsx-runtime') {
    // The plugin composes with jsxs; keep the element shape identical.
    return {
      jsx: (type, props) => ({ type, props: props ?? {}, children: props?.children }),
      jsxs: (type, props) => ({ type, props: props ?? {}, children: props?.children }),
      Fragment: Symbol('Fragment'),
    };
  }
  throw new Error(`unexpected require: ${spec}`);
});

// ── Mount on a fake client ctx, capturing the registered row ──────────────
let row;
let refreshCalls = 0;
const dictionaries = [];
const ctx = {
  effect(fn) {
    fn();
    return () => {};
  },
  locale: {
    register: (ns, dicts) => (dictionaries.push({ ns, dicts }), () => {}),
    bind: (ns) => (key, params) => (params ? `${ns}.${key}:${JSON.stringify(params)}` : `${ns}.${key}`),
  },
  sessions: { refresh: async () => void (refreshCalls += 1) },
  slots: {
    inject: (_key, factory) => factory()(),
    register: (declaration, component) => ((row = { declaration, component }), () => {}),
  },
};
plugin.apply(ctx);
assert.ok(row, 'client half registered a menu row');

const t = row.declaration.inject().t;
const face = row.declaration.inject();

/** Render the row once with the props the Host menu would pass. */
function render() {
  const menuState = { open: true, closes: 0 };
  const props = {
    sessionId: 'session-abc',
    displayTitle: '示例对话',
    useMenuOpenState: () => [menuState.open, () => void (menuState.closes += 1)],
    ...face,
  };
  // Each render pass replays the hooks in call order: hooks are positional in
  // React, and this stub models exactly that by consuming slots in sequence.
  let element = pass();
  function pass() {
    React.__beginPass();
    return row.component(props);
  }
  return {
    menuState,
    get element() {
      return element;
    },
    /** Re-render the row, observing state written by the previous pass. */
    rerender() {
      element = pass();
      return element;
    },
  };
}

// ── Flow 1: happy path ────────────────────────────────────────────────────
{
  const requests = [];
  let confirmed = null;
  globalThis.window.confirm = (message) => ((confirmed = message), true);
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ ok: true, sessionId: 'session-abc', freedBytes: 123 }) };
  };

  const view = render();
  const button = view.element.children[0];
  assert.equal(button.type, 'button');
  assert.equal(button.props.role, 'menuitem');
  assert.equal(button.children[1].children, 'session-delete.label', 'idle label');

  await button.props.onClick();

  assert.ok(confirmed !== null, 'the user is asked to confirm before anything happens');
  assert.ok(confirmed.includes('示例对话'), 'the confirmation names the conversation');
  assert.equal(requests.length, 1, 'exactly one host request');
  assert.equal(requests[0].url, '/api/dsh-session-delete');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(requests[0].body, { sessionId: 'session-abc' }, 'the row id is what gets deleted');
  assert.equal(refreshCalls, 1, 'the session list is refreshed after a successful delete');
  assert.equal(view.menuState.closes, 1, 'the menu closes after a successful delete');

  const busy = view.rerender();
  assert.equal(busy.children[1], null, 'no error is shown on success');
  console.log('happy path        OK -> POST', JSON.stringify(requests[0].body), '| refresh x1 | menu closed');
}

// ── Flow 2: cancelled confirmation ────────────────────────────────────────
{
  const requests = [];
  globalThis.window.confirm = () => false;
  globalThis.fetch = async (url, init) => (requests.push(url), { status: 200, json: async () => ({ ok: true }) });
  const before = refreshCalls;
  const view = render();
  await view.element.children[0].props.onClick();
  assert.equal(requests.length, 0, 'cancelling sends nothing');
  assert.equal(refreshCalls, before, 'cancelling does not refresh');
  console.log('cancelled         OK -> no request, no refresh');
}

// ── Flow 3: host refusal surfaces and does not refresh ────────────────────
{
  globalThis.window.confirm = () => true;
  const before = refreshCalls;
  globalThis.fetch = async () => ({
    status: 409,
    json: async () => ({ ok: false, code: 'session-live', message: 'This conversation is still open.' }),
  });
  const view = render();
  await view.element.children[0].props.onClick();
  assert.equal(refreshCalls, before, 'a refused delete must not refresh the list');
  assert.equal(view.menuState.closes, 0, 'the menu stays open so the message is visible');

  const after = view.rerender();
  const errorNode = after.children[1];
  assert.ok(errorNode, 'an error node is rendered');
  assert.equal(errorNode.props.role, 'alert', 'the message is announced');
  assert.equal(errorNode.children, 'This conversation is still open.', 'the host message is shown verbatim');
  console.log('host refusal      OK -> message shown, no refresh, menu stays open');
}

// ── Flow 4: network failure is reported, not swallowed ────────────────────
{
  globalThis.window.confirm = () => true;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const view = render();
  await view.element.children[0].props.onClick();
  const after = view.rerender();
  assert.equal(after.children[1].children, 'network down', 'a thrown transport error is surfaced');
  console.log('transport failure OK -> surfaced as', JSON.stringify(after.children[1].children));
}

assert.equal(styleTags.length >= 1, true, 'stylesheet was inserted on apply');
console.log('interaction checks passed');

'use strict';

// TestHound step-through hook.
//
// Loaded via NODE_OPTIONS=--require in every Playwright process (main + worker)
// when a case is previewed in "step" mode. It swaps the project's
// `@playwright/test` `test` export for one whose `page` fixture patches the
// page instance so each interaction (navigation, click, fill, ...) blocks until
// TestHound sends a "go" over a local socket. That gives a human-driven,
// step-by-step preview without touching the user's spec.
//
// Design constraints:
//  - Fail open. Any error here must leave Playwright running normally rather
//    than hang or crash a run. Every risky step is wrapped in try/catch and a
//    lost/absent socket resolves the gate immediately.
//  - Spec-agnostic. We patch the live `page` instance (and the locators it
//    produces) rather than internal Playwright classes, which are bundled and
//    not importable by a stable path.

const ADDR = process.env.TESTHOUND_STEP_ADDR;
if (ADDR) {
  try {
    install(ADDR);
  } catch (err) {
    warn(err && err.message);
  }
}

function warn(msg) {
  try {
    process.stderr.write(`[testhound] step hook disabled: ${msg}\n`);
  } catch (_) {
    /* ignore */
  }
}

function install(addr) {
  const pwPath = require.resolve('@playwright/test', { paths: [process.cwd()] });
  const pw = require(pwPath);
  if (!pw || typeof pw.test !== 'function' || typeof pw.test.extend !== 'function') {
    throw new Error('unexpected @playwright/test shape');
  }

  const gate = createGate(addr);

  // Interaction methods present on both Page and Locator that we pause before.
  const ACTIONS = [
    'goto', 'click', 'dblclick', 'fill', 'type', 'press', 'pressSequentially',
    'check', 'uncheck', 'setChecked', 'selectOption', 'selectText', 'hover',
    'tap', 'focus', 'blur', 'clear', 'setInputFiles', 'dragTo', 'goBack',
    'goForward', 'reload', 'waitForURL',
  ];
  // Methods that return a (child) Locator we also want to patch and label.
  const LOCATORS = [
    'locator', 'getByRole', 'getByText', 'getByTestId', 'getByLabel',
    'getByPlaceholder', 'getByTitle', 'getByAltText', 'first', 'last', 'nth',
    'filter', 'and', 'or',
  ];

  // Reentrancy guard: Playwright's own methods call into other patched methods
  // internally; only the outermost call, initiated by the spec, should pause.
  let depth = 0;
  let counter = 0;
  // Locator factories (getByTestId, getByRole, ...) delegate internally to
  // `.locator(internalSelector)`. While inside a factory's own call we skip
  // labelling those internal delegations so the semantic name wins, not the raw
  // internal selector. The outermost factory patches the final result.
  let inFactory = 0;

  function patch(obj, label) {
    if (!obj || typeof obj !== 'object' || obj.__thWrapped) return obj;
    for (const name of ACTIONS) {
      if (typeof obj[name] !== 'function') continue;
      const orig = obj[name].bind(obj);
      obj[name] = function (...args) {
        if (depth > 0 || gate.done) return orig(...args);
        depth += 1;
        const step = {
          i: (counter += 1),
          action: name,
          target: describe(label, name, args),
        };
        return gate
          .wait(step)
          .then(() => orig(...args))
          .finally(() => {
            depth -= 1;
          });
      };
    }
    for (const name of LOCATORS) {
      if (typeof obj[name] !== 'function') continue;
      const orig = obj[name].bind(obj);
      obj[name] = function (...args) {
        // An internal delegation from an outer factory: let that outer call
        // patch and label the final locator with its semantic name.
        if (inFactory > 0) return orig(...args);
        const childLabel = joinLabel(label, name, args);
        inFactory += 1;
        try {
          return patch(orig(...args), childLabel);
        } finally {
          inFactory -= 1;
        }
      };
    }
    try {
      Object.defineProperty(obj, '__thWrapped', { value: true });
      Object.defineProperty(obj, '__thLabel', { value: label || '' });
    } catch (_) {
      /* ignore */
    }
    return obj;
  }

  // Gate web-first assertions the same way as actions, but only when the subject
  // is a page/locator we wrapped. Those matchers return awaited promises, so
  // turning them into gated promises preserves ordering and failure semantics;
  // plain-value assertions (expect(2).toBe(2)) are synchronous and left alone.
  const NON_MATCHERS = new Set(['not', 'resolves', 'rejects']);
  function wrapMatchers(matchers, label, negated) {
    return new Proxy(matchers, {
      get(obj, prop, recv) {
        const val = Reflect.get(obj, prop, recv);
        if (typeof prop === 'symbol') return val;
        if (NON_MATCHERS.has(prop)) {
          return wrapMatchers(val, label, negated || prop === 'not');
        }
        if (typeof val !== 'function') return val;
        return function (...args) {
          if (depth > 0 || gate.done) return val.apply(obj, args);
          depth += 1;
          const name = negated ? `not.${prop}` : String(prop);
          const step = {
            i: (counter += 1),
            action: 'expect',
            target: describeAssert(label, name, args),
          };
          return gate
            .wait(step)
            .then(() => val.apply(obj, args))
            .finally(() => {
              depth -= 1;
            });
        };
      },
    });
  }

  if (typeof pw.expect === 'function') {
    const origExpect = pw.expect;
    const wrapped = function (subject, ...rest) {
      const matchers = origExpect(subject, ...rest);
      if (subject && typeof subject === 'object' && subject.__thWrapped) {
        return wrapMatchers(matchers, subject.__thLabel || '', false);
      }
      return matchers;
    };
    // Preserve expect.soft / poll / configure / extend / any / ... verbatim.
    Object.assign(wrapped, origExpect);
    pw.expect = wrapped;
  }

  const extended = pw.test.extend({
    page: async ({ page }, use) => {
      try {
        patch(page, 'page');
      } catch (err) {
        warn(err && err.message);
      }
      try {
        await use(page);
      } finally {
        // Hold on the final (validated, or failed) state until the user
        // advances, so the browser does not close before they can see it.
        if (!gate.done) {
          await gate.wait(
            {
              i: (counter += 1),
              action: 'finish',
              target: 'review the final state, then finish',
            },
            true,
          );
        }
      }
    },
  });

  // The spec reads `test` (and sometimes `default`) off this module object;
  // both are writable self-references in @playwright/test.
  pw.test = extended;
  pw.default = extended;
}

// ---- description helpers ------------------------------------------------------

function preview(v) {
  if (v == null) return '';
  let s;
  if (typeof v === 'string') s = v;
  else if (v instanceof RegExp) s = v.toString();
  else if (typeof v === 'object') {
    const pick = v.name != null ? v.name : v.hasText != null ? v.hasText : undefined;
    if (pick === undefined) return '';
    s = pick instanceof RegExp ? pick.toString() : String(pick);
  } else s = String(v);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

// Build the label for a locator produced by `factory(args)` off `parent`.
function joinLabel(parent, factory, args) {
  const arg = preview(args[0]);
  const opt = args[1] && typeof args[1] === 'object' ? preview(args[1]) : '';
  const inner = [arg, opt].filter(Boolean).join(', ');
  const seg = `${factory}(${inner})`;
  return parent && parent !== 'page' ? `${parent} › ${seg}` : seg;
}

// Human-readable "what is being validated" for an assertion step, e.g.
// "getByTestId(cart-badge) toHaveText 1".
function describeAssert(label, matcher, args) {
  const subject = label || 'value';
  const expected = args.length ? preview(args[0]) : '';
  return [subject, matcher, expected].filter(Boolean).join(' ');
}

// Human-readable "what is about to happen" for an action step.
function describe(label, action, args) {
  const base = label && label !== 'page' ? label : '';
  if (action === 'goto') return preview(args[0]);
  if (action === 'waitForURL') return preview(args[0]);
  if ((action === 'fill' || action === 'type' || action === 'pressSequentially') && args.length) {
    // On a Locator the value is args[0]; on a Page it is args[1].
    const val = base ? preview(args[0]) : preview(args[1]);
    return base ? `${base} = ${val}` : `${preview(args[0])} = ${val}`;
  }
  if (action === 'press') {
    const key = base ? preview(args[0]) : preview(args[1]);
    return base ? `${base} · ${key}` : key;
  }
  return base;
}

// ---- socket gate --------------------------------------------------------------

// A newline-delimited JSON channel to TestHound. `wait(step)` sends the step and
// resolves when TestHound replies "go" (advance one) or "resume" (run the rest
// without pausing). Any socket failure resolves immediately so runs never hang.
//
// The socket connects lazily on the first action rather than at load. Playwright
// loads this hook in both its main process and each worker, but only the worker
// executes actions, so deferring the connection means only the worker connects
// and TestHound sees exactly one client.
function createGate(addr) {
  const net = require('net');
  const colon = addr.lastIndexOf(':');
  const host = addr.slice(0, colon) || '127.0.0.1';
  const port = Number(addr.slice(colon + 1));

  // `done` is terminal (socket lost or run stopped): every wait resolves.
  // `resumed` means "run to the end without pausing", but the final finish step
  // is forced and still pauses so the validated end state stays on screen.
  const gate = { done: false, resumed: false };
  let socket = null;
  let pending = null;
  let buffer = '';

  const release = () => {
    if (pending) {
      const r = pending;
      pending = null;
      r();
    }
  };
  const finish = () => {
    gate.done = true;
    release();
  };

  const connect = () => {
    if (socket) return;
    socket = net.connect(port, host);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (msg.t === 'resume') {
          gate.resumed = true;
          release();
        } else if (msg.t === 'go') {
          release();
        }
      }
    });
    socket.on('error', finish);
    socket.on('close', finish);
  };

  // `force` (used by the final finish step) pauses even after "resume".
  gate.wait = (step, force) =>
    new Promise((resolve) => {
      if (gate.done) return resolve();
      if (gate.resumed && !force) return resolve();
      connect();
      pending = resolve;
      try {
        // Buffered until the connection is established; Node allows this.
        socket.write(JSON.stringify(Object.assign({ t: 'step' }, step)) + '\n');
      } catch (_) {
        finish();
        resolve();
      }
    });

  return gate;
}

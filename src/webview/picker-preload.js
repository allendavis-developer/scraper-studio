// Preload injected INTO the target website (runs inside the <webview>).
// Handles the interactive element picker overlay and the action recorder.
//
// IMPORTANT: a preload loaded via a file:// URL cannot `require()` sibling files
// (Node can't resolve the relative path), so the DOM selector helpers are
// INLINED here rather than imported from ../shared/page-actions.js. Keep the two
// copies in sync — page-actions.js remains the source used by the run engine and
// the test harness; this copy is only the picker's DOM-side selector generation.

const { ipcRenderer } = require('electron');

// ---- Inlined selector helpers (mirror of shared/page-actions.js) ----------

function isStableClass(c) {
  if (!c) return false;
  if (/^(css-|sc-|jsx-|_)/.test(c)) return false;
  if (/[0-9]{4,}/.test(c)) return false;
  return /^[a-zA-Z][\w-]*$/.test(c);
}

function classSelector(el) {
  const classes = Array.from(el.classList).filter(isStableClass);
  return classes.length ? '.' + classes.slice(0, 3).join('.') : '';
}

function indexOfType(el) {
  const tag = el.tagName.toLowerCase();
  let i = 1;
  let sib = el;
  while ((sib = sib.previousElementSibling)) {
    if (sib.tagName.toLowerCase() === tag) i++;
  }
  return i;
}

function cssPath(el) {
  if (!(el instanceof Element)) return '';

  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
    const byId = '#' + el.id;
    if (document.querySelectorAll(byId).length === 1) return byId;
  }

  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
    let part = cur.tagName.toLowerCase();
    const cls = classSelector(cur);
    if (cls) part += cls;

    const parent = cur.parentElement;
    if (parent) {
      const matches = Array.from(parent.children).filter((c) => {
        try {
          return c.matches(part);
        } catch (_) {
          return false;
        }
      });
      if (matches.length > 1) part += ':nth-of-type(' + indexOfType(cur) + ')';
    }

    parts.unshift(part);

    const candidate = parts.join(' > ');
    try {
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    } catch (_) {}

    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

function listSelector(el) {
  const single = cssPath(el);
  const candidates = [
    single.replace(/:nth-of-type\(\d+\)/g, ''),
    single.replace(/:nth-of-type\(\d+\)$/, '')
  ];
  for (const c of candidates) {
    try {
      const count = document.querySelectorAll(c).length;
      if (count > 1) return { selector: c, count };
    } catch (_) {}
  }
  return { selector: single, count: 1 };
}

// The repeating-item version of relativeCssPath: a selector, relative to `root`,
// that matches MANY children of root (a nested repeating list inside a card).
function relativeListSelector(el, root) {
  const single = relativeCssPath(el, root);
  const candidates = [
    single.replace(/:nth-of-type\(\d+\)/g, ''),
    single.replace(/:nth-of-type\(\d+\)$/, '')
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const count = root.querySelectorAll(c).length;
      if (count > 1) return { selector: c, count };
    } catch (_) {}
  }
  let count = 1;
  try {
    count = single ? root.querySelectorAll(single).length : 1;
  } catch (_) {}
  return { selector: single, count };
}

// A selector for `el` RELATIVE to an ancestor `root` (so root.querySelector(sel)
// finds it in every matching row). Prefers a simple class/tag, else a short path.
function relativeCssPath(el, root) {
  if (!el || el === root) return '';
  const candidates = [];
  const cls = classSelector(el);
  if (cls) candidates.push(cls);
  candidates.push(el.tagName.toLowerCase() + cls);
  for (const c of candidates) {
    try {
      if (root.querySelector(c) === el) return c;
    } catch (_) {}
  }
  const parts = [];
  let cur = el;
  while (cur && cur !== root && cur.nodeType === 1) {
    let part = cur.tagName.toLowerCase();
    const cc = classSelector(cur);
    if (cc) part += cc;
    const parent = cur.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((x) => {
        try {
          return x.matches(part);
        } catch (_) {
          return false;
        }
      });
      if (sibs.length > 1) part += ':nth-of-type(' + indexOfType(cur) + ')';
    }
    parts.unshift(part);
    const cand = parts.join(' > ');
    try {
      if (root.querySelector(cand) === el) return cand;
    } catch (_) {}
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

function deepElementFromPoint(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

function sampleText(el) {
  if (!el) return '';
  return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function safeCount(sel) {
  try {
    return document.querySelectorAll(sel).length;
  } catch (_) {
    return 0;
  }
}

// ===========================================================================
// Interactive element picker
// ===========================================================================

let active = false;
let mode = 'element';
let relativeTo = ''; // if set, produce a selector relative to this ancestor
let overlay = null;
let label = null;
let lastEl = null;

function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    zIndex: 2147483646,
    pointerEvents: 'none',
    background: 'rgba(91, 143, 214, 0.25)',
    border: '2px solid #5b8fd6',
    borderRadius: '1px',
    transition: 'all 40ms ease-out',
    display: 'none'
  });

  label = document.createElement('div');
  Object.assign(label.style, {
    position: 'fixed',
    zIndex: 2147483647,
    pointerEvents: 'none',
    background: '#5b8fd6',
    color: '#fff',
    font: '11px/1.4 monospace',
    padding: '2px 6px',
    borderRadius: '2px',
    maxWidth: '360px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'none'
  });

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(label);
}

function moveOverlay(el, text) {
  const r = el.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.left = r.left + 'px';
  overlay.style.top = r.top + 'px';
  overlay.style.width = r.width + 'px';
  overlay.style.height = r.height + 'px';

  label.style.display = 'block';
  label.textContent = text || cssPath(el);
  const top = r.top - 22 < 0 ? r.bottom + 4 : r.top - 22;
  label.style.left = Math.max(0, r.left) + 'px';
  label.style.top = top + 'px';
}

function hideOverlay() {
  if (overlay) overlay.style.display = 'none';
  if (label) label.style.display = 'none';
}

// In "table" mode you are choosing a TABLE, not a cell — so highlight the whole
// table under the cursor. Anything not in a table simply isn't a target.
function tableUnder(el) {
  return el && el.closest ? el.closest('table') : null;
}

// A friendly label for a whole-table highlight: "Table · 9 rows × 7 columns".
function tableLabel(table) {
  const body = table.querySelectorAll('tbody tr').length || table.querySelectorAll('tr').length;
  const head = table.querySelectorAll('thead th, thead td');
  const first = table.querySelector('tr');
  const cols = head.length || (first ? first.children.length : 0);
  return `📊 This table — ${body} row${body === 1 ? '' : 's'} × ${cols} column${cols === 1 ? '' : 's'}`;
}

function onMove(e) {
  if (!active) return;
  const el = deepElementFromPoint(e.clientX, e.clientY);
  if (!el || el === overlay || el === label) return;

  if (mode === 'table') {
    const table = tableUnder(el);
    if (!table) {
      // Not over a table: make that obvious rather than highlighting a stray cell.
      lastEl = null;
      hideOverlay();
      return;
    }
    lastEl = table;
    moveOverlay(table, tableLabel(table));
    return;
  }

  lastEl = el;
  moveOverlay(el);
}

function onClick(e) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  let el = lastEl || deepElementFromPoint(e.clientX, e.clientY);
  if (!el) return;

  // Picking a TABLE: hand back the table element itself (not the cell you
  // happened to click). Clicking outside any table does nothing — the user can
  // keep moving, or press Esc.
  if (mode === 'table') {
    const table = tableUnder(el);
    if (!table) return; // stay in pick mode; nothing was highlighted anyway
    ipcRenderer.sendToHost('picker:picked', {
      mode,
      selector: cssPath(table),
      sample: sampleText(table.querySelector('caption') || table.querySelector('th') || table)
    });
    stop();
    return;
  }

  // `relativeTo` is set for a column pick inside a row, and for ANY pick made
  // while editing a step nested in a "For each" — the selector must then be
  // relative to the current container so it resolves per item at run time.
  const root = relativeTo ? el.closest(relativeTo) : null;

  if (mode === 'list' && root) {
    // A repeating list nested INSIDE the container (e.g. tags within a card).
    const { selector, count } = relativeListSelector(el, root);
    ipcRenderer.sendToHost('picker:picked', {
      mode,
      selector,
      count,
      relative: true,
      sample: sampleText(root.querySelector(selector) || el)
    });
  } else if (mode === 'list') {
    const { selector, count } = listSelector(el);
    ipcRenderer.sendToHost('picker:picked', {
      mode,
      selector,
      count,
      // relativeTo was requested but the element sits OUTSIDE the container.
      relative: relativeTo ? false : undefined,
      sample: sampleText(document.querySelector(selector))
    });
  } else if (relativeTo) {
    // Element pick with a container: relative when inside it, else absolute
    // (the host flags that as "outside the current item").
    const selector = root ? relativeCssPath(el, root) : cssPath(el);
    ipcRenderer.sendToHost('picker:picked', {
      mode,
      selector,
      relative: !!root,
      sample: sampleText(el)
    });
  } else {
    // Single element: return the exact (unique) selector AND a generalized one
    // (first-of-many) so the host can ask "this exact one" vs "any matching".
    const selector = cssPath(el);
    const gen = listSelector(el); // { selector, count }
    ipcRenderer.sendToHost('picker:picked', {
      mode,
      selector,
      general: gen.selector,
      count: gen.count,
      sample: sampleText(el)
    });
  }
  stop();
}

function onKey(e) {
  if (active && e.key === 'Escape') {
    ipcRenderer.sendToHost('picker:cancelled', {});
    stop();
  }
}

function start(opts) {
  ensureOverlay();
  mode = (opts && opts.mode) || 'element';
  relativeTo = (opts && opts.relativeTo) || '';
  active = true;
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  if (document.body) document.body.style.cursor = 'crosshair';
}

function stop() {
  active = false;
  hideOverlay();
  document.removeEventListener('mousemove', onMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKey, true);
  if (document.body) document.body.style.cursor = '';
}

ipcRenderer.on('picker:start', (_e, opts) => start(opts));
ipcRenderer.on('picker:stop', () => stop());

// ===========================================================================
// Recorder — watch the user drive the page and report raw actions to the host,
// which maps them onto WebHarvest's own step blocks.
// ===========================================================================

let recording = false;
let pendingFill = null;

function isTextLike(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    return !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image'].includes(
      (el.type || '').toLowerCase()
    );
  }
  return false;
}

function selectedText(el) {
  const o = el.options && el.options[el.selectedIndex];
  return o ? (o.text || '').replace(/\s+/g, ' ').trim() : '';
}

let lastSig = null;
let lastSigTs = 0;
let lastFill = { sel: null, val: null, ts: 0 };

function sigOf(a) {
  return [a.type, a.selector || '', a.value || '', a.text || '', a.key || '', a.checked === undefined ? '' : a.checked].join('|');
}

function rawEmit(action) {
  action.ts = Date.now();
  ipcRenderer.sendToHost('rec:action', action);
}

// Non-fill actions: collapse an action identical to the one just before it.
function emit(action) {
  const now = Date.now();
  const sig = sigOf(action);
  if (sig === lastSig && now - lastSigTs < 350) return;
  lastSig = sig;
  lastSigTs = now;
  rawEmit(action);
}

// Fills get their own dedupe keyed on selector+value that survives an
// intervening action — pressing Enter emits the fill (via a keydown flush) AND
// the input's 'change' fires the same fill again, with the Enter key in between.
function flushFill() {
  if (!pendingFill) return;
  const pf = pendingFill;
  pendingFill = null;
  const now = Date.now();
  if (pf.selector === lastFill.sel && pf.value === lastFill.val && now - lastFill.ts < 1200) return;
  lastFill = { sel: pf.selector, val: pf.value, ts: now };
  rawEmit(pf);
}

function recInput(e) {
  const el = e.target;
  if (!isTextLike(el)) return;
  pendingFill = { type: 'fill', selector: cssPath(el), value: el.value != null ? el.value : el.textContent };
}

function recChange(e) {
  const el = e.target;
  if (el.tagName === 'SELECT') {
    flushFill();
    emit({ type: 'select', selector: cssPath(el), value: el.value, text: selectedText(el) });
  } else if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase())) {
    flushFill();
    emit({ type: 'check', selector: cssPath(el), checked: el.checked });
  } else if (isTextLike(el)) {
    pendingFill = { type: 'fill', selector: cssPath(el), value: el.value };
    flushFill();
  }
}

function recClick(e) {
  const el = e.target;
  if (!el || el.nodeType !== 1) return;
  const tag = el.tagName;
  if (tag === 'SELECT' || tag === 'OPTION' || isTextLike(el)) return;
  if (tag === 'INPUT' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase())) return;
  flushFill();
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  emit({ type: 'click', selector: cssPath(el), text });
}

function recKey(e) {
  if (!['Enter', 'Tab', 'Escape'].includes(e.key)) return;
  const el = document.activeElement;
  flushFill();
  emit({ type: 'key', key: e.key, selector: el && el !== document.body ? cssPath(el) : '' });
}

function startRec() {
  if (recording) return;
  recording = true;
  pendingFill = null;
  document.addEventListener('input', recInput, true);
  document.addEventListener('change', recChange, true);
  document.addEventListener('click', recClick, true);
  document.addEventListener('keydown', recKey, true);
}

function stopRec() {
  if (!recording) return;
  flushFill();
  recording = false;
  document.removeEventListener('input', recInput, true);
  document.removeEventListener('change', recChange, true);
  document.removeEventListener('click', recClick, true);
  document.removeEventListener('keydown', recKey, true);
}

ipcRenderer.on('rec:start', () => startRec());
ipcRenderer.on('rec:stop', () => stopRec());

// When the page has keyboard focus, Ctrl/Cmd +/-/0 won't reach the host, so
// forward a zoom request. (The mouse being over the page implies page zoom.)
document.addEventListener(
  'keydown',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    let dir = null;
    if (e.key === '+' || e.key === '=') dir = 'in';
    else if (e.key === '-' || e.key === '_') dir = 'out';
    else if (e.key === '0') dir = 'reset';
    if (!dir) return;
    e.preventDefault();
    ipcRenderer.sendToHost('zoom:page', { dir });
  },
  true
);

'use strict';

// ===========================================================================
// WebHarvest renderer — the control UI.
//
// Responsibilities:
//   - Drive the <webview> (navigation).
//   - Element picker: ask the webview's preload to enter pick mode, receive the
//     chosen selector, and route it (fill an input, or create a scrape step).
//   - Manage the visual step list (add / edit / reorder / delete).
//   - Run the steps against the live page and collect rows.
//   - Render the results table and export CSV.
// ===========================================================================

// The <webview> is mounted per-job (see mountWebview) so each job keeps its own
// session partition — i.e. its own logins. `view` points at the current one.
let view = null;
const urlInput = document.getElementById('url');
const logEl = document.getElementById('log');

// Shared scraping engine (selector generation + page-code builders).
const PA = window.PageActions;
// Expression evaluator + {{...}} interpolation for control flow / variables.
const EXPR = window.Expr;
// Visual text clean-up / extraction pipeline (no regex needed).
const TF = window.Transform;

// Absolute file:// URL for the picker preload injected into every mounted view.
let pickerPreloadUrl = '';
try {
  pickerPreloadUrl = new URL('../webview/picker-preload.js', location.href).href;
} catch (e) {
  console.error('Could not resolve picker preload URL:', e);
}

// (Re)create the embedded browser with a given session partition and wire it up.
function mountWebview(partition) {
  const wrap = document.getElementById('webview-wrap');
  if (view) {
    try {
      view.remove();
    } catch (_) {}
  }
  webviewReady = false;
  const v = document.createElement('webview');
  v.id = 'view';
  v.setAttribute('allowpopups', '');
  v.setAttribute('partition', partition || 'persist:scrapestudio');
  v.setAttribute('webpreferences', 'sandbox=no,contextIsolation=no');
  v.setAttribute('preload', pickerPreloadUrl);
  v.src = 'about:blank';
  // Insert before the overlays so pick/rec/loading hints stay on top.
  wrap.insertBefore(v, wrap.firstChild);
  view = v;
  wireWebview(v);
  return v;
}

// Attach all listeners a freshly-mounted webview needs.
function wireWebview(v) {
  v.addEventListener('dom-ready', () => {
    webviewReady = true;
  });
  v.addEventListener('did-start-loading', () => $('#loading').classList.remove('hidden'));
  v.addEventListener('did-stop-loading', () => {
    $('#loading').classList.add('hidden');
    try {
      urlInput.value = v.getURL();
    } catch (_) {}
    if (recording) v.send('rec:start'); // re-arm recorder across navigations
  });
  v.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return; // aborted (e.g. redirect)
    log(`Load error ${e.errorCode}: ${e.validatedURL}`, 'err');
  });
  v.addEventListener('did-finish-load', () => {
    try {
      v.setZoomFactor(pageZoom);
    } catch (_) {}
  });
  v.addEventListener('ipc-message', onWebviewMessage);
}

// ---- State ----------------------------------------------------------------

/** @type {Array<object>} ordered list of steps */
let steps = [];
/** @type {Array<object>} collected result rows */
let results = [];
/** @type {string[]} raw column keys discovered from scraped rows */
let columns = [];
/** @type {Array<{key:string,label:string,include:boolean}>} export shaping */
let columnConfig = [];

let running = false;
let abortRun = false;

// What to do with the next picked selector.
// { type: 'input', input: HTMLInputElement } | { type: 'newScrape', mode }
let pickTarget = null;

let idSeq = 1;
const nextId = () => idSeq++;

// ---- Small utilities ------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
};

function log(msg, kind = 'info') {
  const line = el('div', { className: 'l-' + kind, textContent: msg });
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run an expression in the page and return its (JSON-serializable) value. */
function pageEval(expr) {
  return view.executeJavaScript(expr, true);
}

// ===========================================================================
// Webview navigation
// ===========================================================================

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return '';
  if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// The <webview> can't accept loadURL until it's attached (dom-ready). Queue any
// early navigation until then. (Set true by wireWebview's dom-ready handler.)
let webviewReady = false;

function navigate(raw) {
  const u = normalizeUrl(raw);
  if (!u) return;
  urlInput.value = u;
  const go = () => view.loadURL(u).catch((e) => log('Navigation failed: ' + e.message, 'err'));
  if (webviewReady) go();
  else view.addEventListener('dom-ready', go, { once: true });
}

// Navigate and resolve when the page finishes loading (used to open the job's
// start URL before a run).
function navigateAndWait(raw, timeout = 20000) {
  const u = normalizeUrl(raw);
  return new Promise((resolve) => {
    if (!u) return resolve();
    urlInput.value = u;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      view.removeEventListener('did-stop-loading', finish);
      resolve();
    };
    view.addEventListener('did-stop-loading', finish);
    const go = () => view.loadURL(u).catch(() => finish());
    if (webviewReady) go();
    else view.addEventListener('dom-ready', go, { once: true });
    setTimeout(finish, timeout);
  });
}

$('#go').addEventListener('click', () => navigate(urlInput.value));
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate(urlInput.value);
});
$('#nav-back').addEventListener('click', () => view && view.canGoBack() && view.goBack());
$('#nav-fwd').addEventListener('click', () => view && view.canGoForward() && view.goForward());
$('#nav-reload').addEventListener('click', () => view && view.reload());

// ===========================================================================
// Zoom — the embedded page and the app's own interface, independently
// ===========================================================================

const clampZoom = (f, lo, hi) => Math.min(hi, Math.max(lo, Math.round(f * 100) / 100));

// Page zoom: scales the content inside the <webview> (like a browser's Ctrl +/-).
let pageZoom = 1;
function setPageZoom(f) {
  pageZoom = clampZoom(f, 0.25, 3);
  try {
    view.setZoomFactor(pageZoom);
  } catch (_) {}
  $('#pz-reset').textContent = Math.round(pageZoom * 100) + '%';
}
$('#pz-in').addEventListener('click', () => setPageZoom(pageZoom + 0.1));
$('#pz-out').addEventListener('click', () => setPageZoom(pageZoom - 0.1));
$('#pz-reset').addEventListener('click', () => setPageZoom(1));
// (Zoom is re-applied on each webview's did-finish-load in wireWebview.)

// Interface zoom: scales Scrape Studio's own chrome via the host webFrame.
let uiZoom = 1;
function setUiZoom(f) {
  uiZoom = clampZoom(f, 0.5, 2.5);
  if (window.harvest && window.harvest.setUiZoom) window.harvest.setUiZoom(uiZoom);
  $('#uz-reset').textContent = Math.round(uiZoom * 100) + '%';
}
$('#uz-in').addEventListener('click', () => setUiZoom(uiZoom + 0.1));
$('#uz-out').addEventListener('click', () => setUiZoom(uiZoom - 0.1));
$('#uz-reset').addEventListener('click', () => setUiZoom(1));

// Track whether the pointer is over the embedded page.
let overWebview = false;
$('#webview-wrap').addEventListener('mouseenter', () => (overWebview = true));
$('#webview-wrap').addEventListener('mouseleave', () => (overWebview = false));

// Keyboard: Ctrl/Cmd +/-/0. Target depends on hover — over the page it zooms the
// page, anywhere else it zooms the interface. Shift always forces interface.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const plus = e.key === '+' || e.key === '=';
  const minus = e.key === '-' || e.key === '_';
  const zero = e.key === '0';
  if (!plus && !minus && !zero) return;
  e.preventDefault();
  if (!e.shiftKey && overWebview) {
    setPageZoom(zero ? 1 : pageZoom + (plus ? 0.1 : -0.1));
  } else {
    setUiZoom(zero ? 1 : uiZoom + (plus ? 0.1 : -0.1));
  }
});

// ===========================================================================
// Job start URL — every run begins here
// ===========================================================================

let startUrl = '';

function setStartUrl(u) {
  startUrl = normalizeUrl(u);
  $('#start-url').value = startUrl;
}

$('#start-url').addEventListener('change', () => {
  startUrl = normalizeUrl($('#start-url').value);
  markDirty();
});
$('#use-current').addEventListener('click', () => {
  try {
    setStartUrl(view.getURL());
    markDirty();
    log('Start URL set to current page.', 'ok');
  } catch (_) {}
});

// ===========================================================================
// Element picker
// ===========================================================================

let pickHidModal = false;
let pickActive = false;

function startPick(mode, target) {
  if (running) return;
  pickTarget = target;
  pickActive = true;
  // If a step editor is open, hide it so the user can actually see and click
  // the page — the editor reappears (with the selector filled) once picked.
  const modal = $('#modal');
  pickHidModal = !modal.classList.contains('hidden');
  if (pickHidModal) modal.classList.add('hidden');
  if (view) view.send('picker:start', { mode, relativeTo: target.relativeTo || '' });
  $('#pick-hint').classList.remove('hidden');
}

// End pick mode. On success the editor reopens (filled); on cancel the editor is
// discarded entirely (an unsaved new step never gets added), returning to normal.
function endPick(cancelled) {
  pickActive = false;
  pickTarget = null;
  $('#pick-hint').classList.add('hidden');
  if (pickHidModal) {
    pickHidModal = false;
    if (cancelled) closeModal();
    else $('#modal').classList.remove('hidden');
  }
}

// Cancel from the host side (e.g. Esc while the page doesn't have focus).
function cancelPick() {
  if (!pickActive) return;
  if (view) view.send('picker:stop');
  endPick(true);
  log('Pick cancelled.', 'warn');
}

// Esc cancels an active pick regardless of which side has keyboard focus.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pickActive) {
    e.preventDefault();
    cancelPick();
  }
});

// Messages sent from the webview preload via sendToHost (wired per-mount in
// wireWebview).
function onWebviewMessage(e) {
  if (e.channel === 'picker:picked') {
    handlePicked(e.args[0]); // manages the editor reopen itself (may show a chooser)
  } else if (e.channel === 'picker:cancelled') {
    endPick(true);
    log('Pick cancelled.', 'warn');
  } else if (e.channel === 'rec:action') {
    onRecordedAction(e.args[0]);
  } else if (e.channel === 'zoom:page') {
    const d = e.args[0] && e.args[0].dir;
    if (d === 'in') setPageZoom(pageZoom + 0.1);
    else if (d === 'out') setPageZoom(pageZoom - 0.1);
    else setPageZoom(1);
  } else if (e.channel === 'diag:ready') {
    window.__diag = e.args[0];
  }
}

function handlePicked(data) {
  const t = pickTarget;
  pickTarget = null;
  pickActive = false;
  $('#pick-hint').classList.add('hidden');
  if (!t) return;

  // Offer "this exact one" vs "any matching (first)" when the generalized
  // selector matches more than one element (and we're not already relative).
  const canChoose =
    t.type === 'input' && !t.relativeTo && data.general && data.general !== data.selector && data.count > 1;

  if (canChoose) {
    chooseSelector(data, (chosen) => fillPick(t, chosen, data));
  } else {
    fillPick(t, data.selector, data);
  }
}

// Fill the picked selector into its input and reopen the editor if it was hidden.
function fillPick(t, selector, data) {
  t.input.value = selector;
  t.input.dispatchEvent(new Event('input', { bubbles: true }));

  // Picked from inside a "For each": the picker tells us whether the element was
  // actually inside the current container. If it wasn't, tick the "somewhere
  // else on the page" box for the user instead of silently producing a selector
  // that can never match within the item.
  if (t.relativeTo && data && scopeAbsBox && editingScope) {
    const outside = data.relative === false;
    if (outside && !scopeAbsBox.checked) {
      scopeAbsBox.click(); // fires change → sets step.abs
      log('That element is outside the current item — searching the whole page for it.', 'warn');
    } else if (!outside && scopeAbsBox.checked) {
      scopeAbsBox.click();
    }
  }

  const rel = t.relativeTo && data && data.relative;
  log(`Selected: ${selector || '(the item itself)'}${rel ? ' (relative to the item)' : ''}`, 'ok');
  if (typeof t.onFilled === 'function') t.onFilled(selector, data);
  if (pickHidModal) {
    pickHidModal = false;
    $('#modal').classList.remove('hidden');
  }
}

// Small centred chooser shown after a single-element pick.
let choiceEl = null;
function closeChoice() {
  if (choiceEl) {
    choiceEl.remove();
    choiceEl = null;
  }
}
function chooseSelector(data, cb) {
  closeChoice();
  const panel = el('div', { className: 'choice' });
  panel.append(
    el('div', { className: 'choice-title', textContent: 'Which element(s)?' }),
    el('div', { className: 'choice-sample', textContent: data.sample ? '“' + data.sample + '”' : '' })
  );
  const exact = el('button', { className: 'primary' });
  exact.textContent = 'This exact element';
  exact.addEventListener('click', () => {
    closeChoice();
    cb(data.selector);
  });
  const any = el('button', {});
  any.textContent = `Any matching — first of ${data.count}`;
  any.addEventListener('click', () => {
    closeChoice();
    cb(data.general);
  });
  panel.append(any, exact);
  document.body.append(panel);
  choiceEl = panel;
}

// Delegate the little "Pick" buttons next to inputs (pagination + modal).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pick-into]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.pickInto);
  if (input) startPick(btn.dataset.pickMode || 'element', { type: 'input', input });
});

// ===========================================================================
// Recorder — user drives the page; we watch and translate to step blocks.
// ===========================================================================

let recording = false;
let recorded = []; // raw {type, selector, value/text/..., ts}

const recBtn = $('#record');
recBtn.addEventListener('click', () => (recording ? stopRecording() : startRecording()));

function startRecording() {
  if (running) return;
  recording = true;
  recorded = [];
  view.send('rec:start');
  recBtn.classList.add('active');
  recBtn.textContent = '■ Stop';
  $('#rec-hint').classList.remove('hidden');
  updateRecCount();
  log('● Recording — perform your actions in the page, then press Stop.', 'warn');
}

function stopRecording() {
  recording = false;
  view.send('rec:stop');
  recBtn.classList.remove('active');
  recBtn.textContent = '● Record';
  $('#rec-hint').classList.add('hidden');

  const added = recordedToSteps(recorded);
  if (!added.length) {
    log('Recording stopped — no actions captured.', 'warn');
    return;
  }
  for (const st of added) steps.push({ id: nextId(), ...st });
  renderSteps();
  markDirty();
  log(`Recording stopped — added ${added.length} step(s). Review & tune delays.`, 'ok');
}

function updateRecCount() {
  $('#rec-count').textContent = `${recorded.length} action${recorded.length === 1 ? '' : 's'}`;
}

function onRecordedAction(a) {
  if (!recording) return;
  recorded.push(a);
  updateRecCount();
}

// (The recorder is re-armed after navigation in wireWebview's did-stop-loading.)

// Translate raw recorded actions into WebHarvest step blocks, inserting Delay
// steps that reflect the real pauses between actions (user-editable afterwards).
function recordedToSteps(raw) {
  const out = [];
  let prevTs = null;

  for (const a of raw) {
    if (prevTs != null) {
      const gap = a.ts - prevTs;
      if (gap >= 400) {
        const ms = Math.min(15000, Math.round(gap / 100) * 100);
        out.push({ type: 'wait', ms });
      }
    }
    prevTs = a.ts;

    if (a.type === 'fill') {
      out.push({ type: 'type', selector: a.selector, text: a.value || '', clear: true, pressEnter: false });
    } else if (a.type === 'select') {
      const useText = !a.value && a.text;
      out.push({
        type: 'select',
        selector: a.selector,
        by: useText ? 'text' : 'value',
        value: useText ? a.text : a.value,
        multi: false
      });
    } else if (a.type === 'check') {
      out.push({ type: 'check', selector: a.selector, state: a.checked ? 'check' : 'uncheck' });
    } else if (a.type === 'key') {
      out.push({ type: 'key', key: a.key, selector: '', ctrl: false, shift: false, alt: false });
    } else if (a.type === 'click') {
      // Prefer "Click text" when the selector is brittle (positional) but the
      // element has short, stable text — more readable and more robust.
      const brittle = /:nth-of-type\(/.test(a.selector);
      const text = (a.text || '').trim();
      if (brittle && text && text.length <= 40) {
        out.push({ type: 'clickText', text, mode: 'exact', container: '', tag: '' });
      } else {
        out.push({ type: 'click', selector: a.selector });
      }
    }
  }
  return out;
}

// ===========================================================================
// Steps: model + rendering
// ===========================================================================

const STEP_META = {
  click: { icon: '🖱️', label: 'Click' },
  clickText: { icon: '🔤', label: 'Click text' },
  select: { icon: '🔽', label: 'Select option' },
  check: { icon: '☑️', label: 'Check' },
  type: { icon: '⌨️', label: 'Fill field' },
  hover: { icon: '👆', label: 'Hover' },
  key: { icon: '⌨', label: 'Press key' },
  wait: { icon: '⏱️', label: 'Delay' },
  waitFor: { icon: '👁️', label: 'Wait for' },
  scroll: { icon: '↕️', label: 'Scroll' },
  loadAll: { icon: '⤓', label: 'Load all' },
  get: { icon: '📥', label: 'Grab one value' },
  scrapeList: { icon: '📋', label: 'Grab a list' },
  goto: { icon: '🌐', label: 'Go to URL' },
  back: { icon: '⬅️', label: 'Go back' },
  if: { icon: '❓', label: 'If' },
  forEach: { icon: '🔄', label: 'For each' },
  while: { icon: '🔁', label: 'While' },
  repeat: { icon: '🔢', label: 'Repeat' },
  skip: { icon: '⏭', label: 'Skip item' },
  break: { icon: '⛔', label: 'Break' },
  // Legacy types — kept so old jobs still render if migration is ever bypassed.
  scrape: { icon: '📥', label: 'Get value' },
  setVar: { icon: '📥', label: 'Get value' },
  emitRow: { icon: '📤', label: 'Add row (old)' }
};

// Block steps hold child step lists.
const BLOCK_TYPES = { if: ['then', 'else'], while: ['body'], repeat: ['body'], forEach: ['body'] };
const isBlock = (s) => !!BLOCK_TYPES[s.type];

function stepDetail(s) {
  switch (s.type) {
    case 'click':
      return s.selector || '(no selector)';
    case 'clickText':
      return `"${s.text}"${s.container ? ' in ' + s.container : ''}`;
    case 'select':
      return `${s.selector} → ${s.by}="${s.value}"`;
    case 'check':
      return `${s.state} · ${s.selector}`;
    case 'hover':
      return s.selector || '(no selector)';
    case 'key':
      return `${modText(s)}${s.key}${s.selector ? ' @ ' + s.selector : ''}`;
    case 'wait':
      return `${s.ms} ms`;
    case 'waitFor':
      return `${s.waitMode === 'disappear' ? 'gone: ' : ''}${s.selector} · ${s.timeout}ms`;
    case 'type':
      return `${s.selector} ← "${s.text}"${s.pressEnter ? ' ⏎' : ''}`;
    case 'scroll':
      return s.mode === 'by' ? `by ${s.px}px` : `to ${s.mode}`;
    case 'loadAll':
      return 'auto-scroll to load everything' + (s.moreSelector ? ' + ' + s.moreSelector : '');
    case 'get': {
      const where = SOURCE_PHRASE[s.source] || s.source;
      const from =
        s.source === 'expr' ? (s.expr || '…')
        : s.source === 'url' ? 'the page URL'
        : `${where} ${s.selector || '(pick one)'}`;
      const kept = s.target === 'column' ? '' : ' · not in the CSV';
      return `${s.name || '(name it)'} ← ${from}${s.source === 'expr' ? '' : tfSummary(s)}${kept}`;
    }
    case 'scrapeList': {
      const cleaned = s.fields.filter((f) => stepTransforms(f).length).length;
      const cols = s.fields.map((f) => f.name).filter(Boolean).join(', ');
      return `each ${s.rowSelector || '(pick a row)'} → ${cols || 'no columns yet'}${cleaned ? ' 🧹' : ''}`;
    }
    case 'skip':
      return 'no row for this item — go to the next';
    case 'emitRow':
      return 'commit current row (old step — rows now commit themselves)';
    case 'goto':
      return `→ ${s.url || '…'}`;
    case 'back':
      return 'browser back';
    case 'forEach':
      return `every ${s.selector || '(pick an item)'} — one row each`;
    case 'if':
      return condSummary(s.condition);
    case 'while':
      return `while ${condSummary(s.condition)}`;
    case 'repeat':
      return `${s.count || '0'} times${s.indexVar ? ` (counter: ${s.indexVar})` : ''}`;
    case 'break':
      return 'exit loop';
    default:
      return '';
  }
}

// How each Get-value source reads in the step list.
const SOURCE_PHRASE = {
  text: 'the text of',
  href: 'the link in',
  src: 'the image in',
  value: 'the field value of',
  attr: 'an attribute of',
  html: 'the HTML of',
  checked: 'whether ticked:',
  count: 'how many',
  exists: 'whether there is a'
};

// " → Text between(£, () → Number" for the step list.
function tfSummary(o) {
  const sum = TF.summary(stepTransforms(o));
  return sum ? ` → ${sum}` : '';
}

function modText(s) {
  const m = [];
  if (s.ctrl) m.push('Ctrl');
  if (s.shift) m.push('Shift');
  if (s.alt) m.push('Alt');
  return m.length ? m.join('+') + '+' : '';
}

// --- Visual conditions (no typing of && / || / operators) ------------------

const COND_OPS = [
  { v: 'eq', label: 'is equal to', sym: '=', binary: true, op: '==' },
  { v: 'ne', label: 'is not equal to', sym: '≠', binary: true, op: '!=' },
  { v: 'gt', label: 'is greater than', sym: '>', binary: true, op: '>' },
  { v: 'ge', label: 'is greater than or equal to', sym: '≥', binary: true, op: '>=' },
  { v: 'lt', label: 'is less than', sym: '<', binary: true, op: '<' },
  { v: 'le', label: 'is less than or equal to', sym: '≤', binary: true, op: '<=' },
  { v: 'contains', label: 'contains', sym: 'contains', binary: true },
  { v: 'ncontains', label: 'does not contain', sym: 'excludes', binary: true },
  { v: 'empty', label: 'is empty', sym: 'is empty', binary: false },
  { v: 'nempty', label: 'is not empty', sym: 'is not empty', binary: false },
  { v: 'true', label: 'is true / yes', sym: 'is true', binary: false },
  { v: 'false', label: 'is false / no', sym: 'is false', binary: false }
];
const isBinaryOp = (op) => {
  const o = COND_OPS.find((x) => x.v === op);
  return o ? o.binary : true;
};

function newRule() {
  return { left: '', op: 'eq', right: '' };
}

function normalizeCond(cond) {
  if (cond && typeof cond === 'object' && Array.isArray(cond.rules)) return cond;
  return { match: 'all', rules: [newRule()] };
}

// Compile visual rules into an expression string for the evaluator.
function compileCondition(cond, known) {
  cond = normalizeCond(cond);
  const rhs = (r) => {
    const v = (r.right == null ? '' : String(r.right)).trim();
    if (known && known.has(v)) return v; // a variable
    if (v !== '' && !isNaN(Number(v))) return v; // a number
    return JSON.stringify(v); // a string
  };
  const one = (r) => {
    const L = (r.left || '').trim();
    switch (r.op) {
      case 'contains':
        return `contains(${L}, ${rhs(r)})`;
      case 'ncontains':
        return `!contains(${L}, ${rhs(r)})`;
      case 'empty':
        return `len(${L}) == 0`;
      case 'nempty':
        return `len(${L}) > 0`;
      case 'true':
        return `(${L})`;
      case 'false':
        return `!(${L})`;
      default: {
        const o = COND_OPS.find((x) => x.v === r.op);
        return `${L} ${o ? o.op : '=='} ${rhs(r)}`;
      }
    }
  };
  const parts = cond.rules.filter((r) => (r.left || '').trim()).map((r) => '(' + one(r) + ')');
  if (!parts.length) return 'false';
  return parts.join(cond.match === 'any' ? ' || ' : ' && ');
}

// Human-readable summary for the step list.
function condSummary(cond) {
  cond = normalizeCond(cond);
  const rules = cond.rules.filter((r) => (r.left || '').trim());
  if (!rules.length) return 'no condition';
  const parts = rules.map((r) => {
    const o = COND_OPS.find((x) => x.v === r.op) || { sym: r.op, binary: true };
    return o.binary ? `${r.left} ${o.sym} ${r.right}` : `${r.left} ${o.sym}`;
  });
  return parts.join(cond.match === 'any' ? ' OR ' : ' AND ');
}

// Like condSummary, but with the live values filled in — "priceVar (7.99) ≥ 200".
// This is what turns "why did nothing happen?" into an obvious answer.
function condSummaryWith(cond, vars) {
  cond = normalizeCond(cond);
  const rules = cond.rules.filter((r) => (r.left || '').trim());
  if (!rules.length) return 'no condition';
  const val = (name) => {
    const v = vars[(name || '').trim()];
    return v === undefined ? '?' : JSON.stringify(v);
  };
  const parts = rules.map((r) => {
    const o = COND_OPS.find((x) => x.v === r.op) || { sym: r.op, binary: true };
    const left = `${r.left} (${val(r.left)})`;
    if (!o.binary) return `${left} ${o.sym}`;
    // The right side may itself be a variable — show its value too.
    const rt = (r.right == null ? '' : String(r.right)).trim();
    const right = rt in vars ? `${rt} (${val(rt)})` : rt;
    return `${left} ${o.sym} ${right}`;
  });
  return parts.join(cond.match === 'any' ? ' OR ' : ' AND ');
}

// Every name you can use in a rule. Columns AND working values share ONE
// namespace — you always read a value by its name, whatever it's kept as.
function collectVarNames(list, out) {
  out = out || new Set();
  for (const s of list) {
    if ((s.type === 'get' || s.type === 'setVar' || s.type === 'scrape') && s.name) out.add(s.name);
    if ((s.type === 'repeat' || s.type === 'forEach') && s.indexVar) out.add(s.indexVar);
    if (isBlock(s)) for (const k of BLOCK_TYPES[s.type]) collectVarNames(s[k] || [], out);
  }
  return out;
}

function countSteps(list) {
  let n = 0;
  for (const s of list) {
    n++;
    if (isBlock(s)) for (const k of BLOCK_TYPES[s.type]) n += countSteps(s[k] || []);
  }
  return n;
}

// Assign fresh session-unique ids to every step (incl. nested), ensure block
// child arrays exist, and migrate legacy step types. Used when loading a job.
function reidList(list) {
  for (let i = 0; i < list.length; i++) {
    const s = migrateStep(list[i]);
    list[i] = s;
    s.id = nextId();
    if (isBlock(s)) {
      for (const k of BLOCK_TYPES[s.type]) {
        s[k] = s[k] || [];
        reidList(s[k]);
      }
    }
  }
  return list;
}

// "Scrape one" and "Set var" were two steps that did the same job, which is
// what made rows confusing. They are now ONE step: 📥 Get value. Old jobs are
// converted on load — nothing to redo by hand.
function migrateStep(s) {
  if (s.type === 'scrape') {
    return {
      ...s,
      type: 'get',
      target: 'column',
      name: s.name || 'value',
      source: EXTRACT_TO_SOURCE[s.extract] || 'text',
      attr: s.attr || '',
      expr: ''
    };
  }
  if (s.type === 'setVar') {
    return { ...s, type: 'get', target: s.target === 'column' ? 'column' : 'var' };
  }
  return s;
}

// The old Scrape-one "Extract" modes map onto Get value's sources.
const EXTRACT_TO_SOURCE = {
  text: 'text',
  html: 'html',
  attr: 'attr',
  href: 'href',
  src: 'src',
  value: 'value',
  checked: 'checked'
};

function renderSteps() {
  $('#steps-empty').classList.toggle('hidden', steps.length > 0);
  const total = countSteps(steps);
  $('#step-count').textContent = total ? `(${total})` : '';
  renderList(steps, $('#steps'));
}

// Recursively render a step list into an <ol>, nesting block children.
function renderList(list, ol) {
  ol.innerHTML = '';
  ol._list = list;
  list.forEach((s, i) => {
    const meta = STEP_META[s.type];
    const li = el('li', { className: 'step' + (isBlock(s) ? ' block-step' : ''), draggable: true });
    li.dataset.id = s.id;

    li.append(
      el('div', { className: 'step-row' }, [
        el('span', { className: 'idx', textContent: i + 1 }),
        el('div', { className: 'body' }, [
          el('div', { className: 'kind', textContent: `${meta.icon} ${meta.label}` }),
          el('div', { className: 'detail', textContent: stepDetail(s), title: stepDetail(s) })
        ]),
        el('div', { className: 'acts' }, [
          el('button', { textContent: '✎', title: 'Edit', onclick: () => openStepEditor(s, list, false) }),
          el('button', { textContent: '🗑', title: 'Delete', onclick: () => deleteStepFrom(list, s.id) })
        ])
      ])
    );
    wireDrag(li, list);

    if (isBlock(s)) {
      const blocks = el('div', { className: 'blocks' });
      for (const key of BLOCK_TYPES[s.type]) blocks.append(blockSection(labelFor(s.type, key), s[key]));
      li.append(blocks);
    }
    ol.append(li);
  });
}

function labelFor(type, key) {
  if (type === 'if') return key === 'then' ? 'Then' : 'Else';
  if (type === 'repeat') return 'Repeat body';
  if (type === 'forEach') return 'For each';
  return 'While body';
}

function blockSection(label, childList) {
  const wrap = el('div', { className: 'block' });
  wrap.append(el('div', { className: 'block-label', textContent: label }));
  const childOl = el('ol', { className: 'steps nested' });
  renderList(childList, childOl);
  wrap.append(childOl);
  const add = el('button', { className: 'add-in-block', textContent: '+ add step' });
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    openTypeMenu(add, (type) => addStepOfType(type, childList));
  });
  wrap.append(add);
  return wrap;
}

function deleteStepFrom(list, id) {
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) list.splice(i, 1);
  renderSteps();
  markDirty();
}

// --- Drag to reorder (within the same list only) ---------------------------

let dragId = null;
let dragList = null;
function wireDrag(li, list) {
  li.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    dragId = li.dataset.id;
    dragList = list;
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', (e) => {
    e.stopPropagation();
    li.classList.remove('dragging');
    document.querySelectorAll('.step').forEach((n) => n.classList.remove('drop-target'));
  });
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragList === list) li.classList.add('drop-target');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove('drop-target');
    if (dragList !== list) return; // only reorder within the same block
    const from = list.findIndex((s) => String(s.id) === String(dragId));
    const to = list.findIndex((s) => String(s.id) === String(li.dataset.id));
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    renderSteps();
    markDirty();
  });
}

// --- Floating "add step" menu (used inside blocks) -------------------------

// Grouped exactly like the sidebar palette — the data steps first, because
// that's what people are actually here for.
const PALETTE_GROUPS = [
  { title: 'Get the data', types: ['scrapeList', 'get'] },
  { title: 'Do something on the page', types: [
    'click', 'type', 'clickText', 'select', 'check', 'hover', 'key',
    'scroll', 'waitFor', 'wait', 'loadAll', 'goto', 'back'] },
  { title: 'Repeat & decide', types: ['forEach', 'if', 'skip', 'while', 'repeat', 'break'] }
];
let openMenuEl = null;
function closeTypeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
    document.removeEventListener('mousedown', menuOutside, true);
  }
}
function menuOutside(e) {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeTypeMenu();
}
function openTypeMenu(anchor, onPick) {
  closeTypeMenu();
  const menu = el('div', { className: 'type-menu' });
  for (const g of PALETTE_GROUPS) {
    menu.append(el('div', { className: 'tm-title', textContent: g.title }));
    const grid = el('div', { className: 'tm-grid' });
    for (const t of g.types) {
      const m = STEP_META[t];
      const b = el('button', { className: g.title === 'Get the data' ? 'key-step' : '',
        textContent: `${m.icon} ${m.label}` });
      b.addEventListener('click', () => {
        closeTypeMenu();
        onPick(t);
      });
      grid.append(b);
    }
    menu.append(grid);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 200) + 'px';
  menu.style.top = r.bottom + 3 + 'px';
  openMenuEl = menu;
  setTimeout(() => document.addEventListener('mousedown', menuOutside, true), 0);
}

const NO_EDITOR = new Set(['break', 'emitRow', 'back', 'skip']); // nothing to configure

function addStepOfType(type, list) {
  const step = { id: nextId(), ...BLANK[type]() };
  if (NO_EDITOR.has(type)) {
    list.push(step);
    renderSteps();
    markDirty();
    return;
  }
  openStepEditor(step, list, true);
}

// --- Palette: add a blank step of a given type -----------------------------

const BLANK = {
  click: () => ({ type: 'click', selector: '' }),
  clickText: () => ({ type: 'clickText', text: '', mode: 'exact', container: '', tag: '' }),
  select: () => ({ type: 'select', selector: '', by: 'text', value: '', multi: false }),
  check: () => ({ type: 'check', selector: '', state: 'check' }),
  hover: () => ({ type: 'hover', selector: '' }),
  key: () => ({ type: 'key', key: 'Enter', selector: '', ctrl: false, shift: false, alt: false }),
  wait: () => ({ type: 'wait', ms: 1000 }),
  waitFor: () => ({ type: 'waitFor', selector: '', timeout: 10000, waitMode: 'appear' }),
  type: () => ({ type: 'type', selector: '', text: '', clear: true, pressEnter: false }),
  scroll: () => ({ type: 'scroll', mode: 'bottom', px: 800 }),
  loadAll: () => ({ type: 'loadAll', waitMs: 900, maxRounds: 40, moreSelector: '' }),
  get: () => ({
    type: 'get',
    name: '',
    target: 'column', // a column (in the results) by default — that's what people want
    source: 'text',
    selector: '',
    attr: '',
    expr: '',
    transforms: []
  }),
  scrapeList: () => ({
    type: 'scrapeList',
    rowSelector: '',
    // ONE empty column to fill in — not a junk "text" column that silently
    // grabs the whole row and shows up in the CSV.
    fields: [{ name: '', selector: '', extract: 'text', attr: '' }]
  }),
  skip: () => ({ type: 'skip' }),
  goto: () => ({ type: 'goto', url: '' }),
  back: () => ({ type: 'back' }),
  if: () => ({ type: 'if', condition: { match: 'all', rules: [newRule()] }, then: [], else: [] }),
  forEach: () => ({ type: 'forEach', selector: '', indexVar: 'i', body: [], maxIter: 1000 }),
  while: () => ({ type: 'while', condition: { match: 'all', rules: [newRule()] }, body: [], maxIter: 1000 }),
  repeat: () => ({ type: 'repeat', count: '10', indexVar: 'i', body: [] }),
  break: () => ({ type: 'break' })
};

function onPaletteClick(e) {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  addStepOfType(btn.dataset.add, steps); // top-level palette adds to the root
}
$('#palette').addEventListener('click', onPaletteClick);
$('#palette-actions').addEventListener('click', onPaletteClick);
$('#palette-logic').addEventListener('click', onPaletteClick);
// The "Start here" card is the same palette, spelled out for a first-timer.
$('#steps-empty').addEventListener('click', onPaletteClick);

// ===========================================================================
// Step editor modal
// ===========================================================================

let editing = null;
let editingList = null; // the list the step belongs to / will be added to
let editingIsNew = false;
let editingScope = ''; // enclosing "For each" selector, if this step is inside one
let scopeAbsBox = null; // the "outside the current item" checkbox (when scoped)

// The nearest enclosing "For each" selector for a step list. A step edited
// inside a For-each picks selectors RELATIVE to the current container — the
// same way a Scrape-list column is relative to its row.
function scopeSelectorFor(list, root, current) {
  root = root || steps;
  current = current || '';
  if (list === root) return current;
  for (const s of root) {
    if (!isBlock(s)) continue;
    const inner = s.type === 'forEach' ? s.selector || current : current;
    for (const k of BLOCK_TYPES[s.type]) {
      const child = s[k] || [];
      if (child === list) return inner;
      const found = scopeSelectorFor(list, child, inner);
      if (found !== null) return found;
    }
  }
  return null;
}

function openStepEditor(step, list, isNew) {
  editing = JSON.parse(JSON.stringify(step)); // work on a copy
  editingList = list || steps;
  editingIsNew = !!isNew;
  editingScope = scopeSelectorFor(editingList) || '';
  scopeAbsBox = null;
  scopeBannerEl = null;
  openTfCols = new Set();
  const meta = STEP_META[step.type];
  $('#modal-title').textContent = `${meta.icon} ${meta.label}`;
  $('#modal-body').innerHTML = '';
  buildEditorFields(editing, $('#modal-body'));
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  editing = null;
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal-cancel').addEventListener('click', closeModal);

function field(label, control, hint) {
  const f = el('div', { className: 'field' });
  f.append(el('label', { textContent: label }), control);
  if (hint) f.append(el('div', { className: 'hint', textContent: hint }));
  return f;
}

// A full-width labelled checkbox row.
function checkboxField(label, checked, onChange) {
  const wrap = el('label', {
    className: 'check-row',
    style: 'display:flex;align-items:center;gap:7px;margin-bottom:10px;cursor:pointer'
  });
  const box = el('input', { type: 'checkbox', checked: !!checked, style: 'width:auto' });
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, el('span', { textContent: label, style: 'font-size:12px' }));
  return wrap;
}

// A compact inline checkbox (for modifier rows).
function inlineCheck(label, checked, onChange) {
  const wrap = el('label', { style: 'display:flex;align-items:center;gap:5px;cursor:pointer' });
  const box = el('input', { type: 'checkbox', checked: !!checked, style: 'width:auto' });
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, el('span', { textContent: label }));
  return wrap;
}

// Read a live <select>'s options from the page and offer them as real choices.
async function loadSelectOptions(selector, container, step) {
  container.innerHTML = '';
  if (!selector) return;
  let opts;
  try {
    opts = await pageEval(PA.readOptionsExpr(selector));
  } catch (_) {
    opts = null;
  }
  if (!opts || !opts.length) {
    container.append(
      el('div', { className: 'hint', textContent:
        'No live options found. Load the page first, or set the option manually below.' })
    );
    return;
  }
  const live = el('select');
  live.append(el('option', { value: '', textContent: `— ${opts.length} live options —` }));
  for (const o of opts) {
    const lbl = o.text || o.value || `#${o.i}`;
    live.append(el('option', { value: String(o.i), textContent: lbl }));
  }
  live.addEventListener('change', () => {
    const o = opts[+live.value];
    if (!o) return;
    // Prefer the stable value; fall back to visible text.
    if (o.value) {
      step.by = 'value';
      step.value = o.value;
    } else {
      step.by = 'text';
      step.value = o.text;
    }
    if (step._valInput) step._valInput.value = step.value;
    if (step._byInput) step._byInput.value = step.by;
  });
  container.append(field('Choose from live options', live));
}

// A selector input where **Pick is the main event**: a big accent button, and a
// live status line under it that tells you, in plain words, what you just
// selected ("✓ 3 on this page — e.g. “$10.00”"). Without that confirmation the
// user is staring at ".price" with no idea whether it's right until they Run.
//
// opts: { mode, relativeTo, onFilled(selector, data), countLabel }
//
// If the step being edited sits inside a "For each", picks default to being
// RELATIVE to that container (unless the step is flagged as "outside the
// current item"), so ".price" means THIS item's price.
function selectorInput(value, opts = {}) {
  const wrap = el('div', { className: 'sel-field' });
  const row = el('span', { className: 'input-with-pick' });
  const input = el('input', {
    className: 'sel-input',
    value: value || '',
    placeholder: 'press Pick →  (or type a CSS selector)'
  });
  const pick = el('button', { className: 'mini-pick pick-btn', textContent: '⊕ Pick' });
  const status = el('div', { className: 'sel-status' });

  const relTo = () =>
    opts.relativeTo !== undefined ? opts.relativeTo : editing && editing.abs ? '' : editingScope;

  const check = () => updateSelStatus(status, input.value, relTo(), opts);
  pick.addEventListener('click', () =>
    startPick(opts.mode || 'element', {
      type: 'input',
      input,
      relativeTo: relTo(), // resolved at click time: `editing.abs` may have been toggled
      onFilled: (sel, data) => {
        if (typeof opts.onFilled === 'function') opts.onFilled(sel, data);
        check();
      }
    })
  );

  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(check, 350);
  });
  row.append(input, pick);
  wrap.append(row, status);
  setTimeout(check, 0); // confirm what's already there when the editor opens
  return { wrap, input, status, check };
}

// Guess a column name from what the user picked, so the common case needs no
// typing at all: ".product-item__price" → "price", "a.title-link" → "title",
// "#search-total" → "searchTotal".
function suggestName(selector) {
  const sel = (selector || '').trim();
  if (!sel) return '';
  // last id/class token in the selector, e.g. ".card > .price" → "price"
  const tokens = sel.match(/[.#][A-Za-z_][\w-]*/g);
  if (!tokens || !tokens.length) return '';
  let raw = tokens[tokens.length - 1].slice(1);
  // strip BEM-ish block prefixes: "product-item__price" → "price"
  if (raw.includes('__')) raw = raw.split('__').pop();
  // drop generic suffixes people don't want in a heading
  raw = raw.replace(/[-_](link|text|label|wrap|wrapper|container|inner)$/i, '');
  const parts = raw.split(/[-_]+/).filter(Boolean);
  if (!parts.length) return '';
  const camel = parts[0].toLowerCase() +
    parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join('');
  return /^[a-z]/i.test(camel) ? camel : '';
}

// Ask the live page how many elements a selector matches, and show a sample.
async function updateSelStatus(status, rawSel, relativeTo, opts = {}) {
  const sel = (rawSel || '').trim();
  const scope = relativeTo || '';
  if (!sel && !scope) {
    status.className = 'sel-status';
    status.textContent = '';
    return;
  }
  const full = scope ? (sel ? scope + ' ' + sel : scope) : sel;
  let info;
  try {
    info = await pageEval(`(() => {
      let els; try { els = document.querySelectorAll(${JSON.stringify(full)}); } catch (e) { return { bad: true }; }
      const first = els[0];
      const txt = first ? (first.innerText || first.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      return { n: els.length, sample: txt.slice(0, 60) };
    })()`);
  } catch (_) {
    info = null;
  }
  if (!info || info.bad) {
    status.className = 'sel-status bad';
    status.textContent = '⚠ That isn’t a valid selector.';
    return;
  }
  if (!info.n) {
    status.className = 'sel-status bad';
    status.textContent = scope
      ? '⚠ Nothing inside the current item matches — is it somewhere else on the page?'
      : '⚠ Nothing on this page matches. Load the right page, then press Pick.';
    return;
  }
  const noun = opts.countLabel || 'match'; // 'match' | 'item' | 'row'
  const plural = noun === 'match' ? 'matches' : noun + 's';
  status.className = 'sel-status ok';
  status.textContent = `✓ ${info.n} ${info.n === 1 ? noun : plural} on this page` +
    (info.sample ? ` — e.g. “${info.sample}”` : '');
}

function select(value, options) {
  const s = el('select');
  for (const o of options) {
    const opt = el('option', { value: o.value, textContent: o.label });
    if (o.value === value) opt.selected = true;
    s.append(opt);
  }
  return s;
}

const EXTRACT_OPTS = [
  { value: 'text', label: 'Text' },
  { value: 'html', label: 'Inner HTML' },
  { value: 'attr', label: 'Attribute…' },
  { value: 'href', label: 'Link (href)' },
  { value: 'src', label: 'Image (src)' },
  { value: 'value', label: 'Form value' },
  { value: 'checked', label: 'Checked (true/false)' },
  { value: 'expr', label: 'Value / expression' }
];

// Run the Scrape-list against the live page and show the first rows exactly as
// they'd land in the CSV — clean-ups and all.
async function previewList(s, out) {
  out.classList.remove('hidden');
  out.textContent = 'reading the page…';
  const rowSel = editingScope && !s.abs
    ? (s.rowSelector ? editingScope + ' ' + s.rowSelector : editingScope)
    : s.rowSelector;
  if (!rowSel) {
    out.className = 'preview-box bad';
    out.textContent = 'Pick a row first (①).';
    return;
  }
  const cols = s.fields.filter((f) => (f.name || '').trim() || f.selector);
  if (!cols.length) {
    out.className = 'preview-box bad';
    out.textContent = 'Add a column (②) — then you’ll see the rows here.';
    return;
  }
  let raw;
  try {
    raw = await pageEval(PA.listExpr(rowSel, cols.filter((f) => f.extract !== 'expr')));
  } catch (_) {
    raw = null;
  }
  if (!raw || !raw.length) {
    out.className = 'preview-box bad';
    out.textContent = '⚠ No rows found. Check the row selector (①) — and make sure the page is loaded.';
    return;
  }
  const shown = raw.slice(0, 5).map((r) => {
    const o = {};
    for (const f of cols) {
      o[f.name || '(unnamed)'] = f.extract === 'expr' ? '(computed at run time)' : cleanValue(f, r[f.name]);
    }
    return o;
  });
  out.className = 'preview-box';
  out.innerHTML = '';
  out.append(el('div', { className: 'pv-head',
    textContent: `${raw.length} row${raw.length === 1 ? '' : 's'} — first ${shown.length}:` }));
  const tbl = el('table', { className: 'pv-table' });
  const hr = el('tr');
  for (const f of cols) hr.append(el('th', { textContent: f.name || '(unnamed)' }));
  tbl.append(hr);
  for (const r of shown) {
    const tr = el('tr');
    for (const f of cols) {
      const v = r[f.name || '(unnamed)'];
      tr.append(el('td', { textContent: v === '' || v == null ? '—' : String(v) }));
    }
    tbl.append(tr);
  }
  out.append(tbl);
  const empties = cols.filter((f) => shown.every((r) => {
    const v = r[f.name || '(unnamed)'];
    return v === '' || v == null;
  }));
  if (empties.length) {
    out.append(el('div', { className: 'pv-warn', textContent:
      `⚠ ${empties.map((f) => f.name || '(unnamed)').join(', ')} came back empty — re-Pick that value inside a row.` }));
  }
}

// Step types whose selectors are affected by an enclosing "For each".
const SELECTOR_STEPS = new Set([
  'click', 'clickText', 'select', 'check', 'type', 'hover', 'key', 'waitFor',
  'loadAll', 'get', 'scrapeList', 'forEach'
]);

let scopeBannerEl = null;

// Top of the editor for a selector step inside a For each: says what selectors
// here are relative to. (No form controls — field order stays predictable.)
function appendScopeBanner(s, root) {
  scopeBannerEl = el('div', { className: 'scope-banner' }, [
    el('div', { className: 'scope-title', textContent: `🔄 Inside “For each ${editingScope}”` }),
    el('div', { className: 'scope-text', textContent:
      'Pick gives you a selector relative to the CURRENT item, so it reads this item’s own values ' +
      'on every pass (e.g. THIS card’s price). Leave a selector blank to mean the item itself.' })
  ]);
  scopeBannerEl.classList.toggle('muted', !!s.abs);
  root.append(scopeBannerEl);
}

// Bottom of the editor: the escape hatch for an element that isn't in the item
// (a page-wide filter, a header, a "next" button). Auto-ticked when you pick
// something outside the container.
function appendScopeEscape(s, root) {
  const box = checkboxField(
    'This element is somewhere else on the page (not inside the item)',
    s.abs,
    (v) => {
      s.abs = v;
      if (scopeBannerEl) scopeBannerEl.classList.toggle('muted', v);
    }
  );
  scopeAbsBox = box.querySelector('input');
  root.append(box);
}

function buildEditorFields(s, root) {
  const scoped = editingScope && SELECTOR_STEPS.has(s.type);
  if (scoped) appendScopeBanner(s, root);
  buildEditorBody(s, root);
  if (scoped) appendScopeEscape(s, root);
}

function buildEditorBody(s, root) {
  if (s.type === 'click' || s.type === 'waitFor') {
    const { wrap, input } = selectorInput(s.selector, { mode: 'element' });
    input.addEventListener('input', () => (s.selector = input.value));
    root.append(field('Element selector', wrap, 'Click "Pick" then point at the element.'));
    if (s.type === 'waitFor') {
      const wm = select(s.waitMode || 'appear', [
        { value: 'appear', label: 'until it appears' },
        { value: 'disappear', label: 'until it disappears (e.g. a spinner)' }
      ]);
      wm.addEventListener('change', () => (s.waitMode = wm.value));
      root.append(field('Wait', wm));
      const t = el('input', { type: 'number', value: s.timeout, min: 0 });
      t.addEventListener('input', () => (s.timeout = +t.value));
      root.append(field('Timeout (ms)', t));
    }
  }

  if (s.type === 'wait') {
    const t = el('input', { type: 'number', value: s.ms, min: 0 });
    t.addEventListener('input', () => (s.ms = +t.value));
    root.append(field('Delay (milliseconds)', t, 'Pause before the next step runs.'));
  }

  if (s.type === 'type') {
    const { wrap, input } = selectorInput(s.selector, { mode: 'element' });
    input.addEventListener('input', () => (s.selector = input.value));
    root.append(field('Input selector', wrap, 'Text, number, date, time, or contenteditable field.'));
    const txt = el('input', { value: s.text });
    txt.addEventListener('input', () => (s.text = txt.value));
    root.append(field('Value to enter', txt, 'For date inputs use the native format, e.g. 2026-07-13.'));
    root.append(checkboxField('Clear field first', s.clear, (v) => (s.clear = v)));
    root.append(checkboxField('Press Enter after (submit)', s.pressEnter, (v) => (s.pressEnter = v)));
  }

  if (s.type === 'clickText') {
    const txt = el('input', { value: s.text, placeholder: 'e.g. 15   or   Add to cart' });
    txt.addEventListener('input', () => (s.text = txt.value));
    root.append(field('Text to match', txt,
      'Clicks the smallest element whose visible text matches. Great for calendar days, custom-dropdown options, tabs.'));

    const m = select(s.mode, [
      { value: 'exact', label: 'Exact match' },
      { value: 'contains', label: 'Contains' }
    ]);
    m.addEventListener('change', () => (s.mode = m.value));
    root.append(field('Match', m));

    const { wrap, input } = selectorInput(s.container, { mode: 'element' });
    input.addEventListener('input', () => (s.container = input.value));
    root.append(field('Search within (optional container)', wrap,
      'Limit the search, e.g. to an open calendar popover, to avoid false matches.'));

    const tag = el('input', { value: s.tag, placeholder: 'e.g. button, a, li (optional)' });
    tag.addEventListener('input', () => (s.tag = tag.value));
    root.append(field('Tag filter (optional)', tag));
  }

  if (s.type === 'select') {
    const { wrap, input } = selectorInput(s.selector, {
      mode: 'element',
      onFilled: (sel) => loadSelectOptions(sel, liveWrap, s)
    });
    input.addEventListener('input', () => (s.selector = input.value));
    root.append(field('Dropdown (<select>) selector', wrap));

    const liveWrap = el('div');
    root.append(liveWrap);
    if (s.selector) loadSelectOptions(s.selector, liveWrap, s);

    const by = select(s.by, [
      { value: 'text', label: 'Visible text' },
      { value: 'value', label: 'Option value' },
      { value: 'index', label: 'Index (0-based)' }
    ]);
    by.addEventListener('change', () => (s.by = by.value));
    root.append(field('Match option by', by));

    const val = el('input', { value: s.value, placeholder: 'the option to choose' });
    val.addEventListener('input', () => (s.value = val.value));
    root.append(field('Option', val));
    s._valInput = val; // so the live picker can fill it
    s._byInput = by;

    root.append(checkboxField('Multi-select (add to selection)', s.multi, (v) => (s.multi = v)));
  }

  if (s.type === 'check') {
    const { wrap, input } = selectorInput(s.selector, { mode: 'element' });
    input.addEventListener('input', () => (s.selector = input.value));
    root.append(field('Checkbox / radio selector', wrap));
    const st = select(s.state, [
      { value: 'check', label: 'Check' },
      { value: 'uncheck', label: 'Uncheck' },
      { value: 'toggle', label: 'Toggle' }
    ]);
    st.addEventListener('change', () => (s.state = st.value));
    root.append(field('Action', st));
  }

  if (s.type === 'hover') {
    const { wrap, input } = selectorInput(s.selector, { mode: 'element' });
    input.addEventListener('input', () => (s.selector = input.value));
    root.append(field('Element selector', wrap, 'Fires the pointer/mouse-enter chain to reveal menus & tooltips.'));
  }

  if (s.type === 'key') {
    const k = select(s.key, [
      'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', ' ',
      'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight',
      'PageDown', 'PageUp', 'Home', 'End'
    ].map((v) => ({ value: v, label: v === ' ' ? 'Space' : v })));
    k.addEventListener('change', () => (s.key = k.value));
    root.append(field('Key', k));

    const mods = el('div', { style: 'display:flex;gap:14px' });
    mods.append(
      inlineCheck('Ctrl', s.ctrl, (v) => (s.ctrl = v)),
      inlineCheck('Shift', s.shift, (v) => (s.shift = v)),
      inlineCheck('Alt', s.alt, (v) => (s.alt = v))
    );
    root.append(field('Modifiers', mods));

    const { wrap, input } = selectorInput(s.selector, { mode: 'element' });
    input.addEventListener('input', () => (s.selector = input.value));
    root.append(field('Focus target (optional)', wrap,
      'If set, this element is focused before the key is sent. Sent as a real browser key event.'));
  }

  if (s.type === 'scroll') {
    const m = select(s.mode, [
      { value: 'bottom', label: 'To bottom' },
      { value: 'top', label: 'To top' },
      { value: 'by', label: 'By pixels' }
    ]);
    const px = el('input', { type: 'number', value: s.px, min: 0 });
    const pxField = field('Pixels', px);
    m.addEventListener('change', () => {
      s.mode = m.value;
      pxField.style.display = s.mode === 'by' ? '' : 'none';
    });
    px.addEventListener('input', () => (s.px = +px.value));
    root.append(field('Scroll', m));
    root.append(pxField);
    pxField.style.display = s.mode === 'by' ? '' : 'none';
  }

  if (s.type === 'loadAll') {
    root.append(el('div', { className: 'hint', textContent:
      'Keeps scrolling to the bottom (and clicking “load more”, if set) until the page ' +
      'stops growing — so lazy-loaded / infinite-scroll lists are fully loaded before you scrape.' }));
    const { wrap, input } = selectorInput(s.moreSelector, { mode: 'element' });
    input.addEventListener('input', () => (s.moreSelector = input.value));
    root.append(field('“Load more” button (optional)', wrap, 'Leave blank for pure infinite-scroll.'));
    const w = el('input', { type: 'number', value: s.waitMs, min: 100 });
    w.addEventListener('input', () => (s.waitMs = +w.value));
    root.append(field('Wait after each scroll (ms)', w, 'Give the page time to load more items.'));
    const mr = el('input', { type: 'number', value: s.maxRounds, min: 1 });
    mr.addEventListener('input', () => (s.maxRounds = +mr.value));
    root.append(field('Max scrolls (safety)', mr));
  }

  if (s.type === 'get') {
    // ORDER MATTERS: you point at the thing FIRST, then name it. Asking for a
    // name before the user has pointed at anything is backwards — and the name
    // can usually be guessed from what they picked.
    const src = select(s.source, [
      { value: 'text', label: 'Its text' },
      { value: 'href', label: 'Its link (href)' },
      { value: 'src', label: 'Its image (src)' },
      { value: 'value', label: 'What’s typed in it (a form field)' },
      { value: 'attr', label: 'One of its attributes…' },
      { value: 'html', label: 'Its inner HTML' },
      { value: 'checked', label: 'Whether it’s ticked (yes/no)' },
      { value: 'count', label: 'How MANY of them there are (a number)' },
      { value: 'exists', label: 'Whether it exists at all (yes/no)' },
      { value: 'url', label: '— the page’s address (no element needed)' },
      { value: 'expr', label: '— a calculation from values you already have' }
    ]);
    src.className = 'src-select';

    const name = el('input', { className: 'name-input', value: s.name, placeholder: 'e.g. price' });
    name.addEventListener('input', () => (s.name = name.value));

    const { wrap, input, check } = selectorInput(s.selector, {
      mode: 'element',
      onFilled: (sel) => {
        // Picking implies you want something off that element.
        if (s.source === 'expr' || s.source === 'url') {
          s.source = 'text';
          src.value = 'text';
          sync();
        }
        // Suggest a name from what was picked, so the common case needs no typing.
        if (!(s.name || '').trim()) {
          const guess = suggestName(sel);
          if (guess) {
            s.name = guess;
            name.value = guess;
          }
        }
      }
    });
    input.addEventListener('input', () => (s.selector = input.value));
    const selField = field('① Which element?', wrap);

    root.append(selField);
    root.append(field('② What do you want from it?', src));

    const attr = el('input', { value: s.attr, placeholder: 'attribute name, e.g. data-id' });
    attr.addEventListener('input', () => (s.attr = attr.value));
    const attrField = field('Which attribute?', attr);
    root.append(attrField);

    const expr = el('input', { value: s.expr, placeholder: 'e.g. was - price' });
    expr.addEventListener('input', () => (s.expr = expr.value));
    const exprField = field('The calculation', expr,
      'Maths and text on values you already have: was - price, price * 1.2, title + " (sale)".');
    root.append(exprField);

    // Clean-ups sit right where you'd look after seeing the raw value.
    const cleanWrap = el('div');
    appendTransformList(s, cleanWrap, () =>
      previewRaw(s.selector, s.source === 'expr' || s.source === 'url' ? 'text' : s.source, s.attr)
    );
    root.append(cleanWrap);

    root.append(field('③ Call it', name,
      'This name is the CSV column heading — and how you refer to it in a rule (“price is less than 200”).'));

    const tgt = select(s.target || 'column', [
      { value: 'column', label: 'Yes — put it in the results table & CSV' },
      { value: 'var', label: 'No — I only need it for a rule (If / While)' }
    ]);
    tgt.className = 'target-select';
    tgt.addEventListener('change', () => (s.target = tgt.value));
    root.append(field('④ Keep it in the results?', tgt));

    const sync = () => {
      const needsSelector = !(s.source === 'expr' || s.source === 'url');
      const readsText = !['expr', 'count', 'exists', 'checked'].includes(s.source);
      exprField.style.display = s.source === 'expr' ? '' : 'none';
      selField.style.display = needsSelector ? '' : 'none';
      attrField.style.display = s.source === 'attr' ? '' : 'none';
      cleanWrap.style.display = readsText ? '' : 'none';
      if (needsSelector) check();
    };
    src.addEventListener('change', () => {
      s.source = src.value;
      sync();
    });
    sync();
  }

  if (s.type === 'skip') {
    root.append(el('div', { className: 'hint', textContent:
      'Abandons the current item: nothing is saved for it and the loop moves straight on to the ' +
      'next one. Put it inside an If to keep only the items you want — e.g. ' +
      '“If price ≥ 200 → Skip item”.' }));
  }

  if (s.type === 'scrapeList') {
    const { wrap, input, check } = selectorInput(s.rowSelector, { mode: 'list', countLabel: 'row' });
    input.addEventListener('input', () => (s.rowSelector = input.value));
    root.append(
      field('① Pick one row', wrap,
        'Click ONE of the repeating items — a whole product card, or a table row. ' +
        'Scrape Studio finds all the others like it. Each one becomes a CSV row.')
    );

    root.append(el('label', { className: 'field-label', textContent: '② What do you want from each row?' }));
    root.append(el('div', { className: 'hint', textContent:
      'Add a column, then Pick that value INSIDE the row you chose (the name, the price…). ' +
      'Values on the same row always stay together.' }));
    const listWrap = el('div', { className: 'field-list' });
    root.append(listWrap);
    renderFieldRows(s, listWrap);

    const add = el('button', { textContent: '+ Add column' });
    add.addEventListener('click', () => {
      s.fields.push({ name: '', selector: '', extract: 'text', attr: '' });
      renderFieldRows(s, listWrap);
    });

    // THE confidence-builder: see the actual rows before you run anything.
    const prev = el('button', { className: 'tf-test', textContent: '👁 Preview the rows' });
    const out = el('div', { className: 'preview-box hidden' });
    prev.addEventListener('click', () => previewList(s, out));
    root.append(el('div', { className: 'tf-bar' }, [add, prev]), out);
    if (s.rowSelector) setTimeout(() => previewList(s, out), 60);
    check();
  }

  if (s.type === 'goto') {
    const url = el('input', { value: s.url, placeholder: 'https://…  (supports {{variables}})' });
    url.addEventListener('input', () => (s.url = url.value));
    root.append(field('URL', url, 'Navigate here. You can interpolate variables, e.g. …/page/{{i}}.'));
  }

  if (s.type === 'if' || s.type === 'while') {
    s.condition = normalizeCond(s.condition);
    if (editingScope) {
      root.append(el('div', { className: 'scope-banner' }, [
        el('div', { className: 'scope-title', textContent: `🔄 Inside “For each ${editingScope}”` }),
        el('div', { className: 'scope-text', textContent:
          'Variables you Set inside the loop hold THIS item’s values, so a rule like ' +
          '“price is greater than 20” tests the current item — and the block runs only for the items that match.' })
      ]));
    }
    buildConditionUI(s.condition, root);
    if (s.type === 'while') {
      const mi = el('input', { type: 'number', value: s.maxIter, min: 1 });
      mi.addEventListener('input', () => (s.maxIter = +mi.value));
      root.append(field('Safety max iterations', mi, 'Hard cap to prevent an infinite loop.'));
    }
    root.append(el('div', { className: 'hint', textContent:
      'Add the steps to run inside the block from the step list (the “+ add step” under it).' }));
  }

  if (s.type === 'repeat') {
    const count = el('input', { value: s.count, placeholder: 'e.g. 10   or   total' });
    count.addEventListener('input', () => (s.count = count.value));
    root.append(field('Repeat count', count, 'A number or an expression (e.g. a variable).'));
    const iv = el('input', { value: s.indexVar, placeholder: 'e.g. i (optional)' });
    iv.addEventListener('input', () => (s.indexVar = iv.value));
    root.append(field('Index variable', iv, 'If set, holds the current iteration (0-based) inside the loop.'));
  }

  if (s.type === 'forEach') {
    const { wrap, input } = selectorInput(s.selector, { mode: 'list', countLabel: 'item' });
    input.addEventListener('input', () => (s.selector = input.value));
    root.append(field('Pick one item', wrap,
      'Click ONE of the repeating items — a product card, a table row. The steps you put inside ' +
      'run once for EVERY one of them, and each pass makes a row.'));
    root.append(el('div', { className: 'hint', textContent:
      'Inside this block, Pick gives you selectors relative to the current item — so “.price” means ' +
      'THIS card’s price. That’s what lets you compare two values in the same card and filter on it.' }));
    const iv = el('input', { value: s.indexVar, placeholder: 'e.g. i (optional)' });
    iv.addEventListener('input', () => (s.indexVar = iv.value));
    root.append(field('Counter name (optional)', iv, 'Holds the item number inside the loop (starts at 0).'));
    const mi = el('input', { type: 'number', value: s.maxIter, min: 1 });
    mi.addEventListener('input', () => (s.maxIter = +mi.value));
    root.append(field('Stop after (safety)', mi, 'A hard cap, so a huge page can’t run forever.'));
    root.append(el('div', { className: 'hint', textContent:
      'Add the per-item steps below via “+ add step”. If a step navigates to a detail page, ' +
      'selectors there are used as-is; add a “Go back” step to return and continue.' }));
  }

  if (s.type === 'break') {
    root.append(el('div', { className: 'hint', textContent:
      'Immediately exits the nearest enclosing While/Repeat loop.' }));
  }
}

// Visual condition builder — pick a value, pick an operator, type what to compare
// against. Nothing to type from memory: the left-hand side is a DROPDOWN of the
// values you've actually grabbed, because a rule pointing at a name that doesn't
// exist is silently false forever — the worst failure mode in the whole app.
function buildConditionUI(cond, root) {
  const vars = Array.from(collectVarNames(steps));

  if (!vars.length) {
    root.append(el('div', { className: 'warn-box', textContent:
      'You haven’t grabbed any values yet, so there’s nothing to test. Add a ' +
      '“📥 Grab one value” step above this one first (e.g. price), then come back.' }));
  }

  const listWrap = el('div', { className: 'cond-list' });
  const match = select(cond.match, [
    { value: 'all', label: 'ALL of these are true (AND)' },
    { value: 'any', label: 'ANY of these are true (OR)' }
  ]);
  match.addEventListener('change', () => (cond.match = match.value));
  const matchField = field('Run when', match);

  const rerender = () => {
    renderCondRules(cond, listWrap, vars, rerender);
    // ALL/ANY only matters once there's more than one rule — hide the noise.
    matchField.style.display = cond.rules.length > 1 ? '' : 'none';
  };
  root.append(matchField, listWrap);

  const add = el('button', { textContent: '+ Add rule' });
  add.addEventListener('click', () => {
    cond.rules.push(newRule());
    rerender();
  });
  root.append(el('div', { style: 'margin-top:6px' }, [add]));
  rerender();
}

function renderCondRules(cond, wrap, vars, rerender) {
  wrap.innerHTML = '';
  cond.rules.forEach((r, i) => {
    // Known values + whatever this rule already names (so a saved rule survives).
    const opts = Array.from(new Set([...vars, ...(r.left ? [r.left] : [])]));
    let left;
    if (opts.length) {
      left = select(r.left || '', [{ value: '', label: '— choose a value —' }]
        .concat(opts.map((v) => ({ value: v, label: v }))));
      left.addEventListener('change', () => (r.left = left.value));
    } else {
      left = el('input', { value: r.left, placeholder: 'grab a value first' });
      left.addEventListener('input', () => (r.left = left.value));
    }

    const op = select(r.op, COND_OPS.map((o) => ({ value: o.v, label: o.label })));
    const right = el('input', { value: r.right, placeholder: 'e.g. 200' });
    right.addEventListener('input', () => (r.right = right.value));
    const syncRight = () => (right.style.display = isBinaryOp(r.op) ? '' : 'none');
    op.addEventListener('change', () => {
      r.op = op.value;
      syncRight();
    });

    const del = el('button', { className: 'del', textContent: '✕', title: 'Remove rule' });
    del.addEventListener('click', () => {
      cond.rules.splice(i, 1);
      if (!cond.rules.length) cond.rules.push(newRule());
      rerender();
    });

    const row = el('div', { className: 'cond-rule' }, [left, op, right, del]);
    wrap.append(row);
    syncRight();
  });
  wrap.append(el('div', { className: 'hint', textContent:
    'Compare with a number (200), some text (Pro), or the name of another value you grabbed (was).' }));
}

// ---------------------------------------------------------------------------
// Clean up the text (the visual extraction pipeline)
// ---------------------------------------------------------------------------

// Old jobs stored a single "Convert to number" checkbox; it becomes the first
// clean-up in the list. New steps just carry `transforms`.
function stepTransforms(o) {
  if (Array.isArray(o.transforms)) return o.transforms;
  return o.clean ? [{ op: 'number' }] : [];
}

// Apply a step's clean-ups to a raw scraped value.
function cleanValue(o, raw) {
  return TF.apply(raw, stepTransforms(o));
}

// The clean-up list editor: [what to do ▾][arg][arg][✕] rows + "Test on the page".
// `getRaw` (optional) reads the value live from the page so the user can SEE
// what their clean-ups do — the difference between guessing and knowing.
function appendTransformList(o, root, getRaw) {
  o.transforms = stepTransforms(o);
  delete o.clean; // migrated into the list

  root.append(el('label', { className: 'field-label', textContent: 'Clean up the text' }));
  root.append(el('div', { className: 'hint', textContent:
    'Optional — turn messy page text into the value you want. They run top to bottom.' }));

  const listWrap = el('div', { className: 'field-list' });
  const out = el('div', { className: 'tf-preview hidden' });

  const renderRows = () => {
    listWrap.innerHTML = '';
    o.transforms.forEach((t, i) => {
      const opSel = select(t.op, TF.TRANSFORM_OPS.map((x) => ({ value: x.v, label: x.label })));
      const meta = () => TF.TRANSFORM_OPS.find((x) => x.v === t.op) || { args: [] };

      const args = ['a', 'b'].map((key) => {
        const inp = el('input', { value: t[key] == null ? '' : t[key] });
        inp.addEventListener('input', () => (t[key] = inp.value));
        return inp;
      });
      const syncArgs = () => {
        const spec = meta().args;
        args.forEach((inp, k) => {
          const a = spec[k];
          inp.style.visibility = a ? 'visible' : 'hidden';
          if (a) {
            inp.placeholder = a.placeholder || '';
            inp.type = a.type === 'number' ? 'number' : 'text';
          }
        });
      };
      opSel.addEventListener('change', () => {
        t.op = opSel.value;
        syncArgs();
      });

      const up = el('button', { className: 'del', textContent: '↑', title: 'Move up' });
      up.addEventListener('click', () => {
        if (i === 0) return;
        o.transforms.splice(i - 1, 0, o.transforms.splice(i, 1)[0]);
        renderRows();
      });
      const del = el('button', { className: 'del', textContent: '✕', title: 'Remove' });
      del.addEventListener('click', () => {
        o.transforms.splice(i, 1);
        renderRows();
      });

      listWrap.append(el('div', { className: 'tf-row' }, [opSel, args[0], args[1], up, del]));
      syncArgs();
    });
  };
  root.append(listWrap);

  const add = el('button', { textContent: '+ Add clean-up' });
  add.addEventListener('click', () => {
    o.transforms.push({ op: 'trim', a: '', b: '' });
    renderRows();
  });

  const bar = el('div', { className: 'tf-bar' }, [add]);
  if (getRaw) {
    const test = el('button', { className: 'tf-test', textContent: '▶ Test on the page' });
    test.addEventListener('click', async () => {
      out.classList.remove('hidden');
      out.textContent = 'reading the page…';
      let raw;
      try {
        raw = await getRaw();
      } catch (e) {
        raw = null;
      }
      if (raw == null) {
        out.className = 'tf-preview bad';
        out.textContent = '⚠ Nothing on this page matches that selector. Load the right page, then Test again.';
        return;
      }
      const val = cleanValue(o, raw);
      out.className = 'tf-preview';
      out.innerHTML = '';
      out.append(
        el('div', { className: 'tf-raw', textContent: `on the page:  ${JSON.stringify(raw)}` }),
        el('div', { className: 'tf-val', textContent: `you get:  ${JSON.stringify(val)}` +
          (typeof val === 'number' ? '   (a number — you can compare it with < >)' : '') })
      );
    });
    bar.append(test);
  }
  root.append(bar, out);
  renderRows();
}

// Read one value from the live page exactly as the run engine would, so the
// "Test" preview can't disagree with the actual run. Inside a For each, preview
// against the FIRST matching item.
async function previewRaw(sel, mode, attr) {
  if (!sel && !editingScope) return null;
  const useScope = editingScope && !(editing && editing.abs);
  const full = useScope ? (sel ? editingScope + ' ' + sel : editingScope) : sel;
  if (!full) return null;
  const found = await pageEval(PA.existsExpr(full));
  if (!found) return null;
  return pageEval(PA.extractExpr(full, mode, attr));
}

function appendExtractControls(s, root) {
  const ex = select(s.extract, EXTRACT_OPTS);
  const attr = el('input', { value: s.attr, placeholder: 'attribute name, e.g. data-id' });
  const attrField = field('Attribute name', attr);
  ex.addEventListener('change', () => {
    s.extract = ex.value;
    attrField.style.display = s.extract === 'attr' ? '' : 'none';
  });
  attr.addEventListener('input', () => (s.attr = attr.value));
  root.append(field('Extract', ex));
  root.append(attrField);
  attrField.style.display = s.extract === 'attr' ? '' : 'none';
}

// Which scrape-list columns have their clean-up panel open (editor-local, not
// saved with the job).
let openTfCols = new Set();

// Per-column rows inside the scrapeList editor.
function renderFieldRows(s, wrap) {
  wrap.innerHTML = '';
  s.fields.forEach((f, i) => {
    const isExpr = f.extract === 'expr';
    const name = el('input', { value: f.name, placeholder: 'column name' });
    name.addEventListener('input', () => (f.name = name.value));

    // Middle control: a relative selector (+Pick) for element columns, or a
    // plain expression input for a "Value / expression" column (e.g. a variable).
    let middle;
    if (isExpr) {
      middle = el('input', { value: f.selector, placeholder: 'expression, e.g. d  or  pad(i+1,2)' });
      middle.addEventListener('input', () => (f.selector = middle.value));
    } else {
      middle = el('span', { className: 'input-with-pick' });
      const sel = el('input', { className: 'sel-input', value: f.selector, placeholder: 'press Pick, then click it in a row' });
      sel.addEventListener('input', () => (f.selector = sel.value));
      const pick = el('button', { className: 'mini-pick pick-btn', textContent: '⊕ Pick' });
      pick.addEventListener('click', () => {
        if (!s.rowSelector) return log('Pick the row (①) first — columns are relative to it.', 'warn');
        startPick('element', {
          type: 'input',
          input: sel,
          relativeTo: s.rowSelector,
          onFilled: (picked) => {
            if (!(f.name || '').trim()) {
              const guess = suggestName(picked);
              if (guess) {
                f.name = guess;
                name.value = guess;
              }
            }
          }
        });
      });
      middle.append(sel, pick);
    }

    const ex = select(f.extract, EXTRACT_OPTS);
    ex.addEventListener('change', () => {
      f.extract = ex.value;
      renderFieldRows(s, wrap); // toggle selector ↔ expression input
    });

    const del = el('button', { className: 'del', textContent: '✕', title: 'Remove' });
    del.addEventListener('click', () => {
      s.fields.splice(i, 1);
      openTfCols.delete(i);
      if (!s.fields.length) s.fields.push({ name: '', selector: '', extract: 'text', attr: '' });
      renderFieldRows(s, wrap);
    });

    // Per-column clean-ups ("£1,299" → 1299) live in a panel under the row, so
    // the column list stays compact until you need them.
    const nTf = stepTransforms(f).length;
    const tfBtn = el('button', {
      className: 'del tf-toggle' + (nTf ? ' on' : ''),
      textContent: nTf ? `🧹${nTf}` : '🧹',
      title: 'Clean up this column’s text'
    });
    tfBtn.addEventListener('click', () => {
      if (openTfCols.has(i)) openTfCols.delete(i);
      else openTfCols.add(i);
      renderFieldRows(s, wrap);
    });

    wrap.append(el('div', { className: 'field-row' }, [name, middle, ex, tfBtn, del]));

    if (openTfCols.has(i) && !isExpr) {
      const panel = el('div', { className: 'tf-panel' });
      appendTransformList(f, panel, () =>
        // Preview against the FIRST row on the page, exactly as the run reads it.
        previewRaw(
          s.rowSelector ? (f.selector ? s.rowSelector + ' ' + f.selector : s.rowSelector) : f.selector,
          f.extract,
          f.attr
        )
      );
      wrap.append(panel);
    }
  });
}

$('#modal-save').addEventListener('click', () => {
  if (!editing) return;
  const list = editingList || steps;
  if (editingIsNew) {
    list.push(editing);
  } else {
    const idx = list.findIndex((s) => s.id === editing.id);
    if (idx >= 0) list[idx] = editing;
    else list.push(editing);
  }
  renderSteps();
  markDirty();
  closeModal();
});

// ===========================================================================
// Run engine
// ===========================================================================

$('#run').addEventListener('click', runSteps);
$('#stop').addEventListener('click', () => {
  abortRun = true;
  log('Stopping…', 'warn');
});

function setRunning(on) {
  running = on;
  $('#run').disabled = on;
  $('#stop').disabled = !on;
  $('#record').disabled = on;
}

async function runSteps() {
  if (running) return;
  if (!steps.length) return log('Add some steps first.', 'warn');

  setRunning(true);
  abortRun = false;
  log('▶ Run started', 'info');

  // Runtime context.
  //  vars     — working values (not in the CSV)
  //  pageRow  — the row being built right now (its names are readable too)
  //  rowBase  — what the row looked like when the current loop pass began, so a
  //             committed row doesn't wipe values inherited from an outer loop
  //  committed — rows added so far (lets a loop tell if a nested loop emitted)
  const ctx = { vars: {}, pageRow: {}, rowBase: {}, listRows: [], committed: 0 };

  try {
    // Always begin the job at its start URL so runs are reproducible.
    if (startUrl) {
      log(`Opening start URL: ${startUrl}`, 'info');
      await navigateAndWait(startUrl);
      await sleep(300);
    }

    try {
      await execList(steps, ctx);
    } catch (e) {
      if (!e || (!e.__break && !e.__skip)) throw e; // a stray Break/Skip outside a loop
      log('  (Skip / Break outside a loop — ignored)', 'warn');
      ctx.pageRow = {};
    }

    // Whatever is still in the row buffer (a job with no loop just collects
    // values top-to-bottom) becomes the final row. Values collected outside a
    // list are repeated onto every list row.
    const leftovers = Object.keys(ctx.pageRow).length > 0;
    if (ctx.listRows.length) {
      for (const r of ctx.listRows) addRow(leftovers ? { ...ctx.pageRow, ...r } : r);
    } else if (leftovers) {
      addRow(ctx.pageRow);
    }

    log(`✓ Run finished — ${results.length} row(s) total`, results.length ? 'ok' : 'warn');
    if (!results.length) explainNoRows(ctx);
    else warnPartialRows();
  } finally {
    clearStepMarks();
    setRunning(false);
  }
}

// A run that produces nothing should say WHY, not just "0 rows". The usual
// causes, in the order they actually happen.
function explainNoRows(ctx) {
  const all = flattenSteps(steps);
  const has = (t) => all.some((s) => s.type === t);

  if (ctx.ifSeen && !ctx.ifTrue) {
    log(`  ↳ Your If was false every time (${ctx.ifSeen}×), so its Then block never ran.`, 'warn');
    log('     Check the operator and the values printed above — e.g. "priceVar (7.99) ≥ 200" is false.', 'warn');
    return;
  }
  if (ctx.skipped) {
    log(`  ↳ Every item hit a “Skip item” (${ctx.skipped}×), so none of them produced a row.`, 'warn');
    return;
  }
  const columns = all.filter((s) => s.type === 'get' && s.target === 'column');
  if (!columns.length && !has('scrapeList')) {
    log('  ↳ Nothing is kept as a column. Add a “Get value” step and keep it as a column ' +
      '(or use “Scrape list”).', 'warn');
    return;
  }
  if (columns.length) {
    log('  ↳ Your Get-value steps found nothing on the page. Open one and press ' +
      '“▶ Test on the page” to check its selector.', 'warn');
    return;
  }
  log('  ↳ Nothing was collected. Check the selectors and any If conditions.', 'warn');
}

// Rows that are missing columns other rows have usually mean the user filtered
// with an If instead of a Skip: the values read BEFORE the If still commit a
// (half-empty) row for the items that didn't match.
function warnPartialRows() {
  const all = new Set();
  for (const r of results) for (const k of Object.keys(r)) all.add(k);
  const partial = results.filter((r) => Object.keys(r).length < all.size);
  if (!partial.length || all.size < 2) return;
  const missing = [...all].filter((k) => partial.some((r) => !(k in r)));
  log(`  ⚠ ${partial.length} row(s) are missing: ${missing.join(', ')}`, 'warn');
  log('     If you only want the items that match your If, put a “⏭ Skip item” in it ' +
    '(e.g. If price ≥ 200 → Skip item) instead of collecting inside Then.', 'warn');
}

// Every step, including the ones nested in blocks.
function flattenSteps(list, out) {
  out = out || [];
  for (const s of list) {
    out.push(s);
    if (isBlock(s)) for (const k of BLOCK_TYPES[s.type]) flattenSteps(s[k] || [], out);
  }
  return out;
}

function markStep(id, cls) {
  const li = document.querySelector(`.step[data-id="${id}"]`);
  if (!li) return;
  li.classList.remove('running', 'done', 'error');
  li.classList.add(cls);
}
function clearStepMarks() {
  document.querySelectorAll('.step').forEach((n) =>
    n.classList.remove('running', 'done', 'error')
  );
}

// --- Recursive execution with variables + control flow ---------------------

const BREAK = { __break: true }; // exit the loop entirely
const SKIP = { __skip: true }; // abandon this item, go to the next one

// Execute a list of steps in order. break/skip bubble up (thrown) to their loop.
async function execList(list, ctx) {
  for (const s of list) {
    if (abortRun) return;
    markStep(s.id, 'running');
    try {
      await execStep(s, ctx);
      markStep(s.id, 'done');
    } catch (err) {
      if (err && (err.__break || err.__skip)) {
        markStep(s.id, 'done');
        throw err; // propagate to the enclosing loop
      }
      markStep(s.id, 'error');
      log(`Step (${s.type}) failed: ${err.message}`, 'err');
    }
  }
}

// ---------------------------------------------------------------------------
// Rows: ONE namespace, and rows that commit themselves
// ---------------------------------------------------------------------------

// Every name you've collected — whether you kept it as a column or as a working
// value — readable by that one name. The row wins over an older working value.
function names(ctx) {
  return Object.assign({}, ctx.vars, ctx.pageRow);
}

const sameRow = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Commit the row being built, then start the next one from whatever the
// enclosing loop had already collected (so a parent's columns aren't lost).
function commitRow(ctx) {
  addRow({ ...ctx.pageRow });
  ctx.committed++;
  ctx.pageRow = { ...ctx.rowBase };
}

// Run one pass of a loop body. This is where a row is born: if the pass
// collected anything new and didn't skip, it becomes a row — no "Add row" step.
// If a NESTED loop already emitted rows this pass, we don't emit a duplicate
// half-row for the parent.
async function runLoopPass(body, ctx) {
  const outerBase = ctx.rowBase;
  const base = { ...ctx.pageRow }; // what this item inherited from outside
  ctx.rowBase = base;
  const before = ctx.committed;
  try {
    await execList(body, ctx);
  } catch (e) {
    ctx.rowBase = outerBase;
    ctx.pageRow = { ...base };
    if (e && e.__skip) {
      ctx.skipped = (ctx.skipped || 0) + 1;
      return; // no row for this item
    }
    throw e; // break / real error
  }
  if (ctx.committed === before && !sameRow(ctx.pageRow, base)) {
    commitRow(ctx);
  } else {
    ctx.pageRow = { ...base };
  }
  ctx.rowBase = outerBase;
}

// Interpolate {{vars}} and, inside a "For each", scope the selector to the
// current container, so ".price" reads THIS item's price.
//
// Not scoped when: the step is flagged "somewhere else on the page" (abs), or
// the container is no longer on the page (we navigated into a detail page — the
// selector is then used as-is, and Go back returns us to the list).
async function resolveSel(rawSel, ctx, abs) {
  const sel = EXPR.interpolate(rawSel || '', names(ctx));
  if (ctx.scope && !abs) {
    const alive = await pageEval(PA.existsExpr(ctx.scope));
    if (alive) return sel ? ctx.scope + ' ' + sel : ctx.scope;
  }
  return sel;
}

async function execStep(s, ctx) {
  // {{name}} interpolation — columns and working values share one namespace.
  const ip = (str) => EXPR.interpolate(str, names(ctx));

  switch (s.type) {
    case 'wait':
      await sleep(s.ms);
      return;

    case 'waitFor':
      await waitForSelector(await resolveSel(s.selector, ctx, s.abs), s.timeout, s.waitMode === 'disappear');
      return;

    case 'click': {
      const r = await pageEval(PA.clickExpr(await resolveSel(s.selector, ctx, s.abs)));
      if (!r || !r.ok) throw new Error(r ? r.err : `not found: ${s.selector}`);
      await waitForLoad();
      return;
    }

    case 'clickText': {
      const r = await pageEval(PA.clickTextExpr({ ...s, text: ip(s.text), container: await resolveSel(s.container, ctx, s.abs) }));
      if (!r || !r.ok) throw new Error(r ? r.err : 'no text match');
      await waitForLoad();
      return;
    }

    case 'select': {
      const r = await pageEval(PA.selectExpr(await resolveSel(s.selector, ctx, s.abs), s.by, ip(s.value), s.multi));
      if (!r || !r.ok) throw new Error(r ? r.err : `select failed: ${s.selector}`);
      log(`  selected "${r.chosen}"`, 'ok');
      await waitForLoad();
      return;
    }

    case 'check': {
      const r = await pageEval(PA.checkExpr(await resolveSel(s.selector, ctx, s.abs), s.state));
      if (!r || !r.ok) throw new Error(r ? r.err : `not found: ${s.selector}`);
      return;
    }

    case 'hover': {
      const r = await pageEval(PA.hoverExpr(await resolveSel(s.selector, ctx, s.abs)));
      if (!r || !r.ok) throw new Error(r ? r.err : `not found: ${s.selector}`);
      return;
    }

    case 'type': {
      const r = await pageEval(PA.fillExpr(await resolveSel(s.selector, ctx, s.abs), ip(s.text), s.clear));
      if (!r || !r.ok) throw new Error(r ? r.err : `input not found: ${s.selector}`);
      if (s.pressEnter) {
        await sendKey('Enter', {});
        await waitForLoad();
      }
      return;
    }

    case 'key': {
      if (s.selector) {
        const sel = await resolveSel(s.selector, ctx, s.abs);
        await pageEval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.focus(); return !!el; })()`);
      }
      await sendKey(s.key, { ctrl: s.ctrl, shift: s.shift, alt: s.alt });
      await waitForLoad();
      return;
    }

    case 'scroll':
      await pageEval(PA.scrollExpr(s.mode, s.px));
      return;

    case 'loadAll': {
      // Scroll to the bottom (and click a "load more" button if given) until the
      // page height stops growing — loads lazy / infinite-scroll lists fully.
      const wait = s.waitMs || 900;
      const max = s.maxRounds || 40;
      const more = s.moreSelector ? await resolveSel(s.moreSelector, ctx, s.abs) : '';
      let last = -1;
      let stable = 0;
      let rounds = 0;
      for (let i = 0; i < max && !abortRun; i++) {
        await pageEval('window.scrollTo(0, document.body.scrollHeight)');
        if (more) await pageEval(PA.clickExpr(more)); // click "load more" if present
        await sleep(wait);
        const h = await pageEval('document.body.scrollHeight');
        rounds++;
        if (h === last) {
          if (++stable >= 2) break; // height unchanged twice → done
        } else {
          stable = 0;
        }
        last = h;
      }
      log(`  loaded content (${rounds} scroll${rounds === 1 ? '' : 's'})`, 'ok');
      return;
    }

    case 'goto':
      await navigateAndWait(ip(s.url));
      await sleep(200);
      return;

    case 'back':
      if (view) {
        try {
          view.goBack();
        } catch (_) {}
      }
      await waitForLoad();
      await sleep(200);
      return;

    case 'get':
    case 'scrape': // legacy (migrated on load; handled here too for safety)
    case 'setVar':
      await execGet(migrateStep(s), ctx);
      return;

    case 'scrapeList': {
      // Element columns are read from the page; "expression" columns (e.g. a
      // loop variable like the current date) are computed here, once per pass,
      // and attached to every row — so each iteration's rows are tagged.
      const elementFields = s.fields.filter((f) => f.extract !== 'expr');
      const raw = await pageEval(PA.listExpr(await resolveSel(s.rowSelector, ctx, s.abs), elementFields));
      const exprVals = {};
      for (const f of s.fields) {
        if (f.extract === 'expr') {
          let v;
          try {
            v = EXPR.evaluate(f.selector, names(ctx));
          } catch (_) {
            v = ip(f.selector);
          }
          exprVals[f.name] = v == null ? '' : v;
        }
      }
      // Rebuild each row honouring the user's column order, running each
      // column's clean-ups on its raw page text.
      const rows = raw.map((r) => {
        const o = {};
        for (const f of s.fields) {
          o[f.name] = f.extract === 'expr' ? exprVals[f.name] : cleanValue(f, r[f.name]);
        }
        return o;
      });
      log(`  scraped ${rows.length} row(s) from list`, rows.length ? 'ok' : 'warn');
      ctx.listRows.push(...rows);
      return;
    }

    // Legacy step from old jobs. Rows now commit themselves at the end of each
    // loop pass, so this just commits early — kept so saved jobs behave the same.
    case 'emitRow': {
      if (!sameRow(ctx.pageRow, ctx.rowBase)) commitRow(ctx);
      return;
    }

    case 'skip':
      throw SKIP;

    case 'if': {
      const truthy = EXPR.truthy(EXPR.evaluate(condExpr(s.condition, ctx), names(ctx)));
      const branch = truthy ? 'Then' : (s.else || []).length ? 'Else' : 'skipped';
      // Say what it decided AND with which values — an If that silently skips
      // everything is the single most confusing thing in a run.
      log(`  if (${condSummaryWith(s.condition, names(ctx))}) → ${truthy ? 'yes' : 'no'} · ${branch}`,
        truthy ? 'ok' : 'info');
      ctx.ifSeen = (ctx.ifSeen || 0) + 1;
      if (truthy) ctx.ifTrue = (ctx.ifTrue || 0) + 1;
      await execList(truthy ? s.then : s.else || [], ctx);
      return;
    }

    case 'while': {
      const cap = s.maxIter || 1000;
      let n = 0;
      while (!abortRun && EXPR.truthy(EXPR.evaluate(condExpr(s.condition, ctx), names(ctx)))) {
        if (n++ >= cap) {
          log(`while: reached the safety cap (${cap} iterations)`, 'warn');
          break;
        }
        try {
          await runLoopPass(s.body, ctx);
        } catch (e) {
          if (e && e.__break) break;
          throw e;
        }
      }
      return;
    }

    case 'repeat': {
      const count = Math.floor(Number(EXPR.evaluate(s.count, names(ctx))) || 0);
      for (let i = 0; i < count && !abortRun; i++) {
        if (s.indexVar) ctx.vars[s.indexVar] = i;
        try {
          await runLoopPass(s.body, ctx);
        } catch (e) {
          if (e && e.__break) break;
          throw e;
        }
      }
      return;
    }

    case 'forEach': {
      const baseSel = await resolveSel(s.selector, ctx, s.abs);
      if (!baseSel) {
        log('  for each: no selector', 'warn');
        return;
      }
      const count = await pageEval(`document.querySelectorAll(${JSON.stringify(baseSel)}).length`);
      const cap = s.maxIter || 1000;
      log(`  for each ${baseSel}: ${count} match(es)`, count ? 'info' : 'warn');

      // Unique marker per nesting depth so nested For-each loops don't collide.
      const depth = (ctx.scopeDepth || 0) + 1;
      const attr = 'data-ss-scope-' + depth;
      const marker = '[' + attr + ']';
      const prevScope = ctx.scope;
      const prevDepth = ctx.scopeDepth;

      for (let i = 0; i < count && i < cap && !abortRun; i++) {
        if (s.indexVar) ctx.vars[s.indexVar] = i;
        // (Re)tag the i-th match each pass — robust across navigations/go-back.
        const tagged = await pageEval(`(() => {
          document.querySelectorAll(${JSON.stringify(marker)}).forEach(e => e.removeAttribute(${JSON.stringify(attr)}));
          const els = document.querySelectorAll(${JSON.stringify(baseSel)});
          const el = els[${i}];
          if (el) { el.setAttribute(${JSON.stringify(attr)}, ''); el.scrollIntoView({ block: 'center' }); }
          return !!el;
        })()`);
        if (!tagged) break;
        log(`  ▸ item ${i + 1} of ${count}`, 'info');
        ctx.scope = marker;
        ctx.scopeDepth = depth;
        try {
          // One pass = one item = (usually) one row, committed automatically.
          await runLoopPass(s.body, ctx);
        } catch (e) {
          ctx.scope = prevScope;
          ctx.scopeDepth = prevDepth;
          if (e && e.__break) break;
          throw e;
        }
        ctx.scope = prevScope;
        ctx.scopeDepth = prevDepth;
      }
      await pageEval(`document.querySelectorAll(${JSON.stringify(marker)}).forEach(e => e.removeAttribute(${JSON.stringify(attr)}))`);
      return;
    }

    case 'break':
      throw BREAK;
  }
}

// Compile a visual condition (or use a raw string) to an expression. The known
// names include the row being built, so "price is less than was" works whether
// those were kept as columns or as working values.
function condExpr(cond, ctx) {
  if (typeof cond === 'string') return cond; // legacy / advanced
  return compileCondition(cond, new Set(Object.keys(names(ctx))));
}

// Plain-language description of a selector for the log — hides the internal
// scope marker ("[data-ss-scope-1] .price" reads as ".price inside this item").
function describeSel(rawSel, resolved, ctx) {
  const scoped = ctx.scope && resolved.startsWith(ctx.scope);
  const shown = rawSel || '(the item itself)';
  return scoped ? `${shown} inside this item` : resolved || shown;
}

// 📥 Get value — read one value from the page (or compute one) and keep it under
// its name, either as a column (in the CSV) or as a working value (logic only).
// Both are readable by that name everywhere.
async function execGet(s, ctx) {
  let val;
  let note = '';
  const name = (s.name || '').trim();
  if (!name) {
    log('  ⚠ Get value has no name — give it one (e.g. price) so you can use it.', 'err');
    return;
  }
  const tfs = stepTransforms(s);
  const sel = await resolveSel(s.selector, ctx, s.abs);

  if (s.source === 'expr') {
    val = EXPR.evaluate(s.expr, names(ctx));
  } else if (s.source === 'url') {
    let url = '';
    try {
      url = view ? view.getURL() : '';
    } catch (_) {
      url = '';
    }
    val = TF.apply(url, tfs); // e.g. pull the product id out of the URL
    if (tfs.length) note = ` (from "${String(url).slice(0, 40)}")`;
  } else if (s.source === 'count') {
    val = await pageEval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  } else if (s.source === 'exists') {
    val = await pageEval(PA.existsExpr(sel));
  } else {
    // Anything read off an element. An "attr" with no name is almost always a
    // mistake — fall back to text so it still returns something useful.
    let mode = s.source;
    if (mode === 'attr' && !(s.attr || '').trim()) {
      mode = 'text';
      log('  (attribute had no name — read the element’s text instead)', 'warn');
    }
    const found = await pageEval(PA.existsExpr(sel));
    if (!found) {
      log(`  ⚠ ${name}: nothing matches ${describeSel(s.selector, sel, ctx)}`, 'err');
      val = TF.apply('', tfs); // keeps the type the clean-ups promise (0 for a number)
    } else {
      const raw = await pageEval(PA.extractExpr(sel, mode, s.attr));
      val = TF.apply(raw, tfs);
      if (tfs.length) note = ` (from "${String(raw == null ? '' : raw).trim().slice(0, 40)}")`;
    }
  }

  if (s.target === 'column') {
    ctx.pageRow[name] = val == null ? '' : val;
    delete ctx.vars[name]; // the row's value is the one that counts now
  } else {
    ctx.vars[name] = val;
    delete ctx.pageRow[name]; // it's a working value: keep it out of the CSV
  }
  log(`  ${s.target === 'column' ? 'column ' : ''}${name} = ${JSON.stringify(val)}${note}`, 'ok');
}

// --- Run helpers -----------------------------------------------------------

// Send a real Chromium key event into the guest page (works where synthetic
// DOM events don't — native submits, date pickers, etc.).
async function sendKey(key, mods) {
  const modifiers = [];
  if (mods.ctrl) modifiers.push('control');
  if (mods.shift) modifiers.push('shift');
  if (mods.alt) modifiers.push('alt');
  const keyCode = key === ' ' ? 'Space' : key;
  view.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // printable single chars also need a char event to actually insert text
  if (key.length === 1 && key !== ' ' && !mods.ctrl && !mods.alt) {
    view.sendInputEvent({ type: 'char', keyCode: key, modifiers });
  }
  view.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await sleep(60);
}

async function clickIfPresent(selector) {
  const r = await pageEval(PA.clickExpr(selector));
  return !!(r && r.ok);
}

async function waitForSelector(selector, timeout, wantGone) {
  const start = Date.now();
  const to = timeout || 10000;
  while (Date.now() - start < to) {
    if (abortRun) return;
    const found = await pageEval(PA.existsExpr(selector));
    if (wantGone ? !found : found) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${selector} to ${wantGone ? 'disappear' : 'appear'}`);
}

// Wait for a navigation to finish — but ONLY if one actually starts. Many
// actions (select, checkbox, in-page clicks) don't navigate at all; in that
// case we resolve after a short grace period instead of stalling for seconds.
function waitForLoad(maxWait = 15000, grace = 450) {
  return new Promise((resolve) => {
    let done = false;
    let navigating = false;
    const onStart = () => {
      navigating = true;
    };
    const finish = () => {
      if (done) return;
      done = true;
      view.removeEventListener('did-start-loading', onStart);
      view.removeEventListener('did-stop-loading', finish);
      resolve();
    };
    view.addEventListener('did-start-loading', onStart);
    view.addEventListener('did-stop-loading', finish);
    // If no navigation has begun by the end of the grace window, don't wait.
    setTimeout(() => {
      if (!navigating) finish();
    }, grace);
    // Hard cap for a navigation that never fires stop-loading.
    setTimeout(finish, maxWait);
  });
}

// ===========================================================================
// Results table + CSV
// ===========================================================================

function addRow(row) {
  results.push(row);
  for (const k of Object.keys(row)) {
    if (!columns.includes(k)) {
      columns.push(k);
      // New source field → add to the export shape (included, labelled = key).
      columnConfig.push({ key: k, label: k, include: true });
    }
  }
  renderResults();
}

// The columns actually shown/exported, in their configured order.
function activeColumns() {
  return columnConfig.filter((c) => c.include);
}

function renderResults() {
  const table = $('#results-table');
  $('#results-empty').classList.toggle('hidden', results.length > 0);
  $('#row-count').textContent = results.length ? `(${results.length})` : '';
  $('#export-csv').disabled = results.length === 0;

  table.innerHTML = '';
  if (!results.length) return;

  const cols = activeColumns();
  const thead = el('tr', {}, cols.map((c) => el('th', { textContent: c.label })));
  table.append(el('thead', {}, [thead]));

  const tbody = el('tbody');
  // Cap the on-screen preview; CSV export always includes everything.
  const shown = results.slice(-500);
  for (const r of shown) {
    tbody.append(
      el('tr', {}, cols.map((c) => {
        const v = r[c.key] == null ? '' : String(r[c.key]);
        return el('td', { textContent: v, title: v });
      }))
    );
  }
  table.append(tbody);
}

$('#clear-results').addEventListener('click', () => {
  results = [];
  columns = [];
  columnConfig = [];
  renderResults();
  log('Results cleared.', 'info');
});

function toCsv() {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = activeColumns();
  const lines = [cols.map((c) => esc(c.label)).join(',')];
  for (const r of results) lines.push(cols.map((c) => esc(r[c.key])).join(','));
  return '﻿' + lines.join('\r\n'); // BOM for Excel
}

// --- Column shaping modal --------------------------------------------------

let colsDraft = [];

$('#shape-cols').addEventListener('click', () => {
  if (!columnConfig.length) {
    log('No columns yet — run a scrape first.', 'warn');
    return;
  }
  colsDraft = columnConfig.map((c) => ({ ...c }));
  renderColsRows();
  $('#cols-modal').classList.remove('hidden');
});

function renderColsRows() {
  const body = $('#cols-body');
  body.innerHTML = '';
  colsDraft.forEach((c, i) => {
    const inc = el('input', { type: 'checkbox', checked: c.include });
    inc.addEventListener('change', () => (c.include = inc.checked));

    const lbl = el('input', { value: c.label });
    lbl.addEventListener('input', () => (c.label = lbl.value));

    const src = el('span', { className: 'src', textContent: c.key, title: 'source field: ' + c.key });

    const up = el('button', { textContent: '↑', title: 'Move up' });
    up.addEventListener('click', () => {
      if (i > 0) {
        [colsDraft[i - 1], colsDraft[i]] = [colsDraft[i], colsDraft[i - 1]];
        renderColsRows();
      }
    });
    const down = el('button', { textContent: '↓', title: 'Move down' });
    down.addEventListener('click', () => {
      if (i < colsDraft.length - 1) {
        [colsDraft[i + 1], colsDraft[i]] = [colsDraft[i], colsDraft[i + 1]];
        renderColsRows();
      }
    });

    body.append(el('div', { className: 'col-row' }, [inc, lbl, src, up, down]));
  });
}

$('#cols-close').addEventListener('click', () => $('#cols-modal').classList.add('hidden'));
$('#cols-cancel').addEventListener('click', () => $('#cols-modal').classList.add('hidden'));
$('#cols-save').addEventListener('click', () => {
  columnConfig = colsDraft.map((c) => ({ ...c }));
  $('#cols-modal').classList.add('hidden');
  renderResults();
  markDirty();
  log('CSV column shape updated.', 'ok');
});

$('#export-csv').addEventListener('click', async () => {
  if (!results.length) return;
  const host = safeHost(urlInput.value) || 'export';
  const res = await window.harvest.saveCsv(`${host}-webharvest.csv`, toCsv());
  if (res.saved) log(`Exported ${results.length} rows → ${res.filePath}`, 'ok');
});

function safeHost(u) {
  try {
    return new URL(normalizeUrl(u)).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

// ===========================================================================
// Recipe save / load
// ===========================================================================

function currentRecipe() {
  return {
    version: 1,
    startUrl,
    steps,
    columns: columnConfig
  };
}

$('#save-recipe').addEventListener('click', async () => {
  const host = safeHost(urlInput.value) || 'recipe';
  const res = await window.harvest.saveRecipe(
    `${host}.json`,
    JSON.stringify(currentRecipe(), null, 2)
  );
  if (res.saved) log(`Recipe saved → ${res.filePath}`, 'ok');
});

$('#load-recipe').addEventListener('click', async () => {
  const res = await window.harvest.loadRecipe();
  if (!res.loaded) return;
  try {
    const r = JSON.parse(res.json);
    steps = reidList(r.steps || []);
    if (r.startUrl) setStartUrl(r.startUrl);
    if (Array.isArray(r.columns)) columnConfig = r.columns.map((c) => ({ ...c }));
    renderSteps();
    log(`Recipe loaded (${steps.length} steps).`, 'ok');
  } catch (e) {
    log('Failed to parse recipe: ' + e.message, 'err');
  }
});

// ===========================================================================
// Resizable panels (draggable dividers)
// ===========================================================================

function initSplitters() {
  let mode = null;
  let splitEl = null;

  const stage = () => $('#stage').getBoundingClientRect();
  const resultsPane = $('#results-pane');
  const logEl2 = $('#log');

  function onMove(e) {
    if (!mode) return;
    if (mode === 'col') {
      // sidebar width = distance from the window's left edge
      const w = Math.min(600, Math.max(220, e.clientX));
      document.body.style.setProperty('--sidebar-w', w + 'px');
    } else if (mode === 'results') {
      // results height = distance from mouse to the bottom of the stage
      const s = stage();
      const h = Math.min(s.bottom - 180, Math.max(80, s.bottom - e.clientY));
      resultsPane.style.setProperty('--results-h', h + 'px');
      resultsPane.style.height = h + 'px';
    } else if (mode === 'log') {
      const paneRect = resultsPane.getBoundingClientRect();
      const h = Math.min(paneRect.bottom - 70, Math.max(28, paneRect.bottom - e.clientY));
      logEl2.style.setProperty('--log-h', h + 'px');
      logEl2.style.height = h + 'px';
    }
  }

  function stopDrag() {
    if (!mode) return;
    mode = null;
    if (splitEl) splitEl.classList.remove('active');
    splitEl = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Re-enable interaction with the embedded page.
    if (view) view.style.pointerEvents = '';
  }

  function startDrag(m, el, cursor) {
    return (e) => {
      mode = m;
      splitEl = el;
      el.classList.add('active');
      document.body.style.cursor = cursor;
      document.body.style.userSelect = 'none';
      // The <webview> would otherwise swallow mousemove while we drag over it.
      if (view) view.style.pointerEvents = 'none';
      e.preventDefault();
    };
  }

  $('#vsplit').addEventListener('mousedown', startDrag('col', $('#vsplit'), 'col-resize'));
  $('#hsplit').addEventListener('mousedown', startDrag('results', $('#hsplit'), 'row-resize'));
  $('#logsplit').addEventListener('mousedown', startDrag('log', $('#logsplit'), 'row-resize'));
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', stopDrag);
}

// ===========================================================================
// Jobs — the auto-saved project store + launch dashboard
// ===========================================================================

let currentJob = null; // { id, name, createdAt, ... }
let loadingJob = false; // suppress autosave while loading a job
let saveTimer = null;

function genId() {
  return 'job-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function collectJob() {
  return {
    id: currentJob ? currentJob.id : genId(),
    name: currentJob ? currentJob.name : 'Untitled',
    startUrl,
    steps,
    columns: columnConfig,
    createdAt: currentJob && currentJob.createdAt ? currentJob.createdAt : Date.now(),
    updatedAt: Date.now()
  };
}

// Debounced auto-save of the current job.
function markDirty() {
  if (loadingJob || !currentJob) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    currentJob = collectJob();
    try {
      await window.harvest.jobs.save(currentJob);
    } catch (_) {}
  }, 500);
}

function relTime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function showDashboard() {
  // Save current work before showing the list.
  if (currentJob) {
    clearTimeout(saveTimer);
    try {
      await window.harvest.jobs.save(collectJob());
    } catch (_) {}
  }
  const list = await window.harvest.jobs.list();
  const wrap = $('#dash-list');
  wrap.innerHTML = '';
  $('#dash-empty').classList.toggle('hidden', list.length > 0);
  for (const j of list) {
    const card = el('div', { className: 'job-card' });
    const name = el('div', { className: 'jc-name', textContent: j.name });
    card.append(
      name,
      el('div', { className: 'jc-url', textContent: j.startUrl || '(no start URL)', title: j.startUrl }),
      el('div', { className: 'jc-meta' }, [
        el('span', { textContent: j.steps + ' step' + (j.steps === 1 ? '' : 's') }),
        el('span', { textContent: relTime(j.updatedAt) })
      ])
    );
    const open = el('button', { className: 'primary', textContent: 'Open' });
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      openJob(j.id);
    });
    const ren = el('button', { textContent: 'Rename' });
    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      inlineRename(name, j);
    });
    const del = el('button', { className: 'danger', textContent: 'Delete' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.harvest.jobs.remove(j.id);
      if (currentJob && currentJob.id === j.id) currentJob = null;
      showDashboard();
    });
    card.append(el('div', { className: 'jc-actions' }, [open, ren, del]));
    card.addEventListener('click', () => openJob(j.id));
    wrap.append(card);
  }
  $('#dashboard').classList.remove('hidden');
}

// Rename a job in place on its card.
function inlineRename(nameEl, job) {
  const input = el('input', { value: job.name });
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    const newName = input.value.trim() || job.name;
    const full = await window.harvest.jobs.load(job.id);
    if (full) {
      full.name = newName;
      full.updatedAt = Date.now();
      await window.harvest.jobs.save(full);
      if (currentJob && currentJob.id === job.id) currentJob.name = newName;
    }
    showDashboard();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') showDashboard();
  });
  input.addEventListener('blur', commit);
}

async function openJob(id) {
  const job = await window.harvest.jobs.load(id);
  if (!job) {
    log('Could not load job.', 'err');
    return;
  }
  loadingJob = true;
  currentJob = job;
  steps = reidList(job.steps || []);
  columnConfig = Array.isArray(job.columns) ? job.columns.map((c) => ({ ...c })) : [];
  setStartUrl(job.startUrl || '');
  results = [];
  columns = [];
  renderResults();
  renderSteps();
  $('#dashboard').classList.add('hidden');
  loadingJob = false;
  // Mount a webview on THIS job's own session partition, then open its URL.
  mountWebview('persist:' + job.id);
  if (job.startUrl) navigate(job.startUrl);
  log(`Opened job: ${job.name}`, 'ok');
}

async function createJob(name, url) {
  const id = genId();
  currentJob = { id, name: name || 'Untitled', createdAt: Date.now() };
  loadingJob = true;
  steps = [];
  columnConfig = [];
  results = [];
  columns = [];
  setStartUrl(url || '');
  renderSteps();
  renderResults();
  loadingJob = false;
  try {
    await window.harvest.jobs.save(collectJob());
  } catch (_) {}
  $('#dashboard').classList.add('hidden');
  $('#newjob-modal').classList.add('hidden');
  mountWebview('persist:' + id);
  if (url) navigate(url);
  log(`Created job: ${currentJob.name}`, 'ok');
}

// Dashboard + new-job wiring.
$('#show-dashboard').addEventListener('click', () => showDashboard());
$('#dash-new').addEventListener('click', () => openNewJobModal());
function openNewJobModal() {
  $('#newjob-name').value = '';
  $('#newjob-url').value = 'https://www.google.com';
  $('#newjob-modal').classList.remove('hidden');
  setTimeout(() => $('#newjob-name').focus(), 30);
}
$('#newjob-close').addEventListener('click', () => $('#newjob-modal').classList.add('hidden'));
$('#newjob-cancel').addEventListener('click', () => $('#newjob-modal').classList.add('hidden'));
$('#newjob-create').addEventListener('click', () => {
  const name = $('#newjob-name').value.trim() || 'Untitled job';
  const url = normalizeUrl($('#newjob-url').value);
  createJob(name, url);
});
$('#newjob-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#newjob-create').click();
});

// ===========================================================================
// Theme (light default; changed from the View menu, persisted)
// ===========================================================================

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem('theme', t);
  } catch (_) {}
}

(function initTheme() {
  let saved = 'light';
  try {
    saved = localStorage.getItem('theme') || 'light';
  } catch (_) {}
  applyTheme(saved);
  if (window.harvest && window.harvest.onSetTheme) window.harvest.onSetTheme(applyTheme);
})();

// ===========================================================================
// Boot
// ===========================================================================

initSplitters();
renderSteps();
renderResults();
log('Ready. Open a job from the dashboard, or create a new one.', 'info');

// Launch into the project dashboard.
showDashboard();

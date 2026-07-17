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
/** @type {Array<object>|null} rows produced mid-run but not yet committed
 *  (a grabbed table/list still in ctx.listRows, or a cell-placement table in
 *  ctx.cellRows) — shown live during a run so you SEE output as it's built. */
let liveExtra = null;

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

// Read from the page, retrying briefly while the result still looks "empty".
// The webview occasionally returns nothing on the FIRST eval right after a step
// editor (re)opens — which used to flash a false "nothing matches / no rows"
// warning even though the selector was fine (the scrape itself always worked).
// `isEmpty(result)` decides whether to keep trying. Only used for the automatic
// on-open reads — live typing still evaluates immediately (see updateSelStatus).
async function pageEvalStable(expr, isEmpty, tries = 6, gap = 180) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      last = await pageEval(expr);
    } catch (_) {
      last = null;
    }
    if (!isEmpty(last)) return last;
    if (i < tries - 1) await sleep(gap);
  }
  return last;
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
// Per-job sign-in / authentication sessions
//
// Each job already runs in its OWN persistent <webview> partition
// ("persist:<jobId>"), so a login done once — including any 2FA — is remembered
// across restarts. This section makes that manageable (log in / forget) and,
// crucially, DETECTS when a site has signed you out mid-run and prompts you to
// sign in again (in the browser, non-blocking) rather than silently failing.
// ===========================================================================

/** @type {{loginUrl:string, check:string}} the current job's auth config */
// mode: 'auto' (stop only on a clear login redirect), 'never' (public site — skip
// ALL login checks/prompts), 'always' (always require being signed in).
let jobAuthCfg = { loginUrl: '', check: '', mode: 'auto' };
let authLostState = null; // set during a run if we detect a sign-out
let authCheckedOnFail = false; // only probe once per run on the first failure

function setJobAuth(auth) {
  jobAuthCfg = {
    loginUrl: (auth && auth.loginUrl) || '',
    check: (auth && auth.check) || '',
    mode: (auth && auth.mode) || 'auto'
  };
  $('#auth-login-url').value = jobAuthCfg.loginUrl;
  $('#auth-check').value = jobAuthCfg.check;
  $('#auth-mode').value = jobAuthCfg.mode;
  reflectAuthMode();
}

// Show the "checks are off" note and dim the marker/login-page controls when the
// site is marked public.
function reflectAuthMode() {
  const never = jobAuthCfg.mode === 'never';
  $('#auth-never-note').classList.toggle('hidden', !never);
  const adv = document.querySelector('.auth-adv');
  if (adv) adv.style.display = never ? 'none' : '';
  const login = $('#auth-login');
  if (login) login.style.display = never ? 'none' : '';
}

$('#auth-mode').addEventListener('change', () => {
  jobAuthCfg.mode = $('#auth-mode').value || 'auto';
  reflectAuthMode();
  if (jobAuthCfg.mode === 'never') hideAuthBanner();
  markDirty();
});
$('#auth-login-url').addEventListener('input', () => {
  jobAuthCfg.loginUrl = $('#auth-login-url').value.trim();
  markDirty();
});
$('#auth-check').addEventListener('input', () => {
  jobAuthCfg.check = $('#auth-check').value.trim();
  markDirty();
});

// Open the site in THIS job's browser so the user can sign in / do 2FA. Uses the
// optional login-page URL if set, otherwise the job's start URL.
function goToLogin() {
  hideAuthBanner();
  const target = jobAuthCfg.loginUrl || startUrl;
  if (!target) return log('Add a start URL (or a login page in the Sign-in panel) first.', 'warn');
  navigate(target);
  const where = jobAuthCfg.loginUrl ? 'login page' : 'start page';
  log(`Opened the ${where} — sign in (and complete any 2FA), then press ▶ Run.`, 'info');
}
$('#auth-login').addEventListener('click', goToLogin);

// Forget this job's saved sign-in (clear its session partition).
$('#auth-forget').addEventListener('click', async () => {
  if (!currentJob) return;
  if (!window.confirm('Forget this job’s saved sign-in? You’ll need to log in again next time.')) return;
  const ok = await window.harvest.auth.clear('persist:' + currentJob.id);
  if (ok) {
    // Remount the (now-empty) session and reopen the start URL.
    mountWebview('persist:' + currentJob.id);
    if (startUrl) navigate(startUrl);
    log('Forgot this job’s sign-in. Log in again when you’re ready.', 'ok');
  } else {
    log('Could not clear the session.', 'err');
  }
});

// Decide whether we look signed-in on the current page.
//  - If a "signed-in marker" selector is set, that's authoritative.
//  - Otherwise we treat a redirect to a login-ish URL, or a visible password
//    field, as a sign-out.
async function detectAuth() {
  let url = '';
  try {
    url = view ? view.getURL() : '';
  } catch (_) {
    url = '';
  }
  // "No login needed" → never treat anything as a sign-out. Nothing gates, and the
  // mid-run sign-out probe can't fire either.
  if (jobAuthCfg.mode === 'never') {
    return { loggedIn: true, byMarker: false, byRedirect: false, reason: '', url };
  }
  const check = (jobAuthCfg.check || '').trim();
  if (check) {
    let ok = false;
    try {
      ok = await pageEval(PA.existsExpr(check));
    } catch (_) {
      ok = false;
    }
    return { loggedIn: !!ok, byMarker: true, byRedirect: false, reason: ok ? '' : 'your “signed-in” marker isn’t on the page', url };
  }
  const byRedirect = /(?:[/.?#=]|^)(?:login|log-in|signin|sign-in|sign_in|sso|oauth|auth|logon|session\/new|account\/login|accounts\/login|users\/sign_in)(?:[/.?#=]|$)/i.test(url);
  let hasPw = false;
  try {
    hasPw = await pageEval('!!(function(){var p=document.querySelector(\'input[type=password]\');return p&&p.offsetParent!==null;})()');
  } catch (_) {
    hasPw = false;
  }
  return {
    loggedIn: !(byRedirect || hasPw),
    byMarker: false,
    byRedirect,
    hasPw,
    reason: byRedirect ? 'the site sent you to a sign-in page' : hasPw ? 'a password field is showing' : '',
    url
  };
}

// Whether a signed-out state should stop the run at the start. With an explicit
// marker we always trust it; without one we only auto-stop on a clear login
// redirect (a visible password field alone is too noisy for public sites).
function authShouldGate(st) {
  if (jobAuthCfg.mode === 'never') return false; // public site — never stop
  if (jobAuthCfg.mode === 'always') return true; // always require sign-in
  if ((jobAuthCfg.check || '').trim()) return true;
  return !!st.byRedirect;
}

function showAuthBanner(st) {
  const host = safeHost(st && st.url) || safeHost(startUrl) || 'this site';
  const why = st && st.reason ? ` — ${st.reason}` : '';
  $('#auth-banner-msg').textContent = `of ${host}${why}. Log in in the browser, then press ▶ Run again.`;
  $('#auth-banner').classList.remove('hidden');
}
function hideAuthBanner() {
  $('#auth-banner').classList.add('hidden');
}
$('#auth-banner-login').addEventListener('click', goToLogin);
$('#auth-banner-dismiss').addEventListener('click', hideAuthBanner);

// ===========================================================================
// Element picker
// ===========================================================================

let pickHidModal = false;
let pickHidMap = false;
let pickActive = false;

function startPick(mode, target) {
  if (running) return;
  pickTarget = target;
  pickActive = true;
  // If a step editor is open, hide it so the user can actually see and click the
  // page — it reappears (filled) once picked. The Map overlay (if the editor was
  // opened from a node) must ALSO step aside, or it would cover the page.
  const modal = $('#modal');
  pickHidModal = !modal.classList.contains('hidden');
  if (pickHidModal) modal.classList.add('hidden');
  const map = $('#map-modal');
  pickHidMap = !map.classList.contains('hidden');
  if (pickHidMap) map.classList.add('hidden');
  const scoped = !!target.relativeTo;
  if (view) view.send('picker:start', { mode, relativeTo: target.relativeTo || '' });
  // Say what you're actually pointing at. A SCOPED pick (a value/list inside a
  // "For each" item, or a column inside a grabbed list) shows a copy of that item
  // in a dialog and only lets you click inside it — so the message is about that,
  // not the whole page. Otherwise: table picks highlight whole tables; list picks
  // highlight whole rows (with an Alt escape hatch to a cell).
  $('#pick-hint').innerHTML = scoped
    ? 'A copy of the item is shown — <b>click the value you want inside it</b>. <kbd>↑</kbd>/<kbd>↓</kbd> for a bigger/smaller box. <kbd>Esc</kbd> to cancel'
    : mode === 'table'
      ? 'Move over the page — <b>whole tables light up</b>. Click the one you want — <kbd>Esc</kbd> to cancel'
      : mode === 'list'
        ? 'Click a repeating item. <kbd>↑</kbd>/<kbd>↓</kbd> grab a <b>bigger/smaller box</b> (e.g. a whole card). Over a table, whole rows light up — <kbd>Alt</kbd> for one cell. <kbd>Esc</kbd> to cancel'
        : 'Click an element. <kbd>↑</kbd>/<kbd>↓</kbd> grab a <b>bigger/smaller box</b> around it. <kbd>Esc</kbd> to cancel';
  $('#pick-hint').classList.remove('hidden');
}

// Bring back whatever the pick hid: the Map first (so it sits behind), then the
// editor on top. Called on both success and cancel.
function restorePickOverlays(discardEditor) {
  if (pickHidMap) {
    pickHidMap = false;
    $('#map-modal').classList.remove('hidden');
  }
  if (pickHidModal) {
    pickHidModal = false;
    if (discardEditor) closeModal();
    else $('#modal').classList.remove('hidden');
  }
}

// End pick mode. On success the editor reopens (filled); on cancel the editor is
// discarded entirely (an unsaved new step never gets added), returning to normal.
function endPick(cancelled) {
  pickActive = false;
  pickTarget = null;
  $('#pick-hint').classList.add('hidden');
  restorePickOverlays(cancelled);
}

// Cancel from the host side (e.g. Esc while the page doesn't have focus).
function cancelPick() {
  if (!pickActive) return;
  if (view) view.send('picker:stop');
  endPick(true);
  log('Pick cancelled.', 'warn');
}

// Keyboard during a pick. Focus stays on the HOST window (the webview isn't
// focused — moving the mouse over it doesn't focus it, and clicks are
// intercepted), so these keys never reach the guest's own listener. We forward
// them, mirroring how Esc is handled here and how zoom is forwarded.
window.addEventListener('keydown', (e) => {
  if (!pickActive) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelPick();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // ↑ grabs a bigger box (parent), ↓ a smaller one — for grabbing a whole card.
    e.preventDefault();
    if (view) view.send('picker:widen', e.key === 'ArrowUp' ? 'up' : 'down');
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

  // Offer "just this one" vs "every one like it" when the generalized selector
  // matches more than one element (and we're not already relative).
  //
  // `noChoice` steps skip it entirely — e.g. "Grab a table", where the answer
  // makes no difference (whatever cell you click, we read the whole table it
  // sits in), so asking would only confuse.
  const canChoose =
    t.type === 'input' &&
    !t.noChoice &&
    !t.relativeTo &&
    data.general &&
    data.general !== data.selector &&
    data.count > 1;

  if (canChoose) {
    chooseSelector(data, (chosen) => fillPick(t, chosen, data), t);
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
  restorePickOverlays(false); // bring back the Map (behind) then the editor (on top)
}

// Small centred chooser shown after a single-element pick.
let choiceEl = null;
function closeChoice() {
  if (choiceEl) {
    choiceEl.remove();
    choiceEl = null;
  }
}
// "You clicked one thing, but N things on this page look just like it — did you
// mean that one, or all of them?" The old wording ("This exact element" / "Any
// matching — first of 63") described the SELECTOR; this describes the OUTCOME,
// which is the only thing the user can reason about.
//
// The sensible default depends on what's being picked: a repeating list wants
// ALL of them; a single value wants the one you clicked. `t.pickWants` says
// which, so the recommended button is the primary one.
function chooseSelector(data, cb, t) {
  closeChoice();
  const wantsMany = t && t.pickWants === 'many';
  const panel = el('div', { className: 'choice' });
  panel.append(
    el('div', { className: 'choice-title', textContent: 'You clicked one of ' + data.count + ' similar things' }),
    el('div', { className: 'choice-sample', textContent: data.sample ? '“' + data.sample + '”' : '' })
  );

  const many = el('button', { className: wantsMany ? 'primary' : '' });
  many.append(
    el('b', { textContent: `All ${data.count} like it` }),
    el('i', { textContent: wantsMany
      ? 'one row each — this is what you want for a list'
      : 'the value is read from the first one' })
  );
  many.addEventListener('click', () => {
    closeChoice();
    cb(data.general);
  });

  const one = el('button', { className: wantsMany ? '' : 'primary' });
  one.append(
    el('b', { textContent: 'Only the one I clicked' }),
    el('i', { textContent: 'ignore the others' })
  );
  one.addEventListener('click', () => {
    closeChoice();
    cb(data.selector);
  });

  // Recommended option first.
  panel.append(wantsMany ? many : one, wantsMany ? one : many);
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
  scrapeTable: { icon: '📊', label: 'Grab a table' },
  formula: { icon: '🧮', label: 'Formula' },
  spread: { icon: '⚡', label: 'Spread into columns' },
  join: { icon: '🔗', label: 'Join in a table' },
  goto: { icon: '🌐', label: 'Go to URL' },
  back: { icon: '⬅️', label: 'Go back' },
  refresh: { icon: '🔄', label: 'Refresh page' },
  if: { icon: '❓', label: 'If' },
  forEach: { icon: '🔄', label: 'For each' },
  forDates: { icon: '📅', label: 'For each date' },
  while: { icon: '🔁', label: 'While' },
  repeat: { icon: '🔢', label: 'Repeat' },
  try: { icon: '🛟', label: 'Try / Recover' },
  group: { icon: '📦', label: 'Task' },
  skip: { icon: '⏭', label: 'Skip item' },
  break: { icon: '⛔', label: 'Break' },
  // Legacy types — kept so old jobs still render if migration is ever bypassed.
  scrape: { icon: '📥', label: 'Get value' },
  setVar: { icon: '📥', label: 'Get value' },
  emitRow: { icon: '📤', label: 'Add row (old)' }
};

// Block steps hold child step lists.
const BLOCK_TYPES = {
  if: ['then', 'else'],
  while: ['body'],
  repeat: ['body'],
  forEach: ['body'],
  forDates: ['body'],
  try: ['body', 'onError'],
  group: ['body']
};
const isBlock = (s) => !!BLOCK_TYPES[s.type];

// Blocks that merely organise / wrap steps — they don't loop or branch on data,
// so a value collected inside them behaves exactly as if it were a sibling
// outside. This keeps the row engine and variable scope totally transparent.
const PASSTHROUGH_BLOCKS = new Set(['group']);

// The design doc's key insight: browser automation is really THREE languages
// mixed together — data flow, control flow, and browser actions. We make that
// visible by colour-coding every step by which language it belongs to. Used for
// the step-list accent border and the Map view node colours.
const STEP_CATEGORY = {
  data: ['get', 'scrapeList', 'scrapeTable', 'formula', 'spread', 'join', 'scrape', 'setVar', 'emitRow'],
  control: ['if', 'while', 'repeat', 'forEach', 'forDates', 'try', 'skip', 'break'],
  group: ['group']
  // everything else falls through to 'action' (things you do to the page)
};
function stepCategory(s) {
  const t = typeof s === 'string' ? s : s.type;
  for (const cat of Object.keys(STEP_CATEGORY)) {
    if (STEP_CATEGORY[cat].includes(t)) return cat;
  }
  return 'action';
}

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
        : s.source === 'textExists' ? `text “${(s.textExists && s.textExists.text) || '…'}” appears?`
        : `${where} ${s.selector || '(pick one)'}`;
      const lead = s.name || (s.target === 'cell' ? 'value' : '(name it)');
      return `${lead} ← ${from}${s.source === 'expr' ? '' : tfSummary(s)}${destSummary(s)}`;
    }
    case 'formula': {
      const lead = s.name || (s.target === 'cell' ? 'value' : '(name it)');
      return `${lead} = ${formulaSummary(s.formula)}${destSummary(s)}`;
    }
    case 'scrapeList': {
      const cleaned = s.fields.filter((f) => stepTransforms(f).length).length;
      const cols = s.fields.map((f) => f.name).filter(Boolean).join(', ');
      const dest = s.keep === 'dataset' ? ` · kept as “${s.dataset || '?'}”` : '';
      return `each ${s.rowSelector || '(pick a row)'} → ${cols || 'no columns yet'}${cleaned ? ' 🧹' : ''}${dest}`;
    }
    case 'scrapeTable': {
      const on = (s.fields || []).filter((f) => f.include !== false);
      if (!s.rowSelector) return '(point at a table)';
      const cols = on.map((f) => f.name).filter(Boolean).join(', ');
      const dest = s.keep === 'dataset' ? ` · kept as “${s.dataset || '?'}”` : '';
      return `${on.length} column${on.length === 1 ? '' : 's'} → ${cols || 'none'}` +
        (s.skipTotals ? ' · no totals' : '') + dest;
    }
    case 'spread': {
      if (!s.dataset) return '(choose a kept dataset)';
      const vals = spreadVals(s);
      if (!s.keyCol || !vals.length) return `${s.dataset} → (choose columns)`;
      return `${s.dataset}: per ${s.keyCol} → “${spreadPattern(s)}” × [${vals.join(', ')}]`;
    }
    case 'join': {
      if (!s.dataset || !s.onLeft || !s.onRight) return '(set up the look-up)';
      const bring = (s.bring || []).length ? s.bring.join(', ') : 'all columns';
      return `look up ${s.onLeft} in “${s.dataset}” (= ${s.onRight}) → attach ${bring}`;
    }
    case 'skip':
      return 'no row for this item — go to the next';
    case 'emitRow':
      return 'commit current row (old step — rows now commit themselves)';
    case 'goto':
      return `→ ${s.url || '…'}`;
    case 'back':
      return 'browser back';
    case 'refresh':
      return 'reload this page';
    case 'forEach': {
      const base = `every ${s.selector || '(pick an item)'} — one row each`;
      const active = activeFilterRules(s.filter);
      return active.length ? `${base} · where ${filterSummary(s.filter)}` : base;
    }
    case 'forDates':
      if (!s.from) return '(set a date range)';
      return `${s.from} → ${s.to || s.from}${Number(s.stepDays) > 1 ? `, every ${s.stepDays}d` : ''} → {{${s.var || 'date'}}}`;
    case 'if':
      return condSummary(s.condition);
    case 'while':
      return `while ${condSummary(s.condition)}`;
    case 'repeat':
      return `${s.count || '0'} times${s.indexVar ? ` (counter: ${s.indexVar})` : ''}`;
    case 'try': {
      const n = countSteps(s.body || []);
      const retry = Number(s.retries) > 0 ? `retry up to ${s.retries}×, ` : '';
      return `${retry}${n} step${n === 1 ? '' : 's'} — recover if any fails`;
    }
    case 'group':
      return s.note || `${countSteps(s.body || [])} step${countSteps(s.body || []) === 1 ? '' : 's'}`;
    case 'break':
      return 'exit loop';
    default:
      return '';
  }
}

// Where a Grab-a-value / Formula result goes, for the step list.
function destSummary(s) {
  if (s.target === 'cell') {
    return ` → cell [${s.matchCol || '?'} = ${s.matchVal || '?'}] · ${s.setCol || s.name || '?'}`;
  }
  return s.target === 'column' ? '' : ' · not in the CSV';
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

// --- "For each … where" filter (keep only matched elements that pass) -------
//
// A filter tests each matched element by its inner text, an attribute, or a
// number pulled from its text. Rules combine with all/any. Empty/blank rules are
// ignored, so a filter with nothing filled in keeps everything.
const FILTER_TESTS = [
  { v: 'text', label: 'its text' },
  { v: 'cell', label: 'a specific column…' },
  { v: 'attr', label: 'an attribute…' },
  { v: 'number', label: 'a number in its text' }
];
const FILTER_OPS = [
  { v: 'contains', label: 'contains' },
  { v: 'ncontains', label: 'does not contain' },
  { v: 'eq', label: 'is exactly' },
  { v: 'ne', label: 'is not' },
  { v: 'startsWith', label: 'starts with' },
  { v: 'endsWith', label: 'ends with' },
  { v: 'matches', label: 'matches (regex)' },
  { v: 'gt', label: '>' },
  { v: 'ge', label: '≥' },
  { v: 'lt', label: '<' },
  { v: 'le', label: '≤' },
  { v: 'empty', label: 'is empty' },
  { v: 'nempty', label: 'is not empty' }
];
const FILTER_OP_NOVALUE = new Set(['empty', 'nempty']);

function normalizeFilter(f) {
  if (f && typeof f === 'object' && Array.isArray(f.rules)) return f;
  return { match: 'all', rules: [] };
}
function newFilterRule() {
  return { test: 'text', attr: '', selector: '', op: 'contains', value: '' };
}
// The rules that actually constrain anything (a value, or a no-value operator).
// A "specific column" rule also needs a column picked, or it constrains nothing.
function activeFilterRules(f) {
  f = normalizeFilter(f);
  return f.rules.filter((r) => r
    && (r.test !== 'cell' || String(r.selector || '').trim() !== '')
    && (String(r.value == null ? '' : r.value).trim() !== '' || FILTER_OP_NOVALUE.has(r.op)));
}
function filterSummary(f) {
  f = normalizeFilter(f);
  const rules = activeFilterRules(f);
  if (!rules.length) return '';
  const part = (r) => {
    const test = r.test === 'attr' ? `[${r.attr || 'attr'}]`
      : r.test === 'number' ? 'number'
      : r.test === 'cell' ? `column “${r.selector || '?'}”`
      : 'text';
    const op = (FILTER_OPS.find((o) => o.v === r.op) || { label: r.op }).label;
    return FILTER_OP_NOVALUE.has(r.op) ? `${test} ${op}` : `${test} ${op} “${r.value}”`;
  };
  return rules.map(part).join(f.match === 'any' ? ' OR ' : ' AND ');
}

// --- Visual formulas (Get value → "Formula") -------------------------------
//
// The same idea as the visual conditions: the user clicks a preset and fills
// dropdowns; we COMPILE it to an expression string that expr.js evaluates. They
// never type operators or function calls. Four presets cover the real needs:
//   math    — A [+ − × ÷] B          → number(a) - number(b)
//   percent — A as % of B            → round(number(a)/number(b)*100, 2)
//   combine — pieces + text glue     → a + " " + b
//   lookup  — value out of a table   → lookup(dataset, "key", "Cerys", "val")
//
// An operand is { type:'col'|'num'|'text', v }. A column reference must be a
// bare identifier (table columns are slugified to identifiers, so they qualify);
// anything else falls back to a harmless 0 / "" so a half-built formula can't
// crash a run.
function colRef(name, fallback) {
  const nm = String(name == null ? '' : name).trim();
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nm) ? nm : fallback;
}

function operandExpr(o) {
  if (!o) return '0';
  if (o.type === 'num') {
    const t = String(o.v == null ? '' : o.v).trim();
    if (t === '') return '0';
    return isNaN(Number(t)) ? JSON.stringify(t) : t; // typed text still works
  }
  return colRef(o.v, '0');
}

function compileFormula(f) {
  if (!f || !f.kind) return '';
  if (f.kind === 'value') {
    return operandExpr(f.v); // just the value, as-is (no maths)
  }
  if (f.kind === 'math') {
    const op = ['+', '-', '*', '/'].includes(f.op) ? f.op : '+';
    return `number(${operandExpr(f.a)}) ${op} number(${operandExpr(f.b)})`;
  }
  if (f.kind === 'percent') {
    return `round(number(${operandExpr(f.part)}) / number(${operandExpr(f.whole)}) * 100, 2)`;
  }
  if (f.kind === 'combine') {
    const parts = (f.parts || []).map((p) =>
      p.type === 'text' ? JSON.stringify(p.v == null ? '' : String(p.v)) : colRef(p.v, '""')
    );
    if (!parts.length) return '""';
    const sep = f.sep == null ? '' : String(f.sep);
    const glue = sep === '' ? ' + ' : ` + ${JSON.stringify(sep)} + `;
    return parts.join(glue);
  }
  if (f.kind === 'lookup') {
    const ds = colRef(f.dataset, '');
    if (!ds) return '""';
    return `lookup(${ds}, ${JSON.stringify(f.keyCol || '')}, ${JSON.stringify(f.keyVal || '')}, ${JSON.stringify(f.valCol || '')})`;
  }
  // List operations — the codeless work-queue building blocks. Each reads a list
  // value (picked from the value dropdown) and returns a value or a new list.
  if (f.kind === 'listFirst') return `listFirst(${operandExpr(f.v)})`;
  if (f.kind === 'listRest') return `listRest(${operandExpr(f.v)})`;
  if (f.kind === 'listAppend') return `listConcat(${operandExpr(f.a)}, ${operandExpr(f.b)})`;
  if (f.kind === 'textTest') {
    // A yes/no check on a value: contains / starts with / matches / is empty…
    // Compiles to the evaluator's own string helpers. Text operands are quoted
    // literals; column operands are bare identifiers.
    const operand = (o) => {
      if (!o) return '""';
      if (o.type === 'num') return operandExpr(o);
      if (o.type === 'text') return JSON.stringify(o.v == null ? '' : String(o.v));
      return colRef(o.v, '""');
    };
    const a = operand(f.a);
    const b = operand(f.b);
    switch (f.op) {
      case 'ncontains': return `!contains(${a}, ${b})`;
      case 'startsWith': return `startsWith(${a}, ${b})`;
      case 'endsWith': return `endsWith(${a}, ${b})`;
      case 'matches': return `test(${a}, ${b})`;
      case 'nmatches': return `!test(${a}, ${b})`;
      case 'eq': return `${a} == ${b}`;
      case 'ne': return `${a} != ${b}`;
      case 'empty': return `len(trim(${a})) == 0`;
      case 'nempty': return `len(trim(${a})) > 0`;
      case 'contains':
      default: return `contains(${a}, ${b})`;
    }
  }
  return '';
}

// The operators offered by the "Yes/No test" formula kind. NO_VALUE ones don't
// use the second operand.
const TEXT_TEST_OPS = [
  { v: 'contains', label: 'contains' },
  { v: 'ncontains', label: 'does not contain' },
  { v: 'eq', label: 'is exactly' },
  { v: 'ne', label: 'is not' },
  { v: 'startsWith', label: 'starts with' },
  { v: 'endsWith', label: 'ends with' },
  { v: 'matches', label: 'matches (regex)' },
  { v: 'nmatches', label: 'does not match (regex)' },
  { v: 'empty', label: 'is empty' },
  { v: 'nempty', label: 'is not empty' }
];
const TEXT_TEST_NOVALUE = new Set(['empty', 'nempty']);

// A blank formula of each kind, used when the user first switches to Formula or
// changes preset.
function blankFormula(kind) {
  switch (kind) {
    case 'value':
      return { kind: 'value', v: { type: 'col', v: '' } };
    case 'percent':
      return { kind: 'percent', part: { type: 'col', v: '' }, whole: { type: 'col', v: '' } };
    case 'combine':
      return { kind: 'combine', sep: ' ', parts: [{ type: 'col', v: '' }, { type: 'col', v: '' }] };
    case 'lookup':
      return { kind: 'lookup', dataset: '', keyCol: '', keyVal: '', valCol: '' };
    case 'textTest':
      return { kind: 'textTest', a: { type: 'col', v: '' }, op: 'contains', b: { type: 'text', v: '' } };
    case 'listFirst':
      return { kind: 'listFirst', v: { type: 'col', v: '' } };
    case 'listRest':
      return { kind: 'listRest', v: { type: 'col', v: '' } };
    case 'listAppend':
      return { kind: 'listAppend', a: { type: 'col', v: '' }, b: { type: 'col', v: '' } };
    default:
      return { kind: 'math', a: { type: 'col', v: '' }, op: '-', b: { type: 'col', v: '' } };
  }
}

// A plain-English summary of a formula for the step list.
function formulaSummary(f) {
  if (!f || !f.kind) return '(build the formula)';
  const opnd = (o) => (!o ? '?' : o.type === 'num' ? String(o.v || '0') : o.type === 'text' ? `"${o.v || ''}"` : o.v || '?');
  if (f.kind === 'value') return opnd(f.v);
  if (f.kind === 'math') return `${opnd(f.a)} ${f.op || '-'} ${opnd(f.b)}`;
  if (f.kind === 'percent') return `${opnd(f.part)} as % of ${opnd(f.whole)}`;
  if (f.kind === 'combine') return (f.parts || []).map(opnd).join(' + ') || '(pieces)';
  if (f.kind === 'lookup')
    return `${f.dataset || '(table)'} where ${f.keyCol || '?'}=“${f.keyVal || '?'}” → ${f.valCol || '?'}`;
  if (f.kind === 'textTest') {
    const op = (TEXT_TEST_OPS.find((o) => o.v === f.op) || { label: f.op || 'contains' }).label;
    return TEXT_TEST_NOVALUE.has(f.op) ? `${opnd(f.a)} ${op}` : `${opnd(f.a)} ${op} ${opnd(f.b)}`;
  }
  if (f.kind === 'listFirst') return `first thing in ${opnd(f.v)}`;
  if (f.kind === 'listRest') return `${opnd(f.v)} without its first thing`;
  if (f.kind === 'listAppend') return `${opnd(f.a)} + ${opnd(f.b)} (as a list)`;
  return '';
}

// Scalar value names a formula operand can reference: single values (Get),
// loop counters/dates IN SCOPE for `targetList`, and the columns of tables/lists
// that go to the CSV (not the ones kept whole as datasets — those are looked up).
function valueNames(targetList) {
  // A loop's counter/date variable only exists INSIDE that loop, so it's only
  // offered to steps within it (default: the step being edited).
  const inScope = enclosingLoopVars(targetList || editingList || steps);
  const set = new Set();
  for (const s of flattenSteps(steps)) {
    if ((s.type === 'get' || s.type === 'setVar' || s.type === 'scrape' || s.type === 'formula') && (s.name || '').trim()) set.add(s.name.trim());
    if ((s.type === 'repeat' || s.type === 'forEach') && (s.indexVar || '').trim() && inScope.has(s.indexVar.trim())) set.add(s.indexVar.trim());
    if (s.type === 'forDates' && (s.var || '').trim() && inScope.has(s.var.trim())) set.add(s.var.trim());
    if ((s.type === 'scrapeTable' || s.type === 'scrapeList') && s.keep !== 'dataset') {
      for (const f of s.fields || []) if ((f.name || '').trim()) set.add(f.name.trim());
    }
  }
  return Array.from(set);
}

// The loop variables (forEach/repeat counters, forDates date) whose loop ENCLOSES
// `targetList` — i.e. the ones actually in scope for a step in that list.
function enclosingLoopVars(targetList) {
  const found = new Set();
  (function walk(list, acc) {
    if (list === targetList) {
      acc.forEach((v) => found.add(v));
      return true;
    }
    for (const s of list) {
      if (!isBlock(s)) continue;
      const mine = [];
      if ((s.type === 'repeat' || s.type === 'forEach') && (s.indexVar || '').trim()) mine.push(s.indexVar.trim());
      if (s.type === 'forDates' && (s.var || '').trim()) mine.push(s.var.trim());
      for (const k of BLOCK_TYPES[s.type]) {
        if (walk(s[k] || [], mine.length ? acc.concat(mine) : acc)) return true;
      }
    }
    return false;
  })(steps, []);
  return found;
}

// The kept datasets (grabbed tables/lists set to "keep as dataset") and their
// columns — what the Look-up formula and the Spread step choose from.
function datasetDefs() {
  const out = [];
  for (const s of flattenSteps(steps)) {
    if ((s.type === 'scrapeTable' || s.type === 'scrapeList') && s.keep === 'dataset' && (s.dataset || '').trim()) {
      // Display the column's CURRENT name — "Grab a table" freezes `label` to the
      // original header (e.g. col7), so a rename must still show through here.
      const fields = (s.fields || [])
        .filter((f) => (f.name || '').trim() && f.include !== false)
        .map((f) => ({ name: f.name, label: f.name }));
      out.push({ name: s.dataset.trim(), fields });
    }
  }
  return out;
}

// Everything you could join TO: every grabbed table/list, whether it's kept as a
// dataset (out of the CSV) or scraped straight to CSV. A kept one is referenced
// by its stable name; a CSV one is offered as "keep it for look-ups" (picking it
// flips that step to a named dataset, so a look-up table doesn't also clutter the
// CSV — and the reference stays stable across saves). This is what lets you join
// to ANY table without having to understand "datasets".
function joinSourceDefs() {
  const out = [];
  let tN = 0;
  let lN = 0;
  for (const st of flattenSteps(steps)) {
    if (st.type !== 'scrapeTable' && st.type !== 'scrapeList') continue;
    const fields = (st.fields || [])
      .filter((f) => (f.name || '').trim() && f.include !== false)
      .map((f) => ({ name: f.name, label: f.name })); // current name (renames must show)
    if (!fields.length) continue;
    const isTable = st.type === 'scrapeTable';
    if (isTable) tN++; else lN++;
    const kept = st.keep === 'dataset' && (st.dataset || '').trim();
    out.push({
      kept: !!kept,
      name: kept ? st.dataset.trim() : '',
      step: st,
      isTable,
      ordinal: isTable ? tN : lN,
      cols: fields.slice(0, 3).map((f) => f.name).join(', '),
      fields
    });
  }
  return out;
}

// Make a dataset name unique against the datasets that already exist (so we never
// auto-suggest a name that's already taken — which would silently reuse/collide).
function uniqueDatasetName(base) {
  const existing = new Set(datasetDefs().map((d) => d.name));
  let name = sanitizeDatasetName(base) || 'data';
  let i = 2;
  while (existing.has(name)) name = (sanitizeDatasetName(base) || 'data') + i++;
  return name;
}

// A safe, unique dataset name auto-derived from a grab step (used when the user
// picks a CSV table for look-ups and we keep it as a dataset for them).
function autoDatasetName(st) {
  const first = (st.fields || []).find((f) => (f.name || '').trim());
  return uniqueDatasetName((first && first.name) || (st.type === 'scrapeTable' ? 'table' : 'list'));
}

// Every name you can use in a rule. Columns AND working values share ONE
// namespace — you always read a value by its name, whatever it's kept as.
function collectVarNames(list, out) {
  out = out || new Set();
  for (const s of list) {
    if ((s.type === 'get' || s.type === 'setVar' || s.type === 'scrape' || s.type === 'formula') && s.name) out.add(s.name);
    if ((s.type === 'scrapeTable' || s.type === 'scrapeList') && s.keep === 'dataset' && s.dataset) out.add(s.dataset);
    if ((s.type === 'repeat' || s.type === 'forEach') && s.indexVar) out.add(s.indexVar);
    if (s.type === 'forDates' && s.var) out.add(s.var);
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

// "Run up to here": run every step before `s`, then stop — leaving the browser
// where `s` would act, so you can edit `s` against the live page (e.g. after
// reopening the app, without running the whole job). Inside a loop, it stops on
// the first iteration that reaches the step.
function runToHere(s) {
  if (running) return log('Already running — press ■ Stop first.', 'warn');
  runSteps({ stopBeforeId: s.id });
}

// --- Right-click menu on a step --------------------------------------------

let ctxMenuEl = null;
function closeCtxMenu() {
  if (ctxMenuEl) ctxMenuEl.remove();
  ctxMenuEl = null;
  document.removeEventListener('click', closeCtxMenu);
  document.removeEventListener('keydown', onCtxKey);
}
function onCtxKey(e) {
  if (e.key === 'Escape') closeCtxMenu();
}
function showStepMenu(x, y, s, list) {
  closeCtxMenu();
  const menu = el('div', { className: 'ctx-menu' });
  const item = (label, hint, onClick, disabled) => {
    const b = el('button', { className: 'ctx-item' + (disabled ? ' disabled' : ''), disabled: !!disabled });
    b.append(el('span', { className: 'ci-label', textContent: label }));
    if (hint) b.append(el('span', { className: 'ci-hint', textContent: hint }));
    if (!disabled) b.addEventListener('click', (ev) => { ev.stopPropagation(); closeCtxMenu(); onClick(); });
    return b;
  };
  menu.append(item('⤓ Run up to here', 'run the steps before this, then stop — so you can edit it against the live page', () => runToHere(s), running));
  menu.append(el('div', { className: 'ctx-sep' }));
  menu.append(item('✎ Edit', '', () => openStepEditor(s, list, false)));
  menu.append(item('🗑 Delete', '', () => deleteStepFrom(list, s.id)));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  ctxMenuEl = menu;
  // Defer so this same right-click doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('click', closeCtxMenu);
    document.addEventListener('keydown', onCtxKey);
  }, 0);
}
function wireStepContext(rowEl, s, list) {
  rowEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showStepMenu(e.clientX, e.clientY, s, list);
  });
}

// Recursively render a step list into an <ol>, nesting block children.
function renderList(list, ol) {
  ol.innerHTML = '';
  ol._list = list;
  wireListDrop(ol, list); // let steps be dropped into (even empty) containers
  list.forEach((s, i) => {
    if (s.type === 'group') {
      ol.append(renderGroup(s, list));
      return;
    }
    const meta = STEP_META[s.type];
    const li = el('li', {
      className: 'step' + (isBlock(s) ? ' block-step' : '') + ' cat-' + stepCategory(s),
      draggable: true
    });
    li.dataset.id = s.id;

    const row = el('div', { className: 'step-row' }, [
      el('span', { className: 'idx', textContent: i + 1 }),
      el('div', { className: 'body' }, [
        el('div', { className: 'kind', textContent: `${meta.icon} ${meta.label}` }),
        el('div', { className: 'detail', textContent: stepDetail(s), title: stepDetail(s) })
      ]),
      el('div', { className: 'acts' }, [
        el('button', { textContent: '⤓', title: 'Run up to here (then stop, so you can edit against the live page)', onclick: () => runToHere(s) }),
        el('button', { textContent: '✎', title: 'Edit', onclick: () => openStepEditor(s, list, false) }),
        el('button', { textContent: '🗑', title: 'Delete', onclick: () => deleteStepFrom(list, s.id) })
      ])
    ]);
    li.append(row);
    wireStepContext(row, s, list);
    wireDrag(li, list, s);

    if (isBlock(s)) {
      const blocks = el('div', { className: 'blocks' });
      for (const key of BLOCK_TYPES[s.type]) {
        blocks.append(blockSection(labelFor(s.type, key), s[key], { type: s.type, key }));
      }
      li.append(blocks);
    }
    ol.append(li);
  });
}

// A "Task" (group) renders as a collapsible folder rather than a generic block:
// a header you can click to expand/collapse, and a body that is just another
// step list. This is the "expandable task" idea — tidy at the top level, full
// detail one click away.
function renderGroup(s, list) {
  const li = el('li', { className: 'step group-step', draggable: true });
  li.dataset.id = s.id;
  const n = countSteps(s.body || []);

  const chevron = el('span', { className: 'grp-chevron', textContent: s.collapsed ? '▸' : '▾' });
  const header = el('div', { className: 'step-row grp-row' }, [
    chevron,
    el('span', { className: 'grp-emoji', textContent: s.emoji || '📦' }),
    el('div', { className: 'body' }, [
      el('div', { className: 'kind grp-name', textContent: s.name || 'Task' }),
      el('div', { className: 'detail', textContent: `${n} step${n === 1 ? '' : 's'}${s.note ? ' · ' + s.note : ''}` })
    ]),
    el('div', { className: 'acts' }, [
      el('button', { textContent: '⤓', title: 'Run up to here (then stop)', onclick: (e) => { e.stopPropagation(); runToHere(s); } }),
      el('button', { textContent: '☆', title: 'Save this task to your library', onclick: (e) => { e.stopPropagation(); saveTaskToLibrary(s); } }),
      el('button', { textContent: '✎', title: 'Edit', onclick: (e) => { e.stopPropagation(); openStepEditor(s, list, false); } }),
      el('button', { textContent: '🗑', title: 'Delete', onclick: (e) => { e.stopPropagation(); deleteStepFrom(list, s.id); } })
    ])
  ]);
  header.addEventListener('click', () => {
    s.collapsed = !s.collapsed;
    renderSteps();
    markDirty();
  });
  li.append(header);
  wireStepContext(header, s, list);
  wireDrag(li, list, s);

  if (!s.collapsed) {
    const blocks = el('div', { className: 'blocks grp-body' });
    blocks.append(blockSection('', s.body, { type: 'group', key: 'body' }));
    li.append(blocks);
  }
  return li;
}

function labelFor(type, key) {
  if (type === 'if') return key === 'then' ? 'Then' : 'Else';
  if (type === 'repeat') return 'Repeat body';
  if (type === 'forEach') return 'For each';
  if (type === 'forDates') return 'Do this for each date';
  if (type === 'try') return key === 'body' ? 'Try these steps' : 'If it fails, recover';
  if (type === 'group') return '';
  return 'While body';
}

function blockSection(label, childList, opts = {}) {
  const wrap = el('div', { className: 'block' + (opts.type ? ' block-' + opts.type + '-' + opts.key : '') });
  if (label) wrap.append(el('div', { className: 'block-label', textContent: label }));
  const childOl = el('ol', { className: 'steps nested' });
  renderList(childList, childOl);
  wrap.append(childOl);
  const add = el('button', { className: 'add-in-block', textContent: '+ add step' });
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddStep(childList); // same directory as the sidebar's "＋ Add step"
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

// --- Drag to reorder / re-parent -------------------------------------------
//
// A step can be dragged within its list OR into a different list — a block's
// Then/Else/body, a Task's body, etc. This is what makes nesting genuinely
// usable: you build steps top-to-bottom, then drag them into the task or the
// branch they belong to. We guard against dropping a block into its own
// descendant (which would create a cycle).

let dragId = null;
let dragList = null;
let dragStep = null;

// Is `targetList` somewhere inside `step`'s own subtree? Used to forbid dropping
// a container into itself.
function listInsideStep(step, targetList) {
  if (!isBlock(step)) return false;
  for (const k of BLOCK_TYPES[step.type]) {
    const child = step[k] || [];
    if (child === targetList) return true;
    for (const c of child) if (listInsideStep(c, targetList)) return true;
  }
  return false;
}

// A move is legal unless it would put a block inside itself.
function canDropInto(targetList) {
  if (!dragStep) return false;
  if (targetList === dragList) return true; // reorder in place is always fine
  return !listInsideStep(dragStep, targetList);
}

// Remove the dragged step from wherever it currently lives and return it.
function detachDragged() {
  const from = dragList.findIndex((s) => String(s.id) === String(dragId));
  if (from < 0) return null;
  return dragList.splice(from, 1)[0];
}

function wireDrag(li, list, step) {
  li.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    dragId = li.dataset.id;
    dragList = list;
    dragStep = step;
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', (e) => {
    e.stopPropagation();
    li.classList.remove('dragging');
    dragId = dragList = dragStep = null;
    document.querySelectorAll('.drop-target, .drop-into').forEach((n) =>
      n.classList.remove('drop-target', 'drop-into'));
  });
  li.addEventListener('dragover', (e) => {
    if (!canDropInto(list)) return;
    e.preventDefault();
    e.stopPropagation();
    li.classList.add('drop-target');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove('drop-target');
    if (!canDropInto(list)) return;
    // Dropping a step onto itself is a no-op.
    if (String(dragId) === String(li.dataset.id) && dragList === list) return;
    const moved = detachDragged();
    if (!moved) return;
    let to = list.findIndex((s) => String(s.id) === String(li.dataset.id));
    if (to < 0) to = list.length;
    list.splice(to, 0, moved);
    renderSteps();
    markDirty();
  });
}

// Let a whole list act as a drop zone, so a step can be dropped into an EMPTY
// block/task (where there are no sibling rows to aim at) — it appends to the end.
// The root <ol> persists across re-renders, so we wire it only once and always
// read the CURRENT backing list from `ol._list` (set by renderList).
function wireListDrop(ol, list) {
  if (ol._dropWired) return;
  ol._dropWired = true;
  ol.addEventListener('dragover', (e) => {
    if (!canDropInto(ol._list)) return;
    e.preventDefault();
    ol.classList.add('drop-into');
  });
  ol.addEventListener('dragleave', (e) => {
    if (e.target === ol) ol.classList.remove('drop-into');
  });
  ol.addEventListener('drop', (e) => {
    ol.classList.remove('drop-into');
    if (!canDropInto(ol._list)) return;
    // If the drop landed on a specific step row, that row's handler already ran.
    if (e.target.closest('.step')) return;
    e.preventDefault();
    e.stopPropagation();
    const moved = detachDragged();
    if (!moved) return;
    ol._list.push(moved);
    renderSteps();
    markDirty();
  });
}

// --- Floating "add step" menu (used inside blocks) -------------------------

// Grouped exactly like the sidebar palette — the data steps first, because
// that's what people are actually here for.
const PALETTE_GROUPS = [
  { title: 'Get the data', types: ['scrapeTable', 'scrapeList', 'get', 'formula', 'spread', 'join'] },
  { title: 'Do something on the page', types: [
    'click', 'type', 'clickText', 'select', 'check', 'hover', 'key',
    'scroll', 'waitFor', 'wait', 'loadAll', 'goto', 'back', 'refresh'] },
  { title: 'Repeat & decide', types: ['forEach', 'forDates', 'if', 'skip', 'while', 'repeat', 'break'] },
  { title: 'Organize & protect', types: ['group', 'try'] }
];
const NO_EDITOR = new Set(['break', 'emitRow', 'back', 'skip', 'refresh']); // nothing to configure

// `pos` (optional) is the canvas position to give the new node when it's added
// from the Map, so it lands where the user asked for it.
function addStepOfType(type, list, pos) {
  const step = { id: nextId(), ...BLANK[type]() };
  if (pos) {
    step.gx = pos.gx;
    step.gy = pos.gy;
  }
  if (NO_EDITOR.has(type)) {
    list.push(step);
    renderSteps();
    markDirty();
    if (typeof renderMap === 'function' && !$('#map-modal').classList.contains('hidden')) renderMap();
    return;
  }
  openStepEditor(step, list, true); // the modal-save hook re-renders the Map
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
    waitFirst: true, // wait for the element to appear before reading it
    transforms: [],
    // "place in a cell" destination (used when target === 'cell')
    matchCol: '',
    matchVal: '',
    setCol: ''
  }),
  // 🧮 A computed column: works out a value from data ALREADY collected (single
  // values, list/table columns, kept datasets) — never off the live page. The
  // visual builder (see renderFormulaBuilder / compileFormula) means no typing.
  formula: () => ({
    type: 'formula',
    name: '',
    target: 'column',
    formula: blankFormula('math'),
    matchCol: '',
    matchVal: '',
    setCol: ''
  }),
  scrapeList: () => ({
    type: 'scrapeList',
    rowSelector: '',
    keep: 'rows', // 'rows' → CSV rows; 'dataset' → kept whole under `dataset`
    dataset: '',
    waitFirst: true, // wait for the rows to appear before scraping
    // ONE empty column to fill in — not a junk "text" column that silently
    // grabs the whole row and shows up in the CSV.
    fields: [{ name: '', selector: '', extract: 'text', attr: '' }]
  }),
  // A table is a scrape that's already been done for you: the <th>s name the
  // columns and the <td>s line them up. You point at it once; everything else
  // (columns, names, numbers, summary rows) is read off the table itself.
  scrapeTable: () => ({
    type: 'scrapeTable',
    rowSelector: '',
    skipTotals: true,
    keep: 'rows', // 'rows' → CSV rows; 'dataset' → kept whole under `dataset`
    dataset: '',
    waitFirst: true, // wait for the table rows to appear before scraping
    fields: []
  }),
  // ⚡ Spread a kept dataset into one column per row — the pivot. Points at a
  // dataset made by a "keep as dataset" table/list step above it. `valCols` may
  // hold several measures (Total AND Margin); `namePattern` names each column,
  // with {} standing in for the key value (e.g. "Sales ({})").
  spread: () => ({
    type: 'spread',
    dataset: '',
    keyCol: '',
    valCols: [],
    namePattern: ''
  }),
  // 🔗 Join — the spreadsheet look-up / SQL LEFT JOIN. Take a "left" set of rows
  // (the rows you're collecting, OR another kept dataset) and, for each one, find
  // the matching row in a kept dataset (`dataset`) where `onLeft` == `onRight`,
  // then pull in the chosen columns (`bring`, empty = all). `prefix` avoids name
  // clashes. If the left side is itself a dataset, the join EMITS combined rows;
  // otherwise it ADDS the columns onto the rows you've already collected.
  join: () => ({
    type: 'join',
    leftSource: 'rows', // 'rows' (what you're collecting) | a kept dataset name
    dataset: '', // the kept dataset to look values up in (the "right" table)
    onLeft: '', // left key column
    onRight: '', // right (dataset) key column
    bring: [], // which right columns to add (empty = all except the key)
    prefix: '' // optional name prefix for the added columns
  }),
  skip: () => ({ type: 'skip' }),
  goto: () => ({ type: 'goto', url: '' }),
  back: () => ({ type: 'back' }),
  refresh: () => ({ type: 'refresh' }),
  if: () => ({ type: 'if', condition: { match: 'all', rules: [newRule()] }, then: [], else: [] }),
  // `filter` keeps only the matched elements whose text/attr/number pass the
  // rules (empty rules = keep all) — so "For each … where it contains Xbox".
  forEach: () => ({ type: 'forEach', selector: '', filter: { match: 'all', rules: [] }, indexVar: 'i', startAt: 0, body: [], maxIter: 1000 }),
  // 📅 A date-range loop: run the body once per date from `from` to `to`, with the
  // current date available as {{var}} (formatted per `format`) — and, by default,
  // dropped in as a CSV column so every row is dated.
  forDates: () => ({
    type: 'forDates',
    from: '',
    to: '',
    stepDays: 1,
    var: 'date',
    format: 'YYYY-MM-DD',
    asColumn: true,
    body: [],
    maxIter: 1000
  }),
  while: () => ({ type: 'while', condition: { match: 'all', rules: [newRule()] }, body: [], maxIter: 1000 }),
  repeat: () => ({ type: 'repeat', count: '10', indexVar: 'i', startAt: 0, body: [] }),
  try: () => ({ type: 'try', retries: 0, body: [], onError: [] }),
  group: () => ({ type: 'group', name: 'Task', emoji: '📦', note: '', collapsed: false, body: [] }),
  break: () => ({ type: 'break' })
};

// ===========================================================================
// Add-step directory (the single "＋ Add step" entry point)
//
// Replaces the old wall of palette buttons: one button opens a categorised
// directory (with plain-language descriptions) that adds a step to whatever list
// you're building — the top-level program, or a block/Task via its "+ add step".
// Saved library Tasks are offered here too.
// ===========================================================================

const STEP_DESC = {
  scrapeTable: 'An HTML table → point at it once; its columns fill in for you',
  scrapeList: 'A repeating list → many rows at once (product cards, search results)',
  get: 'One value read off the page → a named column (or a working value)',
  formula: 'Work out a column from data you already grabbed — maths, %, combine, look-up',
  spread: 'Pivot a kept table/list → one column per row (a column per person)',
  join: 'Match rows to a kept table/list by a shared value → pull its columns in (like a spreadsheet look-up / SQL join)',
  click: 'Click an element — links, buttons, menus',
  type: 'Type into a field (text, number, date)',
  clickText: 'Click by visible text — calendar days, dropdown options, tabs',
  select: 'Choose an option in a native dropdown',
  check: 'Check / uncheck a checkbox or radio',
  hover: 'Hover to reveal menus & tooltips',
  key: 'Press a key (Enter, Tab, arrows…)',
  scroll: 'Scroll the page',
  waitFor: 'Wait until an element appears (or disappears)',
  wait: 'Pause for a fixed time',
  loadAll: 'Auto-scroll (and “load more”) until everything is loaded',
  goto: 'Navigate to a URL (supports {{variables}})',
  back: 'Go back to the previous page',
  refresh: 'Reload the current page',
  forEach: 'Run steps once per matching item — each pass makes a row',
  forDates: 'Run steps once per date in a range — a from/to date loop',
  if: 'Run steps only when a condition is true',
  skip: 'Abandon this item — no row for it — and move on',
  while: 'Repeat while a condition holds',
  repeat: 'Repeat a fixed number of times',
  break: 'Exit the current loop',
  group: 'Group steps into a named, collapsible Task (reusable)',
  try: 'Run steps; if any fails, run recovery steps (with retries)'
};

let addStepTarget = null; // the list a chosen step is added to
let addStepPos = null; // canvas position, when opened from the Map

function openAddStep(list, pos) {
  addStepTarget = list || steps;
  addStepPos = pos || null;
  const body = $('#addstep-body');
  body.innerHTML = '';
  for (const g of PALETTE_GROUPS) {
    body.append(el('div', { className: 'as-group-title', textContent: g.title }));
    const grid = el('div', { className: 'as-grid' });
    for (const t of g.types) {
      const m = STEP_META[t];
      const b = el('button', { className: 'as-item' + (g.title === 'Get the data' ? ' as-key' : '') });
      b.setAttribute('data-add', t); // keeps the step reachable by type (tests + a11y)
      b.append(
        el('span', { className: 'as-ic', textContent: m.icon }),
        el('span', { className: 'as-txt' }, [
          el('b', { textContent: m.label }),
          el('i', { textContent: STEP_DESC[t] || '' })
        ])
      );
      b.addEventListener('click', () => {
        const list = addStepTarget;
        const pos = addStepPos;
        closeAddStep();
        addStepOfType(t, list, pos);
      });
      grid.append(b);
    }
    body.append(grid);
  }
  // Saved library Tasks, if any.
  window.harvest.tasks.list().then((libs) => {
    if (!libs || !libs.length || $('#addstep-modal').classList.contains('hidden')) return;
    body.append(el('div', { className: 'as-group-title', textContent: 'Your saved tasks' }));
    const grid = el('div', { className: 'as-grid' });
    for (const rec of libs) {
      const b = el('button', { className: 'as-item' });
      const del = el('span', { className: 'as-del', title: 'Remove from library', textContent: '✕' });
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.harvest.tasks.remove(rec.id);
        openAddStep(addStepTarget); // refresh
      });
      b.append(
        el('span', { className: 'as-ic', textContent: rec.emoji || '📦' }),
        el('span', { className: 'as-txt' }, [
          el('b', { textContent: rec.name }),
          el('i', { textContent: rec.note || 'your saved task' })
        ]),
        del
      );
      b.addEventListener('click', () => {
        const list = addStepTarget;
        closeAddStep();
        insertTaskInto(list, rec);
      });
      grid.append(b);
    }
    body.append(grid);
  }).catch(() => {});
  $('#addstep-modal').classList.remove('hidden');
}
function closeAddStep() {
  $('#addstep-modal').classList.add('hidden');
}
$('#add-step').addEventListener('click', () => openAddStep(steps));
$('#addstep-close').addEventListener('click', closeAddStep);
$('#addstep-modal').addEventListener('click', (e) => {
  if (e.target.id === 'addstep-modal') closeAddStep(); // click the backdrop to dismiss
});

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
  resetModalPos(); // always open centred, wherever the last one was dragged to
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  editing = null;
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal-cancel').addEventListener('click', closeModal);

// EVERY modal is DRAGGABLE by its header and RESIZABLE by its bottom-right corner
// (resize is CSS — see .modal-card). Dragging shifts the card with a transform
// offset (read back from the transform, so each modal tracks its own position and
// keeps it while briefly hidden for a Pick). The step editor re-centres each time
// a new editor opens (resetModalPos, called from openStepEditor); a user's chosen
// SIZE is left alone so it sticks.
function resetModalPos() {
  const card = $('#modal .modal-card');
  if (card) card.style.transform = '';
}
function makeModalDraggable(card) {
  const head = card.querySelector('.modal-head');
  if (!head) return;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  const currentOffset = () => {
    const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(card.style.transform || '');
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
  };
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return; // the ✕ close button isn't a drag handle
    dragging = true;
    head.classList.add('dragging');
    startX = e.clientX;
    startY = e.clientY;
    const o = currentOffset();
    baseX = o.x;
    baseY = o.y;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    card.style.transform = `translate(${baseX + (e.clientX - startX)}px, ${baseY + (e.clientY - startY)}px)`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    head.classList.remove('dragging');
  });
}
(function wireAllModalsDraggable() {
  document.querySelectorAll('.modal .modal-card').forEach(makeModalDraggable);
})();

function field(label, control, hint) {
  const f = el('div', { className: 'field' });
  f.append(el('label', { textContent: label }), control);
  if (hint) f.append(el('div', { className: 'hint', textContent: hint }));
  return f;
}

// The "place in a cell" destination editor, shared by Grab-a-value and Formula.
// Row = find/create where <matchCol> = <matchVal> (upsert); then fill <setCol>.
// Renders nothing unless the step's target is 'cell'.
function renderCellDest(s, host) {
  host.innerHTML = '';
  if (s.target !== 'cell') return;
  const mc = el('input', { value: s.matchCol || '', placeholder: 'e.g. metal' });
  mc.addEventListener('input', () => (s.matchCol = mc.value));
  const mv = el('input', { value: s.matchVal || '', placeholder: 'e.g. Silver   (or {{metal}})' });
  mv.addEventListener('input', () => (s.matchVal = mv.value));
  const sc = el('input', { value: s.setCol || '', placeholder: 'e.g. price' });
  sc.addEventListener('input', () => (s.setCol = sc.value));
  host.append(
    field('Row — find or create where',
      el('div', { className: 'formula-row' }, [mc, el('span', { className: 'formula-op', textContent: '=' }), mv]),
      'Which row this value belongs to. If the key value is new, a new row (and this key column) is created; ' +
      'otherwise the existing row is updated. The value can be fixed text or a {{grabbed value}}.'),
    field('Column to fill', sc,
      'The value lands in this column — created if it doesn’t exist yet. Blank = use the step’s name.')
  );
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

  // `extra` lets the initial on-open check retry (tries > 1) while live typing
  // stays instant.
  const check = (extra) => updateSelStatus(status, input.value, relTo(), Object.assign({}, opts, extra));
  pick.addEventListener('click', () =>
    startPick(opts.mode || 'element', {
      type: 'input',
      input,
      relativeTo: relTo(), // resolved at click time: `editing.abs` may have been toggled
      noChoice: !!opts.noChoice, // skip the "which one?" prompt (e.g. a table)
      pickWants: opts.pickWants || (opts.mode === 'list' ? 'many' : 'one'),
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
  // Confirm what's already there when the editor opens — retrying, since the
  // webview can return 0 on the very first eval after reopen.
  setTimeout(() => check({ tries: 6 }), 0);
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
  const query = `(() => {
      let els; try { els = document.querySelectorAll(${JSON.stringify(full)}); } catch (e) { return { bad: true }; }
      const first = els[0];
      const txt = first ? (first.innerText || first.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      return { n: els.length, sample: txt.slice(0, 60) };
    })()`;
  // On the automatic on-open check (opts.tries > 1) a "0 matches" is retried a
  // few times, because the webview sometimes returns 0 on the first eval right
  // after the editor opens. A definitively-bad selector stops immediately; live
  // typing (tries = 1) stays instant.
  const info = await pageEvalStable(query, (r) => !r || (!r.bad && !r.n), Math.max(1, opts.tries || 1));
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

// A collapsible cheat-sheet of the date functions + format tokens, shown in the
// "For each date" editor. These functions work anywhere an expression does — a
// 🧮 Formula, or inside {{…}} in a URL / field — so users have a reference on hand.
function dateReference() {
  const wrap = el('details', { className: 'date-ref' });
  wrap.append(el('summary', { textContent: '📘 Date functions & format tokens (use in a 🧮 Formula or {{…}})' }));
  const body = el('div', { className: 'date-ref-body' });

  body.append(el('div', { className: 'dr-head', textContent: 'Format tokens' }));
  body.append(el('div', { className: 'dr-line', textContent:
    'YYYY→2026 · YY→26 · MMMM→July · MMM→Jul · MM→07 · M→7 · DD→07 · D→7' }));

  body.append(el('div', { className: 'dr-head', textContent: 'Functions' }));
  const rows = [
    ['dateAdd(date, days)', 'add/subtract days, rolls over months/years', 'dateAdd("2026-12-30", 3) → 2027-01-02'],
    ['dateFmt(date, format)', 're-write a date in any format', 'dateFmt("2026-07-07", "D MMM YYYY") → 7 Jul 2026'],
    ['dateDiff(from, to)', 'whole days between two dates', 'dateDiff("2026-07-01", "2026-07-31") → 30'],
    ['today()', 'today’s date (YYYY-MM-DD)', 'today() → ' + EXPR.today()]
  ];
  for (const [sig, what, eg] of rows) {
    const row = el('div', { className: 'dr-fn' });
    row.append(
      el('code', { className: 'dr-sig', textContent: sig }),
      el('div', { className: 'dr-what', textContent: what }),
      el('code', { className: 'dr-eg', textContent: eg })
    );
    body.append(row);
  }
  body.append(el('div', { className: 'dr-line', textContent:
    'e.g. in a URL: …?date={{dateFmt(' + 'date' + ', "DD/MM/YYYY")}}   ·   in a Formula: dateAdd(date, 7)' }));

  wrap.append(body);
  return wrap;
}

// A camelCase identifier from free text: "Sales by User" → "salesByUser".
function slugName(text) {
  const parts = String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  if (!parts[0]) return '';
  return parts[0] + parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}
// Keep a dataset name to a safe identifier as the user types.
const sanitizeDatasetName = (v) => String(v || '').replace(/[^A-Za-z0-9_$]/g, '');

// The "rows vs. keep-as-dataset" choice shared by Grab-a-table and Grab-a-list.
// `suggested` seeds the name the first time they switch to "keep". `rerender`
// redraws the surrounding editor so the name field shows/hides.
function datasetKeepControl(s, suggested, rerender) {
  const kind = s.type === 'scrapeList' ? 'list' : 'table';
  const wrap = el('div', { className: 'keep-control' });
  const sel = select(s.keep === 'dataset' ? 'dataset' : 'rows', [
    { value: 'rows', label: 'Put its rows straight into the CSV' },
    { value: 'dataset', label: 'Keep it to pull values from (Formula / Spread)' }
  ]);
  sel.addEventListener('change', () => {
    s.keep = sel.value;
    if (s.keep === 'dataset' && !(s.dataset || '').trim()) s.dataset = uniqueDatasetName(suggested || kind);
    rerender();
  });
  wrap.append(field(`What should happen with this ${kind}?`, sel));
  if (s.keep === 'dataset') {
    const nm = el('input', { value: s.dataset || '', placeholder: 'e.g. salesByUser' });
    nm.addEventListener('input', () => {
      s.dataset = sanitizeDatasetName(nm.value);
      if (nm.value !== s.dataset) nm.value = s.dataset;
    });
    wrap.append(field('Call this dataset', nm,
      'A short name (letters & numbers). You’ll choose it in a Formula “look-up” or a ⚡ Spread step.'));
  }
  return wrap;
}

// One side of a formula: "a value" (a column/single-value by name), "a number",
// or "fixed text". `allowed` limits which types make sense (maths → col/num;
// combine → col/text). Rebuilds itself in place when the type changes.
function operandControl(operand, allowed, onChange) {
  const wrap = el('span', { className: 'operand' });
  const build = () => {
    wrap.innerHTML = '';
    if (!operand.type || !allowed.includes(operand.type)) operand.type = allowed[0];
    const label = (t) => (t === 'col' ? 'a value' : t === 'num' ? 'a number' : 'fixed text');
    // Only show the type chooser when there's an actual choice — a single-type
    // operand (e.g. a list value) just shows its value dropdown, no clutter.
    if (allowed.length > 1) {
      const ts = select(operand.type, allowed.map((t) => ({ value: t, label: label(t) })));
      ts.addEventListener('change', () => {
        operand.type = ts.value;
        build();
        onChange();
      });
      wrap.append(ts);
    }
    if (operand.type === 'col') {
      const nm = valueNames();
      const opts = [{ value: '', label: 'pick a value…' }].concat(nm.map((n) => ({ value: n, label: n })));
      if (operand.v && !nm.includes(operand.v)) opts.push({ value: operand.v, label: operand.v });
      const vs = select(operand.v || '', opts);
      vs.addEventListener('change', () => {
        operand.v = vs.value;
        onChange();
      });
      wrap.append(vs);
    } else {
      const inp = el('input', {
        value: operand.v == null ? '' : operand.v,
        type: operand.type === 'num' ? 'number' : 'text',
        placeholder: operand.type === 'num' ? '0' : 'text',
        style: 'width:100px'
      });
      inp.addEventListener('input', () => {
        operand.v = inp.value;
        onChange();
      });
      wrap.append(inp);
    }
  };
  build();
  return wrap;
}

// The Formula builder: a preset dropdown + preset-specific dropdowns, and a live
// read-only preview of the compiled formula. Re-renders itself into `host`.
function renderFormulaBuilder(s, host) {
  host.innerHTML = '';
  if (!s.formula || !s.formula.kind) s.formula = blankFormula('math');
  const f = s.formula;

  const preview = el('div', { className: 'formula-preview' });
  const refresh = () => {
    const code = compileFormula(f);
    preview.textContent = code ? '= ' + code : '(fill the boxes in)';
  };

  const kindSel = select(f.kind, [
    { value: 'value', label: 'Just use a value as-is  ( no maths )' },
    { value: 'math', label: 'Maths  ( A ＋－×÷ B )' },
    { value: 'percent', label: 'Percentage  ( A as % of B )' },
    { value: 'combine', label: 'Combine text  ( join values )' },
    { value: 'textTest', label: 'Yes/No test  ( contains, starts with… )' },
    { value: 'lookup', label: 'Look up a value from a table / list' },
    { value: 'listFirst', label: 'List: the first thing in it' },
    { value: 'listRest', label: 'List: everything except the first thing' },
    { value: 'listAppend', label: 'List: a list with more added' }
  ]);
  kindSel.addEventListener('change', () => {
    s.formula = blankFormula(kindSel.value);
    renderFormulaBuilder(s, host);
  });
  host.append(field('What kind?', kindSel));

  const body = el('div', { className: 'formula-body' });
  host.append(body);

  if (f.kind === 'value') {
    body.append(el('div', { className: 'formula-row' }, [operandControl(f.v, ['col', 'text', 'num'], refresh)]));
    body.append(el('div', { className: 'hint', textContent:
      'Puts a value straight into the column — e.g. pick “date” to stamp the current date on the row. No maths.' }));
  } else if (f.kind === 'math') {
    const opSel = select(f.op || '-', [
      { value: '+', label: '＋ add' },
      { value: '-', label: '－ subtract' },
      { value: '*', label: '× multiply' },
      { value: '/', label: '÷ divide' }
    ]);
    opSel.addEventListener('change', () => {
      f.op = opSel.value;
      refresh();
    });
    body.append(el('div', { className: 'formula-row' }, [
      operandControl(f.a, ['col', 'num'], refresh),
      opSel,
      operandControl(f.b, ['col', 'num'], refresh)
    ]));
    body.append(el('div', { className: 'hint', textContent: 'e.g. Net − Cost, or price × 1.2.' }));
  } else if (f.kind === 'percent') {
    body.append(el('div', { className: 'formula-row' }, [
      operandControl(f.part, ['col', 'num'], refresh),
      el('span', { className: 'formula-op', textContent: 'as % of' }),
      operandControl(f.whole, ['col', 'num'], refresh)
    ]));
    body.append(el('div', { className: 'hint', textContent: 'e.g. Margin as % of Net → 33.75.' }));
  } else if (f.kind === 'combine') {
    const sepInp = el('input', { value: f.sep == null ? ' ' : f.sep, placeholder: '(a space)', style: 'width:90px' });
    sepInp.addEventListener('input', () => {
      f.sep = sepInp.value;
      refresh();
    });
    body.append(field('Put between the pieces', sepInp, 'A space, a dash “-”, a comma… left blank glues them straight together.'));
    const partsWrap = el('div');
    const renderParts = () => {
      partsWrap.innerHTML = '';
      (f.parts || []).forEach((p, i) => {
        const del = el('button', { textContent: '✕', title: 'Remove this piece' });
        del.addEventListener('click', () => {
          f.parts.splice(i, 1);
          renderParts();
          refresh();
        });
        partsWrap.append(el('div', { className: 'formula-row' }, [operandControl(p, ['col', 'text'], refresh), del]));
      });
      const add = el('button', { className: 'add-in-block', textContent: '+ add piece' });
      add.addEventListener('click', () => {
        (f.parts = f.parts || []).push({ type: 'col', v: '' });
        renderParts();
        refresh();
      });
      partsWrap.append(add);
    };
    renderParts();
    body.append(partsWrap);
  } else if (f.kind === 'textTest') {
    const opSel = select(f.op || 'contains', TEXT_TEST_OPS.map((o) => ({ value: o.v, label: o.label })));
    const bWrap = el('span', { className: 'operand-wrap' }, [operandControl(f.b, ['text', 'col'], refresh)]);
    const syncB = () => { bWrap.style.display = TEXT_TEST_NOVALUE.has(f.op) ? 'none' : ''; };
    opSel.addEventListener('change', () => { f.op = opSel.value; syncB(); refresh(); });
    body.append(el('div', { className: 'formula-row' }, [operandControl(f.a, ['col', 'text'], refresh), opSel, bWrap]));
    syncB();
    body.append(el('div', { className: 'hint', textContent:
      'A Yes/No answer — e.g. does the Name contain “gold”, or is the Barserial empty. ' +
      'Great as a column, or feed it into an “If” / “Skip item” to keep only the rows you want.' }));
  } else if (f.kind === 'listFirst' || f.kind === 'listRest') {
    body.append(el('div', { className: 'formula-row' }, [operandControl(f.v, ['col'], refresh)]));
    body.append(el('div', { className: 'hint', textContent: f.kind === 'listFirst'
      ? 'Takes the FIRST thing out of a list you collected — e.g. the next URL to visit from a queue.'
      : 'The list with its first thing removed. Pair with “the first thing in it” to walk a queue one item at a time.' }));
  } else if (f.kind === 'listAppend') {
    body.append(el('div', { className: 'formula-row' }, [
      operandControl(f.a, ['col'], refresh),
      el('span', { className: 'formula-op', textContent: 'plus' }),
      operandControl(f.b, ['col'], refresh)
    ]));
    body.append(el('div', { className: 'hint', textContent:
      'Joins two lists into one — e.g. add newly-found links to your crawl queue.' }));
  } else if (f.kind === 'lookup') {
    const defs = datasetDefs();
    if (!defs.length) {
      body.append(el('div', { className: 'warn-box', textContent:
        'No kept tables/lists yet. Add a “Grab a table” (or “Grab a list”) above this step, set it to ' +
        '“Keep to pull values from” and give it a name — then choose it here.' }));
    } else {
      const dsSel = select(f.dataset || '',
        [{ value: '', label: 'pick a table / list…' }].concat(defs.map((d) => ({ value: d.name, label: d.name }))));
      const colWrap = el('div');
      const renderCols = () => {
        colWrap.innerHTML = '';
        const def = defs.find((d) => d.name === f.dataset);
        if (!def) return;
        const colOpts = [{ value: '', label: 'pick a column…' }].concat(def.fields.map((c) => ({ value: c.name, label: c.label })));
        const keySel = select(f.keyCol || '', colOpts);
        keySel.addEventListener('change', () => {
          f.keyCol = keySel.value;
          refresh();
        });
        const valInp = el('input', { value: f.keyVal || '', placeholder: 'e.g. Cerys', style: 'width:130px' });
        valInp.addEventListener('input', () => {
          f.keyVal = valInp.value;
          refresh();
        });
        const valSel = select(f.valCol || '', colOpts);
        valSel.addEventListener('change', () => {
          f.valCol = valSel.value;
          refresh();
        });
        colWrap.append(
          field('Find the row where', el('div', { className: 'formula-row' }, [keySel, el('span', { className: 'formula-op', textContent: 'is' }), valInp])),
          field('…and take its', valSel)
        );
      };
      dsSel.addEventListener('change', () => {
        f.dataset = dsSel.value;
        f.keyCol = '';
        f.valCol = '';
        renderCols();
        refresh();
      });
      body.append(field('From this table / list', dsSel));
      body.append(colWrap);
      renderCols();
      body.append(el('div', { className: 'hint', textContent:
        'To make a column for EVERY row in one go (one per person), use the ⚡ Spread into columns step instead.' }));
    }
  }

  host.append(preview);
  refresh();
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
  const raw = await pageEvalStable(
    PA.listExpr(rowSel, cols.filter((f) => f.extract !== 'expr')),
    (r) => !r || !r.length
  );
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
  'loadAll', 'get', 'scrapeList', 'scrapeTable', 'forEach'
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
      { value: 'clickable', label: 'Whether you could click it — e.g. a “Next” button (yes/no)' },
      { value: 'collect', label: 'ALL of them, as a list (for a crawl queue)' },
      { value: 'textExists', label: '— whether some TEXT appears on the page (yes/no)' },
      { value: 'url', label: '— the page’s address (no element needed)' },
      { value: 'expr', label: '— type a raw expression (advanced)' }
    ]);
    src.className = 'src-select';

    const name = el('input', { className: 'name-input', value: s.name, placeholder: 'e.g. price' });
    name.addEventListener('input', () => (s.name = name.value));

    const { wrap, input, check } = selectorInput(s.selector, {
      mode: 'element',
      onFilled: async (sel) => {
        // Picking implies you want something off that element.
        if (s.source === 'expr' || s.source === 'url' || s.source === 'textExists') {
          s.source = 'text';
          src.value = 'text';
        }
        // Auto-pick the RIGHT source: a form field's value is in .value (its text
        // is empty) — the classic "why is it 0/blank?" — so a pick on an input /
        // textarea / select / checkbox / img sets the source for you.
        try {
          const sug = await pageEval(PA.suggestSourceExpr(sel));
          if (sug && sug.strong && sug.source !== s.source) {
            s.source = sug.source;
            src.value = sug.source;
            const what = { value: '“what’s typed in it”', checked: '“whether it’s ticked”', src: '“its image”' }[sug.source] || sug.source;
            log(`Auto-set to ${what} — you picked a <${sug.tag}${sug.type ? ' type=' + sug.type : ''}>.`, 'ok');
          }
        } catch (_) {}
        // Suggest a name from what was picked, so the common case needs no typing.
        if (!(s.name || '').trim()) {
          const guess = suggestName(sel);
          if (guess) {
            s.name = guess;
            name.value = guess;
          }
        }
        sync(); // shows the right fields AND auto-runs the live preview
      }
    });
    input.addEventListener('input', () => {
      s.selector = input.value;
      getPreview();
      if (s.source === 'attr' || s.source === 'collect') refreshAttrList();
    });
    const selField = field('① Which element?', wrap);

    root.append(selField);

    // Wait for the element before reading it — on by default, so a value that's
    // still loading isn't read as blank. Only meaningful for element sources.
    const waitRow = checkboxField('Wait for this to appear on the page first', s.waitFirst !== false, (v) => (s.waitFirst = v));
    root.append(waitRow);

    root.append(field('② What do you want from it?', src));

    // A live "value right now" line so the user sees IMMEDIATELY whether the auto
    // choice is right — no need to press a Test button.
    const livePrev = el('div', { className: 'get-live' });
    root.append(livePrev);

    // Which attribute? Instead of guessing a name, we show the element's ACTUAL
    // attributes as a clickable list, each with the value it would grab. A small
    // "or type one" box remains as an escape hatch.
    const attrList = el('div', { className: 'attr-list' });
    const attr = el('input', { className: 'attr-custom', value: s.attr, placeholder: 'or type one, e.g. data-id' });
    attr.addEventListener('input', () => { s.attr = attr.value; markActiveAttr(); getPreview(); });
    const attrField = field('Which attribute?', el('div', {}, [attrList, attr]),
      'Pick the attribute you want — the value it would grab is shown next to each.');
    root.append(attrField);

    function markActiveAttr() {
      const want = (s.attr || '').trim();
      [...attrList.querySelectorAll('.attr-opt')].forEach((b) => {
        b.classList.toggle('active', b.dataset.attr === want);
      });
    }
    async function refreshAttrList() {
      if (s.source !== 'attr' && s.source !== 'collect') return;
      const full = editingScope && !(editing && editing.abs)
        ? (s.selector ? editingScope + ' ' + s.selector : editingScope) : s.selector;
      attrList.innerHTML = '';
      if (!full) { attrList.append(el('div', { className: 'hint', textContent: 'Pick the element above first ↑' })); return; }
      let attrs = [];
      try { attrs = (await pageEval(PA.attrsExpr(full))) || []; } catch (_) { attrs = []; }
      if (!attrs.length) {
        attrList.append(el('div', { className: 'hint', textContent: 'This element has no attributes — grab its text instead, or type one below.' }));
        return;
      }
      for (const a of attrs) {
        const opt = el('button', { className: 'attr-opt', type: 'button' });
        opt.dataset.attr = a.name;
        opt.append(
          el('span', { className: 'attr-name', textContent: a.name }),
          el('span', { className: 'attr-val', textContent: a.value === '' ? '(empty)' : String(a.value) })
        );
        opt.addEventListener('click', () => {
          s.attr = a.name;
          attr.value = a.name;
          markActiveAttr();
          getPreview();
        });
        attrList.append(opt);
      }
      markActiveAttr();
    }

    const expr = el('input', { value: s.expr, placeholder: 'e.g. was - price' });
    expr.addEventListener('input', () => (s.expr = expr.value));
    const exprField = field('The calculation', expr,
      'Maths and text on values you already have: was - price, price * 1.2, title + " (sale)". ' +
      'For a click-built formula (no typing), use the 🧮 Formula step instead.');
    root.append(exprField);

    // "Whether some TEXT appears" — check for a message (e.g. "Saved") without a
    // selector. Optional container narrows where to look; a live test shows the
    // yes/no right now so you know it's watching the right thing.
    if (!s.textExists) s.textExists = { text: '', mode: 'contains', container: '' };
    const teText = el('input', { value: s.textExists.text, placeholder: 'e.g. Saved successfully' });
    const teResult = el('span', { className: 'te-result' });
    const teTest = async () => {
      const t = (s.textExists.text || '').trim();
      if (!t) { teResult.textContent = ''; return; }
      let hit = false;
      try { hit = await pageEval(PA.textExistsExpr(t, s.textExists.container, s.textExists.mode)); } catch (_) { hit = false; }
      teResult.textContent = hit ? '✓ found on the page right now' : '✗ not on the page right now';
      teResult.className = 'te-result ' + (hit ? 'ok' : 'bad');
    };
    teText.addEventListener('input', () => { s.textExists.text = teText.value; teTest(); });
    const teMode = select(s.textExists.mode, [
      { value: 'contains', label: 'appears anywhere (contains)' },
      { value: 'exact', label: 'is exactly this text' }
    ]);
    teMode.addEventListener('change', () => { s.textExists.mode = teMode.value; teTest(); });
    const teCont = selectorInput(s.textExists.container, { mode: 'element', onFilled: () => teTest() });
    teCont.input.addEventListener('input', () => { s.textExists.container = teCont.input.value; teTest(); });
    const teTestBtn = el('button', { className: 'tf-test', textContent: '👁 Test now' });
    teTestBtn.addEventListener('click', teTest);
    const teField = el('div');
    teField.append(
      field('Text to look for', teText, 'Yes/no depending on whether this text is on the page — e.g. a “Saved” confirmation.'),
      field('Match', teMode),
      field('Look only inside (optional)', teCont.wrap, 'A container to limit the search — leave blank to search the whole page.'),
      el('div', { className: 'tf-bar' }, [teTestBtn]),
      teResult
    );
    root.append(teField);

    // Clean-ups sit right where you'd look after seeing the raw value.
    const cleanWrap = el('div');
    appendTransformList(s, cleanWrap, () =>
      previewRaw(s.selector, s.source === 'expr' || s.source === 'url' ? 'text' : s.source, s.attr)
    );
    root.append(cleanWrap);

    root.append(field('③ Call it', name,
      'This name is the CSV column heading — and how you refer to it in a rule (“price is less than 200”).'));

    const tgt = select(s.target || 'column', [
      { value: 'column', label: 'Put it in the results table & CSV' },
      { value: 'var', label: 'Keep it as a reusable value — for URLs, formulas, row keys, rules (not a CSV column)' },
      { value: 'cell', label: 'Place it in a specific row & column (build / patch a table)' }
    ]);
    tgt.className = 'target-select';
    const cellWrap = el('div');
    tgt.addEventListener('change', () => {
      s.target = tgt.value;
      renderCellDest(s, cellWrap);
    });
    root.append(field('④ Where should it go?', tgt));
    root.append(cellWrap);
    renderCellDest(s, cellWrap);

    // Read the value the step WOULD produce right now, and show it live, so the
    // user sees at a glance whether the source is right (no Test button needed).
    async function getPreview() {
      if (s.source === 'expr' || s.source === 'url' || s.source === 'textExists') { livePrev.textContent = ''; return; }
      if (!s.selector && !editingScope) { livePrev.textContent = ''; return; }
      livePrev.className = 'get-live';
      livePrev.textContent = 'reading the page…';
      const full = editingScope && !(editing && editing.abs)
        ? (s.selector ? editingScope + ' ' + s.selector : editingScope) : s.selector;
      try {
        if (s.source === 'count') {
          const n = await pageEval(`document.querySelectorAll(${JSON.stringify(full)}).length`);
          livePrev.textContent = `value now: ${n}`;
          livePrev.className = 'get-live ok';
          return;
        }
        if (s.source === 'exists') {
          const yes = await pageEval(PA.existsExpr(full));
          livePrev.textContent = `value now: ${yes ? 'yes' : 'no'}`;
          livePrev.className = 'get-live ' + (yes ? 'ok' : 'bad');
          return;
        }
        if (s.source === 'clickable') {
          const yes = await pageEval(PA.clickableExpr(full));
          livePrev.textContent = `value now: ${yes ? 'yes — you could click it' : 'no — missing or disabled'}`;
          livePrev.className = 'get-live ' + (yes ? 'ok' : 'bad');
          return;
        }
        if (s.source === 'collect') {
          const list = await pageEval(PA.collectExpr(full, (s.attr || '').trim() ? 'attr' : 'text', s.attr));
          const n = Array.isArray(list) ? list.length : 0;
          livePrev.textContent = `value now: a list of ${n} item${n === 1 ? '' : 's'}` + (n ? ` — e.g. ${String(list[0]).slice(0, 60)}` : '');
          livePrev.className = 'get-live ' + (n ? 'ok' : 'bad');
          return;
        }
        // Retry: the webview can report "not found" on the first eval after the
        // editor reopens, even though the element is there (and the run works).
        const found = await pageEvalStable(PA.existsExpr(full), (r) => !r);
        if (!found) { livePrev.textContent = '✗ nothing matches that selector on this page'; livePrev.className = 'get-live bad'; return; }
        const mode = s.source === 'attr' && !(s.attr || '').trim() ? 'text' : s.source;
        let raw = await pageEval(PA.extractExpr(full, mode, s.attr));
        const cleaned = cleanValue(s, raw);
        const shown = cleaned === '' || cleaned == null ? '(empty)' : String(cleaned);
        livePrev.textContent = `value now: ${shown.slice(0, 80)}`;
        livePrev.className = 'get-live ' + (shown === '(empty)' ? 'bad' : 'ok');
      } catch (_) {
        livePrev.textContent = '';
      }
    }

    const sync = () => {
      const needsSelector = !(s.source === 'expr' || s.source === 'url' || s.source === 'textExists');
      const readsText = !['expr', 'count', 'exists', 'clickable', 'collect', 'textExists', 'checked'].includes(s.source);
      exprField.style.display = s.source === 'expr' ? '' : 'none';
      teField.style.display = s.source === 'textExists' ? '' : 'none';
      selField.style.display = needsSelector ? '' : 'none';
      // "Wait first" only applies to sources that read a specific element.
      waitRow.style.display = needsSelector && !['count', 'exists', 'clickable', 'collect'].includes(s.source) ? '' : 'none';
      // "collect" can read an attribute (e.g. href) off every match, so it gets
      // the attribute box too.
      attrField.style.display = (s.source === 'attr' || s.source === 'collect') ? '' : 'none';
      cleanWrap.style.display = readsText ? '' : 'none';
      if (s.source === 'attr' || s.source === 'collect') refreshAttrList();
      if (needsSelector) check();
      if (s.source === 'textExists') teTest();
      getPreview(); // auto-run — no Test button press needed
    };
    src.addEventListener('change', () => {
      s.source = src.value;
      sync();
    });
    sync();
  }

  // ---------------------------------------------------------------------------
  // 🧮 Formula — a computed column from data you ALREADY grabbed (values, list /
  // table columns, kept datasets). Not read from the page — so it lives on its
  // own, away from "Grab one value".
  // ---------------------------------------------------------------------------
  if (s.type === 'formula') {
    if (!s.formula || !s.formula.kind) s.formula = blankFormula('math');

    root.append(el('div', { className: 'hint', textContent:
      'A column worked out from data you’ve already collected — single values, list/table ' +
      'columns, and tables/lists you kept as a dataset. Nothing is read from the page here.' }));

    const host = el('div', { className: 'formula-host' });
    root.append(host);
    renderFormulaBuilder(s, host);

    const name = el('input', { className: 'name-input', value: s.name, placeholder: 'e.g. profit' });
    name.addEventListener('input', () => (s.name = name.value));
    root.append(field('Call it', name, 'This name is the CSV column heading — and how you refer to it elsewhere.'));

    const tgt = select(s.target || 'column', [
      { value: 'column', label: 'Put it in the results table & CSV' },
      { value: 'var', label: 'Keep it as a reusable value — for URLs, formulas, row keys, rules (not a CSV column)' },
      { value: 'cell', label: 'Place it in a specific row & column (build / patch a table)' }
    ]);
    const cellWrap = el('div');
    tgt.addEventListener('change', () => {
      s.target = tgt.value;
      renderCellDest(s, cellWrap);
    });
    root.append(field('Where should it go?', tgt));
    root.append(cellWrap);
    renderCellDest(s, cellWrap);
  }

  if (s.type === 'skip') {
    root.append(el('div', { className: 'hint', textContent:
      'Abandons the current item: nothing is saved for it and the loop moves straight on to the ' +
      'next one. Put it inside an If to keep only the items you want — e.g. ' +
      '“If price ≥ 200 → Skip item”.' }));
  }

  if (s.type === 'scrapeList') {
    const { wrap, input, check } = selectorInput(s.rowSelector, {
      mode: 'list',
      countLabel: 'row',
      onFilled: (sel) => maybeSuggestTable(sel)
    });
    input.addEventListener('input', () => (s.rowSelector = input.value));
    root.append(
      field('① Pick one row', wrap,
        'Click ONE of the repeating items — a whole product card, or a search result. ' +
        'Scrape Studio finds all the others like it. Each one becomes a CSV row.')
    );
    root.append(checkboxField('Wait for these rows to appear on the page first', s.waitFirst !== false, (v) => (s.waitFirst = v)));

    // Picked inside an HTML table? "Grab a list" is the wrong tool — say so and
    // offer the one that actually works, rather than letting them fail slowly.
    const nudge = el('div');
    root.append(nudge);

    // Rows in the CSV, or kept whole as a dataset to pull values from / spread?
    const keepWrap = el('div');
    root.append(keepWrap);
    const renderKeep = () => {
      keepWrap.innerHTML = '';
      keepWrap.append(datasetKeepControl(s, slugName(s.dataset) || 'list', renderKeep));
    };
    renderKeep();

    async function maybeSuggestTable(sel) {
      nudge.innerHTML = '';
      let info = null;
      try {
        info = await pageEval(PA.tableInfoExpr(sel));
      } catch (_) {
        info = null;
      }
      if (!info || !info.isTable || !info.columns.length) return;
      const box = el('div', { className: 'table-banner' });
      box.append(
        el('div', { className: 'tb-title', textContent: '📊 That’s an HTML table.' }),
        el('div', { className: 'tb-text', textContent:
          `Use “Grab a table” instead — it reads all ${info.columns.length} columns straight off ` +
          'the table’s headers, so you don’t have to pick them one by one.' })
      );
      const swap = el('button', { className: 'primary', textContent: '📊 Switch to “Grab a table”' });
      swap.addEventListener('click', () => {
        // Rebuild the editor as a table step, keeping what they pointed at.
        const t = { id: editing.id, ...BLANK.scrapeTable(), rowSelector: sel };
        editing = t;
        $('#modal-title').textContent = '📊 Grab a table';
        $('#modal-body').innerHTML = '';
        buildEditorFields(editing, $('#modal-body'));
      });
      box.append(swap);
      nudge.append(box);
    }

    root.append(el('label', { className: 'field-label', textContent: '② What do you want from each row?' }));
    root.append(el('div', { className: 'hint', textContent:
      'Add a column, then Pick that value INSIDE the row you chose (the name, the price…). ' +
      'Values on the same row always stay together.' }));
    const listWrap = el('div', { className: 'field-list' });
    root.append(listWrap);
    // The live preview refreshes automatically whenever a column is picked /
    // changed — so you SEE the rows fill in without pressing anything.
    const out = el('div', { className: 'preview-box hidden' });
    const refreshPreview = () => previewList(s, out);
    renderFieldRows(s, listWrap, refreshPreview);

    const add = el('button', { textContent: '+ Add column' });
    add.addEventListener('click', () => {
      s.fields.push({ name: '', selector: '', extract: 'text', attr: '' });
      renderFieldRows(s, listWrap, refreshPreview);
    });

    // THE confidence-builder: see the actual rows before you run anything.
    const prev = el('button', { className: 'tf-test', textContent: '👁 Preview the rows' });
    prev.addEventListener('click', refreshPreview);
    root.append(el('div', { className: 'tf-bar' }, [add, prev]), out);
    if (s.rowSelector) setTimeout(refreshPreview, 60);
    check();
  }

  // ---------------------------------------------------------------------------
  // 📊 Grab a table — the one shape a picker genuinely cannot handle.
  //
  // Clicking a table row generalizes to `tr` (which swallows the HEADER row);
  // clicking a cell gives `tr > td` (every cell on the page). So we don't guess:
  // point at the table once and we read its own structure — real body rows, one
  // column per <th>, numbers detected, summary rows flagged. Then you SHAPE it:
  // rename, reorder, drop columns, change what each one is, and see the result.
  // ---------------------------------------------------------------------------
  if (s.type === 'scrapeTable') {
    let info = null; // the live table description (from the page)
    const shape = el('div'); // column shaper + preview live here

    const { wrap, input, check } = selectorInput(s.rowSelector, {
      // 'table' mode highlights WHOLE TABLES as you hover, so what you're about
      // to select is unmistakable — no cell-level guessing.
      mode: 'table',
      // And no "did you mean this one or all of them?" prompt: you're choosing a
      // table, so the question is meaningless.
      noChoice: true,
      onFilled: (sel) => loadTable(sel)
    });
    input.addEventListener('input', () => {
      s.rowSelector = input.value;
    });
    root.append(
      field('① Pick the table', wrap,
        'Press Pick — tables light up as you move over them. Click the one you want. ' +
        'That’s the only pick you make; the columns come from the table itself.')
    );
    root.append(shape);

    // Read the table off the page and (re)build the step's columns.
    async function loadTable(sel) {
      shape.innerHTML = '';
      // Retry a few times: right after reopen the webview sometimes returns null
      // on the first eval, which used to flash "that isn't a table".
      const got = await pageEvalStable(
        PA.tableInfoExpr(sel || s.rowSelector),
        (r) => !r || !r.isTable || !r.columns || !r.columns.length
      );
      if (!got || !got.isTable || !got.columns.length) {
        info = null;
        shape.append(el('div', { className: 'warn-box', textContent:
          'That isn’t inside an HTML table. Use “📋 Grab a list” for product cards / search ' +
          'results, or press Pick again and click a real table cell.' }));
        return;
      }
      info = got;
      // Take the table's columns wholesale only when this step has none yet, or
      // when it's pointed at a genuinely DIFFERENT table. We match on the cell
      // selector (td:nth-child(N)), never the name — the user is free to rename
      // columns, and re-opening the step must not undo their shaping.
      const fresh =
        !s.fields.length || !s.fields.some((f) => info.columns.some((c) => c.selector === f.selector));
      if (fresh) {
        s.fields = info.columns.map((c) => ({
          name: c.name,
          label: c.label || c.name,
          selector: c.selector,
          extract: 'text',
          attr: '',
          // A spacer column (no header AND no data) is junk — "col6/col7" that
          // would otherwise clutter the CSV and keep reappearing every run. Start
          // it unticked; a real column (has a header, or has data) stays on.
          include: !(!c.label && c.blank),
          // Money / percent columns become real numbers, so the CSV sums in Excel.
          transforms: c.numeric ? [{ op: 'number' }] : []
        }));
      }
      applyRowSelector();
      renderShaper();
    }

    // The row selector depends on whether the user wants the summary rows.
    function applyRowSelector() {
      if (!info) return;
      s.rowSelector = s.skipTotals && info.rowSelectorNoTotals ? info.rowSelectorNoTotals : info.rowSelector;
      input.value = s.rowSelector;
      check(); // refresh the "✓ N rows on this page" line under the field
    }

    function renderShaper() {
      shape.innerHTML = '';
      if (!info) return;
      const kept = info.rowCount - (s.skipTotals && info.rowSelectorNoTotals ? info.summaryRows : 0);
      const on = s.fields.filter((f) => f.include !== false).length;

      // Say WHICH table this is — a page often has several, and the user needs to
      // see that we took the one they clicked (only that one is scraped).
      const named = info.title ? `“${info.title}”` : 'this table';
      const which = info.tableCount > 1
        ? ` — table ${info.tableIndex} of ${info.tableCount} on this page. Only this one is scraped.`
        : '';
      const banner = el('div', { className: 'table-banner' });
      banner.append(
        el('div', { className: 'tb-title', textContent: `📊 Got ${named}${which}` }),
        el('div', { className: 'tb-text', textContent:
          `${kept} row${kept === 1 ? '' : 's'} × ${on} column${on === 1 ? '' : 's'}. ` +
          'Money and % columns are already set to come out as numbers.' })
      );
      if (info.tableCount > 1) {
        const other = el('div', { className: 'tb-text', textContent:
          'Wrong one? Press Pick again and click a cell in the table you want. ' +
          'To scrape several tables, add one “Grab a table” step per table.' });
        banner.append(other);
      }
      if (info.summaryRows) {
        banner.append(checkboxField(
          `Leave out the ${info.summaryRows} summary row${info.summaryRows === 1 ? '' : 's'} ` +
          '(Subtotal / Total)',
          !!s.skipTotals,
          (v) => {
            s.skipTotals = v;
            applyRowSelector();
            renderShaper();
          }
        ));
      }
      shape.append(banner);

      // Wait for the table to appear before scraping — on by default.
      shape.append(checkboxField('Wait for this table to appear on the page first', s.waitFirst !== false, (v) => (s.waitFirst = v)));

      // Rows in the CSV, or kept whole as a dataset to pull values from?
      shape.append(datasetKeepControl(s, slugName(info.title), renderShaper));

      // --- the column shaper: rename, reorder, drop, retype ------------------
      shape.append(el('label', { className: 'field-label', textContent:
        s.keep === 'dataset' ? '② Shape / name the columns' : '② Shape the columns' }));
      shape.append(el('div', { className: 'hint', textContent:
        'Untick a column to leave it out. Rename it to change the CSV heading. ↑↓ reorders. ' +
        '“As” switches text ↔ number; 🧹 opens full clean-ups (strip £, pull out a number…).' }));

      const list = el('div', { className: 'field-list' });
      s.fields.forEach((f, i) => {
        const inc = el('input', { type: 'checkbox', checked: f.include !== false, style: 'width:auto' });
        inc.addEventListener('change', () => {
          f.include = inc.checked;
          renderShaper();
        });

        const name = el('input', { value: f.name, placeholder: 'column name' });
        name.addEventListener('input', () => {
          f.name = name.value;
        });

        const src = el('span', { className: 'tc-src', textContent: f.label || '—',
          title: 'from the table heading: ' + (f.label || '(none)') });

        // "As": text, or a number (money / percent → a real number). It toggles
        // ONLY the number clean-up, preserving any others the user added in 🧹.
        const isNum = stepTransforms(f).some((t) => t.op === 'number');
        const as = select(isNum ? 'number' : 'text', [
          { value: 'text', label: 'Text' },
          { value: 'number', label: 'Number' }
        ]);
        as.addEventListener('change', () => {
          const others = stepTransforms(f).filter((t) => t.op !== 'number');
          f.transforms = as.value === 'number' ? [...others, { op: 'number' }] : others;
          renderShaper();
        });

        // 🧹 full clean-up pipeline per column — parity with "Grab a list".
        const nTf = stepTransforms(f).length;
        const tfBtn = el('button', {
          className: 'del tf-toggle' + (nTf ? ' on' : ''),
          textContent: nTf ? `🧹${nTf}` : '🧹',
          title: 'Clean up this column’s text'
        });
        tfBtn.addEventListener('click', () => {
          if (openTfCols.has(i)) openTfCols.delete(i);
          else openTfCols.add(i);
          renderShaper();
        });

        const up = el('button', { className: 'del', textContent: '↑', title: 'Move up' });
        up.addEventListener('click', () => {
          if (i === 0) return;
          s.fields.splice(i - 1, 0, s.fields.splice(i, 1)[0]);
          renderShaper();
        });
        const down = el('button', { className: 'del', textContent: '↓', title: 'Move down' });
        down.addEventListener('click', () => {
          if (i >= s.fields.length - 1) return;
          s.fields.splice(i + 1, 0, s.fields.splice(i, 1)[0]);
          renderShaper();
        });

        list.append(el('div', { className: 'tcol-row' + (f.include === false ? ' off' : '') },
          [inc, name, src, as, tfBtn, up, down]));

        // The expandable clean-up panel, previewing against this column's real
        // cell text (the first body row).
        if (openTfCols.has(i)) {
          const panel = el('div', { className: 'tf-panel' });
          appendTransformList(f, panel, () =>
            previewRaw(s.rowSelector ? s.rowSelector + ' ' + f.selector : f.selector, 'text', f.attr)
          );
          list.append(panel);
        }
      });
      shape.append(list);

      const prevBox = el('div', { className: 'preview-box' });
      const bar = el('div', { className: 'tf-bar' });
      const re = el('button', { className: 'tf-test', textContent: '👁 Refresh preview' });
      re.addEventListener('click', () => renderPreview());
      bar.append(re);
      shape.append(bar, prevBox);

      // Live preview of exactly what lands in the CSV.
      async function renderPreview() {
        const cols = s.fields.filter((f) => f.include !== false && (f.name || '').trim());
        if (!cols.length) {
          prevBox.className = 'preview-box bad';
          prevBox.textContent = 'Every column is unticked — nothing would be scraped.';
          return;
        }
        prevBox.className = 'preview-box';
        prevBox.textContent = 'reading the page…';
        const raw = await pageEvalStable(PA.listExpr(s.rowSelector, cols), (r) => !r || !r.length);
        if (!raw || !raw.length) {
          prevBox.className = 'preview-box bad';
          prevBox.textContent = '⚠ No rows found — press Pick and click a cell in the table again.';
          return;
        }
        const shown = raw.slice(0, 6).map((r) => {
          const o = {};
          for (const f of cols) o[f.name] = cleanValue(f, r[f.name]);
          return o;
        });
        prevBox.innerHTML = '';
        prevBox.append(el('div', { className: 'pv-head',
          textContent: `${raw.length} row${raw.length === 1 ? '' : 's'} — first ${shown.length}, exactly as they’ll appear in the CSV:` }));
        const tbl = el('table', { className: 'pv-table' });
        const hr = el('tr');
        for (const f of cols) hr.append(el('th', { textContent: f.name }));
        tbl.append(hr);
        for (const r of shown) {
          const tr = el('tr');
          for (const f of cols) {
            const v = r[f.name];
            const td = el('td', { textContent: v === '' || v == null ? '—' : String(v) });
            if (typeof v === 'number') td.className = 'pv-num';
            tr.append(td);
          }
          tbl.append(tr);
        }
        prevBox.append(tbl);
      }
      renderPreview();
    }

    // Re-opening an existing table step: re-read the table so the shaper works.
    if (s.rowSelector) setTimeout(() => loadTable(s.rowSelector), 40);
  }

  // ---------------------------------------------------------------------------
  // ⚡ Spread into columns — the pivot. Take a kept dataset (a table/list you set
  // to "keep to pull values from") and, for every row, make one (or several)
  // columns named by a template — {} filled with the row's key cell — holding the
  // chosen value cells. This is "for each row in this table, add a column" done
  // right: "Sales (Cerys) Total", "Sales (Cerys) Margin", … from a rows-down table.
  // ---------------------------------------------------------------------------
  if (s.type === 'spread') {
    // Legacy → new shape: a single valCol/prefix becomes valCols[]/namePattern.
    if (!Array.isArray(s.valCols)) s.valCols = s.valCol ? [s.valCol] : [];
    if (s.namePattern == null) s.namePattern = s.prefix != null && s.prefix !== '' ? s.prefix + '{}' : '';
    const defs = datasetDefs();
    if (!defs.length) {
      root.append(el('div', { className: 'warn-box', textContent:
        'First you need a kept dataset. Add a “📊 Grab a table” (or “📋 Grab a list”) ABOVE this step, ' +
        'set it to “Keep to pull values from”, and give it a name. Then come back here.' }));
    } else {
      const body = el('div');
      const dsSel = select(s.dataset || '',
        [{ value: '', label: 'pick a kept table / list…' }].concat(defs.map((d) => ({ value: d.name, label: d.name }))));
      dsSel.addEventListener('change', () => {
        s.dataset = dsSel.value;
        s.keyCol = '';
        s.valCols = [];
        renderBody();
      });
      root.append(field('① Which kept table / list?', dsSel,
        'It must be a “Grab a table/list” step above, set to keep as a dataset.'));
      root.append(body);

      const previewBox = el('div', { className: 'preview-box hidden' });

      function renderBody() {
        body.innerHTML = '';
        const def = defs.find((d) => d.name === s.dataset);
        if (!def) return;

        const keySel = select(s.keyCol || '',
          [{ value: '', label: 'pick a column…' }].concat(def.fields.map((c) => ({ value: c.name, label: c.label }))));
        keySel.addEventListener('change', () => {
          s.keyCol = keySel.value;
          renderBody(); // the ticked-values list hides the key column
        });
        body.append(field('② A column for each…', keySel,
          'The column whose values become the new headings (e.g. User → Cerys, Charlie2…).'));

        // ③ Which value column(s) fill each heading — Total, Margin, or both.
        s.valCols = (Array.isArray(s.valCols) ? s.valCols : []).filter((v) => v !== s.keyCol);
        const valWrap = el('div', { className: 'field-list' });
        for (const c of def.fields) {
          if (c.name === s.keyCol) continue; // the header column isn't a value
          valWrap.append(checkboxField(c.label, s.valCols.includes(c.name), (v) => {
            if (v) { if (!s.valCols.includes(c.name)) s.valCols.push(c.name); }
            else s.valCols = s.valCols.filter((x) => x !== c.name);
            renderPreview();
          }));
        }
        body.append(field('③ …filled with (tick one or more)', valWrap,
          'Tick every measure you want per row — e.g. Total AND Margin.'));

        // ④ How to name each column.
        const pat = el('input', { value: s.namePattern || '', placeholder: 'e.g. Sales ({})' });
        pat.addEventListener('input', () => {
          s.namePattern = pat.value;
          renderPreview();
        });
        body.append(field('④ Name each column', pat,
          `Use {} where the ${s.keyCol || 'key'} value goes — e.g. “Sales ({})” → “Sales (Cerys)”. ` +
          'Blank = just the value. With several measures ticked, each measure’s name is added.'));

        const bar = el('div', { className: 'tf-bar' });
        const prev = el('button', { className: 'tf-test', textContent: '👁 Preview the columns' });
        prev.addEventListener('click', renderPreview);
        bar.append(prev);
        body.append(bar, previewBox);
        if (s.keyCol && spreadVals(s).length) setTimeout(renderPreview, 60);
      }

      // Read the live source table so the user sees the exact column names/values.
      async function renderPreview() {
        const vals = spreadVals(s);
        if (!s.keyCol || !vals.length) return;
        const src = flattenSteps(steps).find(
          (st) => (st.type === 'scrapeTable' || st.type === 'scrapeList') && st.keep === 'dataset' && (st.dataset || '').trim() === s.dataset
        );
        if (!src || !src.rowSelector) return;
        const keyF = (src.fields || []).find((f) => f.name === s.keyCol);
        const valFs = vals.map((v) => (src.fields || []).find((f) => f.name === v)).filter(Boolean);
        if (!keyF || !valFs.length) return;
        previewBox.classList.remove('hidden');
        previewBox.className = 'preview-box';
        previewBox.textContent = 'reading the page…';
        let raw;
        try {
          raw = await pageEval(PA.listExpr(src.rowSelector, [keyF, ...valFs]));
        } catch (_) {
          raw = null;
        }
        const rows = (raw || []).filter((r) => (r[keyF.name] == null ? '' : String(r[keyF.name])).trim());
        if (!rows.length) {
          previewBox.className = 'preview-box bad';
          previewBox.textContent = '⚠ No rows found in that dataset on this page.';
          return;
        }
        const multi = valFs.length > 1;
        previewBox.innerHTML = '';
        previewBox.append(el('div', { className: 'pv-head',
          textContent: `Will create ${rows.length * valFs.length} column${rows.length * valFs.length === 1 ? '' : 's'}:` }));
        const tbl = el('table', { className: 'pv-table' });
        const hr = el('tr');
        const vr = el('tr');
        for (const r of rows.slice(0, 8)) {
          const key = String(r[keyF.name]).trim();
          for (const f of valFs) {
            hr.append(el('th', { textContent: spreadColumnName(s, key, f.name, multi ? f.label || f.name : '') }));
            const v = cleanValue(f, r[f.name]);
            const td = el('td', { textContent: v === '' || v == null ? '—' : String(v) });
            if (typeof v === 'number') td.className = 'pv-num';
            vr.append(td);
          }
        }
        tbl.append(hr, vr);
        previewBox.append(tbl);
      }

      renderBody();
    }
  }

  // ---------------------------------------------------------------------------
  // 🔗 Join — a spreadsheet look-up (VLOOKUP / SQL LEFT JOIN). ONE job: for each
  // row (or value) you've collected, find its match in another table by a shared
  // value and attach that table's columns. Single-purpose on purpose — the old
  // "enrich vs combine" mode confused people; to "combine" a whole table you just
  // grab it as your rows first, then attach the other table here. (The runtime
  // still honours a legacy combine `leftSource`, but the editor no longer makes
  // one.)
  // ---------------------------------------------------------------------------
  if (s.type === 'join') {
    if (!Array.isArray(s.bring)) s.bring = [];
    if (joinSourceDefs().length === 0) {
      root.append(el('div', { className: 'warn-box', textContent:
        'First grab a table or list to look values up in — add a “📊 Grab a table” or “📋 Grab a list” ' +
        'ABOVE this step. Then come back here.' }));
    } else {
      // Join has ONE job: for each row (or value) you've collected, look it up in
      // another table and attach that table's columns. No mode to choose — if you
      // want to "combine" a whole table, you just grab it as your rows first, then
      // attach the other table's columns here.
      s.leftSource = 'rows';
      root.append(el('div', { className: 'hint', textContent:
        'For each row (or value) you’ve collected, find its match in another table and attach that ' +
        'table’s columns to it — like a spreadsheet look-up (VLOOKUP).' }));

      const body = el('div');
      root.append(body);
      const previewBox = el('div', { className: 'preview-box hidden' });

      // Turn a dropdown pick into a stable ref. A kept dataset → its name. A CSV
      // table (value "@<id>") → keep it for look-ups now (name it, take it out of
      // the CSV) and return that name — so the reference survives saves.
      function resolvePick(val) {
        if (!val) return '';
        if (val[0] !== '@') return val;
        const st = flattenSteps(steps).find((x) => String(x.id) === val.slice(1));
        if (!st) return '';
        st.keep = 'dataset';
        if (!(st.dataset || '').trim()) st.dataset = autoDatasetName(st);
        renderSteps();
        markDirty();
        return st.dataset;
      }
      // Options for "which table/list": kept ones by name, CSV ones as "keep for
      // look-ups" (sentinel @id).
      function sourceOptions(placeholder) {
        return [{ value: '', label: placeholder }].concat(
          joinSourceDefs().map((d) => d.kept
            ? { value: d.name, label: d.name + '  (kept for look-ups)' }
            : { value: '@' + d.step.id, label: `${d.isTable ? 'Table' : 'List'} ${d.ordinal} → CSV (${d.cols}) — keep for look-ups` })
        );
      }
      const findKeptFields = (name) => {
        const d = joinSourceDefs().find((x) => x.kept && x.name === name);
        return d ? d.fields : null;
      };
      function leftColumns() {
        return valueNames(editingList);
      }

      function renderBody() {
        body.innerHTML = '';
        previewBox.classList.add('hidden');
        let n = 1;
        const num = () => '①②③④'.charAt(n++ - 1) || '';

        // The look-up (right) table.
        const rightSel = select(s.dataset || '', sourceOptions('pick a table / list…'));
        rightSel.addEventListener('change', () => {
          s.dataset = resolvePick(rightSel.value) || '';
          s.onRight = '';
          s.bring = [];
          renderBody();
        });
        body.append(field(`${num()} Look values up in`, rightSel,
          'The table/list whose columns you want to pull in.'));

        const rightFields = findKeptFields(s.dataset);
        if (!rightFields) return;

        // The match.
        const lcols = leftColumns();
        let leftKey;
        if (lcols.length) {
          leftKey = select(s.onLeft || '',
            [{ value: '', label: 'pick…' }].concat(lcols.map((c) => ({ value: c, label: c }))));
          leftKey.addEventListener('change', () => {
            s.onLeft = leftKey.value;
            renderPreview();
          });
        } else {
          leftKey = el('input', { value: s.onLeft || '', placeholder: 'a value you grabbed', style: 'width:150px' });
          leftKey.addEventListener('input', () => {
            s.onLeft = leftKey.value;
            renderPreview();
          });
        }
        const rightKey = select(s.onRight || '',
          [{ value: '', label: 'pick a column…' }].concat(rightFields.map((c) => ({ value: c.name, label: c.label }))));
        rightKey.addEventListener('change', () => {
          s.onRight = rightKey.value;
          s.bring = s.bring.filter((c) => c !== s.onRight);
          renderBody();
        });
        body.append(field(`${num()} Match where`,
          el('div', { className: 'formula-row' }, [
            el('span', { className: 'formula-op', textContent: 'my value' }), leftKey,
            el('span', { className: 'formula-op', textContent: '=' }),
            el('span', { className: 'formula-op', textContent: 'table' }), rightKey
          ]),
          'Pick a value or column you grabbed (a “Grab one value” works too) and the table column it ' +
          'equals — e.g. barserial = barserial.'));

        // Which columns to attach, and IN WHAT ORDER. Ticked columns show first
        // (in the order you arrange them with ↑↓), then the unticked ones.
        const candidates = rightFields.filter((f) => f.name !== s.onRight);
        const labelOf = (nm) => (candidates.find((c) => c.name === nm) || {}).label || nm;
        const isOn = (nm) => (s.bring.length ? s.bring.includes(nm) : true);
        const materialize = () => { if (!s.bring.length) s.bring = candidates.map((c) => c.name); };
        const orderedNames = () => {
          const on = (s.bring.length ? s.bring : candidates.map((c) => c.name)).filter((nm) => candidates.some((c) => c.name === nm));
          const off = candidates.map((c) => c.name).filter((nm) => !on.includes(nm));
          return on.concat(off);
        };
        const bringWrap = el('div', { className: 'field-list' });
        const renderBring = () => {
          bringWrap.innerHTML = '';
          orderedNames().forEach((nm) => {
            const on = isOn(nm);
            const cb = el('input', { type: 'checkbox', checked: on, style: 'width:auto' });
            cb.addEventListener('change', () => {
              materialize();
              if (cb.checked) { if (!s.bring.includes(nm)) s.bring.push(nm); }
              else s.bring = s.bring.filter((x) => x !== nm);
              renderBring();
              renderPreview();
            });
            const move = (dir) => {
              materialize();
              const i = s.bring.indexOf(nm);
              const j = i + dir;
              if (i < 0 || j < 0 || j >= s.bring.length) return;
              [s.bring[i], s.bring[j]] = [s.bring[j], s.bring[i]];
              renderBring();
              renderPreview();
            };
            const up = el('button', { className: 'del', textContent: '↑', title: 'Attach earlier' });
            up.addEventListener('click', () => move(-1));
            const down = el('button', { className: 'del', textContent: '↓', title: 'Attach later' });
            down.addEventListener('click', () => move(1));
            bringWrap.append(el('div', { className: 'tcol-row' + (on ? '' : ' off') },
              [cb, el('span', { textContent: labelOf(nm), style: 'flex:1' }), up, down]));
          });
        };
        renderBring();
        body.append(field(`${num()} Attach these columns  (tick, and ↑↓ to order)`, bringWrap,
          'These get added to each matched row, in this order. All are on by default.'));

        // Optional name prefix (avoid clashes).
        const pre = el('input', { value: s.prefix || '', placeholder: '(none)' });
        pre.addEventListener('input', () => {
          s.prefix = pre.value;
          renderPreview();
        });
        body.append(field(`${num()} Prefix the added columns (optional)`, pre,
          'Put in front of each added column name to avoid clashing with a column you already have — e.g. “supplier”.'));

        const bar = el('div', { className: 'tf-bar' });
        const prev = el('button', { className: 'tf-test', textContent: '👁 Preview the look-up table' });
        prev.addEventListener('click', renderPreview);
        bar.append(prev);
        body.append(bar, previewBox);
        if (s.onRight) setTimeout(renderPreview, 60);
      }

      // Preview the RIGHT (look-up) table live — its real keys + the columns
      // you'll pull in. (The left rows/values exist only at run time.)
      async function renderPreview() {
        const rightFields = findKeptFields(s.dataset);
        if (!rightFields || !s.onRight) return;
        previewBox.classList.remove('hidden');
        previewBox.className = 'preview-box';
        const src = flattenSteps(steps).find(
          (st) => (st.type === 'scrapeTable' || st.type === 'scrapeList') && st.keep === 'dataset' && (st.dataset || '').trim() === s.dataset
        );
        if (!src || !src.rowSelector) {
          previewBox.textContent = 'The look-up table isn’t on this page right now — its values are read when you run.';
          return;
        }
        const keyF = (src.fields || []).find((f) => f.name === s.onRight);
        let bring = (s.bring || []).filter((c) => c && c !== s.onRight);
        if (!bring.length) bring = rightFields.filter((f) => f.name !== s.onRight).map((f) => f.name);
        const bringFs = bring.map((nm) => (src.fields || []).find((f) => f.name === nm)).filter(Boolean);
        if (!keyF) return;
        previewBox.textContent = 'reading the page…';
        let raw;
        try {
          raw = await pageEval(PA.listExpr(src.rowSelector, [keyF, ...bringFs]));
        } catch (_) {
          raw = null;
        }
        const rows = (raw || []).filter((r) => (r[keyF.name] == null ? '' : String(r[keyF.name])).trim());
        if (!rows.length) {
          previewBox.className = 'preview-box bad';
          previewBox.textContent = '⚠ No rows found in that table on this page.';
          return;
        }
        previewBox.innerHTML = '';
        previewBox.append(el('div', { className: 'pv-head', textContent:
          `Matching on “${s.onLeft || '?'}” = “${s.onRight}”, pulling in: ${bringFs.map((f) => (s.prefix || '') + f.name).join(', ')}` }));
        const tbl = el('table', { className: 'pv-table' });
        const hr = el('tr');
        hr.append(el('th', { textContent: keyF.name + '  (key)' }));
        for (const f of bringFs) hr.append(el('th', { textContent: (s.prefix || '') + f.name }));
        tbl.append(hr);
        for (const r of rows.slice(0, 8)) {
          const tr = el('tr');
          const kv = cleanValue(keyF, r[keyF.name]);
          tr.append(el('td', { textContent: kv === '' || kv == null ? '—' : String(kv) }));
          for (const f of bringFs) {
            const v = cleanValue(f, r[f.name]);
            const td = el('td', { textContent: v === '' || v == null ? '—' : String(v) });
            if (typeof v === 'number') td.className = 'pv-num';
            tr.append(td);
          }
          tbl.append(tr);
        }
        previewBox.append(tbl);
      }

      renderBody();
    }
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
    root.append(field('Counter name', iv, 'If set, holds the current iteration inside the loop.'));
    const sa = el('input', { type: 'number', value: s.startAt == null ? 0 : s.startAt });
    sa.addEventListener('input', () => (s.startAt = +sa.value || 0));
    root.append(field('Counter starts at', sa, 'The first value of the counter — e.g. 1 to count 1,2,3… instead of 0,1,2…'));
  }

  if (s.type === 'forEach') {
    const { wrap, input, check } = selectorInput(s.selector, { mode: 'list', countLabel: 'item' });
    input.addEventListener('input', () => { s.selector = input.value; });
    root.append(field('Pick one item', wrap,
      'Click ONE of the repeating items — a product card, a table row. The steps you put inside ' +
      'run once for EVERY one of them, and each pass makes a row.'));
    root.append(el('div', { className: 'hint', textContent:
      'Inside this block, Pick gives you selectors relative to the current item — so “.price” means ' +
      'THIS card’s price. That’s what lets you compare two values in the same card and filter on it.' }));

    // "…where" filter: keep only the matched items that pass, with a live count
    // and a preview of exactly which items survive — so you can SEE the loop is
    // catching the right ones (and nothing extra) before running.
    buildForEachFilter(s, root);

    const iv = el('input', { value: s.indexVar, placeholder: 'e.g. i (optional)' });
    iv.addEventListener('input', () => (s.indexVar = iv.value));
    root.append(field('Counter name (optional)', iv, 'Holds the item number inside the loop.'));
    const sa = el('input', { type: 'number', value: s.startAt == null ? 0 : s.startAt });
    sa.addEventListener('input', () => (s.startAt = +sa.value || 0));
    root.append(field('Counter starts at', sa, 'The counter’s first value — set 1 to count 1,2,3… instead of 0,1,2…'));
    const mi = el('input', { type: 'number', value: s.maxIter, min: 1 });
    mi.addEventListener('input', () => (s.maxIter = +mi.value));
    root.append(field('Stop after (safety)', mi, 'A hard cap, so a huge page can’t run forever.'));
    root.append(el('div', { className: 'hint', textContent:
      'Add the per-item steps below via “+ add step”. If a step navigates to a detail page, ' +
      'selectors there are used as-is; add a “Go back” step to return and continue.' }));
  }

  // ---------------------------------------------------------------------------
  // 📅 For each date — a from/to date loop. Native date pickers, a chosen output
  // format, and the date handed to the body as {{var}} (and, by default, a column).
  // No more hand-crafting "2026-07-{{pad(i,2)}}" URLs.
  // ---------------------------------------------------------------------------
  if (s.type === 'forDates') {
    const preview = el('div', { className: 'hint' });

    const from = el('input', { type: 'date', value: s.from || '' });
    from.addEventListener('input', () => { s.from = from.value; refresh(); });
    root.append(field('From date', from));

    const to = el('input', { type: 'date', value: s.to || '' });
    to.addEventListener('input', () => { s.to = to.value; refresh(); });
    root.append(field('To date (inclusive)', to));

    const stepN = el('input', { type: 'number', min: 1, value: s.stepDays || 1 });
    stepN.addEventListener('input', () => { s.stepDays = Math.max(1, +stepN.value || 1); refresh(); });
    root.append(field('Step', stepN, 'Days between each run — 1 = every day, 7 = weekly.'));

    const varName = el('input', { value: s.var || 'date' });
    varName.addEventListener('input', () => { s.var = varName.value; refresh(); });
    const varField = field('Store the date as', varName);
    root.append(varField);

    // Output format — presets plus a custom escape hatch.
    const FMT_PRESETS = [
      ['YYYY-MM-DD', '2026-07-07  (ISO — most sites & URLs)'],
      ['DD/MM/YYYY', '07/07/2026  (UK)'],
      ['MM/DD/YYYY', '07/07/2026  (US)'],
      ['D MMM YYYY', '7 Jul 2026'],
      ['__custom__', 'Custom…']
    ];
    const isPreset = FMT_PRESETS.some(([v]) => v === s.format);
    const fmtSel = select(isPreset ? s.format : '__custom__', FMT_PRESETS.map(([v, l]) => ({ value: v, label: l })));
    const customFmt = el('input', { value: s.format || '', placeholder: 'e.g. YYYY.MM.DD' });
    const customField = field('Custom format', customFmt, 'Tokens: YYYY YY · MMMM MMM MM M · DD D');
    fmtSel.addEventListener('change', () => {
      if (fmtSel.value === '__custom__') {
        customField.style.display = '';
      } else {
        s.format = fmtSel.value;
        customField.style.display = 'none';
      }
      refresh();
    });
    customFmt.addEventListener('input', () => { s.format = customFmt.value; refresh(); });
    root.append(field('Date format', fmtSel, 'How the date is written — match what the site/URL expects.'));
    root.append(customField);
    customField.style.display = isPreset ? 'none' : '';

    root.append(checkboxField('Also add the date as a CSV column', s.asColumn !== false, (v) => (s.asColumn = v)));

    root.append(preview);
    root.append(el('div', { className: 'hint', textContent:
      'Add the steps to run for each date below — e.g. a “🌐 Go to URL” with the date in it ' +
      '(…?fromDate={{' + (s.var || 'date') + '}}&toDate={{' + (s.var || 'date') + '}}), then your grab / spread / formula steps.' }));

    root.append(dateReference());

    function refresh() {
      varField.querySelector('.hint') && varField.querySelector('.hint').remove();
      varField.append(el('div', { className: 'hint', textContent:
        `Use it anywhere with {{${(s.var || 'date').trim() || 'date'}}} — in a URL, a field, or a formula.` }));
      const dates = enumerateDates(s.from, s.to, s.stepDays, s.format);
      if (!dates.length) {
        preview.textContent = '⚠ Set a valid From and To date.';
        return;
      }
      const shown = dates.slice(0, 6).join(' · ');
      preview.textContent = `Runs ${dates.length} time${dates.length === 1 ? '' : 's'}: ${shown}${dates.length > 6 ? ' · …' : ''}`;
    }
    refresh();
  }

  if (s.type === 'group') {
    root.append(el('div', { className: 'hint', textContent:
      'A Task is just a named, collapsible folder of steps — it runs its steps in order and ' +
      'changes nothing about how values or rows work. Use it to tidy a long job into readable ' +
      'chunks (Login · Search · Extract), collapse the ones you’re not editing, and reuse them.' }));

    const emojiRow = el('div', { style: 'display:flex;gap:6px' });
    const emoji = el('input', { value: s.emoji || '📦', style: 'width:52px;text-align:center' });
    emoji.addEventListener('input', () => (s.emoji = emoji.value));
    const name = el('input', { value: s.name || '', placeholder: 'e.g. Log in' });
    name.addEventListener('input', () => (s.name = name.value));
    emojiRow.append(emoji, name);
    root.append(field('Icon & name', emojiRow, 'The name shown on the folder. Pick any emoji you like.'));

    const note = el('input', { value: s.note || '', placeholder: 'optional — what this task does' });
    note.addEventListener('input', () => (s.note = note.value));
    root.append(field('Note (optional)', note));

    const save = el('button', { textContent: '☆ Save this task to your library' });
    save.addEventListener('click', () => saveTaskToLibrary(editing));
    root.append(el('div', { className: 'tf-bar' }, [save]));
    root.append(el('div', { className: 'hint', textContent:
      'Saved tasks appear under “📚 From library” in the palette, ready to drop into any job.' }));
  }

  if (s.type === 'try') {
    root.append(el('div', { className: 'warn-box', textContent:
      'Websites are unreliable — a click misses, an element is slow, a login fails. Put the risky ' +
      'steps under “Try these steps”. If ANY of them fails, Scrape Studio jumps to “If it fails, ' +
      'recover” instead of stopping the whole run. This is the visual version of Success ▸ / Failure ▸.' }));

    const retries = el('input', { type: 'number', min: 0, max: 20, value: s.retries || 0 });
    retries.addEventListener('input', () => (s.retries = Math.max(0, +retries.value || 0)));
    root.append(field('Retry the “Try” steps this many times first', retries,
      'e.g. 2 = attempt up to 3 times before giving up and recovering. Great for flaky logins ' +
      '(Try: log in · retry 2× → recover: email me / stop).'));

    root.append(el('div', { className: 'hint', textContent:
      'Add the risky steps under “Try these steps”, and what to do on failure under “If it fails, ' +
      'recover” (e.g. Go to URL, Grab a value, or ⛔ Break to give up on this item).' }));
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
// The "For each … where" filter builder: one or many rules (all/any), a live
// "N of M match" count, and a preview of the matched items' text — so the user
// can confirm the loop catches exactly the items they mean.
function buildForEachFilter(s, root) {
  s.filter = normalizeFilter(s.filter);
  const f = s.filter;

  root.append(el('label', { className: 'field-label', textContent: 'Only these items (optional filter)' }));
  root.append(el('div', { className: 'hint', textContent:
    'Leave empty to use every match. Or keep only the ones that match a rule — e.g. its text ' +
    'contains “Xbox”, or a specific column (Pick it) is exactly “Other”. Combine rules with ALL / ANY.' }));

  const previewBox = el('div', { className: 'preview-box hidden' });
  const matchSel = select(f.match, [
    { value: 'all', label: 'ALL of these (AND)' },
    { value: 'any', label: 'ANY of these (OR)' }
  ]);
  matchSel.addEventListener('change', () => { f.match = matchSel.value; runPreview(); });
  const matchRow = field('Keep items where', matchSel);
  root.append(matchRow);

  const rulesWrap = el('div', { className: 'field-list' });
  root.append(rulesWrap);

  function renderRules() {
    rulesWrap.innerHTML = '';
    f.rules.forEach((r, i) => {
      const testSel = select(r.test, FILTER_TESTS.map((t) => ({ value: t.v, label: t.label })));
      const attrInp = el('input', { value: r.attr || '', placeholder: 'attribute', style: 'width:90px' });
      const opSel = select(r.op, FILTER_OPS.map((o) => ({ value: o.v, label: o.label })));
      const valInp = el('input', { value: r.value == null ? '' : r.value, placeholder: 'value', style: 'flex:1;min-width:70px' });

      // "a specific column…": a Pick button + the picked column selector. The pick
      // is RELATIVE to the item (row), so it targets that one column in every
      // row — even when every column is a bare <td> that shares a selector, the
      // picked "td:nth-of-type(2)" disambiguates it by position. Works the same
      // for card/div lists (the "column" is any sub-element you click).
      const cellInp = el('input', { value: r.selector || '', placeholder: 'pick a column →', style: 'width:130px', title: 'The column this rule tests' });
      const cellPick = el('button', { className: 'mini-pick pick-btn', textContent: '⊕', title: 'Pick the column to test' });
      const cellWrap = el('span', { className: 'input-with-pick', style: 'gap:3px' }, [cellInp, cellPick]);
      cellInp.addEventListener('input', () => { r.selector = cellInp.value; runPreview(); });
      cellPick.addEventListener('click', () => {
        // The item/row this filter belongs to (matches runPreview's scope).
        const rowSel = editingScope && !s.abs ? (s.selector ? editingScope + ' ' + s.selector : editingScope) : s.selector;
        if (!rowSel) { log('Pick the row for this “For each” first, then pick a column.', 'warn'); return; }
        startPick('element', {
          type: 'input',
          input: cellInp,
          relativeTo: rowSel,
          onFilled: (selv) => { r.selector = selv; cellInp.value = selv; runPreview(); }
        });
      });

      const syncVis = () => {
        attrInp.style.display = r.test === 'attr' ? '' : 'none';
        cellWrap.style.display = r.test === 'cell' ? '' : 'none';
        valInp.style.display = FILTER_OP_NOVALUE.has(r.op) ? 'none' : '';
      };
      testSel.addEventListener('change', () => { r.test = testSel.value; syncVis(); runPreview(); });
      attrInp.addEventListener('input', () => { r.attr = attrInp.value; runPreview(); });
      opSel.addEventListener('change', () => { r.op = opSel.value; syncVis(); runPreview(); });
      valInp.addEventListener('input', () => { r.value = valInp.value; runPreview(); });
      const del = el('button', { className: 'del', textContent: '✕', title: 'Remove rule' });
      del.addEventListener('click', () => { f.rules.splice(i, 1); renderRules(); runPreview(); });
      rulesWrap.append(el('div', { className: 'formula-row' }, [testSel, attrInp, cellWrap, opSel, valInp, del]));
      syncVis();
    });
    matchRow.style.display = f.rules.length > 1 ? '' : 'none';
  }

  const add = el('button', { className: 'add-in-block', textContent: '+ add rule' });
  add.addEventListener('click', () => { f.rules.push(newFilterRule()); renderRules(); });

  const test = el('button', { className: 'tf-test', textContent: '👁 Test filter on the page' });
  test.addEventListener('click', runPreview);
  root.append(el('div', { className: 'tf-bar' }, [add, test]), previewBox);

  async function runPreview() {
    const sel = editingScope && !s.abs ? (s.selector ? editingScope + ' ' + s.selector : editingScope) : s.selector;
    if (!sel) { previewBox.classList.add('hidden'); return; }
    previewBox.classList.remove('hidden');
    previewBox.className = 'preview-box';
    previewBox.textContent = 'reading the page…';
    let info;
    try {
      info = await pageEval(PA.elementFilterExpr(sel, normalizeFilter(f)));
    } catch (_) {
      info = null;
    }
    if (!info) { previewBox.className = 'preview-box bad'; previewBox.textContent = '⚠ Could not read the page.'; return; }
    previewBox.innerHTML = '';
    const headTxt = info.filtered
      ? `✓ ${info.matched} of ${info.total} items match — these run:`
      : `No filter yet — all ${info.total} items run. (Add a rule to narrow it.)`;
    previewBox.append(el('div', { className: 'pv-head', textContent: headTxt }));
    if (info.matched === 0 && info.filtered) previewBox.className = 'preview-box bad';
    const listEl = el('div', { className: 'filter-samples' });
    for (const smp of info.samples) listEl.append(el('div', { className: 'fs-item', textContent: smp.text || '(empty)' }));
    if (info.matched > info.samples.length) listEl.append(el('div', { className: 'fs-more', textContent: `…and ${info.matched - info.samples.length} more` }));
    previewBox.append(listEl);
  }

  renderRules();
  if (s.selector && activeFilterRules(f).length) setTimeout(runPreview, 60);
}

function buildConditionUI(cond, root) {
  // A kept table/list is a whole DATASET, not a single value — you can't sensibly
  // test "salesByUser is greater than 200". So they're left OUT of the things you
  // can compare here (matching the Formula value picker). To test a value FROM a
  // table/list, pull one out first with a 🧮 Formula “look-up”, then test that.
  const datasetNames = new Set(datasetDefs().map((d) => d.name));
  const vars = Array.from(collectVarNames(steps)).filter((v) => !datasetNames.has(v));

  if (!vars.length) {
    root.append(el('div', { className: 'warn-box', textContent:
      'You haven’t grabbed any single values yet, so there’s nothing to test. Add a ' +
      '“📥 Grab one value” step above this one (e.g. price) — or, to test a value from a kept ' +
      'table/list, pull one out with a 🧮 Formula “look-up” first — then come back.' }));
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
function renderFieldRows(s, wrap, refresh) {
  refresh = typeof refresh === 'function' ? refresh : () => {};
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
          onFilled: async (picked) => {
            // Auto-pick the RIGHT source, exactly like Grab-a-value: a form
            // field's value / a checkbox's ticked / an image's src — so a picked
            // <input>/<select>/checkbox/<img> column doesn't come out blank.
            try {
              const full = s.rowSelector ? (picked ? s.rowSelector + ' ' + picked : s.rowSelector) : picked;
              const sug = await pageEval(PA.suggestSourceExpr(full));
              if (sug && sug.strong && sug.source && sug.source !== f.extract) f.extract = sug.source;
            } catch (_) {}
            if (!(f.name || '').trim()) {
              const guess = suggestName(picked);
              if (guess) f.name = guess;
            }
            renderFieldRows(s, wrap, refresh); // reflect the new source + name
            refresh(); // auto-run the live preview — no button press needed
          }
        });
      });
      middle.append(sel, pick);
    }

    const ex = select(f.extract, EXTRACT_OPTS);
    ex.addEventListener('change', () => {
      f.extract = ex.value;
      renderFieldRows(s, wrap, refresh); // toggle selector ↔ expression input
      refresh();
    });

    const del = el('button', { className: 'del', textContent: '✕', title: 'Remove' });
    del.addEventListener('click', () => {
      s.fields.splice(i, 1);
      openTfCols.delete(i);
      if (!s.fields.length) s.fields.push({ name: '', selector: '', extract: 'text', attr: '' });
      renderFieldRows(s, wrap, refresh);
      refresh();
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
      renderFieldRows(s, wrap, refresh);
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
  // If the editor was opened from the Map (adding or editing a node), refresh it.
  if (typeof renderMap === 'function' && !$('#map-modal').classList.contains('hidden')) renderMap();
});

// ===========================================================================
// Run engine
// ===========================================================================

$('#run').addEventListener('click', () => runSteps());
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

// `opts.stopBeforeId` — "Run up to here": run every step before that one, then
// stop, leaving the page where the step will act (for editing it live).
async function runSteps(opts) {
  opts = opts || {};
  if (running) return;
  if (!steps.length) return log('Add some steps first.', 'warn');

  setRunning(true);
  abortRun = false;
  authLostState = null;
  authCheckedOnFail = false;
  hideAuthBanner();

  // Every run starts from a clean sheet — no rows, discovered columns, or CSV
  // shaping carried over from a previous run. Without this, results accumulate
  // across runs and stale columns from an earlier date/table keep reappearing.
  results.length = 0;
  columns.length = 0;
  columnConfig.length = 0;
  liveExtra = null;
  renderResults();

  log(opts.stopBeforeId != null ? '▶ Run up to the selected step' : '▶ Run started', 'info');

  // Runtime context.
  //  vars     — working values (not in the CSV)
  //  pageRow  — the row being built right now (its names are readable too)
  //  rowBase  — what the row looked like when the current loop pass began, so a
  //             committed row doesn't wipe values inherited from an outer loop
  //  committed — rows added so far (lets a loop tell if a nested loop emitted)
  //  datasets — grabbed tables kept whole (not emitted as rows) so Formula
  //             columns can pull values out of them: lookup(salesByUser, …)
  const ctx = { vars: {}, pageRow: {}, rowBase: {}, listRows: [], datasets: {}, cellRows: [], committed: 0, stopBeforeId: opts.stopBeforeId };

  try {
    // Always begin the job at its start URL so runs are reproducible.
    if (startUrl) {
      log(`Opening start URL: ${startUrl}`, 'info');
      await navigateAndWait(startUrl);
      await sleep(300);
    }

    // Auth gate: if this job needs a login and we look signed out, stop now and
    // prompt — rather than running a doomed scrape against a login page.
    const authAtStart = await detectAuth();
    if (!authAtStart.loggedIn && authShouldGate(authAtStart)) {
      log(`⚠ You appear to be signed out (${authAtStart.reason}). Log in in the browser, then Run again.`, 'err');
      if ((jobAuthCfg.check || '').trim()) {
        log('   (If this job signs in with its own steps, clear the “signed-in” marker in the Sign-in panel.)', 'warn');
      }
      showAuthBanner(authAtStart);
      return; // the finally below still clears state
    }

    let stoppedEarly = false;
    try {
      await execList(steps, ctx);
    } catch (e) {
      if (e && e.__stop) {
        stoppedEarly = true; // "Run up to here" reached its target — a clean stop
      } else if (!e || (!e.__break && !e.__skip)) {
        throw e; // a real error
      } else {
        log('  (Skip / Break outside a loop — ignored)', 'warn');
        ctx.pageRow = {};
      }
    }

    // "Run up to here": don't commit a partial row or print the row summary —
    // the point was to leave the page positioned, not to produce output.
    if (stoppedEarly) {
      log('■ Stopped before the selected step — the page is where that step will act. Edit it, then Run again.', 'ok');
      return; // the finally clears marks + running state
    }

    // A step failed AND we now look signed out → almost certainly the cause.
    if (authLostState) {
      log(`⚠ A step failed and you appear to be signed out — ${authLostState.reason || 'your session ended'}.`, 'err');
      showAuthBanner(authLostState);
    }

    // Whatever is still in the row buffer (a job with no loop just collects
    // values top-to-bottom) becomes the final row. Values collected outside a
    // list are repeated onto every list row.
    // Commit the pending rows for real now — clear the live view first so they
    // aren't counted twice.
    liveExtra = null;
    const leftovers = Object.keys(ctx.pageRow).length > 0;
    if (ctx.listRows.length) {
      for (const r of ctx.listRows) addRow(leftovers ? { ...ctx.pageRow, ...r } : r);
    } else if (leftovers && !ctx.cellRows.length) {
      addRow(ctx.pageRow);
    }
    // Rows assembled by "place in a cell" (row × column upsert) are their own
    // self-contained table — emit them in the order their rows first appeared.
    for (const r of ctx.cellRows) addRow(r);

    log(`✓ Run finished — ${results.length} row(s) total`, results.length ? 'ok' : 'warn');
    if (!results.length && !authLostState) explainNoRows(ctx);
    else if (results.length) warnPartialRows();
  } finally {
    liveExtra = null; // drop references to this run's pending buckets
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
  if (!columns.length && !has('scrapeList') && !has('scrapeTable')) {
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
const STOP = { __stop: true }; // "Run up to here" — stop before the target step

// Execute a list of steps in order. break/skip bubble up (thrown) to their loop.
//
// Normally a step that fails is logged and the run continues (a scrape shouldn't
// die on one missing element). But inside a "Try" block we set ctx.strict so a
// real failure propagates up to the Try, which then runs its recovery steps.
async function execList(list, ctx) {
  for (const s of list) {
    if (abortRun) return;
    // "Run up to here": stop the moment we reach the target — BEFORE running it —
    // so the page is left exactly where that step would act, ready to edit. In a
    // loop this fires on the first iteration that reaches the step.
    if (ctx.stopBeforeId != null && s.id === ctx.stopBeforeId) throw STOP;
    markStep(s.id, 'running');
    try {
      await execStep(s, ctx);
      markStep(s.id, 'done');
    } catch (err) {
      if (err && err.__stop) throw err; // propagate straight to the top
      if (err && (err.__break || err.__skip)) {
        markStep(s.id, 'done');
        throw err; // propagate to the enclosing loop
      }
      markStep(s.id, 'error');
      if (ctx.strict) throw err; // let the enclosing Try catch it
      log(`Step (${s.type}) failed: ${err.message}`, 'err');
      // The first failure of a run is a good moment to check whether the real
      // cause is a sign-out (session expired mid-scrape). If so, stop and prompt.
      if (!authCheckedOnFail) {
        authCheckedOnFail = true;
        const st = await detectAuth();
        if (!st.loggedIn) {
          authLostState = st;
          abortRun = true;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rows: ONE namespace, and rows that commit themselves
// ---------------------------------------------------------------------------

// Every name you've collected — whether you kept it as a column, a working
// value, or a whole kept-table (dataset) — readable by that one name. Precedence
// low→high: datasets, then working values, then the row being built.
function names(ctx) {
  return Object.assign({}, ctx.datasets, ctx.vars, ctx.pageRow);
}

const sameRow = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Did this loop pass actually collect data — i.e. add at least one NON-BLANK
// value beyond what it inherited from the enclosing loop? Used to decide whether
// a pass becomes a row. Guards against emitting an all-empty row for a matched
// element that had none of the target cells — e.g. the empty spacer <tr></tr>
// rows some sites put between real rows, which otherwise each grab nothing yet
// still commit a blank row.
function passHasData(pageRow, base) {
  for (const k of Object.keys(pageRow)) {
    if (pageRow[k] === base[k]) continue; // unchanged from what we inherited
    if (String(pageRow[k] == null ? '' : pageRow[k]).trim() !== '') return true;
  }
  return false;
}

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
  if (ctx.committed === before && passHasData(ctx.pageRow, base)) {
    commitRow(ctx);
  } else {
    // Nothing new, or only blanks (e.g. an empty spacer row) → no row for this
    // item. Reset the buffer to what we inherited for the next pass.
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

    case 'refresh':
      if (view) {
        try {
          view.reload();
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

    case 'formula':
      execFormula(s, ctx);
      return;

    case 'scrapeList': {
      // Element columns are read from the page; "expression" columns (e.g. a
      // loop variable like the current date) are computed here, once per pass,
      // and attached to every row — so each iteration's rows are tagged.
      const elementFields = s.fields.filter((f) => f.extract !== 'expr');
      const listSel = await resolveSel(s.rowSelector, ctx, s.abs);
      await waitFirstIfSet(s, listSel);
      const raw = await pageEval(PA.listExpr(listSel, elementFields));
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
      if (s.keep === 'dataset' && (s.dataset || '').trim()) {
        const dsName = s.dataset.trim();
        ctx.datasets[dsName] = rows;
        log(`  kept list as “${dsName}” (${rows.length} row(s)) — pull values from it in a Formula / Spread`,
          rows.length ? 'ok' : 'warn');
      } else {
        log(`  scraped ${rows.length} row(s) from list`, rows.length ? 'ok' : 'warn');
        ctx.listRows.push(...rows);
        liveRender(ctx); // show them now, not only at the end
      }
      return;
    }

    // 📊 Grab a table — same row engine, but only the columns the user kept
    // (ticked), in the order they arranged them, under the names they gave.
    case 'scrapeTable': {
      const cols = (s.fields || []).filter((f) => f.include !== false && (f.name || '').trim());
      if (!cols.length) {
        log('  table: no columns are ticked — nothing to scrape', 'warn');
        return;
      }
      const tableSel = await resolveSel(s.rowSelector, ctx, s.abs);
      await waitFirstIfSet(s, tableSel);
      const raw = await pageEval(PA.listExpr(tableSel, cols));
      const rows = raw.map((r) => {
        const o = {};
        for (const f of cols) o[f.name] = cleanValue(f, r[f.name]);
        return o;
      });
      // "Keep to pull values from" → store the whole table under a name so a
      // Formula column can look values up in it, instead of putting its rows in
      // the CSV. Everything else about the step (columns, names, cleanups) is
      // identical — only the destination changes.
      if (s.keep === 'dataset' && (s.dataset || '').trim()) {
        const dsName = s.dataset.trim();
        ctx.datasets[dsName] = rows;
        log(`  kept table as “${dsName}” (${rows.length} row(s) × ${cols.length} col) — pull values from it in a Formula`,
          rows.length ? 'ok' : 'warn');
      } else {
        log(`  scraped ${rows.length} row(s) × ${cols.length} column(s) from the table`,
          rows.length ? 'ok' : 'warn');
        ctx.listRows.push(...rows);
        liveRender(ctx); // show them now, not only at the end
      }
      return;
    }

    // ⚡ Spread a dataset into columns — the pivot. Works on ANY kept dataset (a
    // grabbed table OR a grabbed list). For every row, make a column named
    // <prefix><keyCell> holding <valueCell>: rows (Cerys 110)(Charlie2 12.99) →
    // columns "Sales by Cerys"=110, "Sales by Charlie2"=12.99, on the current row.
    case 'spread': {
      const dsName = (s.dataset || '').trim();
      const rows = ctx.datasets[dsName];
      if (!Array.isArray(rows)) {
        log(`  spread: no kept dataset named “${dsName || '(none)'}” yet — put a “keep as dataset” step above this one`, 'warn');
        return;
      }
      const vals = spreadVals(s);
      if (!s.keyCol || !vals.length) {
        log('  spread: choose which column becomes the headers and at least one value column', 'warn');
        return;
      }
      const labels = datasetFieldLabels(dsName); // slug → human label, for suffixes
      let n = 0;
      for (const r of rows) {
        const key = (r[s.keyCol] == null ? '' : String(r[s.keyCol])).trim();
        if (!key) continue; // skip blank/spacer rows
        for (const vc of vals) {
          // With several measures, add the measure's label so the columns stay
          // distinct (e.g. "Sales (Cerys) Total" vs "Sales (Cerys) Margin").
          const name = spreadColumnName(s, key, vc, vals.length > 1 ? labels[vc] || vc : '');
          ctx.pageRow[name] = r[vc] == null ? '' : r[vc];
          n++;
        }
      }
      log(`  spread “${dsName}” into ${n} column(s)`, n ? 'ok' : 'warn');
      return;
    }

    // 🔗 Join — spreadsheet look-up / SQL LEFT JOIN. For every LEFT row, find the
    // RIGHT (dataset) row with the same key and pull its chosen columns in. The
    // left side is either the rows you're collecting (→ add columns in place) or
    // another kept dataset (→ emit the combined rows). Unmatched left rows keep
    // their own columns; the pulled-in ones come through blank.
    case 'join': {
      const right = ctx.datasets[(s.dataset || '').trim()];
      if (!Array.isArray(right)) {
        log(`  join: no kept dataset named “${s.dataset || '(none)'}” yet — grab a table/list above and set it to “keep as dataset”`, 'warn');
        return;
      }
      if (!s.onLeft || !s.onRight) {
        log('  join: choose which columns to match on (your rows’ column = the table’s column)', 'warn');
        return;
      }
      const norm = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
      // Build the look-up index once: key → the first right row with that key.
      const index = new Map();
      for (const r of right) {
        const k = norm(r[s.onRight]);
        if (k !== '' && !index.has(k)) index.set(k, r);
      }
      // Which right columns to bring across (default: all except the match key).
      let bring = (s.bring || []).filter((c) => c && c !== s.onRight);
      if (!bring.length) bring = Object.keys(right[0] || {}).filter((c) => c !== s.onRight);
      const pfx = s.prefix || '';

      // Add the matched columns onto one left row; returns whether it matched.
      // The key comes from the row's own column, else a working value you grabbed
      // (so "Grab one value → use it as the key" works).
      const applyTo = (row) => {
        const kv = row[s.onLeft] != null ? row[s.onLeft] : ctx.vars[s.onLeft];
        const m = index.get(norm(kv));
        for (const c of bring) {
          const nm = pfx + c;
          if (m) row[nm] = m[c] == null ? '' : m[c];
          else if (!(nm in row)) row[nm] = '';
        }
        return !!m;
      };
      // Make the added columns real output columns (so committed rows show/export
      // them). Rows still in ctx.listRows register themselves when they flush.
      const register = () => {
        for (const c of bring) {
          const nm = pfx + c;
          if (!columns.includes(nm)) {
            columns.push(nm);
            columnConfig.push({ key: nm, label: nm, include: true });
          }
        }
      };

      let matched = 0;
      let total = 0;
      const leftName = (s.leftSource || 'rows').trim();
      if (leftName && leftName !== 'rows') {
        // Left is itself a kept dataset → EMIT the combined rows.
        const left = ctx.datasets[leftName];
        if (!Array.isArray(left)) {
          log(`  join: no kept dataset named “${leftName}” — pick a valid left table/list`, 'warn');
          return;
        }
        for (const lr of left) {
          const row = Object.assign({}, lr);
          if (applyTo(row)) matched++;
          total++;
          ctx.listRows.push(row);
        }
        log(`  joined “${leftName}” ⋈ “${s.dataset}” → ${total} row(s), ${matched} matched`, matched ? 'ok' : 'warn');
      } else {
        // Left = the rows / values I'm collecting → ADD columns onto them in
        // place. That includes committed rows, rows waiting to commit, AND the row
        // being built right now (so a single grabbed value + attached columns
        // works). If nothing's been collected but the key is a working value,
        // start a row from it.
        const targets = results.concat(ctx.listRows);
        if (Object.keys(ctx.pageRow).length) targets.push(ctx.pageRow);
        if (!targets.length && ctx.vars[s.onLeft] != null) {
          ctx.pageRow[s.onLeft] = ctx.vars[s.onLeft];
          targets.push(ctx.pageRow);
        }
        for (const row of targets) {
          if (applyTo(row)) matched++;
          total++;
        }
        register();
        renderResults();
        if (!total) {
          log(`  join: nothing to attach to yet — grab your key value/rows BEFORE this step`, 'warn');
        } else {
          log(`  joined in “${s.dataset}” → ${matched} of ${total} row(s) matched`, matched ? 'ok' : 'warn');
        }
      }
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
      const start = Math.floor(Number(s.startAt) || 0); // counter's first value
      for (let i = 0; i < count && !abortRun; i++) {
        if (s.indexVar) ctx.vars[s.indexVar] = start + i;
        try {
          await runLoopPass(s.body, ctx);
        } catch (e) {
          if (e && e.__break) break;
          throw e;
        }
      }
      return;
    }

    case 'forDates': {
      const dates = enumerateDates(ip(s.from), ip(s.to), s.stepDays, s.format);
      const cap = s.maxIter || 1000;
      const name = (s.var || 'date').trim() || 'date';
      const asCol = s.asColumn !== false;
      log(`  for each date ${s.from || '?'} → ${s.to || s.from || '?'}: ${dates.length} date(s)`, dates.length ? 'info' : 'warn');
      const outerBase = ctx.rowBase;
      for (let k = 0; k < dates.length && k < cap && !abortRun; k++) {
        const d = dates[k];
        // The date is a working value first, so it's readable as {{date}} in URLs,
        // fields and formulas THIS pass. We do NOT pre-write it into the row —
        // doing so makes the pass look "unchanged" and suppresses the commit.
        ctx.vars[name] = d;
        log(`  ▸ ${name} = ${d}  (${k + 1} of ${dates.length})`, 'info');
        const base = { ...ctx.pageRow };
        ctx.rowBase = base;
        const before = ctx.committed;
        const beforeLen = results.length;
        try {
          await execList(s.body, ctx);
        } catch (e) {
          ctx.rowBase = outerBase;
          ctx.pageRow = { ...base };
          if (e && e.__skip) { ctx.skipped = (ctx.skipped || 0) + 1; continue; } // skip this date
          if (e && e.__break) break;
          delete ctx.vars[name];
          throw e;
        }
        if (ctx.committed === before) {
          // The body didn't emit its own rows → this date IS one row (even if only
          // the date is filled in). This is the whole point of a date loop.
          if (asCol) ctx.pageRow[name] = d;
          commitRow(ctx);
        } else {
          // A nested loop already emitted this date's rows — stamp the date on them.
          if (asCol) stampColumn(beforeLen, name, d);
          ctx.pageRow = { ...base };
        }
        ctx.rowBase = outerBase;
      }
      delete ctx.vars[name];
      return;
    }

    case 'forEach': {
      const baseSel = await resolveSel(s.selector, ctx, s.abs);
      if (!baseSel) {
        log('  for each: no selector', 'warn');
        return;
      }
      const cap = s.maxIter || 1000;

      // Which matches to iterate: all of them, or — if a "where …" filter is set
      // — only the ones that pass (by DOM index among the matches).
      let indices;
      if (activeFilterRules(s.filter).length) {
        const info = await pageEval(PA.elementFilterExpr(baseSel, normalizeFilter(s.filter)));
        indices = (info && info.kept) || [];
        log(`  for each ${baseSel} where ${filterSummary(s.filter)}: ${indices.length} of ${info ? info.total : 0} match`,
          indices.length ? 'info' : 'warn');
      } else {
        const count = await pageEval(`document.querySelectorAll(${JSON.stringify(baseSel)}).length`);
        indices = Array.from({ length: count }, (_, k) => k);
        log(`  for each ${baseSel}: ${count} match(es)`, count ? 'info' : 'warn');
      }

      // Unique marker per nesting depth so nested For-each loops don't collide.
      const depth = (ctx.scopeDepth || 0) + 1;
      const attr = 'data-ss-scope-' + depth;
      const marker = '[' + attr + ']';
      const prevScope = ctx.scope;
      const prevDepth = ctx.scopeDepth;

      const start = Math.floor(Number(s.startAt) || 0); // counter's first value
      for (let n = 0; n < indices.length && n < cap && !abortRun; n++) {
        const i = indices[n]; // DOM index among the selector's matches
        if (s.indexVar) ctx.vars[s.indexVar] = start + n; // counter = position among kept items (from startAt)
        // (Re)tag the i-th match each pass — robust across navigations/go-back.
        const tagged = await pageEval(`(() => {
          document.querySelectorAll(${JSON.stringify(marker)}).forEach(e => e.removeAttribute(${JSON.stringify(attr)}));
          const els = document.querySelectorAll(${JSON.stringify(baseSel)});
          const el = els[${i}];
          if (el) { el.setAttribute(${JSON.stringify(attr)}, ''); el.scrollIntoView({ block: 'center' }); }
          return !!el;
        })()`);
        if (!tagged) break;
        log(`  ▸ item ${n + 1} of ${indices.length}`, 'info');
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

    case 'group':
      // A Task is transparent: just run its steps in the current context.
      await execList(s.body || [], ctx);
      return;

    case 'try': {
      // Run the body; if a step fails, retry (optionally) and then fall back to
      // the recovery steps. The body runs in "strict" mode so a failure actually
      // propagates here instead of being logged-and-ignored.
      const attempts = Math.max(1, (Number(s.retries) || 0) + 1);
      let failure = null;
      for (let a = 0; a < attempts && !abortRun; a++) {
        const prevStrict = ctx.strict;
        ctx.strict = true;
        try {
          await execList(s.body || [], ctx);
          failure = null;
          break; // succeeded
        } catch (e) {
          if (e && (e.__break || e.__skip || e.__stop)) {
            ctx.strict = prevStrict;
            throw e; // control flow (or "run up to here"), not an error
          }
          failure = e;
          if (a + 1 < attempts) log(`  try: attempt ${a + 1} failed (${e.message}) — retrying…`, 'warn');
        } finally {
          ctx.strict = prevStrict;
        }
      }
      if (failure) {
        log(`  try failed (${failure.message}) → running the recovery steps`, 'warn');
        await execList(s.onError || [], ctx);
      }
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
// Put a value into an addressable output cell: find the row whose key column
// (`matchCol`) equals `matchVal`, creating it if new, then set column `setCol`.
// This is "this value → row X, column Y" with update-or-create on both axes.
function upsertCell(ctx, matchCol, matchVal, setCol, val) {
  const norm = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  const key = norm(matchVal);
  const has = (r) => r && norm(r[matchCol]) === key;
  // Land on a row that ALREADY exists first — one an earlier placement made, a
  // row from a grabbed table/list, a committed row, or the row being built right
  // now — so "add stockQuantity to barserial X" patches the real X instead of
  // appending a duplicate. Only make a new row when the key is genuinely new.
  let row =
    ctx.cellRows.find(has) ||
    ctx.listRows.find(has) ||
    results.find(has) ||
    (has(ctx.pageRow) ? ctx.pageRow : null);
  const created = !row;
  if (!row) {
    row = {};
    row[matchCol] = matchVal;
    ctx.cellRows.push(row);
  }
  row[setCol] = val == null ? '' : val;
  // If we patched a row already in the visible results table, surface the new
  // column right away.
  if (results.includes(row)) {
    if (!columns.includes(setCol)) {
      columns.push(setCol);
      columnConfig.push({ key: setCol, label: setCol, include: true });
    }
    renderResults();
  }
  return { created };
}

// Shared "place in a cell" destination for Grab-a-value and Formula. Returns true
// if it handled the value (target === 'cell').
function placeInCell(s, val, ctx) {
  if (s.target !== 'cell') return false;
  const ip = (str) => EXPR.interpolate(str, names(ctx));
  const matchCol = (s.matchCol || '').trim();
  const matchVal = ip((s.matchVal || '').trim());
  const setCol = (s.setCol || '').trim() || (s.name || '').trim();
  if (!matchCol || !setCol) {
    log('  ⚠ place: set the row’s key column, the row value, and which column to fill', 'err');
    return true;
  }
  const res = upsertCell(ctx, matchCol, matchVal, setCol, val);
  liveRender(ctx); // show the table filling in, cell by cell
  log(`  placed ${JSON.stringify(val == null ? '' : val)} → ${res.created ? 'new' : 'existing'} row [${matchCol} = ${matchVal}] · column ${setCol}`, 'ok');
  return true;
}

async function execGet(s, ctx) {
  let val;
  let note = '';
  const name = (s.name || '').trim();
  if (!name && s.target !== 'cell') {
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
  } else if (s.source === 'clickable') {
    val = await pageEval(PA.clickableExpr(sel));
  } else if (s.source === 'collect') {
    // Gather EVERY match into a list (e.g. all child link hrefs) — the seed/grow
    // primitive for a work-queue crawl. Keep it as a working value (list var).
    val = await pageEval(PA.collectExpr(sel, (s.attr || '').trim() ? 'attr' : 'text', s.attr));
    note = ` (${Array.isArray(val) ? val.length : 0} item${Array.isArray(val) && val.length === 1 ? '' : 's'})`;
  } else if (s.source === 'textExists') {
    const te = s.textExists || {};
    const container = te.container ? await resolveSel(te.container, ctx, s.abs) : '';
    const wanted = EXPR.interpolate((te.text || '').trim(), names(ctx));
    val = wanted ? await pageEval(PA.textExistsExpr(wanted, container, te.mode)) : false;
    note = ` (“${String(wanted).slice(0, 40)}” ${val ? 'found' : 'not found'})`;
  } else {
    // Anything read off an element. An "attr" with no name is almost always a
    // mistake — fall back to text so it still returns something useful.
    let mode = s.source;
    if (mode === 'attr' && !(s.attr || '').trim()) {
      mode = 'text';
      log('  (attribute had no name — read the element’s text instead)', 'warn');
    }
    await waitFirstIfSet(s, sel); // wait for it to appear first (unless unticked)
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

  if (placeInCell(s, val, ctx)) return;
  if (s.target === 'column') {
    ctx.pageRow[name] = val == null ? '' : val;
    delete ctx.vars[name]; // the row's value is the one that counts now
  } else {
    ctx.vars[name] = val;
    delete ctx.pageRow[name]; // it's a working value: keep it out of the CSV
  }
  log(`  ${s.target === 'column' ? 'column ' : ''}${name} = ${JSON.stringify(val)}${note}`, 'ok');
}

// 🧮 Formula — compute a value from data ALREADY collected (values + kept
// datasets), never off the live page. The click-built formula is compiled to an
// expression and evaluated against the whole namespace.
function execFormula(s, ctx) {
  const name = (s.name || '').trim();
  if (!name && s.target !== 'cell') {
    log('  ⚠ Formula has no name — give it one (e.g. profit) so it becomes a column.', 'err');
    return;
  }
  const code = compileFormula(s.formula);
  let val;
  try {
    val = EXPR.evaluate(code, names(ctx));
  } catch (e) {
    log(`  ⚠ ${name}: couldn’t work out the formula (${e.message})`, 'err');
    val = '';
  }
  if (val == null) val = '';
  if (placeInCell(s, val, ctx)) return;
  if (s.target === 'column') {
    ctx.pageRow[name] = val;
    delete ctx.vars[name];
  } else {
    ctx.vars[name] = val;
    delete ctx.pageRow[name];
  }
  log(`  ${s.target === 'column' ? 'column ' : ''}${name} = ${JSON.stringify(val)}  (= ${code})`, 'ok');
}

// --- Spread helpers (shared by the runtime, the editor, and stepDetail) -----

// The value columns a Spread emits — new `valCols`, or the legacy single `valCol`.
function spreadVals(s) {
  if (Array.isArray(s.valCols) && s.valCols.length) return s.valCols;
  return s.valCol ? [s.valCol] : [];
}

// The naming template. `{}` (or any {…}) stands in for the key value. Falls back
// to the legacy `prefix` (prepended), then to bare `{}` (just the key value).
function spreadPattern(s) {
  if (s.namePattern != null && s.namePattern !== '') return s.namePattern;
  if (s.prefix != null && s.prefix !== '') return s.prefix + '{}';
  return '{}';
}

// Build one column's name: fill the template with the key value, then (only when
// several measures are spread) append the measure's label to keep them distinct.
function spreadColumnName(s, keyVal, valCol, suffixLabel) {
  const pat = spreadPattern(s);
  let name = /\{[^}]*\}/.test(pat) ? pat.replace(/\{[^}]*\}/g, keyVal) : pat + keyVal;
  if (suffixLabel) name = (name + ' ' + suffixLabel).trim();
  return name;
}

// slug → human label for a kept dataset's columns (from its source step's fields).
function datasetFieldLabels(name) {
  const src = flattenSteps(steps).find(
    (st) => (st.type === 'scrapeTable' || st.type === 'scrapeList') && st.keep === 'dataset' && (st.dataset || '').trim() === name
  );
  const map = {};
  if (src) for (const f of src.fields || []) if (f.name) map[f.name] = f.label || f.name;
  return map;
}

// The dates a "For each date" loop runs over: from → to inclusive, stepping
// `stepDays`, each written in `format`. Rollover-safe (uses the engine's date
// helpers). Returns [] for an unset/invalid range so a run just does nothing.
function enumerateDates(from, to, stepDays, format) {
  const out = [];
  const start = EXPR.dateAdd(from, 0); // normalise to YYYY-MM-DD; '' if invalid
  if (!start) return out;
  const end = to ? EXPR.dateAdd(to, 0) : start;
  if (!end) return out;
  const step = Math.max(1, Math.trunc(Number(stepDays) || 1));
  let cur = start;
  let guard = 0;
  while (EXPR.dateDiff(cur, end) >= 0 && guard++ < 100000) {
    out.push(format ? EXPR.dateFmt(cur, format) : cur);
    cur = EXPR.dateAdd(cur, step);
  }
  return out;
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

// A grab step's auto "wait for it to appear first" (on unless unticked). Polls
// briefly for the element, then proceeds either way — a timeout isn't fatal, the
// grab's own "nothing matches" handling still reports it. Skips waiting when
// we're already scoped inside a live For-each item (that element exists).
async function waitFirstIfSet(s, resolvedSel) {
  if (s.waitFirst === false || !resolvedSel) return;
  try {
    await waitForSelector(resolvedSel, s.waitTimeout || 10000, false);
  } catch (_) {
    log('  (waited, but it never appeared — reading anyway)', 'warn');
  }
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

// Fill a column onto rows added since `fromIndex` that don't already have it —
// used to stamp the current date onto rows a nested loop emitted for that date.
function stampColumn(fromIndex, key, value) {
  let changed = false;
  for (let r = fromIndex; r < results.length; r++) {
    if (results[r][key] === undefined) {
      results[r][key] = value;
      changed = true;
    }
  }
  if (changed && !columns.includes(key)) {
    columns.push(key);
    columnConfig.push({ key, label: key, include: true });
  }
  if (changed) renderResults();
}

// The columns actually shown/exported, in their configured order.
function activeColumns() {
  return columnConfig.filter((c) => c.include);
}

// Show the rows produced so far but not yet committed (a grabbed table still in
// ctx.listRows, or a cell-placement table in ctx.cellRows), so output appears as
// it's built instead of only at the very end. Registers their columns too.
function liveRender(ctx) {
  const pending = (ctx.listRows || []).concat(ctx.cellRows || []);
  for (const row of pending) {
    for (const k of Object.keys(row)) {
      if (!columns.includes(k)) {
        columns.push(k);
        columnConfig.push({ key: k, label: k, include: true });
      }
    }
  }
  liveExtra = pending;
  renderResults();
}

function renderResults() {
  const table = $('#results-table');
  // During a run we also show the not-yet-committed rows so you see live output.
  const rows = liveExtra && liveExtra.length ? results.concat(liveExtra) : results;
  $('#results-empty').classList.toggle('hidden', rows.length > 0);
  $('#row-count').textContent = rows.length ? `(${rows.length})` : '';
  $('#export-csv').disabled = results.length === 0;

  table.innerHTML = '';
  if (!rows.length) return;

  const cols = activeColumns();
  const thead = el('tr', {}, cols.map((c) => el('th', { textContent: c.label })));
  table.append(el('thead', {}, [thead]));

  const tbody = el('tbody');
  // Cap the on-screen preview; CSV export always includes everything.
  const shown = rows.slice(-500);
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

// Raw CSV text (no byte-order mark — the encoding, incl. any BOM, is applied
// when the file is written, per the chosen encoding).
function toCsv() {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = activeColumns();
  const lines = [cols.map((c) => esc(c.label)).join(',')];
  for (const r of results) lines.push(cols.map((c) => esc(r[c.key])).join(','));
  return lines.join('\r\n'); // CRLF line endings (Excel-friendly)
}

// CSV file encodings. Excel on Windows opens "UTF-8 with BOM" reliably (the BOM
// is what stops it mangling £ / accents), so that's the default. UTF-16 LE is the
// most bullet-proof for older Excel / lots of non-Latin text; plain UTF-8 (no
// BOM) is for other tools that don't want the marker.
const CSV_ENCODINGS = [
  { value: 'utf8bom', label: 'UTF-8 (Excel-ready) — recommended' },
  { value: 'utf16le', label: 'UTF-16 (best for older Excel / non-English text)' },
  { value: 'utf8', label: 'UTF-8 without BOM (other tools)' }
];
let csvEncoding = 'utf8bom';

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
  const res = await window.harvest.saveCsv(`${host}-webharvest.csv`, toCsv(), csvEncoding);
  if (res.saved) {
    const enc = (CSV_ENCODINGS.find((e) => e.value === csvEncoding) || {}).label || csvEncoding;
    log(`Exported ${results.length} rows (${enc.split(' —')[0]}) → ${res.filePath}`, 'ok');
  }
});

// Encoding picker beside the Export button.
(function wireCsvEncoding() {
  const sel = $('#csv-encoding');
  if (!sel) return;
  for (const e of CSV_ENCODINGS) sel.append(el('option', { value: e.value, textContent: e.label }));
  sel.value = csvEncoding;
  sel.addEventListener('change', () => { csvEncoding = sel.value; markDirty(); });
})();

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

// A portable snapshot of the whole scrape — everything needed to reproduce it
// elsewhere. No id/timestamps (those are per-install); name travels so an import
// can label itself. Editor-only fields (keys starting "_") are stripped.
function jobExport() {
  return {
    kind: 'scrape-studio-job',
    version: 1,
    name: currentJob ? currentJob.name : 'Untitled',
    startUrl,
    steps: JSON.parse(JSON.stringify(steps, (k, v) => (k.charAt(0) === '_' ? undefined : v))),
    columns: columnConfig,
    csvEncoding,
    auth: { ...jobAuthCfg }
  };
}

// Apply an imported job object to the current workspace. Returns true on success.
// Shared by the Import button and covered directly by tests.
function applyImportedJob(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('not a job file');
  if (!Array.isArray(obj.steps)) throw new Error('no steps in this file');
  steps = reidList(obj.steps);
  setStartUrl(obj.startUrl || '');
  columnConfig = Array.isArray(obj.columns) ? obj.columns.map((c) => ({ ...c })) : [];
  if (obj.csvEncoding) { csvEncoding = obj.csvEncoding; const es = $('#csv-encoding'); if (es) es.value = csvEncoding; }
  setJobAuth(obj.auth);
  results = [];
  columns = [];
  renderResults();
  renderSteps();
  markDirty(); // persist the import into the open job (was missing → imports were lost)
  return true;
}

$('#export-job').addEventListener('click', async () => {
  const base = (currentJob && currentJob.name) || safeHost(urlInput.value) || 'scrape';
  const safe = base.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'scrape';
  const res = await window.harvest.exportJob(`${safe}.job`, JSON.stringify(jobExport(), null, 2));
  if (res.saved) log(`Job exported → ${res.filePath}`, 'ok');
});

$('#import-job').addEventListener('click', async () => {
  const res = await window.harvest.importJob();
  if (!res.loaded) return;
  try {
    applyImportedJob(JSON.parse(res.json));
    log(`Job imported (${countSteps(steps)} step${countSteps(steps) === 1 ? '' : 's'}).`, 'ok');
  } catch (e) {
    log('Could not import this file: ' + e.message, 'err');
  }
});

// ===========================================================================
// Reusable Task library — save a Task once, drop it into any job
// ===========================================================================

// Strip transient/editor-only fields (anything starting with "_") from a step
// subtree so it serialises cleanly into the library.
function cleanTaskTree(step) {
  return JSON.parse(JSON.stringify(step, (k, v) => (k.charAt(0) === '_' ? undefined : v)));
}

async function saveTaskToLibrary(step) {
  const clone = cleanTaskTree(step);
  clone.collapsed = false;
  const meta = STEP_META[clone.type] || { icon: '📦', label: 'Task' };
  const rec = {
    id: 'task-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
    name: (clone.name || meta.label || 'Task').trim() || 'Task',
    emoji: clone.emoji || meta.icon || '📦',
    note: clone.note || '',
    step: clone,
    updatedAt: Date.now()
  };
  try {
    await window.harvest.tasks.save(rec);
    log(`☆ Saved “${rec.name}” to your task library.`, 'ok');
  } catch (e) {
    log('Could not save task: ' + e.message, 'err');
  }
}

// Insert a saved task (deep-cloned, with fresh ids) into a given list — the
// top-level program, or a block/Task body. Offered from the Add-step directory.
function insertTaskInto(list, rec) {
  const arr = [JSON.parse(JSON.stringify(rec.step))];
  reidList(arr); // fresh session ids + ensure block child arrays exist
  (list || steps).push(arr[0]);
  renderSteps();
  markDirty();
  if (typeof renderMap === "function" && !$("#map-modal").classList.contains("hidden")) renderMap();
  log(`Inserted “${rec.name}”.`, "ok");
}

// ===========================================================================
// Map view — the whole program as an auto-laid-out flowchart
//
// The step list is the low-friction way to BUILD; the map is the way to
// UNDERSTAND. It draws control flow as arrows (branches, loops, recovery paths),
// colours every node by which of the three "languages" it belongs to
// (data / action / control), and can overlay DATA flow — who produces a value
// and who consumes it — as labelled links. Read-only, but click a node to edit.
// ===========================================================================

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}

// ---------------------------------------------------------------------------
// The Map is an EDITABLE, Blueprint-style canvas — the place you actually
// DESCRIBE a scrape, not just look at it. Each "graph" is one container: the
// whole program, or the inside of a Module / loop / If / Try you drilled into
// by double-clicking. You add nodes, drag them around, wire node → node to set
// the order, and open a Module (or block) to author ITS graph. The nested step
// list stays the single source of truth, so the run engine is unchanged.
// ---------------------------------------------------------------------------

const MAPN = { W: 210, H: 56, SEC_X: 34, HEADER_H: 30, SECTION_GAP: 46, PAD: 24 };

const escapeReg = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let mapKnown = new Set();

// Which known names appear (word-ish) in a string.
function namesIn(str, known) {
  const out = [];
  if (!str) return out;
  const s = String(str);
  for (const name of known) {
    if (!name) continue;
    if (new RegExp('(^|[^\\w$])' + escapeReg(name) + '($|[^\\w$])').test(s)) out.push(name);
  }
  return out;
}

// Data pins: the values a node PRODUCES (outputs) and CONSUMES (inputs).
function computePins(s) {
  const outputs = [];
  const inputs = [];
  const addIn = (str) => {
    for (const n of namesIn(str, mapKnown)) if (!inputs.includes(n)) inputs.push(n);
  };
  if ((s.type === 'get' || s.type === 'setVar' || s.type === 'scrape' || s.type === 'formula') && s.name) outputs.push(s.name);
  if ((s.type === 'scrapeTable' || s.type === 'scrapeList') && s.keep === 'dataset' && s.dataset) outputs.push(s.dataset);
  if (s.type === 'scrapeList' && s.keep !== 'dataset') for (const f of s.fields || []) if (f.name) outputs.push(f.name);
  if ((s.type === 'forEach' || s.type === 'repeat') && s.indexVar) outputs.push(s.indexVar);
  if (s.type === 'forDates' && s.var) outputs.push(s.var);
  if (s.type === 'if' || s.type === 'while') {
    const c = normalizeCond(s.condition);
    for (const r of c.rules) {
      if (r.left && mapKnown.has(r.left) && !inputs.includes(r.left)) inputs.push(r.left);
      const rt = (r.right == null ? '' : String(r.right)).trim();
      if (mapKnown.has(rt) && !inputs.includes(rt)) inputs.push(rt);
    }
  }
  if (s.type === 'get' && s.source === 'expr') addIn(s.expr);
  if (s.type === 'formula') addIn(compileFormula(s.formula));
  if (s.type === 'spread' && s.dataset && mapKnown.has(s.dataset) && !inputs.includes(s.dataset)) inputs.push(s.dataset);
  if (s.type === 'repeat') addIn(s.count);
  if (s.type === 'goto') addIn(s.url);
  if (s.type === 'type' || s.type === 'clickText') addIn(s.text);
  if (s.type === 'scrapeList') for (const f of s.fields || []) if (f.extract === 'expr') addIn(f.selector);
  return { outputs, inputs };
}

function truncate(str, n) {
  const s = String(str == null ? '' : str);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// --- Navigation: a stack of frames, one per container you've drilled into ---
let mapStack = [];
let mapModel = null;
let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;
let mapNodeDrag = null; // { node, step, offX, offY, contentTop, moved }
let mapWire = null; // { from, el, a }
let mapPanning = null; // { sx, sy }
let mapRenderQueued = false;

function sectionLabel(type, key) {
  if (type === 'group') return '';
  return labelFor(type, key) || key;
}

// A frame describes one editable graph: its title and the child list(s) it
// contains (an If has two — Then / Else; a Try has Try / Recover; a Module or
// loop has one).
function frameFor(step) {
  if (!step) return { label: 'Main', emoji: '🗺', sections: [{ label: '', list: steps }], step: null };
  const secs = BLOCK_TYPES[step.type].map((k) => {
    step[k] = step[k] || [];
    return { label: sectionLabel(step.type, k), list: step[k] };
  });
  const meta = STEP_META[step.type] || { icon: '•', label: step.type };
  return {
    label: step.type === 'group' ? (step.name || 'Task') : meta.label,
    emoji: step.type === 'group' ? (step.emoji || '📦') : meta.icon,
    sections: secs,
    step
  };
}
const currentFrame = () => mapStack[mapStack.length - 1];

// Give every step in a list a canvas position the first time it's shown.
function ensurePos(list) {
  list.forEach((s, i) => {
    if (typeof s.gx !== 'number') s.gx = 100;
    if (typeof s.gy !== 'number') s.gy = i * (MAPN.H + 30);
  });
}

// Lay a frame out: node rects (absolute canvas coords, sections stacked), the
// sequential exec edges, and per-section metadata (header + add-button pos).
function buildFrameModel(frame) {
  mapKnown = collectVarNames(steps);
  const W = MAPN.W;
  const H = MAPN.H;
  const nodes = [];
  const edges = [];
  const sections = [];
  const multi = frame.sections.length > 1;
  let y = MAPN.PAD;

  frame.sections.forEach((sec, si) => {
    ensurePos(sec.list);
    const headerY = y;
    const contentTop = y + (multi ? MAPN.HEADER_H : 6);
    const secObj = { label: sec.label, list: sec.list, si, headerY, contentTop };
    sections.push(secObj);

    const firstGy = sec.list.length ? sec.list[0].gy || 0 : 0;
    const startNode = { start: true, secList: sec.list, sec: secObj, x: MAPN.SEC_X, y: contentTop + firstGy + (H - 30) / 2, w: 56, h: 30 };
    nodes.push(startNode);

    let bottom = contentTop + 60;
    const secNodes = [];
    sec.list.forEach((s) => {
      const node = {
        step: s, secList: sec.list, sec: secObj,
        x: MAPN.SEC_X + (s.gx || 0), y: contentTop + (s.gy || 0),
        w: W, h: H, cat: stepCategory(s), pins: computePins(s)
      };
      nodes.push(node);
      secNodes.push(node);
      bottom = Math.max(bottom, node.y + H);
    });

    if (secNodes.length) {
      edges.push({ from: startNode, to: secNodes[0] });
      for (let i = 0; i < secNodes.length - 1; i++) edges.push({ from: secNodes[i], to: secNodes[i + 1] });
    }
    secObj.bottom = bottom;
    secObj.addPos = { x: MAPN.SEC_X + 100, y: bottom + 14 };
    y = bottom + MAPN.SECTION_GAP;
  });

  const width = Math.max(400, ...nodes.map((n) => n.x + n.w)) + 90;
  const height = y + 10;
  return { frame, sections, nodes, edges, width, height };
}

const pinOut = (n) => ({ x: n.x + n.w, y: n.y + n.h / 2 });
const pinIn = (n) => ({ x: n.x, y: n.y + n.h / 2 });

function edgePath(a, b, cls, marker) {
  const dx = Math.max(28, Math.abs(b.x - a.x) / 2);
  const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  return svgEl('path', { class: cls, d, fill: 'none', 'marker-end': `url(#${marker})` });
}

// Producer → consumer links for the current frame (data-flow overlay).
function mapDataLinks(nodes) {
  const real = nodes.filter((n) => n.step);
  const producers = {};
  for (const n of real) for (const nm of n.pins.outputs) (producers[nm] = producers[nm] || []).push(n);
  const links = [];
  for (const c of real) {
    for (const nm of c.pins.inputs) {
      const prod = producers[nm];
      if (!prod) continue;
      let best = null;
      for (const p of prod) {
        if (p === c) continue;
        if (p.y <= c.y && (!best || p.y > best.y)) best = p;
      }
      if (!best) best = prod.find((p) => p !== c) || null;
      if (best) links.push({ name: nm, from: best, to: c });
    }
  }
  return links;
}

// Screen → graph coordinates (undo pan/zoom).
function canvasPoint(e) {
  const rect = $('#map-canvas').getBoundingClientRect();
  return { x: (e.clientX - rect.left - mapPanX) / mapZoom, y: (e.clientY - rect.top - mapPanY) / mapZoom };
}

function mapNodeEl(n) {
  if (n.start) {
    const g = svgEl('g', { class: 'mnode mstart' });
    g.append(svgEl('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 15 }));
    g.append(svgEl('text', { class: 'mstart-t', x: n.x + n.w / 2, y: n.y + n.h / 2 + 4, 'text-anchor': 'middle' }, 'Start'));
    const op = svgEl('circle', { class: 'pin pin-out', cx: n.x + n.w, cy: n.y + n.h / 2, r: 6 });
    op.addEventListener('mousedown', (e) => { e.stopPropagation(); startWire(n); });
    g.append(op);
    return g;
  }
  const s = n.step;
  const meta = STEP_META[s.type] || { icon: '•', label: s.type };
  const title = s.type === 'group' ? (s.name || 'Task') : meta.label;
  const g = svgEl('g', { class: 'mnode cat-' + n.cat + (isBlock(s) ? ' mblock' : ''), 'data-id': s.id });
  g.append(svgEl('rect', { class: 'mbox', x: n.x, y: n.y, width: n.w, height: n.h, rx: 9 }));
  g.append(svgEl('text', { class: 'm-ic', x: n.x + 13, y: n.y + 24 }, meta.icon));
  g.append(svgEl('text', { class: 'm-nm', x: n.x + 36, y: n.y + 22 }, truncate(title, 20)));
  // Second line: for a block, an unambiguous "open its graph" affordance instead
  // of the summary (which lives inside); for a leaf, the step's own summary.
  if (isBlock(s)) {
    const kids = BLOCK_TYPES[s.type].reduce((a, k) => a + countSteps(s[k] || []), 0);
    g.append(svgEl('text', { class: 'm-dt m-open', x: n.x + 13, y: n.y + 42 },
      `${kids} step${kids === 1 ? '' : 's'} · double-click ⤢`));
  } else {
    g.append(svgEl('text', { class: 'm-dt', x: n.x + 13, y: n.y + 42 }, truncate(stepDetail(s), 28)));
  }
  const ip = svgEl('circle', { class: 'pin pin-in', 'data-inpin': s.id, cx: n.x, cy: n.y + n.h / 2, r: 6 });
  const op = svgEl('circle', { class: 'pin pin-out', cx: n.x + n.w, cy: n.y + n.h / 2, r: 6 });
  op.addEventListener('mousedown', (e) => { e.stopPropagation(); startWire(n); });
  g.append(ip, op);
  const del = svgEl('text', { class: 'm-btn m-del', x: n.x + n.w - 15, y: n.y + 17 }, '✕');
  del.addEventListener('mousedown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => { e.stopPropagation(); mapDeleteNode(n); });
  g.append(del);
  g.addEventListener('mousedown', (e) => { e.stopPropagation(); startNodeDrag(n, e); });
  g.addEventListener('dblclick', (e) => { e.stopPropagation(); onNodeActivate(n); });
  return g;
}

function renderMapCrumbs() {
  const nav = $('#map-crumbs');
  nav.innerHTML = '';
  mapStack.forEach((f, i) => {
    if (i) nav.append(el('span', { className: 'crumb-sep', textContent: '›' }));
    const b = el('button', {
      className: 'crumb' + (i === mapStack.length - 1 ? ' current' : ''),
      textContent: (f.emoji ? f.emoji + ' ' : '') + f.label
    });
    if (i < mapStack.length - 1) b.addEventListener('click', () => { mapStack.length = i + 1; renderMap(); fitMap(); });
    nav.append(b);
  });
}

function renderMapCanvas() {
  const canvas = $('#map-canvas');
  const old = canvas.querySelector('.map-svg');
  if (old) old.remove();
  mapModel = buildFrameModel(currentFrame());
  const totalSteps = mapModel.sections.reduce((a, s) => a + s.list.length, 0);
  $('#map-empty').classList.toggle('hidden', totalSteps > 0);

  const svg = svgEl('svg', { class: 'map-svg', width: mapModel.width, height: mapModel.height, viewBox: `0 0 ${mapModel.width} ${mapModel.height}` });
  const defs = svgEl('defs');
  for (const [id, color] of [['m-flow', 'var(--map-line)'], ['m-data', 'var(--map-dataflow)']]) {
    defs.append(svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      [svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: color })]));
  }
  svg.append(defs);
  const z = svgEl('g', { class: 'map-zoomer' });
  svg.append(z);

  for (const sec of mapModel.sections) {
    if (mapModel.sections.length > 1 && sec.label) {
      z.append(svgEl('text', { class: 'msec-label', x: MAPN.SEC_X, y: sec.headerY + 18 }, sec.label.toUpperCase()));
      z.append(svgEl('line', { class: 'msec-line', x1: MAPN.SEC_X, y1: sec.headerY + 24, x2: mapModel.width - 40, y2: sec.headerY + 24 }));
    }
    const add = svgEl('g', { class: 'madd' });
    add.append(svgEl('rect', { x: sec.addPos.x, y: sec.addPos.y, width: 96, height: 26, rx: 13 }));
    add.append(svgEl('text', { x: sec.addPos.x + 48, y: sec.addPos.y + 17, 'text-anchor': 'middle' }, '＋ node'));
    add.addEventListener('mousedown', (e) => e.stopPropagation());
    add.addEventListener('click', (e) => { e.stopPropagation(); mapAddNode(sec.list, 100, sec.list.length * (MAPN.H + 30), add); });
    z.append(add);
  }

  for (const e of mapModel.edges) z.append(edgePath(pinOut(e.from), pinIn(e.to), 'medge', 'm-flow'));

  if ($('#map-dataflow').checked) {
    for (const lk of mapDataLinks(mapModel.nodes)) {
      const a = pinOut(lk.from);
      const b = pinIn(lk.to);
      z.append(edgePath(a, b, 'mdlink', 'm-data'));
      z.append(svgEl('text', { class: 'mdlabel', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 3, 'text-anchor': 'middle' }, lk.name));
    }
  }

  for (const n of mapModel.nodes) z.append(mapNodeEl(n));
  canvas.append(svg);
}

function renderMap() {
  renderMapCrumbs();
  renderMapCanvas();
  applyMapTransform();
  // On a branching graph (If → Then/Else, Try → Try/Recover) the toolbar "＋ Node"
  // would be ambiguous about which lane it targets, so hide it and let the user
  // use the labelled "＋ node" button under each lane instead.
  $('#map-add').style.display = currentFrame().sections.length > 1 ? 'none' : '';
}
function scheduleCanvas() {
  if (mapRenderQueued) return;
  mapRenderQueued = true;
  requestAnimationFrame(() => {
    mapRenderQueued = false;
    renderMapCanvas();
    applyMapTransform();
  });
}

function applyMapTransform() {
  const z = $('#map-canvas').querySelector('.map-zoomer');
  if (z) z.setAttribute('transform', `translate(${mapPanX},${mapPanY}) scale(${mapZoom})`);
  $('#map-zoom-reset').textContent = Math.round(mapZoom * 100) + '%';
}
function fitMap() {
  if (!mapModel) return;
  const canvas = $('#map-canvas');
  const cw = canvas.clientWidth || 900;
  const ch = canvas.clientHeight || 600;
  const z = Math.min(cw / mapModel.width, ch / mapModel.height, 1.15);
  mapZoom = Math.max(0.2, z * 0.92);
  mapPanX = Math.max(20, (cw - mapModel.width * mapZoom) / 2);
  mapPanY = 24;
  applyMapTransform();
}
function setMapZoom(zoom, cx, cy) {
  const rect = $('#map-canvas').getBoundingClientRect();
  cx = cx == null ? rect.width / 2 : cx;
  cy = cy == null ? rect.height / 2 : cy;
  const nz = clampZoom(zoom, 0.2, 3);
  mapPanX = cx - ((cx - mapPanX) * nz) / mapZoom;
  mapPanY = cy - ((cy - mapPanY) * nz) / mapZoom;
  mapZoom = nz;
  applyMapTransform();
}

// --- Editing actions --------------------------------------------------------
function startNodeDrag(n, e) {
  if (n.start) return;
  const cp = canvasPoint(e);
  mapNodeDrag = { node: n, step: n.step, offX: cp.x - n.x, offY: cp.y - n.y, contentTop: n.sec.contentTop, moved: false };
}
function startWire(n) {
  const a = pinOut(n);
  const path = svgEl('path', { class: 'mwire-temp', d: '', fill: 'none' });
  const z = $('#map-canvas').querySelector('.map-zoomer');
  if (z) z.append(path);
  mapWire = { from: n, el: path, a };
}
function onNodeActivate(n) {
  if (n.start) return;
  const s = n.step;
  if (isBlock(s)) {
    mapStack.push(frameFor(s));
    renderMap();
    fitMap();
  } else {
    openStepEditor(s, n.secList, false);
  }
}
function mapDeleteNode(n) {
  const i = n.secList.indexOf(n.step);
  if (i >= 0) n.secList.splice(i, 1);
  renderSteps();
  markDirty();
  renderMap();
}
// Wire from A's out-pin to B's in-pin ⇒ B runs right after A (and re-parents B
// into A's section if it was in another branch). "Start → B" makes B first.
function mapReorder(fromNode, toId) {
  if (!fromNode) return;
  let tgt = null;
  let tgtList = null;
  for (const sec of mapModel.sections) {
    const f = sec.list.find((s) => String(s.id) === String(toId));
    if (f) { tgt = f; tgtList = sec.list; break; }
  }
  if (!tgt) return;
  if (!fromNode.start && tgt === fromNode.step) return;
  const destList = fromNode.secList;
  if (isBlock(tgt) && listInsideStep(tgt, destList)) return; // no cycles
  const ti = tgtList.indexOf(tgt);
  if (ti >= 0) tgtList.splice(ti, 1);
  if (fromNode.start) {
    destList.unshift(tgt);
  } else {
    const si = destList.indexOf(fromNode.step);
    destList.splice(si + 1, 0, tgt);
  }
  renderSteps();
  markDirty();
  renderMap();
}
// Adding a node on the canvas uses the SAME step directory as the sidebar, so
// there's only ever one way to pick a step — it just remembers where to put it.
function mapAddNode(list, gx, gy) {
  openAddStep(list, { gx, gy });
}

function openMap() {
  $('#map-modal').classList.remove('hidden');
  mapStack = [frameFor(null)];
  mapZoom = 1;
  mapPanX = 0;
  mapPanY = 0;
  renderMap();
  fitMap();
}
function closeMap() {
  $('#map-modal').classList.add('hidden');
}

// --- Wiring -----------------------------------------------------------------
$('#open-map').addEventListener('click', openMap);
$('#map-close').addEventListener('click', closeMap);
$('#map-fit').addEventListener('click', fitMap);
$('#map-add').addEventListener('click', () => {
  const sec = currentFrame().sections[0];
  mapAddNode(sec.list, 100, sec.list.length * (MAPN.H + 30), $('#map-add'));
});
$('#map-dataflow').addEventListener('change', renderMapCanvas);
$('#map-zoom-in').addEventListener('click', () => setMapZoom(mapZoom + 0.15));
$('#map-zoom-out').addEventListener('click', () => setMapZoom(mapZoom - 0.15));
$('#map-zoom-reset').addEventListener('click', () => setMapZoom(1));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#map-modal').classList.contains('hidden')) closeMap();
});

(function initMapInteractions() {
  const canvas = $('#map-canvas');
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.mnode') || e.target.closest('.pin') || e.target.closest('.madd')) return;
    mapPanning = { sx: e.clientX - mapPanX, sy: e.clientY - mapPanY };
    canvas.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (mapWire) {
      const cp = canvasPoint(e);
      const a = mapWire.a;
      const dx = Math.max(28, Math.abs(cp.x - a.x) / 2);
      mapWire.el.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${cp.x - dx} ${cp.y}, ${cp.x} ${cp.y}`);
    } else if (mapNodeDrag) {
      const cp = canvasPoint(e);
      mapNodeDrag.step.gx = Math.max(0, cp.x - mapNodeDrag.offX - MAPN.SEC_X);
      mapNodeDrag.step.gy = Math.max(0, cp.y - mapNodeDrag.offY - mapNodeDrag.contentTop);
      mapNodeDrag.moved = true;
      scheduleCanvas();
    } else if (mapPanning) {
      mapPanX = e.clientX - mapPanning.sx;
      mapPanY = e.clientY - mapPanning.sy;
      applyMapTransform();
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (mapWire) {
      let toId = null;
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const pin = t && t.closest('[data-inpin]');
      const node = t && t.closest('.mnode[data-id]');
      if (pin) toId = pin.getAttribute('data-inpin');
      else if (node) toId = node.getAttribute('data-id');
      if (mapWire.el.parentNode) mapWire.el.remove();
      const from = mapWire.from;
      mapWire = null;
      if (toId != null) mapReorder(from, toId);
    } else if (mapNodeDrag) {
      const moved = mapNodeDrag.moved;
      mapNodeDrag = null;
      if (moved) { renderSteps(); markDirty(); }
    } else if (mapPanning) {
      mapPanning = null;
      canvas.classList.remove('grabbing');
    }
  });
  canvas.addEventListener('wheel', (e) => {
    if ($('#map-modal').classList.contains('hidden')) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    setMapZoom(mapZoom + (e.deltaY < 0 ? 0.12 : -0.12), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  // (Adding a node is always via the explicit "＋ Node" / "＋ node" buttons — we
  // deliberately DON'T add on double-click-empty, so a stray double-click while
  // panning never silently creates a step.)
})();

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
    csvEncoding,
    auth: { ...jobAuthCfg },
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
  csvEncoding = job.csvEncoding || 'utf8bom';
  { const es = $('#csv-encoding'); if (es) es.value = csvEncoding; }
  setStartUrl(job.startUrl || '');
  setJobAuth(job.auth);
  hideAuthBanner();
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
  setJobAuth(null);
  hideAuthBanner();
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
// Software update button (the bar under the brand header)
// ===========================================================================

(function initUpdateButton() {
  const bar = document.getElementById('updbar');
  const btn = document.getElementById('update-btn');
  const msg = document.getElementById('update-msg');
  if (!bar || !btn || !window.harvest || !window.harvest.updates) return;

  let ready = false; // an update has downloaded and is ready to install
  let revertTimer = null;
  const setMsg = (t) => { if (msg) msg.textContent = t || ''; };

  function reset(text) {
    ready = false;
    bar.classList.remove('ready');
    btn.disabled = false;
    btn.textContent = '⭮ Check for updates';
    setMsg(text || '');
  }

  btn.addEventListener('click', () => {
    if (ready) { window.harvest.updates.install(); return; } // "Restart to update"
    clearTimeout(revertTimer);
    btn.disabled = true;
    bar.classList.remove('ready');
    btn.textContent = 'Checking…';
    setMsg('');
    window.harvest.updates.check();
  });

  window.harvest.updates.onStatus((s) => {
    const state = s && s.state;
    clearTimeout(revertTimer);
    if (state === 'checking') { btn.disabled = true; btn.textContent = 'Checking…'; setMsg(''); }
    else if (state === 'available') { btn.disabled = true; btn.textContent = 'Downloading…'; setMsg('v' + (s.version || '') + ' found'); }
    else if (state === 'downloading') { btn.disabled = true; btn.textContent = 'Downloading…'; setMsg(Math.round(s.percent || 0) + '%'); }
    else if (state === 'downloaded') {
      ready = true; bar.classList.add('ready'); btn.disabled = false;
      btn.textContent = '↻ Restart to update'; setMsg('v' + (s.version || '') + ' ready');
    } else if (state === 'not-available') {
      reset('You’re on the latest version' + (s.version ? ' (v' + s.version + ')' : ''));
      revertTimer = setTimeout(() => setMsg(''), 6000);
    } else if (state === 'dev') {
      reset('Dev build — updates only in the installed app');
      revertTimer = setTimeout(() => setMsg(''), 6000);
    } else if (state === 'error') {
      reset('Check failed — please try again shortly');
      revertTimer = setTimeout(() => setMsg(''), 8000);
    }
  });

  window.harvest.updates.version()
    .then((v) => { if (v) btn.title = 'You have v' + v + ' — click to check for a newer version'; })
    .catch(() => {});
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

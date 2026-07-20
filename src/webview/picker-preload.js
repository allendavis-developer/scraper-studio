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

// Interaction/state classes toggle at runtime — present while Picking (field is
// focused/active), gone at Test/Scrape time — so a selector built from one matches
// nothing later. (Mirror of isStateClass in shared/page-actions.js.)
function isStateClass(c) {
  if (/^(is-|has-|ng-)/i.test(c)) return true; // is-focused, has-error, ng-dirty…
  return /^(focus|focused|active|hover|hovered|selected|open|opened|closed|expanded|collapsed|dragging|drag|loading|dirty|touched|pristine|disabled|checked|filled|pressed|highlighted)$/i.test(c);
}

function isStableClass(c) {
  if (!c) return false;
  if (/^(css-|sc-|jsx-|_)/.test(c)) return false;
  if (/[0-9]{4,}/.test(c)) return false;
  if (isStateClass(c)) return false;
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

// Form controls seldom have a usable id but usually carry a stable, semantic
// attribute (name/placeholder/aria-label/data-testid). Prefer it — unique,
// readable, reorder-proof, and it's what tells otherwise-identical fields
// (start date vs end date) apart. (Mirror of shared/page-actions.js.)
function stableAttrSelector(el) {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return '';
  for (const attr of ['name', 'placeholder', 'aria-label', 'data-testid']) {
    const val = el.getAttribute(attr);
    if (!val || val.length > 80) continue;
    const sel = tag + '[' + attr + '=' + JSON.stringify(val) + ']';
    try {
      if (document.querySelectorAll(sel).length === 1) return sel;
    } catch (_) {}
  }
  return '';
}

function cssPath(el) {
  if (!(el instanceof Element)) return '';

  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
    const byId = '#' + el.id;
    if (document.querySelectorAll(byId).length === 1) return byId;
  }

  const attrSel = stableAttrSelector(el);
  if (attrSel) return attrSel;

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

// Narrow a repeating-row selector to only rows that actually contain cells, when
// that excludes some matches — i.e. skip the empty spacer <tr></tr> rows some
// sites put between real rows. Without this, those spacers would be iterated
// (each wasting a "wait for it" timeout) and, if grabbed, become blank rows.
// `root` scopes the count for a nested/relative list (defaults to document).
function narrowRowsWithCells(base, root) {
  try {
    const scope = root || document;
    const withCells = base.selector + ':has(td, th)';
    const all = scope.querySelectorAll(base.selector).length;
    const kept = scope.querySelectorAll(withCells).length;
    if (kept > 0 && kept < all) return Object.assign({}, base, { selector: withCells, count: kept });
  } catch (_) {}
  return base;
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
// Widen-to-parent: `hoverEl` is the element directly under the cursor, and
// `widenLevels` is how many parents up from it the highlight has been walked with
// ↑ (↓ walks back in). Lets you grab a whole card whose children fill it, without
// hunting for a bare edge to hover. Moving to a new base element resets it.
let hoverEl = null;
let widenLevels = 0;
// Scoped picking: when a pick is RELATIVE to a container (a For-each item, or a
// grab-a-list column), we pop a MODAL DIALOG containing a styled copy of one
// instance of that container and let the user pick inside the copy. This beats
// spotlighting a real instance in place: it's always centred and visible no
// matter where the page is scrolled, and there's no ambiguity about which of
// the many instances you're pointing at. The copy lives in the page's own
// document, so it inherits all the site's CSS. A selector derived from the copy
// (e.g. ".card-title", "td:nth-of-type(2)") applies identically to every real
// instance, so picking in the copy configures the scrape for all of them.
let scopeRoot = null;      // the CLONE the user picks within (or null when unscoped)
let scopeBackdrop = null;  // the dimming backdrop behind the dialog
let scopeDialog = null;    // the dialog box holding the clone
let scopeStage = null;     // the resizable area the copy is scaled to fill
let scopeScaler = null;    // the element the fit-scale transform is applied to
let scopeSizedBox = null;  // wrapper sized to the SCALED footprint
let scopeMounted = null;   // what's shown (clone, or its <table> wrapper)
let scopeResizeObs = null; // re-fits when the copy or the dialog size changes

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

// Enter scoped mode: pop a dialog containing a styled COPY of the first instance
// of `sel`, and confine picking to that copy. Returns the clone the user picks
// within (or null if `sel` matches nothing — caller then falls back to an
// unconstrained pick rather than trapping the user with nothing to click).
function enterScope(sel) {
  clearScope();
  if (!sel) return null;
  let src = null;
  try { src = document.querySelector(sel); } catch (_) { src = null; }
  if (!src) return null;

  // A copy of the real item. cloneNode(true) keeps its classes/structure, so the
  // page's CSS styles it exactly, and any selector we derive from the clone maps
  // back onto every real instance. Images keep their resolved src, so thumbnails
  // show. `scopeRoot` is the clone itself (what selectors are relative to);
  // `mounted` is what we actually put in the dialog — for table-context elements
  // that's a minimal <table> wrapper, because a bare <tr>/<td> won't render
  // (and thus can't be clicked) outside a table.
  const clone = src.cloneNode(true);
  clone.querySelectorAll && clone.querySelectorAll('a[href]').forEach((a) => a.removeAttribute('href'));
  let srcWidth = '';
  try { srcWidth = getComputedStyle(src).width; } catch (_) {}
  let mounted = clone;
  const tag = src.tagName;
  if (tag === 'TR' || tag === 'TD' || tag === 'TH') {
    const table = document.createElement('table');
    const srcTable = src.closest('table');
    if (srcTable) table.className = srcTable.className; // keep the table's styling
    if (srcWidth) table.style.width = srcWidth; // approximate the column proportions
    const tbody = document.createElement('tbody');
    if (tag === 'TR') {
      tbody.appendChild(clone);
    } else {
      const tr = document.createElement('tr');
      tr.appendChild(clone);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    mounted = table;
  } else {
    // A normal block (card/div): pin its width to the real rendered width (cards
    // often get their width from a grid/flex PARENT that's absent here). Cap
    // max-width to the same value so a late-loading image can never make the copy
    // render wider than the real card. Height stays free (the fit scales it).
    try {
      clone.style.width = srcWidth;
      clone.style.maxWidth = srcWidth;
      clone.style.flex = 'none';
      clone.style.margin = '0';
    } catch (_) {}
  }

  scopeBackdrop = document.createElement('div');
  Object.assign(scopeBackdrop.style, {
    position: 'fixed', inset: '0', zIndex: 2147483640,
    background: 'rgba(15, 23, 42, 0.62)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px'
  });

  // A consistent, comfortable default size — and RESIZABLE (drag the bottom-right
  // corner). The copy inside always scales to fill the stage, so dragging bigger
  // makes the card bigger. overflow:hidden is required for the resize grip.
  const initW = Math.round(Math.min(window.innerWidth * 0.6, 680));
  const initH = Math.round(Math.min(window.innerHeight * 0.62, 540));
  scopeDialog = document.createElement('div');
  Object.assign(scopeDialog.style, {
    display: 'flex', flexDirection: 'column',
    background: '#fff', color: '#0f172a', borderRadius: '10px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.45)', overflow: 'hidden',
    font: '13px/1.5 system-ui, sans-serif',
    width: initW + 'px', height: initH + 'px',
    minWidth: '260px', minHeight: '200px',
    maxWidth: '94vw', maxHeight: '92vh',
    resize: 'both'
  });
  const header = document.createElement('div');
  Object.assign(header.style, {
    flex: '0 0 auto', background: '#5b8fd6', color: '#fff',
    padding: '8px 12px', font: '600 12px/1.4 system-ui, sans-serif'
  });
  header.textContent = '👇 Click the value you want inside this item — Esc to cancel';
  // The stage holds the copy at a single scale so it fits with NO scrolling. The
  // scaler is scaled from its top-left; the sizedBox takes the SCALED footprint so
  // the dialog is only as big as the (bounded) scaled content.
  const stage = document.createElement('div');
  Object.assign(stage.style, {
    flex: '1 1 auto', padding: '16px', display: 'flex',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    background: '#f8fafc'
  });
  const sizedBox = document.createElement('div');
  sizedBox.style.overflow = 'hidden';
  const scaler = document.createElement('div');
  scaler.style.transformOrigin = 'top left';
  scaler.appendChild(mounted);
  sizedBox.appendChild(scaler);
  stage.appendChild(sizedBox);
  scopeDialog.appendChild(header);
  scopeDialog.appendChild(stage);
  scopeBackdrop.appendChild(scopeDialog);
  document.documentElement.appendChild(scopeBackdrop);

  scopeStage = stage;
  scopeScaler = scaler;
  scopeSizedBox = sizedBox;
  scopeMounted = mounted;
  scopeRoot = clone;

  // Scale the copy to FILL the stage. Re-run whenever the copy's size changes
  // (product images load asynchronously, so the first measurement is often too
  // small) OR the dialog is resized — a ResizeObserver on both handles it.
  fitScope();
  try {
    scopeResizeObs = new ResizeObserver(() => fitScope());
    scopeResizeObs.observe(stage);
    scopeResizeObs.observe(mounted);
  } catch (_) {}

  return clone;
}

// Scale the copy to FILL the current stage (so dragging the dialog bigger makes
// the card bigger), preserving aspect ratio and never overflowing. Size the
// wrapper to the scaled footprint so it centres. offsetWidth/Height are the
// LAYOUT (unscaled) size, unaffected by the transform, so this re-runs safely.
function fitScope() {
  if (!scopeStage || !scopeMounted || !scopeScaler || !scopeSizedBox) return;
  const cw = Math.max(1, scopeMounted.offsetWidth);
  const ch = Math.max(1, scopeMounted.offsetHeight);
  const availW = Math.max(1, scopeStage.clientWidth - 32); // stage padding 16*2
  const availH = Math.max(1, scopeStage.clientHeight - 32);
  const f = Math.min(3, availW / cw, availH / ch); // fill; cap keeps images sane
  scopeScaler.style.width = cw + 'px';
  scopeScaler.style.height = ch + 'px';
  scopeScaler.style.transform = 'scale(' + f + ')';
  scopeSizedBox.style.width = Math.round(cw * f) + 'px';
  scopeSizedBox.style.height = Math.round(ch * f) + 'px';
}

function clearScope() {
  scopeRoot = null;
  if (scopeResizeObs) { try { scopeResizeObs.disconnect(); } catch (_) {} scopeResizeObs = null; }
  if (scopeBackdrop && scopeBackdrop.parentNode) scopeBackdrop.parentNode.removeChild(scopeBackdrop);
  scopeBackdrop = null;
  scopeDialog = null;
  scopeStage = null;
  scopeScaler = null;
  scopeSizedBox = null;
  scopeMounted = null;
}

// Flash the label as a transient message near the cursor (e.g. when a click
// lands outside the scoped container).
let flashTimer = null;
function flashMessage(x, y, text) {
  if (!label) return;
  label.style.display = 'block';
  label.style.background = '#c0392b';
  label.textContent = text;
  label.style.left = Math.max(0, x + 8) + 'px';
  label.style.top = Math.max(0, y - 24) + 'px';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { label.style.background = '#5b8fd6'; hideOverlay(); }, 1100);
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

// The repeating unit inside a data table is the ROW, but the cursor always lands
// on a cell. When picking a LIST (e.g. the "For each" item), snap to the
// enclosing <tr> so hovering anywhere in a row highlights the whole row and
// picking it grabs EVERY row. Only for genuine multi-row data tables; a header
// row isn't a data row, so hovering the header falls back to normal cell
// highlighting.
function rowUnder(el) {
  if (!el || !el.closest) return null;
  const tr = el.closest('tr');
  if (!tr) return null;
  const table = tr.closest('table');
  if (!table) return null;
  if (tr.closest('thead')) return null; // header row isn't a data row
  const bodyRows = table.querySelectorAll('tbody tr').length || table.querySelectorAll('tr').length;
  if (bodyRows < 2) return null; // not a repeating structure
  return tr;
}

// Label for a snapped whole-row highlight: "This row — picks every row (9)".
// Counts only rows that actually have cells, so empty spacer <tr></tr> rows
// aren't included in the promise the label makes.
function rowLabel(tr) {
  const table = tr.closest('table');
  let n = 0;
  if (table) {
    const body = table.querySelectorAll('tbody tr');
    const rows = body.length ? body : table.querySelectorAll('tr');
    n = [...rows].filter((r) => r.querySelector('td, th')).length;
  }
  return `📋 This row — picks every row (${n})`;
}

// Walk `base` up `levels` parents, stopping before <body>/<html> so widening can
// never select the whole document. In a scoped pick, also stop AT scopeRoot so
// widening can't escape the container the user is confined to.
function widenedFrom(base, levels) {
  let e = base;
  for (let k = 0; k < levels && e; k++) {
    if (scopeRoot && e === scopeRoot) break;
    const p = e.parentElement;
    if (!p || p === document.body || p === document.documentElement) break;
    if (scopeRoot && !scopeRoot.contains(p)) break;
    e = p;
  }
  return e;
}

// A short label for a widened highlight: "▢ div.wrapper-box".
function boxLabel(el) {
  const tag = el.tagName.toLowerCase();
  const cls = el.classList && el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '';
  return `▢ ${tag}${cls}`;
}

function onMove(e) {
  if (!active) return;
  const el = deepElementFromPoint(e.clientX, e.clientY);
  if (!el || el === overlay || el === label) return;

  // Scoped pick: only elements INSIDE the copied item (the dialog clone) are
  // valid, so don't highlight the dialog chrome or the dimmed backdrop. (Widening
  // with ↑ is also clamped to the clone.)
  if (scopeRoot && !scopeRoot.contains(el)) {
    hoverEl = null;
    lastEl = null;
    if (overlay) overlay.style.display = 'none';
    return;
  }

  if (mode === 'table') {
    hoverEl = null; // widen (↑/↓) doesn't apply to whole-table picks
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

  // Picking a repeating LIST over a table: snap the highlight to the whole row —
  // the common case. Holding Alt opts out, to highlight the single cell instead
  // (a rare "for each cell in this column" pick).
  if (mode === 'list' && !e.altKey) {
    const row = rowUnder(el);
    if (row) {
      hoverEl = null; // rows use snap/Alt, not ↑/↓ widen
      lastEl = row;
      moveOverlay(row, rowLabel(row));
      return;
    }
  }

  // Generic highlight (element mode, or a list pick that isn't a table row).
  // Supports ↑/↓ widen-to-parent (see onKey). Moving to a new base element
  // restarts the widen from that element.
  if (el !== hoverEl) { hoverEl = el; widenLevels = 0; }
  const shown = widenedFrom(hoverEl, widenLevels);
  lastEl = shown;
  moveOverlay(shown, widenLevels > 0 ? boxLabel(shown) : undefined);
}

function onClick(e) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  // With Alt held in list mode, pick the exact cell under the cursor (ignore any
  // stale row-snapped highlight) so the escape hatch is reliable.
  let el = (e.altKey && mode === 'list')
    ? deepElementFromPoint(e.clientX, e.clientY)
    : (lastEl || deepElementFromPoint(e.clientX, e.clientY));
  if (!el) return;

  // Scoped pick: a click outside the copied item (on the dialog chrome or the
  // dimmed backdrop) is not a valid target. Ignore it (stay in pick mode) rather
  // than returning a selector that can't resolve inside the item.
  if (scopeRoot && !scopeRoot.contains(el)) {
    flashMessage(e.clientX, e.clientY, '⤺ Click a value inside the item');
    return;
  }

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

  // Picking a repeating LIST over a table: use the whole row, not the clicked
  // cell (mirrors the row-snapping highlight in onMove). Alt opts out.
  if (mode === 'list' && !e.altKey) {
    const row = rowUnder(el);
    if (row) el = row;
  }

  // `relativeTo` is set for a column pick inside a row, and for ANY pick made
  // while editing a step nested in a "For each" — the selector must then be
  // relative to the container so it resolves per item at run time. In scoped
  // mode the container is the dialog CLONE (scopeRoot); a selector relative to it
  // maps onto every real instance. Otherwise fall back to the nearest matching
  // ancestor on the live page.
  const root = scopeRoot || (relativeTo ? el.closest(relativeTo) : null);

  if (mode === 'list' && root) {
    // A repeating list nested INSIDE the container (e.g. tags within a card).
    let res = relativeListSelector(el, root);
    if (el.tagName === 'TR') res = narrowRowsWithCells(res, root); // drop spacer rows
    const { selector, count } = res;
    ipcRenderer.sendToHost('picker:picked', {
      mode,
      selector,
      count,
      relative: true,
      sample: sampleText(root.querySelector(selector) || el)
    });
  } else if (mode === 'list') {
    let res = listSelector(el);
    if (el.tagName === 'TR') res = narrowRowsWithCells(res); // drop spacer rows
    const { selector, count } = res;
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

// ↑ ('up') widens the highlight out to the parent box; ↓ ('down') walks back in
// toward the element under the cursor. This is how you grab a whole card (e.g.
// the .wrapper-box around a thumbnail + content) without a bare edge to hover.
// Called both from the guest's own keydown AND from the host (which forwards the
// arrow keys, since keyboard focus is usually on the host during a pick).
function widenStep(dir) {
  if (!active || !hoverEl) return; // not applicable (table / row-snap / nothing hovered)
  if (dir === 'up') {
    // Only step up if there's actually a bigger box to select.
    if (widenedFrom(hoverEl, widenLevels + 1) !== widenedFrom(hoverEl, widenLevels)) widenLevels++;
  } else if (widenLevels > 0) {
    widenLevels--;
  }
  const shown = widenedFrom(hoverEl, widenLevels);
  lastEl = shown;
  moveOverlay(shown, widenLevels > 0 ? boxLabel(shown) : undefined);
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') {
    ipcRenderer.sendToHost('picker:cancelled', {});
    stop();
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    widenStep(e.key === 'ArrowUp' ? 'up' : 'down');
  }
}

function start(opts) {
  ensureOverlay();
  mode = (opts && opts.mode) || 'element';
  relativeTo = (opts && opts.relativeTo) || '';
  hoverEl = null;
  widenLevels = 0;
  active = true;
  // Scoped pick: pop a dialog with a copy of the container so only its own
  // elements can be picked. If the container isn't on the page (bad selector /
  // navigated away), fall back to a normal unconstrained pick rather than
  // trapping the user with nothing selectable.
  clearScope();
  if (relativeTo) enterScope(relativeTo);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  if (document.body) document.body.style.cursor = 'crosshair';
}

function stop() {
  active = false;
  hideOverlay();
  clearScope();
  document.removeEventListener('mousemove', onMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKey, true);
  if (document.body) document.body.style.cursor = '';
}

ipcRenderer.on('picker:start', (_e, opts) => start(opts));
ipcRenderer.on('picker:stop', () => stop());
ipcRenderer.on('picker:widen', (_e, dir) => widenStep(dir));

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

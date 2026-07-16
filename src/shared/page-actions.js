// ===========================================================================
// Shared scraping engine — pure logic with NO Electron/DOM-event dependencies.
//
// Two kinds of exports:
//   1. DOM helpers (cssPath, listSelector, …) — run wherever `document` exists
//      (the webview picker preload, or a page context during tests).
//   2. Code builders (extractExpr, listExpr, selectExpr, …) — return strings of
//      JavaScript that the app runs inside the page via executeJavaScript, and
//      that tests run via page.evaluate. Same code both places => testable.
//
// Loaded three ways:
//   - <script src> in the renderer  -> window.PageActions
//   - require() in the webview preload
//   - require() in the Node test harness
// ===========================================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PageActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Selector generation (needs `document`) -----------------------------

  function isStableClass(c) {
    if (!c) return false;
    if (/^(css-|sc-|jsx-|_)/.test(c)) return false; // framework-generated
    if (/[0-9]{4,}/.test(c)) return false; // long digit runs => generated
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

  // Build a selector: unique enough, resilient to minor page changes.
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

  // Generalize a single element's selector to match all its repeating siblings.
  // The positional constraint that makes a selector unique often sits on an
  // ancestor (e.g. `li:nth-of-type(1) > article > … > p.price`), so we try
  // dropping ALL positional constraints first — that usually exposes the
  // repeating class signature shared by every sibling.
  function listSelector(el) {
    const single = cssPath(el);
    const candidates = [
      single.replace(/:nth-of-type\(\d+\)/g, ''), // drop all positions
      single.replace(/:nth-of-type\(\d+\)$/, '') // drop only the last
    ];
    for (const c of candidates) {
      try {
        const count = document.querySelectorAll(c).length;
        if (count > 1) return { selector: c, count };
      } catch (_) {}
    }
    return { selector: single, count: 1 };
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

  // ---- Tables: the one shape a picker can't guess ---------------------------
  //
  // An HTML table is a scrape that's already been done for you: the <th>s name
  // the columns and the <td>s line them up. But a generic element picker is
  // hopeless on one — clicking a row generalizes to `tr` (which swallows the
  // HEADER row) and clicking a cell gives `tr > td` (every cell in the page).
  //
  // So when a pick lands anywhere inside a <table>, we read the table's own
  // structure instead of guessing: real body rows, one column per header, and a
  // flag for the rows that are obviously summaries (Subtotal / Total).

  const HEADERISH = 'total|totals|sum|subtotal|grand|footer|summary';

  function slugify(text, i) {
    let s = (text || '').trim().toLowerCase();
    s = s.replace(/[^a-z0-9]+/g, ' ').trim(); // "Margin %" -> "margin"
    if (!s) return 'col' + (i + 1);
    const parts = s.split(' ');
    return (
      parts[0] +
      parts
        .slice(1)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join('')
    );
  }

  // Does this column's data look numeric (money, percent, plain numbers)?
  function looksNumeric(cells) {
    const seen = cells.map((c) => (c ? (c.innerText || c.textContent || '').trim() : '')).filter(Boolean);
    if (!seen.length) return false;
    const numeric = seen.filter((t) => /^[^\w]*-?[\d.,]+\s*%?$/.test(t) || /^[£$€]\s*-?[\d.,]+/.test(t));
    return numeric.length >= Math.ceil(seen.length * 0.6);
  }

  // Given ANY element inside a table (a row, a cell, the table itself), describe
  // the whole table: how to select its data rows, and one column per header.
  function tableInfo(el) {
    if (!(el instanceof Element)) return null;
    const table = el.closest('table');
    if (!table) return null;

    const tableSel = cssPath(table);

    // Body rows = <tbody> rows if present, otherwise every row that isn't the
    // header (a row made of <th>s).
    const hasTbody = !!table.querySelector('tbody tr');
    const rowPart = hasTbody ? 'tbody tr' : 'tr';
    let rows = Array.from(table.querySelectorAll(rowPart));
    if (!hasTbody) rows = rows.filter((r) => !r.querySelector('th'));
    if (!rows.length) return null;

    // Header names: <thead> cells, else the first row's <th>s.
    let heads = Array.from(table.querySelectorAll('thead th, thead td'));
    if (!heads.length) {
      const first = table.querySelector('tr');
      if (first && first.querySelector('th')) heads = Array.from(first.children);
    }

    // Column count from the widest body row (headers can be missing/merged).
    const width = rows.reduce((m, r) => Math.max(m, r.children.length), 0);
    if (!width) return null;

    const columns = [];
    for (let i = 0; i < width; i++) {
      const head = heads[i];
      const label = head ? (head.innerText || head.textContent || '').trim() : '';
      const name = slugify(label, i);
      const cells = rows.slice(0, 8).map((r) => r.children[i]);
      // Is every sampled cell in this column empty? A column with NO header and
      // NO data is a spacer (a stray/colspan cell that pushed the row width out) —
      // the app defaults those OFF so "col6/col7" junk never reaches the CSV.
      const blank = cells.every((c) => !c || !(c.innerText || c.textContent || '').trim());
      columns.push({
        name,
        label,
        selector: 'td:nth-child(' + (i + 1) + ')',
        numeric: looksNumeric(cells),
        blank
      });
    }

    // Summary rows: a class shared by SOME (not all) rows whose name reads like
    // a total — e.g. <tr class="total">. Also catch rows whose first cell says so.
    const counts = {};
    for (const r of rows) r.classList.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
    const summaryClass = Object.keys(counts).find(
      (c) => new RegExp(HEADERISH, 'i').test(c) && counts[c] < rows.length
    );
    const summaryRows = summaryClass
      ? counts[summaryClass]
      : rows.filter((r) => {
          const t = r.children[0];
          return t && new RegExp('^(' + HEADERISH + ')\\b', 'i').test((t.innerText || '').trim());
        }).length;

    // WHICH table did they click? A page can have many. The selector above is
    // unique to this one, but the user needs to SEE that it's the right one — so
    // name it (its <caption>, or the nearest heading above it) and say where it
    // sits among the page's tables.
    const all = Array.from(document.querySelectorAll('table'));
    const index = all.indexOf(table) + 1;

    let title = '';
    const cap = table.querySelector('caption');
    if (cap) title = (cap.innerText || cap.textContent || '').trim();
    if (!title) {
      // Walk backwards through the document for the closest preceding heading.
      const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      for (let i = heads.length - 1; i >= 0; i--) {
        const h = heads[i];
        if (h.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) {
          title = (h.innerText || h.textContent || '').trim();
          break;
        }
      }
    }

    return {
      isTable: true,
      rowSelector: tableSel + ' ' + rowPart,
      rowSelectorNoTotals: summaryClass ? tableSel + ' ' + rowPart + ':not(.' + summaryClass + ')' : '',
      summaryClass: summaryClass || '',
      summaryRows,
      rowCount: rows.length,
      columns,
      title: title.slice(0, 60),
      tableIndex: index,
      tableCount: all.length
    };
  }

  // Code-builder form: run tableInfo inside the page for an already-picked
  // selector. tableInfo leans on cssPath/slugify/looksNumeric, so we ship those
  // along with it — the page has no access to this module's scope.
  function tableInfoExpr(selector) {
    return `(() => {
      const HEADERISH = ${J(HEADERISH)};
      const isStableClass = ${isStableClass.toString()};
      const classSelector = ${classSelector.toString()};
      const indexOfType = ${indexOfType.toString()};
      const cssPath = ${cssPath.toString()};
      const slugify = ${slugify.toString()};
      const looksNumeric = ${looksNumeric.toString()};
      const tableInfo = ${tableInfo.toString()};
      const el = document.querySelector(${J(selector)});
      return el ? tableInfo(el) : null;
    })()`;
  }

  // ---- Extraction (code builders) -----------------------------------------

  // A statement (ending in `return …`) that extracts a value from element `v`.
  function extractStmt(v, mode, attr) {
    switch (mode) {
      case 'html':
        return `return ${v} ? ${v}.innerHTML : null;`;
      case 'attr':
        return `return ${v} ? ${v}.getAttribute(${J(attr || '')}) : null;`;
      case 'href':
        return `return ${v} ? (${v}.href || ${v}.getAttribute('href')) : null;`;
      case 'src':
        return `return ${v} ? (${v}.currentSrc || ${v}.src || ${v}.getAttribute('src')) : null;`;
      case 'value':
        return `return ${v} ? (${v}.value != null ? ${v}.value : '') : null;`;
      case 'checked':
        return `return ${v} ? !!${v}.checked : null;`;
      default: // text
        return `return ${v} ? (${v}.innerText || ${v}.textContent || '').replace(/\\s+/g,' ').trim() : null;`;
    }
  }

  function extractExpr(selector, mode, attr) {
    return `(() => { const el = document.querySelector(${J(selector)}); ${extractStmt(
      'el',
      mode,
      attr
    )} })()`;
  }

  // Returns an array of row objects from a repeating selector.
  function listExpr(rowSelector, fields) {
    const fieldCode = fields
      .map((f) => {
        const target = f.selector ? `row.querySelector(${J(f.selector)})` : 'row';
        return `o[${J(f.name)}] = (el => { ${extractStmt('el', f.extract, f.attr)} })(${target});`;
      })
      .join('\n');
    return `(() => {
      const rows = Array.from(document.querySelectorAll(${J(rowSelector)}));
      return rows.map(row => { const o = {}; ${fieldCode} return o; });
    })()`;
  }

  // Filter a repeating selector's matches by rules on each element's text /
  // attribute / number. Returns which matches pass (their indices), the totals,
  // and a few samples — powering "For each … where …" plus its live preview.
  //
  // A rule: { test:'text'|'attr'|'number', attr, op, value }. `match` is 'all' or
  // 'any'. Empty rules → everything passes. Runs entirely in the page (self-
  // contained: no module scope) so it can be shipped via executeJavaScript.
  function elementFilterExpr(selector, filter) {
    return `(() => {
      const nodes = Array.from(document.querySelectorAll(${J(selector)}));
      const filter = ${JSON.stringify(filter || null)};
      const norm = s => (s == null ? '' : String(s)).replace(/\\s+/g,' ').trim();
      const numOf = s => { const m = String(s == null ? '' : s).match(/-?[0-9][0-9.,]*/); return m ? parseFloat(m[0].replace(/,/g,'')) : NaN; };
      const active = filter && Array.isArray(filter.rules)
        ? filter.rules.filter(r => r
            && (r.test !== 'cell' || String(r.selector != null ? r.selector : '').trim() !== '') // a column rule needs a column
            && (String(r.value != null ? r.value : '').trim() !== '' || r.op === 'empty' || r.op === 'nempty'))
        : [];
      function fieldRaw(el, rule) {
        if (rule.test === 'attr') return el.getAttribute(rule.attr || '') || '';
        // A specific column: read one descendant cell (selector relative to the
        // row), so "the Category column = Other" tests THAT cell, not the whole
        // row's text — even when several columns share a tag/class.
        if (rule.test === 'cell') {
          if (!rule.selector) return '';
          let c = null;
          try { c = el.querySelector(rule.selector); } catch (_) { c = null; }
          return c ? norm(c.innerText || c.textContent) : '';
        }
        return norm(el.innerText || el.textContent);
      }
      function testRule(el, rule) {
        const raw = fieldRaw(el, rule);
        const op = rule.op;
        const want = rule.value == null ? '' : String(rule.value);
        if (op === 'empty') return norm(raw) === '';
        if (op === 'nempty') return norm(raw) !== '';
        if (rule.test === 'number' || op === 'gt' || op === 'ge' || op === 'lt' || op === 'le') {
          const a = numOf(raw), b = parseFloat(String(want).replace(/,/g,''));
          if (op === 'gt') return a > b;
          if (op === 'ge') return a >= b;
          if (op === 'lt') return a < b;
          if (op === 'le') return a <= b;
          if (op === 'eq') return a === b;
          if (op === 'ne') return a !== b;
        }
        const s = raw.toLowerCase(), w = want.toLowerCase();
        switch (op) {
          case 'contains': return s.indexOf(w) >= 0;
          case 'ncontains': return s.indexOf(w) < 0;
          case 'eq': return s === w;
          case 'ne': return s !== w;
          case 'startsWith': return s.lastIndexOf(w, 0) === 0;
          case 'endsWith': return w === '' || s.slice(-w.length) === w;
          case 'matches': try { return new RegExp(want).test(raw); } catch (_) { return false; }
          default: return true;
        }
      }
      function pass(el) {
        if (!active.length) return true;
        const rs = active.map(r => testRule(el, r));
        return filter.match === 'any' ? rs.some(Boolean) : rs.every(Boolean);
      }
      const kept = [];
      const samples = [];
      nodes.forEach((el, i) => {
        if (pass(el)) {
          kept.push(i);
          if (samples.length < 12) samples.push({ i, text: norm(el.innerText || el.textContent).slice(0, 90) });
        }
      });
      return { total: nodes.length, matched: kept.length, kept, samples, filtered: active.length > 0 };
    })()`;
  }

  // ---- Action builders (return {ok, ...}) ---------------------------------

  function clickExpr(selector) {
    return `(() => {
      const el = document.querySelector(${J(selector)});
      if (!el) return { ok:false, err:'not found' };
      el.scrollIntoView({ block:'center' });
      el.click();
      return { ok:true };
    })()`;
  }

  // Click the (smallest) element whose visible text matches — for calendar
  // days, custom-dropdown options, tabs, buttons without stable selectors.
  function clickTextExpr({ container, tag, text, mode }) {
    return `(() => {
      const scope = ${container ? `document.querySelector(${J(container)})` : 'document'};
      if (!scope) return { ok:false, err:'container not found' };
      const norm = s => (s||'').replace(/\\s+/g,' ').trim();
      const want = norm(${J(text)});
      const nodes = Array.from(scope.querySelectorAll(${J(tag || '*')}));
      let hits = nodes.filter(n => {
        const t = norm(n.textContent);
        return ${mode === 'contains' ? 't.includes(want)' : 't === want'};
      });
      // Prefer the actually-clickable element on a tie. A "VIEW" link sits inside
      // a <td> that shares its text; clicking the <td> does nothing, so a link /
      // button / [role=button] with the same label must win over its container.
      const clickable = (n) => {
        const tg = n.tagName;
        if (tg === 'A' || tg === 'BUTTON') return true;
        if (n.getAttribute && (n.getAttribute('role') === 'button' || n.hasAttribute('onclick'))) return true;
        if (tg === 'INPUT') { const t = (n.getAttribute('type')||'').toLowerCase(); return t === 'submit' || t === 'button'; }
        return false;
      };
      hits.sort((a, b) => (clickable(b) - clickable(a)) || (a.textContent.length - b.textContent.length));
      const el = hits[0];
      if (!el) return { ok:false, err:'no text match for "'+want+'"' };
      el.scrollIntoView({ block:'center' });
      el.click();
      return { ok:true, text: norm(el.textContent).slice(0,60) };
    })()`;
  }

  function fillExpr(selector, text, clear) {
    return `(() => {
      const el = document.querySelector(${J(selector)});
      if (!el) return { ok:false, err:'not found' };
      el.focus();
      // Set the value through the element PROTOTYPE's native setter. Frameworks
      // like React patch the instance-level value setter with a change tracker;
      // writing via the instance setter (el.value = x) updates that tracker too,
      // so React thinks nothing changed, ignores our input event, and on its
      // next render resets the field to its (empty) state — which is why a
      // search would run blank. The native setter bypasses the tracker, so the
      // input event is seen as a real change and the value sticks.
      const setVal = (v) => {
        if (el.isContentEditable) { el.textContent = v; return; }
        let proto = null;
        if (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
        else if (typeof HTMLSelectElement !== 'undefined' && el instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;
        else if (typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) proto = HTMLInputElement.prototype;
        const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, v);
        else el.value = v;
      };
      ${clear ? 'setVal("");' : ''}
      setVal(${J(text)});
      // Fire the events frameworks and plain listeners expect, with the modern
      // InputEvent where available.
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${J(text)} })); }
      catch (_) { el.dispatchEvent(new Event('input', { bubbles: true })); }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok:true, value: (el.value != null ? el.value : (el.textContent || '')) };
    })()`;
  }

  // Native <select>. by = 'value' | 'text' | 'index'. Handles multi-selects.
  function selectExpr(selector, by, value, multi) {
    return `(() => {
      const el = document.querySelector(${J(selector)});
      if (!el) return { ok:false, err:'not found' };
      if (!el.options) return { ok:false, err:'not a <select>' };
      const opts = Array.from(el.options);
      const norm = s => (s||'').replace(/\\s+/g,' ').trim();
      const want = ${J(String(value))};
      let target;
      if (${J(by)} === 'index') target = opts[Number(want)];
      else if (${J(by)} === 'text')
        target = opts.find(o => norm(o.text) === want) || opts.find(o => norm(o.text).includes(want));
      else
        target = opts.find(o => o.value === want) || opts.find(o => o.value.includes(want));
      if (!target) return { ok:false, err:'option not found: '+want };
      if (el.multiple && ${multi ? 'true' : 'false'}) target.selected = true;
      else el.value = target.value;
      el.dispatchEvent(new Event('input', { bubbles:true }));
      el.dispatchEvent(new Event('change', { bubbles:true }));
      return { ok:true, chosen: norm(target.text), value: target.value };
    })()`;
  }

  // state = 'check' | 'uncheck' | 'toggle'. Uses click() so listeners fire.
  function checkExpr(selector, state) {
    return `(() => {
      const el = document.querySelector(${J(selector)});
      if (!el) return { ok:false, err:'not found' };
      const want = ${J(state)} === 'toggle' ? !el.checked : ${J(state)} === 'check';
      if (el.checked !== want) el.click();
      if (el.checked !== want) { el.checked = want; el.dispatchEvent(new Event('change', { bubbles:true })); }
      return { ok:true, checked: el.checked };
    })()`;
  }

  function hoverExpr(selector) {
    return `(() => {
      const el = document.querySelector(${J(selector)});
      if (!el) return { ok:false, err:'not found' };
      el.scrollIntoView({ block:'center' });
      const r = el.getBoundingClientRect();
      const o = { bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2 };
      ['pointerover','mouseover','pointerenter','mouseenter','mousemove'].forEach(t => {
        try { el.dispatchEvent(new MouseEvent(t, o)); } catch(_) {}
      });
      return { ok:true };
    })()`;
  }

  // Read a <select>'s live options so the UI can offer real choices.
  function readOptionsExpr(selector) {
    return `(() => {
      const el = document.querySelector(${J(selector)});
      if (!el || !el.options) return null;
      return Array.from(el.options).map((o,i) => ({ i, value:o.value, text:(o.text||'').replace(/\\s+/g,' ').trim() }));
    })()`;
  }

  function existsExpr(selector) {
    return `!!document.querySelector(${J(selector)})`;
  }

  // Collect a value from EVERY element matching `selector` into an array — the
  // "gather a list" primitive (e.g. every child link's href, every price).
  // mode 'attr' reads an attribute; for href we use the .href PROPERTY so the
  // URL is absolute (ready to navigate to). Anything else reads trimmed text.
  function collectExpr(selector, mode, attr) {
    return `(() => {
      const els = Array.from(document.querySelectorAll(${J(selector)}));
      const mode = ${J(mode || 'text')}, attr = ${J(attr || '')};
      return els.map((el) => {
        if (mode === 'attr') {
          if (attr === 'href' && el.href != null && el.href !== '') return el.href;
          if (attr === 'src' && el.src != null && el.src !== '') return el.src;
          return el.getAttribute(attr) || '';
        }
        return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      });
    })()`;
  }

  // What would you most likely want OFF this element? A form field's value lives
  // in .value (its text is empty) — the #1 "why is it 0/blank?" gotcha — so we
  // suggest the right source instead of the generic "text". Returns e.g.
  // { source:'value', tag:'input', type:'date', strong:true }.
  function suggestSourceExpr(selector) {
    return `(() => {
      const el = document.querySelector(${J(selector)});
      if (!el) return null;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      let source = 'text', strong = false;
      if (tag === 'input') {
        if (type === 'checkbox' || type === 'radio') { source = 'checked'; }
        else { source = 'value'; }
        strong = true;
      } else if (tag === 'textarea' || tag === 'select') {
        source = 'value'; strong = true;
      } else if (tag === 'img') {
        source = 'src'; strong = true;
      }
      return { source, tag, type, strong };
    })()`;
  }

  // Does a piece of TEXT appear on the page (optionally only within a container)?
  // Great for "did my save actually work?" — check for a confirmation message
  // without needing a selector for it. mode = 'contains' | 'exact'. Returns a
  // boolean. Matching is whitespace-normalized; 'contains' is case-insensitive.
  function textExistsExpr(text, container, mode) {
    return `(() => {
      const scope = ${container ? `document.querySelector(${J(container)})` : 'document.body'};
      if (!scope) return false;
      const norm = s => (s == null ? '' : String(s)).replace(/\\s+/g,' ').trim();
      const hay = norm(scope.innerText || scope.textContent);
      const want = norm(${J(text)});
      if (!want) return false;
      return ${mode === 'exact'
        ? 'hay === want'
        : 'hay.toLowerCase().indexOf(want.toLowerCase()) >= 0'};
    })()`;
  }

  function scrollExpr(mode, px) {
    if (mode === 'top') return 'window.scrollTo(0, 0)';
    if (mode === 'by') return `window.scrollBy(0, ${Number(px) || 0})`;
    return 'window.scrollTo(0, document.body.scrollHeight)';
  }

  // JSON.stringify shorthand for embedding literals safely into code strings.
  function J(v) {
    return JSON.stringify(v == null ? '' : v);
  }

  return {
    // DOM helpers
    isStableClass,
    classSelector,
    indexOfType,
    cssPath,
    listSelector,
    deepElementFromPoint,
    sampleText,
    safeCount,
    tableInfo,
    tableInfoExpr,
    // code builders
    extractStmt,
    extractExpr,
    listExpr,
    elementFilterExpr,
    clickExpr,
    clickTextExpr,
    fillExpr,
    selectExpr,
    checkExpr,
    hoverExpr,
    readOptionsExpr,
    existsExpr,
    collectExpr,
    textExistsExpr,
    suggestSourceExpr,
    scrollExpr
  };
});

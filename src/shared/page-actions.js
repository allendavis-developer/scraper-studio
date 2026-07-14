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
      hits.sort((a,b) => a.textContent.length - b.textContent.length); // most specific first
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
    // code builders
    extractStmt,
    extractExpr,
    listExpr,
    clickExpr,
    clickTextExpr,
    fillExpr,
    selectExpr,
    checkExpr,
    hoverExpr,
    readOptionsExpr,
    existsExpr,
    scrollExpr
  };
});

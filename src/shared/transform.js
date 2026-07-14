// ===========================================================================
// Text clean-up / extraction pipeline.
//
// A scraped value is nearly always messy — "£1,299.99 (inc VAT)", "Posted on
// 14 July 2026", "SKU-1234 · in stock". Pulling the useful part out of that
// normally means regex, which is a coder tool. Instead a step carries a small
// LIST of named clean-ups ("Text between … and …", "Number", "First number"),
// each picked from a dropdown and applied in order — a visual pipeline.
//
// TRANSFORM_OPS is the single source of truth: the renderer builds the UI from
// it (label + argument fields), apply() runs it, and test/transform-tests.js
// covers it headlessly.
//
// Loaded as window.Transform in the renderer, require()'d in tests.
// ===========================================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Transform = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const S = (v) => (v == null ? '' : String(v));

  // "£1,299.99" → 1299.99 · "" → 0
  function toNumber(v) {
    const n = parseFloat(S(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  // The numbers inside a string, in order: "3 of 12 left (£4.50)" → [3, 12, 4.5]
  function numbersIn(v) {
    const hits = S(v).match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
    return hits.map(toNumber);
  }

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };

  const pad2 = (n) => (n < 10 ? '0' + n : String(n));

  // Dates the user can actually explain: they tell us whether their site writes
  // day-first or month-first, so we never have to guess 03/04/2026.
  function toIsoDate(v, order) {
    const s = S(v).trim();
    if (!s) return '';

    const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${iso[1]}-${pad2(+iso[2])}-${pad2(+iso[3])}`;

    // 14 July 2026 / 14 Jul 2026
    const dText = s.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
    if (dText) {
      const m = MONTHS[dText[2].slice(0, 3).toLowerCase()];
      if (m) return `${dText[3]}-${pad2(m)}-${pad2(+dText[1])}`;
    }

    // July 14, 2026 / Jul 14 2026
    const mText = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})\s*(?:st|nd|rd|th)?,?\s+(\d{4})/);
    if (mText) {
      const m = MONTHS[mText[1].slice(0, 3).toLowerCase()];
      if (m) return `${mText[3]}-${pad2(m)}-${pad2(+mText[2])}`;
    }

    // 14/07/2026 · 07-14-26 · 14.07.2026
    const num = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
    if (num) {
      const a = +num[1];
      const b = +num[2];
      let y = +num[3];
      if (y < 100) y += 2000;
      const d = order === 'mdy' ? b : a;
      const m = order === 'mdy' ? a : b;
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(m)}-${pad2(d)}`;
    }
    return '';
  }

  // Each op: { v, label, args, fn }. `args` drives the UI (one input each).
  const TRANSFORM_OPS = [
    // — tidy up —
    { v: 'trim', short: 'Tidy spaces', label: 'Tidy spaces (trim + collapse doubles)', args: [],
      fn: (x) => S(x).replace(/\s+/g, ' ').trim() },
    { v: 'lower', short: 'lowercase', label: 'lowercase', args: [], fn: (x) => S(x).toLowerCase() },
    { v: 'upper', short: 'UPPERCASE', label: 'UPPERCASE', args: [], fn: (x) => S(x).toUpperCase() },

    // — numbers —
    { v: 'number', short: 'Number', label: 'Number — strip £ $ , %  ("£1,299.99" → 1299.99)', args: [],
      fn: (x) => toNumber(x) },
    { v: 'firstNumber', short: 'First number', label: 'First number in the text  ("5 left" → 5)', args: [],
      fn: (x) => { const n = numbersIn(x); return n.length ? n[0] : 0; } },
    { v: 'lastNumber', short: 'Last number', label: 'Last number in the text', args: [],
      fn: (x) => { const n = numbersIn(x); return n.length ? n[n.length - 1] : 0; } },
    { v: 'int', short: 'Whole number', label: 'Whole number (drop the decimals)', args: [],
      fn: (x) => Math.trunc(toNumber(x)) },
    { v: 'round', short: 'Round', label: 'Round to … decimal places', args: [{ name: 'a', placeholder: 'e.g. 2', type: 'number' }],
      fn: (x, a) => { const f = Math.pow(10, parseInt(a, 10) || 0); return Math.round(toNumber(x) * f) / f; } },
    { v: 'digits', short: 'Digits only', label: 'Keep only the digits  ("SKU-1234" → "1234")', args: [],
      fn: (x) => S(x).replace(/\D/g, '') },

    // — pull a piece out —
    { v: 'between', short: 'Text between', label: 'Text between … and …', args: [
        { name: 'a', placeholder: 'after this' }, { name: 'b', placeholder: 'before this' }],
      fn: (x, a, b) => {
        const s = S(x);
        const i = s.indexOf(S(a));
        if (i < 0) return '';
        const from = i + S(a).length;
        const j = S(b) === '' ? -1 : s.indexOf(S(b), from);
        return (j < 0 ? s.slice(from) : s.slice(from, j)).trim();
      } },
    { v: 'after', short: 'Text after', label: 'Text after …', args: [{ name: 'a', placeholder: 'this text' }],
      fn: (x, a) => {
        const s = S(x);
        const i = s.indexOf(S(a));
        return i < 0 ? '' : s.slice(i + S(a).length).trim();
      } },
    { v: 'before', short: 'Text before', label: 'Text before …', args: [{ name: 'a', placeholder: 'this text' }],
      fn: (x, a) => {
        const s = S(x);
        const i = s.indexOf(S(a));
        return i < 0 ? '' : s.slice(0, i).trim();
      } },
    { v: 'part', short: 'Split, take part', label: 'Split by … and take part #', args: [
        { name: 'a', placeholder: 'separator, e.g. |' }, { name: 'b', placeholder: 'part no. (1 = first)', type: 'number' }],
      fn: (x, a, b) => {
        const sep = S(a);
        if (!sep) return S(x);
        const parts = S(x).split(sep);
        const i = (parseInt(b, 10) || 1) - 1;
        return i >= 0 && i < parts.length ? parts[i].trim() : '';
      } },

    // — rewrite —
    { v: 'replace', short: 'Replace', label: 'Replace … with …', args: [
        { name: 'a', placeholder: 'find' }, { name: 'b', placeholder: 'replace with' }],
      fn: (x, a, b) => (S(a) === '' ? S(x) : S(x).split(S(a)).join(S(b))) },
    { v: 'prepend', short: 'Add at start', label: 'Add text at the start', args: [{ name: 'a', placeholder: 'e.g. https://site.com' }],
      fn: (x, a) => S(a) + S(x) },
    { v: 'append', short: 'Add at end', label: 'Add text at the end', args: [{ name: 'a', placeholder: 'e.g.  GBP' }],
      fn: (x, a) => S(x) + S(a) },
    { v: 'pad', short: 'Pad', label: 'Pad with leading zeros to a width', args: [{ name: 'a', placeholder: 'e.g. 2', type: 'number' }],
      fn: (x, a) => {
        let s = S(x);
        const w = parseInt(a, 10) || 0;
        while (s.length < w) s = '0' + s;
        return s;
      } },
    { v: 'default', short: 'If empty use', label: 'If it is empty, use …', args: [{ name: 'a', placeholder: 'fallback value' }],
      fn: (x, a) => (S(x).trim() === '' ? S(a) : x) },

    // — dates —
    { v: 'dateDMY', short: 'Date (day first)', label: 'Date, day first (14/07/2026) → 2026-07-14', args: [],
      fn: (x) => toIsoDate(x, 'dmy') },
    { v: 'dateMDY', short: 'Date (month first)', label: 'Date, month first (07/14/2026) → 2026-07-14', args: [],
      fn: (x) => toIsoDate(x, 'mdy') },

    // — power users —
    { v: 'pattern', short: 'Pattern', label: 'Custom pattern (regex) — advanced', args: [
        { name: 'a', placeholder: 'e.g. [0-9]+' }, { name: 'b', placeholder: 'capture group (blank = whole)', type: 'number' }],
      fn: (x, a, b) => {
        try {
          const m = S(x).match(new RegExp(S(a)));
          if (!m) return '';
          const g = S(b).trim() === '' ? 0 : parseInt(b, 10) || 0;
          return m[g] == null ? '' : m[g];
        } catch (_) {
          return '';
        }
      } }
  ];

  const OP = {};
  for (const o of TRANSFORM_OPS) OP[o.v] = o;

  // Run the clean-ups in order. Unknown ops are skipped, so an old job that
  // used a since-renamed op still runs (it just doesn't transform).
  function apply(value, transforms) {
    let v = value;
    for (const t of transforms || []) {
      const op = OP[t && t.op];
      if (!op) continue;
      try {
        v = op.fn(v, t.a, t.b);
      } catch (_) {
        /* a bad clean-up leaves the value alone rather than killing the run */
      }
    }
    return v;
  }

  // One-line description for the step list, e.g. 'text between "£" and "("' → number
  function summary(transforms) {
    const list = (transforms || []).filter((t) => t && OP[t.op]);
    if (!list.length) return '';
    return list
      .map((t) => {
        const op = OP[t.op];
        const short = op.short;
        const args = [t.a, t.b].filter((x) => x != null && String(x) !== '');
        return args.length ? `${short}(${args.join(', ')})` : short;
      })
      .join(' → ');
  }

  return { TRANSFORM_OPS, apply, summary, toNumber, toIsoDate, numbersIn };
});

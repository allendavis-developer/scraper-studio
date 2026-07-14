// ===========================================================================
// Tiny safe expression evaluator for Scrape Studio's control flow.
//
// Supports: numbers, 'strings', true/false, variables, ( ), the operators
// + - * / %, comparisons < <= > >= == !=, logical && || !, and a set of helper
// functions (len, lower, upper, trim, number, int, round, floor, ceil, abs,
// min, max, contains, startsWith, endsWith, replace, slice).
//
// No eval / new Function (blocked by CSP and unsafe) — this is a hand-written
// recursive-descent parser. Values keep their natural JS types, so a variable
// set from an element count is a number and arithmetic "just works", while a
// scraped text value is a string (use number(x) to convert).
//
// Loaded as window.Expr in the renderer and require()'d in tests.
// ===========================================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Expr = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- tokenizer ----------------------------------------------------------
  function tokenize(src) {
    const toks = [];
    let i = 0;
    const two = ['<=', '>=', '==', '!=', '&&', '||'];
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        let n = '';
        while (i < src.length && /[0-9.]/.test(src[i])) n += src[i++];
        toks.push({ t: 'num', v: parseFloat(n) });
        continue;
      }
      if (c === '"' || c === "'") {
        const q = c;
        i++;
        let s = '';
        while (i < src.length && src[i] !== q) {
          if (src[i] === '\\' && i + 1 < src.length) {
            const nx = src[i + 1];
            s += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
            i += 2;
          } else s += src[i++];
        }
        i++; // closing quote
        toks.push({ t: 'str', v: s });
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let id = '';
        while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) id += src[i++];
        toks.push({ t: 'id', v: id });
        continue;
      }
      const pair = src.slice(i, i + 2);
      if (two.includes(pair)) {
        toks.push({ t: 'op', v: pair });
        i += 2;
        continue;
      }
      if ('+-*/%<>!(),'.includes(c)) {
        toks.push({ t: 'op', v: c });
        i++;
        continue;
      }
      throw new Error('Unexpected character: ' + c);
    }
    toks.push({ t: 'eof' });
    return toks;
  }

  // ---- parser (recursive descent) ----------------------------------------
  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const eat = (v) => {
      if (toks[p].v === v) {
        p++;
        return true;
      }
      return false;
    };

    function parseExpr() {
      return parseOr();
    }
    function binL(sub, ops) {
      let left = sub();
      while (peek().t === 'op' && ops.includes(peek().v)) {
        const op = next().v;
        left = { k: 'bin', op, l: left, r: sub() };
      }
      return left;
    }
    const parseOr = () => binL(parseAnd, ['||']);
    const parseAnd = () => binL(parseEq, ['&&']);
    const parseEq = () => binL(parseCmp, ['==', '!=']);
    const parseCmp = () => binL(parseAdd, ['<', '<=', '>', '>=']);
    const parseAdd = () => binL(parseMul, ['+', '-']);
    const parseMul = () => binL(parseUnary, ['*', '/', '%']);

    function parseUnary() {
      if (peek().t === 'op' && (peek().v === '!' || peek().v === '-')) {
        const op = next().v;
        return { k: 'un', op, e: parseUnary() };
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const tok = peek();
      if (tok.t === 'num') {
        next();
        return { k: 'lit', v: tok.v };
      }
      if (tok.t === 'str') {
        next();
        return { k: 'lit', v: tok.v };
      }
      if (tok.t === 'id') {
        next();
        if (tok.v === 'true') return { k: 'lit', v: true };
        if (tok.v === 'false') return { k: 'lit', v: false };
        if (peek().v === '(') {
          next();
          const args = [];
          if (peek().v !== ')') {
            args.push(parseExpr());
            while (eat(',')) args.push(parseExpr());
          }
          if (!eat(')')) throw new Error('Expected )');
          return { k: 'call', name: tok.v, args };
        }
        return { k: 'var', name: tok.v };
      }
      if (eat('(')) {
        const e = parseExpr();
        if (!eat(')')) throw new Error('Expected )');
        return e;
      }
      throw new Error('Unexpected token: ' + (tok.v != null ? tok.v : tok.t));
    }

    const ast = parseExpr();
    if (peek().t !== 'eof') throw new Error('Unexpected trailing input');
    return ast;
  }

  // ---- evaluation ---------------------------------------------------------
  const isNum = (v) => typeof v === 'number' && !isNaN(v);
  const toNum = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };
  const looksNum = (v) => isNum(v) || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)));

  const FUNCS = {
    len: (x) => String(x == null ? '' : x).length,
    lower: (x) => String(x == null ? '' : x).toLowerCase(),
    upper: (x) => String(x == null ? '' : x).toUpperCase(),
    trim: (x) => String(x == null ? '' : x).trim(),
    number: (x) => toNum(x),
    num: (x) => toNum(x),
    int: (x) => Math.trunc(toNum(x)),
    abs: (x) => Math.abs(toNum(x)),
    floor: (x) => Math.floor(toNum(x)),
    ceil: (x) => Math.ceil(toNum(x)),
    round: (x, d) => {
      const f = Math.pow(10, d ? toNum(d) : 0);
      return Math.round(toNum(x) * f) / f;
    },
    min: (...a) => Math.min(...a.map(toNum)),
    max: (...a) => Math.max(...a.map(toNum)),
    contains: (a, b) => String(a == null ? '' : a).includes(String(b == null ? '' : b)),
    startsWith: (a, b) => String(a == null ? '' : a).startsWith(String(b == null ? '' : b)),
    endsWith: (a, b) => String(a == null ? '' : a).endsWith(String(b == null ? '' : b)),
    replace: (a, b, c) => String(a == null ? '' : a).split(String(b)).join(String(c == null ? '' : c)),
    slice: (a, b, c) => String(a == null ? '' : a).slice(toNum(b), c === undefined ? undefined : toNum(c)),
    // Left-pad to a width with a fill char (default "0") — e.g. pad(i+1, 2) → "07".
    pad: (v, width, ch) => {
      let s = String(v == null ? '' : v);
      const w = toNum(width);
      const c = ch == null || String(ch) === '' ? '0' : String(ch);
      while (s.length < w) s = c + s;
      return s;
    },
    // Regex helpers for pulling values out of messy text.
    // match(str, pattern[, group]) → the match (or a capture group), else "".
    match: (s, pattern, group) => {
      try {
        const m = String(s == null ? '' : s).match(new RegExp(String(pattern)));
        if (!m) return '';
        return group == null ? m[0] : m[toNum(group)] || '';
      } catch (_) {
        return '';
      }
    },
    // test(str, pattern) → true/false
    test: (s, pattern) => {
      try {
        return new RegExp(String(pattern)).test(String(s == null ? '' : s));
      } catch (_) {
        return false;
      }
    },
    // regexReplace(str, pattern, replacement) — global replace
    regexReplace: (s, pattern, repl) => {
      try {
        return String(s == null ? '' : s).replace(new RegExp(String(pattern), 'g'), String(repl == null ? '' : repl));
      } catch (_) {
        return String(s == null ? '' : s);
      }
    }
  };

  function ev(node, vars) {
    switch (node.k) {
      case 'lit':
        return node.v;
      case 'var':
        return vars ? vars[node.name] : undefined;
      case 'un': {
        const v = ev(node.e, vars);
        return node.op === '!' ? !truthy(v) : -toNum(v);
      }
      case 'call': {
        const fn = FUNCS[node.name];
        if (!fn) throw new Error('Unknown function: ' + node.name);
        return fn(...node.args.map((a) => ev(a, vars)));
      }
      case 'bin':
        return binop(node.op, ev(node.l, vars), () => ev(node.r, vars));
      default:
        throw new Error('Bad node');
    }
  }

  function truthy(v) {
    if (typeof v === 'string') return v.length > 0;
    if (typeof v === 'number') return v !== 0 && !isNaN(v);
    return !!v;
  }

  function binop(op, a, rThunk) {
    // short-circuit logical
    if (op === '&&') return truthy(a) ? truthy(rThunk()) : false;
    if (op === '||') return truthy(a) ? true : truthy(rThunk());
    const b = rThunk();
    switch (op) {
      case '+':
        if (typeof a === 'string' || typeof b === 'string') return String(a) + String(b);
        return toNum(a) + toNum(b);
      case '-':
        return toNum(a) - toNum(b);
      case '*':
        return toNum(a) * toNum(b);
      case '/':
        return toNum(a) / toNum(b);
      case '%':
        return toNum(a) % toNum(b);
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const numeric = looksNum(a) && looksNum(b);
        const x = numeric ? toNum(a) : String(a);
        const y = numeric ? toNum(b) : String(b);
        if (op === '<') return x < y;
        if (op === '<=') return x <= y;
        if (op === '>') return x > y;
        return x >= y;
      }
      case '==':
        return looksNum(a) && looksNum(b) ? toNum(a) === toNum(b) : String(a) === String(b);
      case '!=':
        return looksNum(a) && looksNum(b) ? toNum(a) !== toNum(b) : String(a) !== String(b);
      default:
        throw new Error('Unknown operator ' + op);
    }
  }

  function evaluate(src, vars) {
    if (src == null || String(src).trim() === '') return undefined;
    return ev(parse(String(src)), vars || {});
  }

  // Replace {{ ... }} occurrences in a string with the evaluated result.
  function interpolate(str, vars) {
    if (str == null) return str;
    return String(str).replace(/\{\{([^}]+)\}\}/g, (_m, inner) => {
      try {
        const v = evaluate(inner.trim(), vars);
        return v == null ? '' : String(v);
      } catch (_) {
        return '';
      }
    });
  }

  return { evaluate, interpolate, truthy, parse };
});

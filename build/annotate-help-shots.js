// Crop + annotate the raw help screenshots (build/help-shots/raw) into finished
// figures (build/help-shots/annotated AND src/help/img, for packaging).
//
// A spec (build/help-shots/spec.js) describes, per figure: which raw shot, the
// crop rectangle, and the annotations (boxes, arrows, labels). ALL coordinates
// are in ORIGINAL raw-image pixels — easy to read straight off the screenshots.
//
//   node build/annotate-help-shots.js
//
// Rendering is done in headless Chromium: the raw PNG is positioned inside a
// crop-sized viewport and an SVG overlay draws the annotations on top; we then
// screenshot the viewport 1:1. No native image library required.

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { FIGURES } = require('./help-shots/spec.js');

const RAW = path.join(__dirname, 'help-shots', 'raw');
const OUT = path.join(__dirname, 'help-shots', 'annotated');
const PKG = path.join(__dirname, '..', 'src', 'help', 'img');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PKG, { recursive: true });

const ACCENT = '#e0362f';   // arrows / boxes — a strong, legible red
const ACCENT2 = '#1f6feb';  // secondary (blue) callouts

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Build the SVG overlay for one figure's annotations. Coords are translated from
// original-image space into crop-local space by the caller (ox, oy = crop origin).
function overlaySvg(fig, ox, oy, w, h) {
  const parts = [];
  const T = (x, y) => [x - ox, y - oy];
  for (const a of (fig.items || [])) {
    const color = a.color === 'blue' ? ACCENT2 : (a.color || ACCENT);
    if (a.type === 'box') {
      const [x, y] = T(a.x, a.y);
      const r = a.r == null ? 10 : a.r;
      parts.push(`<rect x="${x}" y="${y}" width="${a.w}" height="${a.h}" rx="${r}" ry="${r}"
        fill="none" stroke="${color}" stroke-width="${a.sw || 4}"/>`);
    } else if (a.type === 'arrow') {
      const [x1, y1] = T(a.x1, a.y1);
      const [x2, y2] = T(a.x2, a.y2);
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}"
        stroke-width="${a.sw || 5}" marker-end="url(#ah-${color.replace('#', '')})"/>`);
    } else if (a.type === 'dot') {
      const [x, y] = T(a.x, a.y);
      parts.push(`<circle cx="${x}" cy="${y}" r="${a.rad || 9}" fill="${color}"/>`);
    }
  }
  // Labels drawn as foreignObject chips so text wraps and looks like the app.
  for (const a of (fig.items || [])) {
    if (a.type !== 'label') continue;
    const color = a.color === 'blue' ? ACCENT2 : (a.color || ACCENT);
    const [x, y] = T(a.x, a.y);
    const maxw = a.w || 320;
    parts.push(`<foreignObject x="${x}" y="${y}" width="${maxw}" height="200">
      <div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block;font:600 26px/1.3 'Segoe UI',system-ui,sans-serif;
        color:#fff;background:${color};padding:8px 14px;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,.28);
        max-width:${maxw - 20}px;">${esc(a.text)}</div>
    </foreignObject>`);
  }
  const markers = [ACCENT, ACCENT2].map((c) => `
    <marker id="ah-${c.replace('#', '')}" viewBox="0 0 10 10" refX="8" refY="5"
      markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="${c}"/>
    </marker>`).join('');
  return `<svg width="${w}" height="${h}" style="position:absolute;left:0;top:0" xmlns="http://www.w3.org/2000/svg">
    <defs>${markers}</defs>${parts.join('\n')}</svg>`;
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    for (const fig of FIGURES) {
      const rawPath = path.join(RAW, fig.shot + '.png');
      if (!fs.existsSync(rawPath)) { console.log('  !! missing raw:', fig.shot); continue; }
      const dataUri = 'data:image/png;base64,' + fs.readFileSync(rawPath).toString('base64');
      const [ox, oy, w, h] = fig.crop;
      const svg = overlaySvg(fig, ox, oy, w, h);
      const html = `<!doctype html><html><head><meta charset="utf-8">
        <style>*{margin:0;padding:0}html,body{background:#fff}
        .vp{position:relative;width:${w}px;height:${h}px;overflow:hidden}
        .vp img{position:absolute;left:${-ox}px;top:${-oy}px}</style></head>
        <body><div class="vp" id="vp"><img src="${dataUri}">${svg}</div></body></html>`;
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const el = await page.$('#vp');
      const buf = await el.screenshot({ type: 'png' });
      fs.writeFileSync(path.join(OUT, fig.name + '.png'), buf);
      fs.writeFileSync(path.join(PKG, fig.name + '.png'), buf);
      await page.close();
      console.log('  figure:', fig.name, `(${w}x${h})`);
    }
  } finally {
    await browser.close();
  }
  console.log('\nAnnotated →', OUT, '\nPackaged →', PKG);
})().catch((e) => { console.error(e); process.exit(1); });

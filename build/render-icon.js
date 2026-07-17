// Render build/icon-source.html (pure CSS) to the app icon assets:
//   build/icon.png  — 1024x1024 master (electron-builder derives platform icons)
//   build/icon.ico  — multi-size Windows icon (16..256) for crisp taskbar/tray
// Uses Playwright's bundled Chromium. Run: node build/render-icon.js
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const SRC = 'file://' + path.join(__dirname, 'icon-source.html').replace(/\\/g, '/');
const OUT_DIR = __dirname;
const SIZES = [16, 32, 48, 64, 128, 256];

async function shotAt(browser, size) {
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.goto(SRC, { waitUntil: 'networkidle0' });
  // The design is authored at 1024px; `zoom` scales the whole layout (and its
  // rendered pixels) down to the target icon size. We then clip the page to a
  // clean size×size box — robust at any scale, unlike element screenshots.
  await page.evaluate((z) => {
    document.documentElement.style.margin = '0';
    document.body.style.margin = '0';
    const stage = document.querySelector('.stage');
    stage.style.zoom = String(z);
  }, size / 1024);
  const buf = await page.screenshot({
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  await page.close();
  return buf;
}

// Pack an array of {size, png:Buffer} into a Windows .ico (PNG-compressed entries).
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const b = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0); // width (0 => 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1); // height
    dir.writeUInt8(0, b + 2);   // palette
    dir.writeUInt8(0, b + 3);   // reserved
    dir.writeUInt16LE(1, b + 4);   // color planes
    dir.writeUInt16LE(32, b + 6);  // bits per pixel
    dir.writeUInt32LE(e.png.length, b + 8);  // size of image data
    dir.writeUInt32LE(offset, b + 12);        // offset of image data
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    // Master PNG at full res.
    const master = await shotAt(browser, 1024);
    fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), master);
    console.log('wrote icon.png (1024)');

    // Per-size PNGs for the .ico.
    const entries = [];
    for (const size of SIZES) {
      const png = await shotAt(browser, size);
      entries.push({ size, png });
      console.log('rendered', size);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(entries));
    console.log('wrote icon.ico (' + SIZES.join(',') + ')');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

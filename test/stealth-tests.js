// A clean, believable User-Agent is what keeps bot-protection (Cloudflare, etc.)
// from blocking us on sight. This tests the pure UA/header logic.
//
//   node test/stealth-tests.js

const { realisticUserAgent, looksLikeBot, defaultHeaders, clientHints, userAgentMetadata } = require('../src/shared/stealth.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`);
}

// Electron's real default UA on Windows.
const ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'scrape-studio/0.1.0 Chrome/130.0.0.0 Electron/33.2.0 Safari/537.36';

const cleaned = realisticUserAgent(ELECTRON_UA);
console.log('  cleaned UA:', cleaned);

ok('the Electron token is gone', !/Electron/i.test(cleaned), cleaned);
ok('the app-name token is gone', !/scrape-?studio/i.test(cleaned), cleaned);
ok('it still declares Chrome', /Chrome\/130\.0\.0\.0/.test(cleaned), cleaned);
ok('it keeps the real Windows platform', /Windows NT 10\.0; Win64; x64/.test(cleaned), cleaned);
ok('it looks like a normal Chrome UA', /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/.test(cleaned), cleaned);
ok('the original UA reads as a bot, the cleaned one does not', looksLikeBot(ELECTRON_UA) && !looksLikeBot(cleaned));

// macOS platform carries through.
const mac = realisticUserAgent(
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) scrape-studio/0.1.0 Chrome/131.0.0.0 Electron/33.0.0 Safari/537.36'
);
ok('a Mac platform is preserved', /Macintosh; Intel Mac OS X 10_15_7/.test(mac) && !/Electron/.test(mac), mac);

// Never accidentally use "KHTML, like Gecko" as the platform token.
ok('garbage/empty UA falls back to a valid Windows UA',
  !looksLikeBot(realisticUserAgent('')) && !/KHTML.+KHTML/.test(realisticUserAgent('')),
  realisticUserAgent(''));

// Headers a real Chrome sends.
const h = defaultHeaders('en-GB,en;q=0.9');
ok('default headers include Accept-Language', h['Accept-Language'] === 'en-GB,en;q=0.9', JSON.stringify(h));
ok('default headers include Sec-Fetch-* + Upgrade-Insecure-Requests',
  h['Sec-Fetch-Mode'] === 'navigate' && h['Upgrade-Insecure-Requests'] === '1', JSON.stringify(h));

// Client hints must NOT mention Electron and must match the UA's Chrome version.
const ch = clientHints(cleaned);
ok('sec-ch-ua does not advertise Electron', !/Electron/i.test(ch['sec-ch-ua']), ch['sec-ch-ua']);
ok('sec-ch-ua matches the UA Chrome major (130)', /"130"/.test(ch['sec-ch-ua']), ch['sec-ch-ua']);
ok('sec-ch-ua names Google Chrome', /Google Chrome/.test(ch['sec-ch-ua']), ch['sec-ch-ua']);
ok('sec-ch-ua-mobile is ?0 (desktop)', ch['sec-ch-ua-mobile'] === '?0', JSON.stringify(ch));
ok('sec-ch-ua-platform reflects Windows for a Windows UA', ch['sec-ch-ua-platform'] === '"Windows"', JSON.stringify(ch));
ok('a Mac UA yields a macOS platform hint', clientHints(mac)['sec-ch-ua-platform'] === '"macOS"', JSON.stringify(clientHints(mac)));

// The CDP client-hint metadata (what makes the real app emit clean Sec-CH-UA in
// Chrome's header order) must be consistent with the UA and Electron-free.
const meta = userAgentMetadata(cleaned);
ok('metadata brands do not include Electron', !JSON.stringify(meta.brands).match(/Electron/i), JSON.stringify(meta.brands));
ok('metadata brands include Google Chrome', meta.brands.some((b) => b.brand === 'Google Chrome' && b.version === '130'), JSON.stringify(meta.brands));
ok('metadata fullVersion matches the UA', /^130\./.test(meta.fullVersion), meta.fullVersion);
ok('metadata is desktop (mobile:false) with a platform', meta.mobile === false && !!meta.platform, JSON.stringify({ mobile: meta.mobile, platform: meta.platform }));
ok('a Mac UA yields a macOS metadata platform', userAgentMetadata(mac).platform === 'macOS', userAgentMetadata(mac).platform);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Promoting session cookies to persistent ones is what keeps a "remember this
// device" / 2FA token alive across an app restart. This tests the pure decision.
//
//   node test/session-cookie-tests.js

const { cookiePersistDetails, YEAR_SECONDS } = require('../src/shared/session-cookies.js');

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}
function ok(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`);
}

const NOW = 1_700_000_000_000; // fixed clock
const EXP = Math.floor(NOW / 1000) + YEAR_SECONDS;

// A genuine session cookie (no expiry) on a host → promoted with a 1yr expiry.
const promoted = cookiePersistDetails(
  { name: 'device_trust', value: 'abc', domain: '.nospos.com', path: '/', secure: true, httpOnly: true, session: true, sameSite: 'lax', hostOnly: false },
  NOW
);
ok('a session cookie is promoted (not null)', promoted !== null, 'was null');
eq('…given a far-future expiry so it hits disk', promoted.expirationDate, EXP);
eq('…keeps name/value/flags', [promoted.name, promoted.value, promoted.secure, promoted.httpOnly, promoted.sameSite],
  ['device_trust', 'abc', true, true, 'lax']);
eq('…builds an https URL for a secure cookie', promoted.url, 'https://nospos.com/');
eq('…passes the domain for a DOMAIN cookie', promoted.domain, '.nospos.com');

// Already-persistent cookies are left alone (session !== true).
eq('a persistent cookie is not touched', cookiePersistDetails(
  { name: 'auth', value: 'x', domain: '.nospos.com', path: '/', session: false }, NOW), null);

// Host-only cookies must NOT gain a `domain` (that would widen their scope).
const hostOnly = cookiePersistDetails(
  { name: 's', value: '1', domain: 'app.nospos.com', path: '/reports', secure: false, session: true, hostOnly: true }, NOW);
ok('host-only cookie stays host-only (no domain field)', !('domain' in hostOnly), JSON.stringify(hostOnly));
eq('…uses http URL when not secure', hostOnly.url, 'http://app.nospos.com/reports');

// Guards.
eq('null cookie → null', cookiePersistDetails(null, NOW), null);
eq('missing name → null', cookiePersistDetails({ domain: 'x.com', session: true }, NOW), null);
eq('missing domain → null', cookiePersistDetails({ name: 'a', session: true }, NOW), null);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

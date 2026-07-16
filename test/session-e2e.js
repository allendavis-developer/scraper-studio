// The real thing: a site's session cookie (its 2FA "remember this device" token)
// must survive an app restart, so you're not asked for the code every launch.
// We set a session cookie, quit, relaunch with the SAME user-data dir, and check
// it's still there. Drives the actual Electron main-process session.
//
//   node test/session-e2e.js

const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require('playwright');

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  const root = path.join(__dirname, '..');
  const userDir = path.join(os.tmpdir(), 'scrapestudio-session-' + Date.now());
  const PART = 'persist:job-2fa-test';

  try {
    console.log('Sign-in (incl. 2FA) survives a restart\n' + '='.repeat(50));

    // ---- Run 1: set a SESSION cookie (no expiry), like a "remember device" token.
    let app = await electron.launch({ args: [root, '--user-data-dir=' + userDir] });
    await app.firstWindow();
    const before = await app.evaluate(async ({ session }, part) => {
      const ses = session.fromPartition(part); // creates it → our handler attaches
      await ses.cookies.set({ url: 'https://nospos.com/', name: 'twofa_device', value: 'trusted', secure: true, httpOnly: true });
      await new Promise((r) => setTimeout(r, 500)); // let the promote handler run
      const c = await ses.cookies.get({ name: 'twofa_device' });
      await ses.cookies.flushStore(); // make sure it's on disk before we quit
      return c.map((x) => ({ session: x.session, hasExp: typeof x.expirationDate === 'number' }));
    }, PART);

    check('a bare session cookie gets promoted to persistent (expiry added)',
      before.length === 1 && before[0].session === false && before[0].hasExp === true, JSON.stringify(before));
    await app.close();

    // ---- Run 2: same user-data dir → the cookie must still be there.
    app = await electron.launch({ args: [root, '--user-data-dir=' + userDir] });
    await app.firstWindow();
    const after = await app.evaluate(async ({ session }, part) => {
      const c = await session.fromPartition(part).cookies.get({ name: 'twofa_device' });
      return c.map((x) => ({ name: x.name, value: x.value }));
    }, PART);
    await app.close();

    check('…and it SURVIVES a full app restart (no 2FA re-prompt)',
      after.length === 1 && after[0].value === 'trusted', JSON.stringify(after));
  } catch (e) {
    FAIL++;
    console.log('  ✗ EXCEPTION: ' + e.message);
    console.log(e.stack);
  } finally {
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n' + '='.repeat(50));
  console.log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
})();

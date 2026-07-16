// ===========================================================================
// Keeping you signed in — including 2FA — across app restarts.
//
// A `persist:` webview partition already writes PERSISTENT cookies (ones with an
// expiry) to disk, so a normal login survives a restart. But a site's "remember
// this device" / 2FA token is almost always a SESSION cookie (no expiry), which
// Chromium keeps only in memory and drops when the app quits — so you'd be asked
// for the code again every launch.
//
// A real browser hides this because closing a *tab* doesn't end the session, and
// "continue where you left off" restores session cookies on restart. We get the
// same effect by re-writing each session cookie as a long-lived persistent one,
// so it lands on disk and is there next launch.
//
// This module is the pure decision — given a cookie, what to re-set it as — so it
// can be unit-tested without Electron. The wiring (listen for cookie changes and
// call cookies.set) lives in the main process.
// ===========================================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionCookies = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const YEAR_SECONDS = 60 * 60 * 24 * 365;

  // Given a Chromium cookie object, return the `cookies.set` details that would
  // re-write it as a persistent cookie (so it survives a restart) — or null if it
  // shouldn't be touched (already persistent, or missing the bits we need).
  //
  // Preserves the cookie's scope exactly: a host-only cookie stays host-only (we
  // don't pass `domain`, which would widen it to subdomains); a domain cookie
  // keeps its domain. `now` is injectable for deterministic tests.
  function cookiePersistDetails(cookie, now) {
    if (!cookie || cookie.session !== true) return null; // only genuine session cookies
    if (!cookie.name) return null;
    const host = cookie.domain ? String(cookie.domain).replace(/^\./, '') : '';
    if (!host) return null;

    const path = cookie.path || '/';
    const url = (cookie.secure ? 'https://' : 'http://') + host + path;
    const nowMs = typeof now === 'number' ? now : Date.now();

    const details = {
      url,
      name: cookie.name,
      value: cookie.value == null ? '' : cookie.value,
      path,
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      expirationDate: Math.floor(nowMs / 1000) + YEAR_SECONDS // → written to disk
    };
    if (cookie.sameSite) details.sameSite = cookie.sameSite;
    // Only a DOMAIN cookie carries `domain`; a host-only cookie must not, or it
    // would be promoted to every subdomain.
    if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
    return details;
  }

  return { cookiePersistDetails, YEAR_SECONDS };
});

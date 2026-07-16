// ===========================================================================
// Look like a normal browser, not automation.
//
// Electron's default User-Agent literally contains "Electron/<ver>" and the app
// name (e.g. "scrape-studio/0.1.0") — a dead giveaway that bot-protection
// services (Cloudflare, etc.) flag and block. We rebuild a clean desktop-Chrome
// UA that keeps the REAL platform + Chromium version (so it stays consistent
// with the engine's TLS / client-hint fingerprint) and drops the tell-tale
// tokens. Pure functions here so they're unit-testable without Electron.
// ===========================================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Stealth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Turn Electron's default UA into a believable desktop-Chrome UA.
  //   in:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
  //         (KHTML, like Gecko) scrape-studio/0.1.0 Chrome/130.0.0.0
  //         Electron/33.2.0 Safari/537.36"
  //   out: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
  //         (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
  function realisticUserAgent(defaultUA) {
    const ua = String(defaultUA || '');
    const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '131.0.0.0';
    // The platform token inside the first parentheses (falls back to Windows).
    let platform = (ua.match(/\(([^)]*)\)/) || [])[1] || 'Windows NT 10.0; Win64; x64';
    // A bare "(KHTML, like Gecko)" match would be wrong — guard against it.
    if (/KHTML/i.test(platform)) platform = 'Windows NT 10.0; Win64; x64';
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }

  // Does a UA still look like automation (Electron / the app name / headless)?
  function looksLikeBot(ua) {
    return /Electron|Headless|scrape-?studio|webharvest|jsdom|PhantomJS/i.test(String(ua || ''));
  }

  // Extra request headers a real Chrome sends that Electron may omit or set
  // oddly. Merged onto every request (without clobbering ones already present).
  function defaultHeaders(lang) {
    return {
      'Accept-Language': lang || 'en-GB,en;q=0.9',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document',
      'Upgrade-Insecure-Requests': '1'
    };
  }

  return { realisticUserAgent, looksLikeBot, defaultHeaders };
});

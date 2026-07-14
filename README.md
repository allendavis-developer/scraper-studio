# Scrape Studio

> **New to it? Read [GUIDE.md](GUIDE.md)** — a plain-language user guide with a
> cookbook of real jobs (list→detail drill-down, date ranges, infinite scroll)
> and an honest list of current limitations.

A visual, point-and-click web scraper. Load any website in an embedded browser,
**click the elements you want** (no inspect-element, no hand-writing selectors),
build a scrape as a sequence of visual steps, run it, and export **CSV**.

## Run it

```bash
npm install
npm start
```

## How it works

The app is a two-pane Electron desktop app:

- **Left — the program.** An ordered list of steps you build visually. Add
  steps from the palette, reorder them by dragging, edit them in a dialog.
- **Right — the browser.** A real embedded Chromium (`<webview>`) that loads any
  URL. Two **Pick** buttons put the page into a Ctrl-Shift-C-style picker: hover
  to highlight, click to capture a robust CSS selector automatically.

### Typical flow

1. From the **dashboard**, create a **New scrape job** (name + start URL) or open
   an existing one. Every **Run** re-opens the job's start URL first, so a job is
   reproducible. (Change it anytime in the sidebar, or **⤒ Use current page**.)
2. Add a **📋 Scrape list** step. In its dialog press **Pick** — the editor
   temporarily hides so you can see the page, click one repeating item (a product
   card, table row, search result), and the editor reopens with the selector
   filled. Scrape Studio generalizes it to match every sibling.
3. Add **columns** — for each, press **Pick** and click the title / price / link
   inside the row. Choose what to extract (text, attribute, `href`, `src`,
   form value, checked state).
4. Optionally add action steps before it (dismiss a cookie banner, select a
   filter, wait for content — see the table below).
5. For multi-page scraping, wrap it in a **While** loop that clicks “next” (see
   Control flow below).
6. Press **▶ Run**, watch rows fill the results table.
7. Press **⚙ Columns** to shape the CSV — rename headers, drop columns, reorder —
   then **⬇ Export CSV**.

> Picking always happens **inside a step** (the editor hides while you point at
> the page, then reopens filled in). There are no separate global "pick" buttons.

### Jobs & the dashboard

Scrape Studio opens on a **project dashboard** listing your scrape jobs (like a
recent-projects screen). Everything you do is **auto-saved** to the job as you
work — no manual save. Create a **New scrape job** (name + start URL), open an
existing one, rename, or delete. The **≡ Jobs** button returns to the dashboard.

### Logins / authentication (per-job sessions)

Each job has its **own persistent browser session**. To scrape a site that needs
a login: open the job, browse to the site in the embedded browser, and **log in
normally**. That session (cookies, etc.) is saved **for that job** and survives
restarts — and every run reuses it. Different jobs can be signed into different
sites or accounts independently.

### Values, rows & control flow

**📥 Get value** reads one thing off the page and gives it a **name**. You use
that one name everywhere — in a rule (*“price is less than 200”*) or in text
(`{{title}}`). It is kept as either:

- **a column** (default) — it goes in the results table & CSV, or
- **a working value** — for your rules only, kept out of the CSV.

That's the only difference: **one namespace**, so a column is readable by name in
a condition just like anything else.

**Rows commit themselves.** One pass of a loop = one row. Inside a **For each**,
everything you collect for that card becomes that card's row — there is no
“add row” step. A job with no loop produces a single row at the end.

To keep only *some* items, use **⏭ Skip item** — it abandons the current item (no
row for it) and moves on:

```
For each  .product-card
  Get  price = .price   (clean-up: Number)   → column
  If   price ≥ 200 → Skip item               ← the ones you don't want, gone
  Get  title = .title                        → column
                     ← the row commits itself: { title, price }
```

| Step | What it does |
|------|--------------|
| 📥 Get value | Read **one** value into a named column (or working value): element **text / attribute / value / href / src / html / checked**, a **count**, **does it exist**, the **page URL**, or a **calculation**. Plus [clean-ups](#cleaning-up-messy-text-no-regex). |
| 🌐 Go to URL | Navigate somewhere (supports `{{variables}}` — e.g. `…/page/{{i}}`) |
| ❓ If / Else | Run the **Then** block when a condition is true, else the **Else** block |
| 🔄 For each | Run a block **once per matching element**; selectors inside are relative to the current one, and each pass makes a row |
| 🔁 While | Repeat the **body** while a condition holds (with a safety iteration cap) |
| 🔢 Repeat | Repeat the **body** a number of times, with an optional index variable |
| ⏭ Skip item | Abandon this item — **no row for it** — and move to the next |
| ⛔ Break | Exit the nearest loop entirely |

**Conditions are visual** — no typing of `&&`, `>`, etc. For If / While you pick
**Match ALL / ANY**, then add rules like `price` · **is greater than** · `300`,
choosing the operator from a dropdown and your value from a list. At run time the
log shows the decision *with the real numbers* —
`if (price (7.99) ≥ 200) → no · skipped` — so a filter that drops everything is
never silent.

Block steps are **nested** in the step list; use the **+ add step** button under a
block to add steps inside it.

**Expressions** (Get value → *a calculation*, and `Repeat` count — conditions use
the visual builder above) support numbers, `"strings"`, values, `+ - * / %`, and
functions like `number()`, `int()`, `round()`, `pad()`, `len()`, `lower()`,
`contains()`. Values are typed — a `count` is a number (so `n > 2` works), and a
**Number** clean-up makes scraped text numeric.

**`{{…}}` interpolation** works in text fields (Fill value, Click-text, Go-to
URL, selectors), e.g. Fill `page {{ i + 1 }}`.

**Multi-page example:** `Get more = does it exist? .next` → `While more is true` →
{ Scrape list · Click `.next` · refresh `more` }. Each iteration's rows
accumulate. (This replaces the old fixed pagination panel.)

### Cleaning up messy text (no regex)

Pages give you `Price: £1,024.50 (inc VAT)`, not `1024.5`. Every step that reads
the page has a **Clean up the text** list — clean-ups you pick from a dropdown,
applied in order:

| # | Clean-up | Result |
|---|----------|--------|
| 1 | Text between `£` and `(` | `1,024.50` |
| 2 | Number — strip `£ $ , %` | `1024.5` |

**▶ Test on the page** shows `on the page: "…"` → `you get: 1024.5` before you
run anything. Available: tidy spaces / lower / upper · **Number**, first/last
number, whole number, round, digits only · **text between / after / before**,
split-and-take-part · replace, add at start/end, pad, default-if-empty ·
**dates** (day-first *or* month-first → `2026-07-14`) · and a raw **regex** for
power users who want it. A number clean-up yields a real number, so `<` / `>`
comparisons work.

**Date-range example** (scrape a report for every day of July, no hardcoding):

```
Repeat 31   (index variable: i)
  ├─ Fill  #from  = {{ pad(i+1,2) }}/07/2026
  ├─ Fill  #to    = {{ pad(i+1,2) }}/07/2026
  ├─ Click  "Run report"
  ├─ Wait for  .results-row
  └─ Scrape list  (row = .results-row; columns: … + a "date" column of
                   type “Value / expression” = pad(i+1,2)+"/07/2026")
```

Each day's rows accumulate and are tagged with that day's date.

### Scraping aligned groups (name ↔ price on the same row)

Use **one Scrape list**, not two scrapes. Two separate scrapes give you all the
names then all the prices, unaligned. Instead:

1. **Scrape list → ① Pick the row**: click one *repeating item* (the whole card
   / table row). It generalizes to every sibling.
2. **② Add a column per value** and **Pick the value inside a row** (the name,
   the price…). Column selectors are **relative to the row**, so the name and
   price on the same row stay together — one row per item with aligned columns.

A column can also be **“Value / expression”** — a variable or formula (e.g. a
loop’s date) instead of a page element.

### Appearance

The app opens in **light mode** (black text, Word-style dark-blue accents).
Switch themes from the menu bar: **View → Appearance → Light / Dark** (remembered
between sessions). Visited web pages are forced to render in **light mode** by
default, independent of the app's theme.

### Zoom

Two independent zooms:

- **Page zoom** (browser bar, `−  100%  +`) — scales the embedded page.
- **Interface zoom** (top of the sidebar) — scales Scrape Studio's own chrome.
- **Ctrl + / − / 0** targets whichever your **mouse is over**: the embedded page
  if you're hovering it, otherwise the interface. (Hold **Shift** to always mean
  the interface.)

### Filling framework-controlled fields

Modern search boxes are often React/Vue "controlled inputs" that snap back to
empty unless their internal state is updated. **Fill field** writes through the
native value setter and dispatches a real `input` event, so the value sticks and
a following **Click** on the search button submits the actual text.

### Step types

| Step | What it does |
|------|--------------|
| 🖱️ Click | Click an element (follow links, open menus, buttons) |
| 🔤 Click text | Click the element whose visible text matches — calendar days, custom-dropdown options, tabs (robust when there's no stable selector) |
| 🔽 Select option | Drive a native `<select>`; reads the live option list off the page, matches by visible text / value / index, fires `input`+`change`. Supports multi-selects |
| ☑️ Check | Check / uncheck / toggle a checkbox or radio (via real `click()` so listeners fire) |
| ⌨️ Fill field | Fill a text / number / **date** / time / contenteditable field; optional clear-first and press-Enter-to-submit |
| 👆 Hover | Fire the pointer/mouse-enter chain to reveal hover menus & tooltips |
| ⌨ Press key | Send a **real** Chromium key event (Enter, Tab, Esc, arrows…) with Ctrl/Shift/Alt — works where synthetic events don't (native submits, keyboard-driven date pickers) |
| ⏱️ Delay | Pause a fixed number of milliseconds |
| 👁️ Wait for | Wait until an element appears (with timeout) |
| ↕️ Scroll | Scroll to top / bottom, or by N pixels (for lazy-loaded lists) |
| ⤓ Load all | Keep scrolling (and clicking “load more”) until the page stops growing — infinite-scroll lists |
| ⬅️ Go back | Return to the previous page (after visiting a detail page) |
| 📥 Get value | Capture a single named value (see above) |
| 📋 Scrape list | Capture every matching row × its columns → many rows at once |

**Extraction modes:** text, inner HTML, an attribute, `href`, `src`, a
form-control **value**, or **checked** state.

**Single vs list:** `Get value` columns collected outside a list (e.g. the page
title) are repeated on every row produced by `Scrape list`, so you can tag rows
with page-level context.

### Record mode — for custom / complex widgets

Some controls can't be modelled by a single high-level block — custom dropdowns,
JS date pickers, multi-step widgets. For those, press **● Record**, perform the
actions yourself in the page, then **Stop**. Scrape Studio watches how you interact
and translates it into its *own* step blocks so the result is fully readable and
editable:

- typing → **Fill field** · a native `<select>` change → **Select option** ·
  checkbox → **Check** · Enter/Tab/Esc → **Press key**
- a click with a brittle positional selector but short stable text → **Click
  text**; otherwise → **Click**
- the real pauses between your actions become **Delay** steps you can retune

So even a bespoke widget ends up as a sequence of the same blocks you already
understand — nothing is an opaque "custom" recording.

## Testing

```bash
npm test
```

Runs `test/scrape-tests.js`, which drives the **exact same engine module** the
app uses (`src/shared/page-actions.js`) against real sites via headless Chromium:

- **books.toscrape.com** — 3-page list scrape, absolute link/image resolution,
  and the point-and-click selector generator (unique selector + list
  generalization).
- **quotes.toscrape.com/search** — native `<select>` driving, a dependent
  dropdown that only populates after a real `change` event, then a filtered
  scrape.
- **webscraper.io test shop** — a realistic product-search page (cards, prices,
  descriptions, links).
- **interaction builders** — fill / check / toggle / hover / click-by-text.
- **eBay** — best-effort; eBay's anti-bot blocks *headless* runs, so it's
  reported as skipped (the real app is a full interactive browser session).

`npm run test:all` runs everything — **162 passed, 0 failed** (1 skipped: eBay):

| Suite | Covers |
|-------|--------|
| `expr-tests` (27) | the expression evaluator (no `eval` — CSP-safe) |
| `transform-tests` (37) | every text clean-up: numbers, text-between, dates, regex |
| `scrape-tests` (23) | the engine against **real sites**, headless |
| `ui-e2e` (69) | the **real app** driven via Playwright: picker + Esc-cancel, run, column shaping, action steps, controlled-input fill, recorder, zoom, jobs dashboard, control flow, **relative picking inside a For each**, comparing two values in one card, **Skip item**, self-committing rows, clean-up pipeline + live preview, and the "why did I get 0 rows?" explanations |
| `legacy-e2e` (6) | **old saved jobs still run** — `Scrape one` / `Set var` / `Add row` migrate to `Get value` and produce identical rows |

Sample CSVs land in `test/output/`.

### Recipes

**💾 / 📂** export and import the whole program (start URL + steps + column
shape) as a JSON recipe file. (Jobs are also auto-saved to the dashboard.)

## Architecture

```
src/
  main/
    main.js            Electron main process — window, CSV/recipe file I/O (IPC)
    preload.js         Safe IPC bridge exposed to the control UI
  renderer/
    index.html         Two-pane layout + step-editor modal
    styles.css         Dense, utilitarian styling
    renderer.js        Steps model, picker + recorder wiring, run engine, CSV
  webview/
    picker-preload.js  Injected into the target page: element-picker overlay +
                       the action recorder
  shared/
    page-actions.js    THE ENGINE — selector generation + all page-code builders
                       (extract / list / click / select / check / hover / …).
                       Shared verbatim by the app and the test harness.
    expr.js            Safe expression evaluator + {{…}} interpolation for
                       control flow (no eval; CSP-safe recursive-descent parser).
    transform.js       The text clean-up pipeline (numbers, text-between, dates,
                       regex). TRANSFORM_OPS is the single source of truth: the
                       editor UI is built from it and the tests run it directly.
test/
  expr-tests.js        Unit tests for the expression evaluator
  transform-tests.js   Unit tests for every text clean-up
  scrape-tests.js      Live-site tests that run the engine via headless Chromium
  ui-e2e.js            Drives the real app end-to-end via Playwright/Electron
  legacy-e2e.js        Old saved jobs still load, migrate, and produce the same rows
```

Scraping actions run inside the page via `webview.executeJavaScript` using code
built by `shared/page-actions.js`; the interactive picker and recorder run in the
webview preload and report back over `ipcRenderer.sendToHost`. Real key events
go through `webview.sendInputEvent`. Because the engine is one dependency-free
module, the tests exercise the identical code path the app runs.

## Notes / limits (v1)

- Selector generation skips hash-like framework classes (`css-1a2b3c`, `sc-…`).
- Multi-page scraping is done with a **While** loop (there's no fixed pagination
  panel) — more flexible, but you build the loop yourself.
- The results table previews the last 500 rows; CSV export contains all rows.
- Widgets inside cross-origin **iframes** aren't reachable yet.

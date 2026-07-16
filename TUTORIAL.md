# Scrape Studio — Guided Tutorial

A hands-on tour of the app **and** the four example jobs that ship pre-loaded on
your dashboard. By the end you'll understand every panel on screen, how data
flows into a CSV, and how to rebuild each example yourself.

> **Start here:** run `npm start`. You land on the **dashboard**. Four seeded
> jobs are waiting:
>
> | Job | Teaches |
> |-----|---------|
> | 📊 **Report table — line items only** | **scraping an HTML table in one pick** |
> | 📊 **Report table — every row** | the same table, keeping Subtotal & Total |
> | 📚 **Books — simple list** | the one-node scrape (the 90% case) |
> | 📚 **Books — only under £20** | a **Module**, a **For each** loop, an **If**, **Skip**, and **data flow** |
> | 💬 **Quotes — Log in, then scrape** | two **Modules** wired together, a login, and **Try / Recover** |
> | 📚 **Books — paginated** | a **While** loop driven by a data value |
>
> Open any one, then read the matching section below. Press **🗺 Map** on each to
> see it as a graph.

---

## 1. The screen, panel by panel

```
┌───────────────────────────┬────────────────────────────────────────────────┐
│ SIDEBAR (your program)     │ BROWSER (real Chromium, per-job session)        │
│ [ start URL ............⤒ ]│ ◀ ▶ ⟳ [ url ...... ] Go  −100%+  ●Rec  ▶Run ■Stop│
│ ▸ 🔐 Sign-in               │                                                 │
│                            │          (the live web page)                    │
│ STEPS (14)          🗺 Map  │                                                 │
│ ┌───────────────────────┐  ├────────────────────────────────────────────────┤
│ │    ＋ Add step         │  │ RESULTS   ⚙Columns  Clear  ⬇Export CSV          │
│ └───────────────────────┘  │ (rows land here as you run)                     │
│  📦 Log in                 │ ───────────────────────────────────────────────│
│  📦 Scrape products  ⋮     │ LOG (what happened, with the real values)       │
│    🔄 For each             │                                                 │
│      📥 Grab one value     │                                                 │
│ 💾 Export recipe  📂 Import│                                                 │
└───────────────────────────┴────────────────────────────────────────────────┘
```

**Left — your program.** The **Steps** list is the star; everything else is one
line until you need it.
- **Start URL** (top) — every **Run** opens this first, so a job is reproducible.
  **⤒** copies the browser's current address.
- **🔐 Sign-in** — collapsed by default. Open it only when a site needs a login
  (see §6); most jobs never touch it.
- **＋ Add step** — the one way to add a step. Opens a **directory** of every step,
  grouped (*Get the data* · *Do something on the page* · *Repeat & decide* ·
  *Organize & protect*) with a plain-English description of each — plus **Your
  saved tasks**. Blocks and Tasks have their own **+ add step** that opens the
  same directory, adding *inside* them.
- **Steps** — your ordered, nestable program (scrolls). **🗺 Map** opens the graph
  editor.
- **💾 / 📂** — export/import a job as a JSON recipe.

**Right — the browser + output.**
- A real embedded browser. Type a URL, or let a run drive it.
- **▶ Run / ■ Stop** sit in the browser bar next to **● Record**, so they're
  always visible — no scrolling to find them.
- **● Record** watches you click/type and turns it into steps.
- **Results** — the rows you've scraped; **⚙ Columns** renames/reorders/drops
  them; **⬇ Export CSV** saves.
- **Log** — a narrated trace of the run, *with the real values*, so a filter that
  drops everything is never silent.

**Two ways to build the same program:** the **Steps** list (fast, linear) and the
**🗺 Map** (a Blueprint-style node graph — §5). They edit the *same* job.

---

## 2. How data flows into a CSV (read this once)

This is the heart of the tool, and the answer to "how do variables / data flow
work?" It's deliberately *cleaner* than wiring every value by hand.

**1. Values are named.** Three things create a named value:
- **📥 Grab one value** — read one thing off the page, give it a name (`price`).
- **📋 Grab a list** — each **column** you add is a named value (`title`, `price`).
- a **loop counter** — a For-each / Repeat can expose an index (`i`).

Those names *are your variables.*

**2. The name is the wire.** Anywhere you use that name, that step **consumes** the
value — no manual wiring:
- in a **rule**: `price` **is greater than** `20`
- in **text**: `Go to URL … /page/{{ i + 1 }}`
- in a **calculation**: a Grab-one-value of type *“a calculation”* = `was - price`

In the **Map**, tick **Data flow** and these name-links are drawn as green wires
(producer ▸ consumer). So you get Blueprint-style data wires to *look at*, without
the chore of drawing every one.

**3. One namespace, two fates.** Every value is readable by its name *everywhere*.
The only decision is where it ends up:
- **a column** → it goes in the results table & the CSV, **or**
- **a working value** → used only for your logic, kept *out* of the CSV.

Either way you read it by name. (A `count` or a **Number** clean-up gives a real
number, so `>` / `<` comparisons work.)

**4. Rows commit themselves — no "add row" step.** Inside a **For each**, *one pass
= one row*: whatever columns you collected for that item become that item's CSV
row, automatically. A job with no loop produces one row at the end. To *drop* an
item, use **⏭ Skip item** (no row for it).

**5. Modules don't change any of this.** A **📦 Task (Module)** is a transparent
folder: a value grabbed in `Log in` is still visible to a later `Scrape` module,
because a Module doesn't create a new scope — it just organizes. So data flows
*between* modules by name, in run order, like shared variables — again, no wiring.

> **The whole point:** the fewest possible user actions to get a clean CSV row.
> Pick the repeating row, pick the columns inside it — done. Naming a value once
> makes it usable everywhere; rows commit themselves. Compare that to wiring every
> value pin-to-pin: same expressive power, far fewer steps.

**Execution flow vs data flow** (the two kinds of wire, exactly like Unreal):
- **Execution** = *what runs next* — the order of steps, branches, loops. In the
  Map these are the grey arrows between nodes.
- **Data** = *where a value goes* — the green `Data flow` links. A value can be
  produced early and consumed much later; order only matters in that the producer
  must run first.

---

## 3. Example-by-example

### 📊 Report table — line items only  *(the one-pick table)*

**What it does:** turns a `Sales & Income Summary` table into a clean CSV.

**How it's built:** a single **📊 Grab a table** step. That's it.

A table is the one shape a point-and-click picker genuinely *cannot* handle —
click a row and it matches the `<thead>` header row too; click a cell and it
matches every cell on the page. So this step doesn't guess: it reads the table's
own structure.

**Build it yourself:**
1. **＋ Add step → 📊 Grab a table.**
2. **① Pick the table** → **Pick** → move over the page: **whole tables light up**
   (*“📊 This table — 9 rows × 7 columns”*). Click the one you want. Done picking.
3. It fills in everything: all 7 columns named from the headers (`Type`, `Gross`,
   `VAT`, `Net`, `Cost`, `Margin`, `Percent`), money and % set to come out as
   **numbers**, the header row excluded, and the 2 **Subtotal / Total** rows left
   out (there's a tick-box if you want them — that's the second seeded job).
4. **② Shape the columns** — untick what you don't want, rename any (it becomes the
   CSV heading), **↑↓** to reorder, flip a column between **Text** and **Number**.
   The **live preview** under it shows the exact rows you'll get.
5. **▶ Run → ⬇ Export CSV:**
   ```
   type,gross,vat,net,cost,margin,percent
   Graded Sales,0,0,0,0,0,0
   Second Hand Sales,511.09,42.39,468.7,256.75,211.95,45.22
   ...
   ```
   `511.09` is a real number, not `"£511.09"` text — so it sums in Excel.

**Several tables on the page?** You get **the one you clicked**, and the editor
says which: *“📊 Got **“Staff”** — table 2 of 3 on this page. Only this one is
scraped.”* Wrong one? Pick again and click a cell in the table you want. To
scrape two tables, add **two Grab-a-table steps**.

> **Watch out:** a blank cell in a **Number** column comes out as `0`. If a blank
> genuinely means "no value" (not zero), set that column to **Text**.

---

### 📚 Books — simple list  *(the baseline)*

**What it does:** grabs the whole first page of books into rows.

**How it's built:** a single **📋 Grab a list** step:
- **① Pick one row** → `article.product_pod` (one book card).
- **② columns:** `title` (the link's *title* attribute), `price` (the `.price_color`
  text, with a **Number** clean-up → `51.77`), `stock` (the availability text).

**Build it yourself:**
1. New job → start URL `https://books.toscrape.com/`.
2. Add **📋 Grab a list** → **Pick** → click one book card.
3. **+ Add column**, **Pick** the title; add another, Pick the price; on the price
   column press **🧹** and add the **Number** clean-up. Press **👁 Preview the rows**.
4. **▶ Run** → **⬇ Export CSV**.

**Data flow here:** none needed — the columns *are* the row. This is the 90% case.

---

### 📚 Books — only under £20  *(module · loop · rule · data flow)*

**What it does:** visits every book card and keeps **only** the ones under £20.

**Shape (open the Map and drill into `Scrape cheap books` → `For each`):**
```
📦 Scrape cheap books           ← a Module (folder), just for tidiness
  └ 🔄 For each  article.product_pod        (one pass per book = one row)
      ├ 📥 Grab  price  = .price_color   (Number)     ← working value
      ├ ❓ If  price ≥ 20  →  ⏭ Skip item              ← drops the pricey ones
      └ 📥 Grab  title = h3 a (title attr)  → column
```

**The data flow:** `price` is produced by the Grab, then **consumed** by the `If`.
Turn on **Data flow** in the Map and you'll see the green `price` wire from the
Grab node into the If. `price` is a **working value** (not a column), so it drives
the rule but doesn't clutter the CSV; `title` is a **column**, so it's what you
export. One pass that isn't skipped commits one row.

**Why it's clean:** no "start row / add row / end row" plumbing. The loop means
"one book = one row"; Skip means "not this one"; the column is the output.

**Build it yourself:**
1. Start URL `https://books.toscrape.com/`.
2. Add **📦 Task**, name it *Scrape cheap books*. Open it (double-click in the Map,
   or **+ add step** under it in the list).
3. Inside: add **🔄 For each** → Pick a book card.
4. Inside the loop: **📥 Grab one value** → Pick `.price_color`, add **Number**
   clean-up, name `price`, keep as **working value**.
5. **❓ If** → rule `price` **is greater than or equal to** `20` → inside *Then*
   add **⏭ Skip item**.
6. **📥 Grab one value** → Pick the title → keep as **column**.

---

### 💬 Quotes — Log in, then scrape  *(modules wired together · Try/Recover)*

**What it does:** logs into quotes.toscrape.com, then scrapes the quotes, guarded
against failure.

**Shape (top-level Map shows two modules wired `Log in ▸ Scrape quotes`):**
```
📦 Log in                         🔐  (this is the module abstraction)
  ├ 🌐 Go to URL  /login
  ├ ⌨️ Fill  #username = admin
  ├ ⌨️ Fill  #password = admin
  └ 🖱️ Click  submit
📦 Scrape quotes
  └ 🛟 Try (retry 1×)
       try:     📋 Grab a list  .quote → text, author, tag
       recover: 📥 Grab  status = "scrape failed — recovered"
```

**What to notice:**
- **Modules as abstractions.** At the top level you see `Log in → Scrape quotes`.
  Double-click either to open *its own graph* and see/edit how it works. That's
  the core idea: name a module, then describe it with nodes inside.
- **Data between modules.** If `Log in` grabbed a value, `Scrape quotes` could read
  it by name — modules share the run's namespace in order.
- **🛟 Try / Recover.** If the list scrape fails (page changed, timed out), the run
  jumps to the recovery steps instead of dying. `retry 1×` means it tries the risky
  steps twice before recovering.

**Build it yourself:** add a **📦 Task** *Log in* with Go-to-URL + two **Fill field**
steps + a **Click**; add a **📦 Task** *Scrape quotes* containing a **🛟 Try /
Recover** whose *Try* holds a Grab-a-list and whose *recover* notes the failure.

> This job logs in *within its steps*, so it deliberately leaves the Sign-in
> "marker" blank (§6). For a real bank/2FA site you'd instead log in by hand once
> and set a marker.

---

### 📚 Books — paginated  *(a While loop driven by data)*

**What it does:** scrapes 5 pages of books by following the **next** link.

**Shape:**
```
📥 Grab  more = does `.next a` exist?   → working value (true/false)
🔁 While  more is true   (safety cap: 5)
    ├ 📋 Grab a list  article.product_pod → title, price
    ├ 🖱️ Click  .next a          (go to the next page)
    └ 📥 Grab  more = does `.next a` exist?   (refresh the flag)
```

**The data flow:** the boolean `more` is the wire that drives the loop. It's grabbed
before the loop, tested by **While**, and *refreshed* at the end of each pass. When
the last page has no **next** link, `more` becomes false and the loop stops. Each
pass's rows accumulate. (The safety cap of 5 keeps the demo quick — raise it to
scrape all 50 pages.)

**Build it yourself:** Grab `more` = *does it exist?* on `.next a` (working value);
add a **🔁 While** with rule `more` **is true / yes**; inside: Grab-a-list, then
**Click** `.next a`, then re-Grab `more`.

---

## 4. Tasks & the reusable library

- **📦 Task** groups steps into a named, collapsible folder. Purely organizational
  — it changes nothing about values or rows. Collapse the ones you're not editing.
- Press **☆** on a Task (or **Save to library** in its editor) to save it. It then
  appears under **Your saved tasks** in **＋ Add step** — drop your `Log in` into any
  job. Inserted copies get fresh ids, so editing one never touches another.

---

## 5. The Map — building with nodes

Press **🗺 Map**. This is an **editable** canvas (like Unreal's Blueprints), not a
picture. Each graph is one container: the whole program, or the inside of a
Module / loop / If / Try.

| Do this | To… |
|---------|-----|
| **＋ Node** (or double-click empty space) | add a step here |
| **drag** a node | move it (position is remembered) |
| **double-click** a node | edit it — or, if it's a Module/loop/branch, **open its graph** |
| **breadcrumbs** (top-left) | climb back out (`Main › Scrape products › For each`) |
| drag a node's **right dot ▸ → another's left dot** | set the order (Start ▸ node = make it first) |
| the **✕** on a node | delete it |
| **Data flow** checkbox | overlay green producer ▸ consumer value links |
| drag empty space / scroll | pan / zoom |

Node colours = the three "languages": **green** grabs data · **blue** acts on the
page · **amber** repeats/decides · **violet** is a Module. Grey arrows are
execution order; green links are data.

**The workflow you asked for:** add a **📦 Task**, name it (e.g. *Fetch report*),
double-click to open its empty graph, and build it with nodes. Back in `Main`, that
module is one node you wire between `Log in` and `Export`. A module's node can live
inside *another* module's graph — abstractions all the way down.

---

## 6. Sign-in & staying logged in (incl. 2FA)

Each job has its **own** browser session, saved to disk, so a login sticks across
restarts. In the **🔐 Sign-in** panel:

- **🔓 Log in to this site** → opens the browser on the right so you sign in (and
  do any 2FA). Done once, remembered. (No need to tell the app where the login
  page is — it opens the *Login page* you optionally set, else the start URL.)
- **Forget this sign-in** → wipe it (sign out / switch account).
- **Detect sign-outs (optional)** → press **Pick** and click something only shown
  when logged in (your avatar menu, a *Logout* link). Now every run checks it
  first; if you've been signed out, the run **pauses** and a red banner over the
  browser says *"Signed out … log in, then Run again."* Log in there, press **▶
  Run** — no data lost to a doomed run. Even with no marker, a run that's
  **redirected to a login page** raises the same prompt.
- Leave the marker **blank** for jobs that log in *as their own steps* (like the
  Quotes example), so the pre-run check doesn't block that login.

If the *site itself* logs you out mid-run, there's nothing we can do to stop it —
but you'll be told clearly and can re-authenticate in one click.

---

## Cheat-sheet

- **Get a CSV fast:** Grab a list → Pick the row → Pick the columns → Run → Export.
- **Filter items:** For each → grab a value → If … → **Skip item**.
- **A variable:** Grab one value and name it. Use it by name in rules / `{{text}}`
  / calculations. Keep it a **column** (in the CSV) or a **working value** (logic
  only).
- **See the flow:** 🗺 Map → tick **Data flow**.
- **Reuse:** make a **📦 Task**, press **☆**, drop it into other jobs from **📚**.
- **Robustness:** wrap flaky steps in **🛟 Try / Recover** (with retries).
- **Logins:** 🔐 Sign-in → Log in to this site (once); optionally Pick a "signed-in"
  marker so runs detect a sign-out.

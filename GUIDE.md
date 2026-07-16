# Scrape Studio — User Guide & Cookbook

A practical, plain-language guide for building scrape jobs. No coding required for
the common cases; the "Advanced" notes are optional.

- [Core ideas](#core-ideas)
- [The steps, in plain language](#the-steps-in-plain-language)
- [Getting a selector (Pick)](#getting-a-selector-pick)
- [Cleaning up messy text](#cleaning-up-messy-text)
- [Working inside a "For each"](#working-inside-a-for-each)
- [Values & rows](#values--rows)
- [Conditions (visual)](#conditions-visual)
- [Cookbook: real scraping jobs](#cookbook-real-scraping-jobs)
- [Expressions (optional / advanced)](#expressions-optional--advanced)
- [Known limitations & where it gets hard](#known-limitations--where-it-gets-hard)

---

## Core ideas

- **Job** — one scrape you build and save. It has a **start URL** and a list of
  **steps**. Every run opens the start URL first. Jobs auto-save; the launch
  **dashboard** lists them. Each job keeps its **own login/session**.
- **Steps** run top to bottom. Some steps are **actions** (click, type…), some
  **read data** (Grab a value, Grab a list), some are **logic** (if, loops).
- **The results table** is your output → **Export CSV**.

### Values, rows, and how they get into the table

**📥 Grab one value** reads one thing off the page and gives it a **name**
(`price`, `title`). That name is how you use it everywhere — in a rule
(*"price is less than 200"*) or in text (`{{title}}`).

Each value is kept as one of two things:

| Keep it as | Means |
|---|---|
| **A column** (the default) | It goes in the results table & CSV. |
| **A working value** | Only for your rules — it **won't** appear in the CSV. |

That's the *only* difference. You read it by name either way.

**Rows commit themselves.** One pass of a loop = one row. Inside a
**For each**, everything you collect for that card becomes that card's row —
you don't "add" it anywhere. A job with no loop just collects values and
produces a single row at the end.

**To keep only some items, use ⏭ Skip item.** It abandons the current item —
no row for it — and moves to the next. Put it in an **If**:

```
For each  product card
  Get  price  = .price   (Number)     → column
  If   price ≥ 200 → Skip item        ← the ones you don't want, gone
  Get  title  = .title                → column
                    ← the row commits itself: { title, price }
```

**Grab a list** is the shortcut for the simple case: one page, one repeating
list, many rows at once. Use it when you don't need per-item logic.

---

## The steps, in plain language

**Actions**
| Step | What it does |
|------|--------------|
| 🖱️ Click | Click an element (button, link, tab). |
| 🔤 Click text | Click whatever shows a given text (a calendar day, a menu option). |
| 🔽 Select option | Choose an option in a dropdown. |
| ☑️ Check | Tick / untick a checkbox or radio. |
| ⌨️ Fill field | Type into a box. Options: clear first, press Enter after. |
| 👆 Hover | Hover to reveal a menu / tooltip. |
| ⌨ Press key | Press Enter, Tab, arrows, etc. |
| ⏱️ Delay | Wait a fixed time. |
| 👁️ Wait for | Wait until something **appears** — or **disappears** (e.g. a loading spinner). |
| ↕️ Scroll | Scroll up/down/by pixels. |
| ⤓ Load all | Keep scrolling (and clicking "load more") until the page stops growing. For infinite-scroll lists. |
| 🌐 Go to URL | Open a web address (can include variables). |
| ⬅️ Go back | Go back to the previous page (after visiting a detail page). |

**Getting data**
| Step | What it does |
|------|--------------|
| 📊 Grab a table | An **HTML table**. Point at it **once** (click any cell) and it does the rest — a column per heading, money/% as numbers, Subtotal/Total rows left out. Then shape it. **See [Scraping a table](#scraping-a-table).** |
| 📥 Grab one value | Read **one** value into a named **column** (or a working value). Text, a link, an attribute, a count, "does it exist", the page URL, or a calculation. |
| 📋 Grab a list | Grab a repeating list (product cards, search results) → **many rows at once**, with columns you Pick yourself. |

They can **clean up** the text they find — see
[Cleaning up messy text](#cleaning-up-messy-text).

---

## Scraping a table

If the thing you want is a real HTML table, **don't** use *Grab a list* — a
picker can't make sense of a table (clicking a row matches the **header** row
too; clicking a cell matches every cell on the page). Use **📊 Grab a table**:

1. **＋ Add step → 📊 Grab a table.**
2. **① Pick the table** → press **Pick**. Now move over the page: **whole tables
   light up** (with a label — *“📊 This table — 9 rows × 7 columns”*), so there's
   no doubt what you're about to grab. Click the one you want. That's the only
   pick you make.
3. It reads the table itself and fills in:
   - **every column**, named from the `<th>` headings (`Gross` → `gross`),
   - **numbers**: money and % columns come out as `511.09` / `45.22`, not text, so
     they add up in Excel,
   - **no header row** and — if the table has them — **no Subtotal / Total rows**
     (untick the box to keep them).
4. **② Shape the columns**: untick any you don't want, rename them (that's the CSV
   heading), **↑↓** to reorder, and switch a column between **Text** and **Number**.
   A **live preview** underneath shows the exact rows you'll get.
5. **Save step → ▶ Run → ⬇ Export CSV.**

> Blank cells become `0` in a Number column. If you'd rather keep them empty, set
> that column to **Text**.

**Several tables on the page?** You get **the one you clicked** — nothing else.
The editor tells you which one it took, by name: *“Got **“Staff”** — table 2 of 3
on this page. Only this one is scraped.”* Wrong one? Press **Pick** again and
click a cell in the table you actually want. To scrape **more than one** table,
add **one “Grab a table” step per table**.

(There's no *“this exact element vs any matching”* prompt on a table — that
question is meaningless here, since whichever cell you click, you get the table
it sits in.)

**Logic**
| Step | What it does |
|------|--------------|
| ❓ If / Else | Do something only when a condition is true. |
| 🔄 For each | Do a block once **for every** matching element (a card, a row). Selectors inside are relative to the current one, and each pass produces a row. |
| 🔁 While | Repeat while a condition is true. |
| 🔢 Repeat | Repeat a fixed number of times. |
| ⏭ Skip item | Abandon the current item — **no row for it** — and move to the next. The way to filter. |
| ⛔ Break | Stop the current loop entirely. |

---

## Getting a selector (Pick)

A **selector** tells Scrape Studio which element you mean. You rarely type one:
inside any step, press **Pick**, the editor hides, you click the element on the
page, and the selector fills in.

When you Pick a single element, you're asked **"which element(s)?"**:
- **This exact element** — only the one you clicked.
- **Any matching (first of N)** — the general kind (e.g. *any* price → the first
  one). Choose this when you want "the first price", or when you'll loop.

For **Grab a list** and **For each**, you pick one **repeating item** (a whole
card/row); Scrape Studio generalizes it to match all of them.

---

## Cleaning up messy text

Pages rarely give you a clean value. They give you
`Price: £1,024.50 (inc VAT) — while stocks last`. Every step that reads the page
has a **Clean up the text** list: you add clean-ups from a dropdown and they run
**in order**, each one working on the result of the one above it. No regex.

For the price above:

| # | Clean-up | Result |
|---|----------|--------|
| 1 | Text between `£` and `(` | `1,024.50` |
| 2 | Number — strip £ $ , % | `1024.5` |

Press **▶ Test on the page** and you immediately see `on the page: "…"` →
`you get: 1024.5`. No need to run the whole job to find out.

**The clean-ups**

| Group | What you get |
|-------|--------------|
| Tidy | Tidy spaces, lowercase, UPPERCASE |
| Numbers | Number (strips `£ $ , %`), First number in the text, Last number, Whole number, Round to N places, Keep only the digits |
| Pull a piece out | **Text between … and …**, Text after …, Text before …, Split by … and take part # |
| Rewrite | Replace … with …, Add text at the start / end, Pad with zeros, If it is empty use … |
| Dates | Date **day first** (14/07/2026) or **month first** (07/14/2026) → `2026-07-14` |
| Advanced | Custom pattern (regex) — only if you want it |

Two things worth knowing:

- A number clean-up produces a **real number**, so `>` `<` comparisons in an
  **If**/**While** work properly (`19.99 > 5`, not `"19.99" > "5"`).
- **Date** clean-ups ask you whether the site writes day-first or month-first —
  so `03/04/2026` is never guessed wrong. They understand `14 July 2026` and
  `July 14, 2026` too, and always give back `2026-07-14` (sorts correctly in
  Excel).

In **Grab a list**, each column has its own 🧹 button for its own clean-ups.

---

## Working inside a "For each"

**For each** runs a block once for every matching element — every product card,
every table row. The important part: **inside the block, selectors mean "this
item's …"**.

When you open a step inside a For each you'll see a banner:

> 🔄 **Inside "For each .product-card"** — Pick gives you a selector relative to
> the CURRENT item.

So **Pick** the price inside one card and you get `.price` — not a selector
pointing at that one card's price. On every pass it reads *that* item's price.
(Leave a selector blank to mean the item itself.)

This is what lets you **compare values within one item** and act on it:

```
For each   .product-card
  Get  price = .price       (Number)          → column
  Get  was   = .was-price   (Number)          → working value
  If   price ≥ was → Skip item                ← not discounted: no row, next card
  Get  title = .title                         → column
                          ← the row commits itself: { title, price }
```

Every card is measured against **its own** "was" price. The same shape works for
"only cards with a badge" (Get `hasBadge` = *Does it exist?*, If not → Skip
item), "only 4-star and up", "only in stock", and so on.

**If the element isn't in the item** — a page-wide filter, a header, the "next"
button — tick **"This element is somewhere else on the page"**. Picking something
outside the item ticks it for you automatically.

---

## Values & rows

Every value you **Get** has a name, and you use that one name everywhere —
whether you kept it as a column or as a working value. There is no second
namespace to keep track of.

- **Column** → in the results table & CSV. **Working value** → rules only.
- **Inside a loop, a name always means THIS pass's value.** In a For each,
  `price` is the current card's price; the row buffer starts fresh for each item,
  so there's no ambiguity about "which price".
- **The row commits itself** at the end of each loop pass (or at the end of the
  run, if there's no loop). Nothing to remember.
- To **drop an item**, use **⏭ Skip item** — never "just don't collect anything",
  because values you already collected for that item would still form a row.
- A **Number** clean-up strips `£ , $ %` so `£329.99` becomes `329.99` — needed
  for numeric comparisons and maths. See
  [Cleaning up messy text](#cleaning-up-messy-text).

You can drop any value into a text box with double braces: Fill
`page {{ pageNumber }}`, or Go to URL `https://site.com/list?p={{ i }}`.

> **Why is my row half-empty?** You filtered with an **If** instead of a
> **Skip item**: the values you read *before* the If still committed a row for
> the items that didn't match. Move the filter to `If … → Skip item`. The run
> log warns you when this happens.

---

## Conditions (visual)

**If** and **While** don't need typed operators. You choose **Match ALL / ANY**,
then add rules like:

> `price` — **is greater than** — `300`

Pick the operator from a dropdown (is equal to, contains, is empty, is true…)
and your variable from a list. Combine rules with ALL (and) or ANY (or).

---

## Keeping big jobs tidy: Tasks, Try/Recover, and the Map

Small scrapes stay a short list — that's the point. When a job gets bigger,
three tools keep it readable and robust:

- **📦 Task** — a named folder of steps. Add one, name it (`Log in`,
  `Extract`, `Export`), and drag steps into it (or use *+ add step*). Click its
  header to **collapse** it, so a long job reads as a few boxes instead of forty
  rows. A Task doesn't change anything about how your run works — it's just for
  tidiness and reuse. Press **☆** on a Task to save it to your **library** and
  drop it into other jobs from **Your saved tasks** in **＋ Add step**.

- **🛟 Try / Recover** — for the steps that *sometimes* fail (a login, a slow
  page, a flaky click). Put them under **Try**; if any fails, Scrape Studio runs
  your **recovery** steps instead of stopping the whole run. Set **retries** to
  give the risky steps a few more attempts first. Example: *Try to log in,
  retry twice; if it still fails, ⛔ Break so we give up on this item.*

- **🗺 Map** — press **Map** above the steps to open the **graph editor**: an
  editable canvas (like Unreal's Blueprints) where you actually *build* the job.
  **＋ Node** adds a step, **drag** moves it, **double-click** edits it — or, for a
  Module / loop / branch, **opens its own graph** (the breadcrumb up top walks you
  back out). Drag from a node's **right dot ▸ to another's left dot** to set the
  order. Boxes are coloured by what they are (green = grabs data, blue = does
  something on the page, amber = repeat/decide, violet = Module), and **Data flow**
  shows which step produces each value and which uses it. The Map and the step
  list edit the **same** job — so you can name a Module here, open it, and describe
  it with nodes, then use that Module inside another Module's graph.

---

## Cookbook: real scraping jobs

### 1. A simple list (name + price, aligned)
1. **Grab a list** → **Pick** one product card (the repeating box).
2. **Add column** `name` → **Pick** the name inside the card.
3. **Add column** `price` → **Pick** the price inside the card.
4. **Run** → one row per product, columns aligned. **Export CSV**.

> Do **not** use two separate scrapes for name and price — that gives you all the
> names then all the prices, unaligned. One “Grab a list” with two columns keeps
> them together.

### 1b. The same list, but with a filter or a rule
Use **For each** + **Skip item** when you need logic per item:
1. **For each** → Pick one product card.
2. **Grab one value** `price` → Pick the price (clean-up: **Number**).
3. **If** `price` is greater than `200` → **Skip item**.
4. **Grab one value** `name` → Pick the name.
5. **Run** → one row per *surviving* card. Rows commit themselves.

### 2. Search, then scrape the results
1. **Fill field** the search box (e.g. `xbox series x`).
2. **Press key** Enter (or **Click** the search button).
3. **Wait for** a result element to appear.
4. **Grab a list** the results.

### 3. Multiple pages ("Next" button)
```
Get     hasNext = Does it exist?  .next      → working value
While   hasNext is true
  Grab a list   the results
  Click   .next
  Wait for      a result element
  Get     hasNext = Does it exist?  .next    ← refresh it each lap
```
Simplest version if the button disappears on the last page: use a **While** whose
rule checks a `hasNext` variable you refresh each loop.

### 4. Infinite scroll / "Load more"
1. **Load all** (optionally give it the "load more" button).
2. **Grab a list**.

### 5. Loop over cards; for each, open its detail page, scrape it, come back
This is the powerful one — **For each** makes it clean:
```
For each   .product-card
  Get  name  = .title                          ← relative to THIS card
  Get  price = .price          (Number)
  If   price ≤ 300 → Skip item                 ← only the expensive ones
  Click   a.title-link                         ← opens this card's detail page
  Get  detail = .spec-value                    ← on the detail page
  Go back                                      ← return to the list, continue
                        ← row: { name, price, detail }
```
Inside **For each**, `.title` means *this* card's title — just **Pick** it and
you get the relative selector. After you **Click** into a detail page, selectors
there are used as-is; **Go back** returns you to the list so the loop continues
with the next card. See [Working inside a "For each"](#working-inside-a-for-each).

### 5b. Only the items that beat a rule (compare inside one card)
```
For each   .product-card
  Get  price  = .price      (Number)         → column
  Get  was    = .was-price  (Number)         → working value
  If   price ≥ was → Skip item               ← this card's own two values
  Get  name   = .title                       → column
  Get  saving = Expression  was - price      → column
```
Only discounted cards produce a row. Swap the rule for "rating is at least 4",
"stock is greater than 0", "title contains Pro" — same shape.

### 6. Scrape a report for every day of a month (date range)
```
Repeat 31   (index variable: i)
  Fill  #from = {{ pad(i+1, 2) }}/07/2026
  Fill  #to   = {{ pad(i+1, 2) }}/07/2026
  Click  "Run report"
  Wait for  a result row
  Grab a list  (columns … + a "date" column of type "Value / expression" = pad(i+1,2)+"/07/2026")
```
`pad(i+1, 2)` makes `01, 02, … 31`. Each day's rows are tagged with the date.

### 7. Log in first
Open the job, browse to the site, **log in normally** in the built-in browser.
That session is saved for this job. Then build/run your steps — every run reuses
the login.

---

## Expressions (optional / advanced)

Used in **Grab one value → a calculation**, **Repeat count**, and list
"Value / expression" columns. Everyday users can ignore these — for pulling
values out of text, use [clean-ups](#cleaning-up-messy-text) instead; they cover
the same ground without typing anything.

- Maths: `+ - * / %`, e.g. `total + 1`, `price * 1.2`
- Text: `name + " (sale)"`, `len(title)`, `lower(x)`, `contains(x, "sale")`
- Numbers from text: `number(x)`, `int(x)`, `round(x, 2)`, `pad(n, 2)`
- Regex (power users): `match(text, "[0-9]+")` (first number),
  `match(url, "/p/([0-9]+)", 1)` (capture group), `test(x, "^SKU")`,
  `regexReplace(x, "[^0-9]", "")`
- Variables are **typed**: a `count` is a number, scraped text is a string.
  Use `number(x)` (or the Convert-to-number checkbox) before doing maths on
  scraped text.

---

## Known limitations & where it gets hard

An honest list of things that are currently **impossible or clunky**, so you can
plan around them (and so we know what to build next).

| Scenario | Status | Notes / workaround |
|----------|--------|--------------------|
| List → detail → back, per item | ✅ Easy | **For each** + **Go back**. |
| Multi-page "Next" | ✅ OK | **While** + Click next. A dedicated helper would be friendlier. |
| Infinite scroll | ✅ Easy | **Load all** step. |
| Wait for spinner to vanish | ✅ Easy | **Wait for → until it disappears**. |
| Numbers from prices | ✅ Easy | **Number** clean-up. |
| **Text formatting for non-coders** | ✅ Easy | **Clean up the text**: Text between / after / before, First number, Digits only, Split & take part, Dates → `2026-07-14`, and more — chained visually, with **▶ Test on the page** to preview. Regex is available but never required. |
| **Compare two values inside one card** | ✅ Easy | Inside **For each**, Pick gives relative selectors, so `Get price` / `Get was` read THIS item — then an **If** compares them. |
| **Skip an item mid-loop** | ✅ Easy | **⏭ Skip item** — put it in an If to keep only the items you want. |
| **De-duplicate rows** | ❌ Not yet | No way to drop duplicates across pages. **Planned:** a "unique by column" option on export. |
| **Retry a flaky step** | ⚠️ Partial | A failing step is logged and the job continues, but there's no automatic retry. Workaround: **Wait for** before acting. |
| **Iframes** (embedded widgets) | ❌ Not supported | Elements inside a cross-origin iframe can't be reached yet. |
| **Multiple output tables** | ❌ Not yet | One results table per job; run separate jobs for different data shapes. |
| **Download images/files** | ❌ Not yet | You can scrape an image URL, but not download the file. |
| **Random delays (anti-bot)** | ⚠️ Minor | Only fixed **Delay**. |
| **Collecting a list into a variable** | ❌ Not yet | Variables hold a single value (no arrays). Use **For each** to iterate the page directly instead. |

If a job needs one of the ❌ items, tell us — several are small additions.

# Qlik dashboard templates: live embed page + static snapshot

Two pieces that work together.

1. **A live dashboard page** (`remarketing_dashboard.html` is the reference
   copy). One HTML file that embeds several Qlik Sense sheets as iframes,
   with a numbered menu, per-sheet filters, fullscreen, and a staggered
   loader so the first sheet paints fast. Viewers authenticate with their own
   Qlik session; the page holds no credentials.

2. **A static snapshot generator** (`qlik-static-snapshot.mjs`). Turns any
   page built on the template's contract into an offline-openable twin where
   each sheet is a PNG. Clicking a PNG swaps that sheet back to the live
   iframe, then the rest follow in the background.

Verified against Qlik Cloud on 2026-09-03. The behaviours flagged as traps
below were measured, not read off documentation - a few of them contradict
what the docs imply.

---

## Before you publish anything

**This repository is public. Never commit a generated static page.**

The live page is safe to publish: it contains ids and configuration only, and
no data appears until a viewer authenticates against your tenant. A static
snapshot is a different object entirely - it bakes rendered figures,
forecasts and named customers into images with **no authentication gate at
all**. Anyone who opens the file sees the numbers.

`.gitignore` blocks `*.static.html` and `*.static-assets/` for this reason.
Do not override it. Share a snapshot the way you would share a PDF of the
same numbers: directly, with people who should have them.

Worth knowing about the live page too: it publishes your tenant hostname, the
app id, every sheet id, and whatever contact address you put in the footer.
None of that grants access without a login, but they are real identifiers of
real systems and people. Use a role address rather than an individual's email
if the page is going somewhere public.

---

## Part 1: the live dashboard page

### Tenant prerequisites

- **Content Security Policy** - a one-time admin ask. The tenant must allow
  your page's origin to frame it:

      Administration > Content Security Policy > Add
        Origin:     <user>.github.io
        Directives: frame-ancestors     (this one alone is enough)

  `frame-ancestors` is the *only* directive needed for plain iframes. It does
  not involve enabling `eval` or any script-execution permission, which is
  worth saying out loud when you ask an admin for it. Without it the iframes
  refuse to render with an X-Frame-Options-style error, and the page cannot
  detect that for you - it looks like a blank sheet.
- **An embed theme** (strongly recommended, see below).
- Viewers need normal access to the app. The page grants nothing.

### The config contract

Everything you edit lives in one `<script>` block near the top. The generator
reads the same block, so keep it declarative.

```js
window.CONFIG = {
  host:  "my-tenant.eu.qlikcloud.com",
  appid: "00000000-0000-0000-0000-000000000000",
  theme: "my-embed-theme",   // a qextFilename - see the theme section
  opt:   "ctxmenu,currsel"   // default Single Integration API options
};

window.PAGE = {
  // page title, subtitle, footer text
};

// Applied to EVERY sheet on the page.
window.GLOBAL_SELECTIONS = [
  { field: "Year",    values: [2026] },
  { field: "Quarter", values: [3, 4] }
];

window.SHEETS = [
  { id: "00000000-0000-0000-0000-000000000001",
    title: "Overview",
    subtitle: "Actuals vs target" },

  { id: "00000000-0000-0000-0000-000000000002",
    title: "Volume",
    subtitle: "Units sold",
    selections: [{ field: "Measure", values: ["# Sold Units"] }] }
];
```

**`SHEETS` entry options**

| key | meaning |
| --- | --- |
| `id` | sheet id (required) |
| `title`, `subtitle` | shown in the menu and section header |
| `height` | CSS height of the iframe box (default `84vh`) |
| `appid` | embed this one sheet from a different app |
| `opt` | override `CONFIG.opt` for this sheet |
| `identity` | name this sheet's Qlik session (see below) |
| `selections` | `[{field, values}]`, merged over `GLOBAL_SELECTIONS` |
| `renderWidth`, `renderHeight` | snapshot render size only; ignored live |

The same sheet id can appear several times with different `selections` - that
is how one "measure selector" sheet becomes several sections.

### Sessions and `identity`

Each iframe URL carries an `identity` parameter, defaulting to a hash of that
sheet's combined selections. Sheets with identical selections therefore share
one Qlik engine session and stay in sync; sheets with different selections get
their own and do not fight over selection state.

This matters more than it looks. Qlik shares an engine session per
(app, identity), so **anyone with the same app open elsewhere - including you,
in another browser tab - shares that session**. When testing anything about
how a sheet renders, close your own copy of the app first. A contended session
produces intermittent, inexplicable results.

For your own scripted QIX work the equivalent knob is
`openAppSession({ appId, identity })`, which lands in the engine URL as
`/app/<id>/identity/<id>`. The Reporting API has no such parameter - it owns
its sessions and cannot be isolated from interactive users.

### URL overrides

The page accepts the same parameter names as the Single Integration API, so a
working `/single/` query string can be pasted onto the page URL:

```
?host=<host>   ?appid=<id>   ?theme=<qextFilename>   ?opt=<opts>
?select=Field,value1,value2       (repeatable; REPLACES GLOBAL_SELECTIONS)
?select=clearall                  (no global selections)
```

### Loader tuning

Constants near the bottom of the render script:

| constant | default | effect |
| --- | --- | --- |
| `FIRST_SETTLE_MS` | 2500 | CPU headroom for sheet 01 before the rest start |
| `SETTLE_MS` | 800 | gap between later releases |
| `MAX_CONCURRENT` | 2 | parallel loads after sheet 01 |
| `LOAD_TIMEOUT_MS` | 15000 | frees a slot when a frame never fires `load` |

Sheet 01 loads alone deliberately: if every sheet boots at once they compete
for CPU and the visible one paints last. `loading="lazy"` does not help -
Chrome's threshold is wide enough that everything starts within a second or
two anyway.

---

## Part 2: the embed theme

### Why you want one

A Qlik theme is the only way to change how embedded and exported sheets look,
and it does two useful things here: it removes client chrome that makes no
sense in an embed, and it can drop card borders and shadows so sheets sit
flush in your own layout.

It matters most for snapshots. **The Reporting API renders the full client
chrome, so a sheet PNG includes the app's navigation/tab row** - with the tab
labels truncated to the render width. `/single/` never shows that row. A theme
whose CSS hides those elements removes it at render time, with no cropping.

Themes carry arbitrary CSS. `GET /v1/themes/{id}/theme.json` exposes the hook:

```json
"customStyles": [{ "cssRef": "theme.css", "classRef": "my-embed-theme" }]
```

That stylesheet ships inside the theme package and is injected scoped to
`classRef`, so it can restyle or hide anything the client renders. Read an
existing one with `GET /v1/themes/{id}/theme.css`.

### Keep two themes, not one dynamic one

Leave the interactive app on its normal theme and pass a second,
embed-oriented theme per request. Theme CSS rules are unconditional - nothing
in the cascade tells a stylesheet whether it is rendering inside an iframe, a
headless export, or the live client - so a "context-aware" theme is not
possible. The per-request `theme` parameter is the mechanism instead, and it
leaves interactive users untouched.

### The trap: a theme has three identifiers and only one works

`GET /v1/themes` returns all three:

| identifier | example | accepted by `theme=` / `jsOpts.theme`? |
| --- | --- | --- |
| extension `id` | a 22-char opaque string | **no** |
| display `name` | `Acme for IFrame` | **no** |
| `qextFilename` | `acme-theme-for-iframe` | **yes** |

Only `qextFilename` resolves. The other two are **silently ignored** - the
render simply comes back with the app's own styling and no error anywhere.
Measured: a valid `qextFilename` changed 21% of pixels versus an unthemed
baseline, while a nonsense string changed 0%; the id and display-name forms
behaved exactly like the nonsense string.

Find yours with:

```bash
curl -s -H "Authorization: Bearer $QLIK_API_KEY" \
  "https://$QLIK_HOST/api/v1/themes" \
  | python -c "import json,sys;[print(t['qextFilename'],'|',t['name']) for t in json.load(sys.stdin)['data']]"
```

The generator validates this for you and refuses to run with a wrong form,
telling you the right value.

---

## Part 3: generating a static snapshot

### Authentication: this part needs an API key

The page needs no credentials - its iframes ride the viewer's own browser SSO
session. The Reporting API cannot borrow a browser session, so the generator
needs its own tenant credential. This is unavoidable, not a design choice.

```powershell
$env:QLIK_API_KEY = "<key>"        # PowerShell
```
```bash
export QLIK_API_KEY=<key>          # bash
```

Create the key in Qlik under *Settings > API keys*. It inherits your own
permissions, so it can read exactly the apps you can. Treat it as a password:
never commit it, never paste it into the page.

### Run it

```bash
node qlik-static-snapshot.mjs remarketing_dashboard.html --crop-top 8
```

Start with `--dry-run`: it resolves the config, prints the plan (app, sheet,
render size, merged selections per section) and exports nothing.

| option | default | notes |
| --- | --- | --- |
| `--out <file>` | `<page>.static.html` | |
| `--crop-top <pct>` | 0 | trims the top of every shot, losslessly |
| `--crop-bottom <pct>` | 0 | |
| `--zoom <n>` | 2 | Qlik `outZoom`; multiplies pixel size |
| `--width <px>` | 1400 | logical render width |
| `--height <px>` | 800 | logical render height |
| `--theme <qext>` | page's `CONFIG.theme` | |
| `--no-theme` | | export with the app's own styling |
| `--host <host>` | page's `CONFIG.host` | |
| `--api-key <key>` | `$QLIK_API_KEY` | |
| `--assets inline` | default | base64 into the HTML; one portable file |
| `--assets folder` | | sibling PNGs; much smaller HTML |
| `--only <n,m>` | | export only these `SHEETS` indexes, for testing |
| `--frame-selector <sel>` | `.sheet-frame` | container holding each iframe |
| `--dry-run` | | print the plan, export nothing |

Expect roughly 3 to 25 seconds per sheet - a cold app pays the same
open-and-render cost a user would, a warm one is fast. Eight sheets took about
40 seconds warm, producing a 2.4 MB single file (or a 54 KB file plus PNGs in
folder mode).

### Sizing: check this per sheet

`--width`/`--height` are the **logical viewport** Qlik renders into, and
`--zoom` multiplies the output pixels (1400x800 at `--zoom 2` gives a
2800x1600 PNG).

**A sheet whose own layout is taller than the render height comes back with
its lower content simply missing, and nothing reports it.** One global height
rarely suits every sheet. Override per sheet in `SHEETS`:

```js
{ id: "...", title: "Overview", renderHeight: 1400 }
```

Open each PNG once and confirm the whole sheet is there. This is the single
most likely way to ship a snapshot that looks fine and is quietly incomplete.

### Cropping

An embed theme removes the navigation row but leaves the space it occupied, so
shots often want 5 to 10 percent off the top.

The crop is **lossless and CSS-only**: the wrapper takes the aspect ratio of
the visible band and the image covers it, anchored so the trimmed edge falls
outside. Fonts and chart proportions are untouched, the full PNG stays in the
file, and you can retune the crop afterwards by editing the emitted
`aspect-ratio` and `object-position` values.

### How the static page behaves

- Every sheet shows its PNG, with a "Click for the live view" hint on hover.
- The page's own loader is neutralised rather than patched: its queue is
  pointed at `about:blank`, so it runs harmlessly behind the images.
- Clicking a shot promotes **that** sheet to a live iframe first and gives it
  the machine to itself; once it loads, the remaining sheets are released
  through the same staggered pattern.
- `window.qlikStaticGoLiveAll()` promotes everything from the first sheet.
- Offline, a click shows "Offline - the live view needs a connection" instead
  of loading a blank frame.
- Snapshots are keyed by a hash of their export request, not by position, and
  the runtime checks each sheet id before painting. Reorder `SHEETS` without
  regenerating and it warns in the console and leaves that sheet live, rather
  than showing the wrong sheet's numbers.

---

## Adapting the template to a new dashboard

1. Copy the reference page, edit `CONFIG` and `SHEETS`, delete the rest of the
   example entries.
2. Add your page's origin to the tenant CSP allowlist.
3. Confirm the sheets load live, in the browser, signed in.
4. `--dry-run` the generator, then export.
5. Check every PNG for cut-off content and tune `renderHeight`.
6. Tune `--crop-top`.

For the generator to work, a page must satisfy two things. It verifies both
and fails loudly rather than emitting a half-working file.

- `window.CONFIG` and `window.SHEETS` are assigned in a `<script>` block that
  does not need a DOM (the block is executed in a sandbox).
- One container per sheet matches `--frame-selector`, in `SHEETS` order, each
  holding an `<iframe>` whose target URL is in `data-src` (or `src`).

---

## Troubleshooting

| symptom | cause |
| --- | --- |
| Iframes blank, console shows a CSP refusal | page origin not in the tenant CSP allowlist |
| Iframes blank, no console error | not signed in; open Qlik in another tab, then reload |
| Snapshot has the app's tab bar across the top | no theme applied, or a theme id/display name was passed instead of the `qextFilename` |
| Theme seems to work sometimes | you (or someone) had the app open elsewhere; a shared engine session makes render tests erratic |
| Snapshot missing the lower half of a sheet | `renderHeight` too small for that sheet's layout |
| `Invalid extension on file name` | you are on the file-template report path; that is unrelated to this tool |
| Generator: "not a qextFilename" | it found your theme under a different identifier and printed the right value |
| Export finished but a chart is missing | Qlik skips unsupported objects (third-party extensions) and reports them as warnings; the generator prints them |
| Static file will not open in some viewers | 2.4 MB inline is large; use `--assets folder` |

A note on that last row of the theme problem: report requests return `202`
then `done` with no errors even when `jsOpts` was ignored entirely. Never
infer from a successful status that a render option took effect - compare the
actual output.

---

## Known limits

- The generator needs an API key; it cannot use browser SSO.
- Chart internals do not reflow. A snapshot scales as an image, so axis ticks,
  truncated labels and legend placement stay exactly as rendered. Rendering at
  `--zoom 2` keeps it sharp when scaled down.
- The selection bar (`opt=currsel`) is not rendered by the Reporting API, so
  snapshots do not show filter pills. Print the applied selections as text in
  your own layout if viewers need them.
- Only the reference page has been exercised end to end. The contract above is
  documented but untested on a second layout.
- There is no way to inject CSS per export, and no way to pass a theme inline.
  `jsOpts` accepts `theme` and `language` only, and unknown keys are accepted
  and ignored without error. Per-render chart tweaks go through the Reporting
  API's `patches` / `patchesById` instead, which change chart properties rather
  than CSS.

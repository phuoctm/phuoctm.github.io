#!/usr/bin/env node
//
// qlik-static-snapshot -- turn an iframe-embedding Qlik dashboard page into a
// static, offline-openable twin, where each embedded sheet becomes a PNG that
// swaps back to the LIVE iframe when clicked.
//
// Usage
//   node qlik-static-snapshot.mjs <page.html> [options]
//
//   --out <file>        output path (default: <page>.static.html)
//   --crop-top <pct>    trim this % off the top of every shot (default 0)
//   --crop-bottom <pct> trim this % off the bottom (default 0)
//   --zoom <n>          Qlik outZoom, multiplies pixel size (default 2)
//   --width <px>        logical render width (default 1400)
//   --height <px>       logical render height (default 800)
//   --theme <qext>      override the page's CONFIG.theme
//   --no-theme          export with no theme at all (app's own styling)
//   --host <host>       override the page's CONFIG.host
//   --api-key <key>     override the QLIK_API_KEY env var
//   --assets inline     base64 the PNGs into the HTML (default; one file)
//   --assets folder     write PNGs next to the output instead
//   --only <n,m>        export only these SHEETS indexes (0-based), for testing
//   --dry-run           resolve config and print the plan, export nothing
//
// AUTHENTICATION -- read this first
//   The page itself needs no credentials: its iframes ride the viewer's own
//   interactive Qlik session (SSO cookies) in the browser. This generator
//   CANNOT do that -- the Reporting API has no way to borrow a browser
//   session -- so it needs its own tenant credential:
//
//       $env:QLIK_API_KEY = "<key>"      (PowerShell)
//       export QLIK_API_KEY=<key>        (bash)
//
//   That is the one thing it needs beyond the page. It reads no tenant
//   metadata, no config files and no other state, which is why it lives here
//   next to the page rather than inside a bigger toolchain.
//
// CONTRACT the source page must satisfy (this is the reusable template shape)
//   1. A <script> block assigning:
//        window.CONFIG            { host, appid, theme }   theme = a qextFilename
//        window.SHEETS            [ { id, title, subtitle?, height?, appid?,
//                                     selections?: [ {field, values[]} ] } ]
//        window.GLOBAL_SELECTIONS [ {field, values[]} ]    optional
//      Assignments are executed in a sandbox, so comments and expressions are
//      fine, but they must not need a real DOM.
//   2. One element per sheet matching --frame-selector (default ".sheet-frame")
//      in SHEETS order, each containing an <iframe> whose target URL is in
//      `data-src` (or `src`).
//
//   The generator VERIFIES both and fails loudly rather than emitting a
//   half-working page.
//
// WHY THE THEME MATTERS
//   The Reporting API renders the FULL client chrome, so a sheet PNG includes
//   the app's navigation/tab row -- which /single/ never shows. Passing the
//   same embed theme the page's iframes use removes it at render time. Qlik
//   accepts ONLY the theme's `qextFilename` here (not its id, not its display
//   name), and an unresolvable value is silently ignored -- the export just
//   comes back with app styling and no error. So the theme is validated
//   against /v1/themes before anything is exported.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const srcPath = args._[0];

if (!srcPath || args.help) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(srcPath ? 0 : 1);
}

const num = (v, d) => (v === undefined ? d : Number(v));
const OPT = {
  out: args.out || srcPath.replace(/\.html?$/i, "") + ".static.html",
  cropTop: num(args["crop-top"], 0),
  cropBottom: num(args["crop-bottom"], 0),
  zoom: num(args.zoom, 2),
  width: num(args.width, 1400),
  height: num(args.height, 800),
  frameSelector: args["frame-selector"] || ".sheet-frame",
  assets: args.assets === "folder" ? "folder" : "inline",
  only: args.only && args.only !== true
    ? String(args.only).split(",").map((s) => Number(s.trim())) : null,
  dryRun: Boolean(args["dry-run"]),
  apiKey: args["api-key"] && args["api-key"] !== true ? args["api-key"] : process.env.QLIK_API_KEY,
};

const fail = (msg) => { console.error(`\n  ERROR  ${msg}\n`); process.exit(1); };

// ------------------------------------------------- read the page and its config

const html = readFileSync(resolve(srcPath), "utf8");

// Pull the config out by executing the page's assignment block in a sandbox.
// A real DOM is not provided on purpose: a page that needs one to declare its
// config is not following the contract, and should say so loudly.
function extractConfig(source) {
  // Strip HTML comments FIRST. A page that documents itself will happily
  // mention "<script>" inside a comment, and a naive scan then starts
  // capturing mid-prose and hands the sandbox something that cannot parse.
  const stripped = source.replace(/<!--[\s\S]*?-->/g, "");
  const blocks = [...stripped.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const win = { location: { search: "", href: "" } };
  const sandbox = { window: win, URLSearchParams, console: { log() {}, warn() {}, error() {} } };
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);
  let found = null;
  for (const code of blocks) {
    if (!/window\.(CONFIG|SHEETS)\s*=/.test(code)) continue;
    try {
      runInContext(code, ctx, { timeout: 5000 });
    } catch {
      // A block that also touches the DOM will throw partway. Whatever it
      // managed to assign before throwing is still usable.
    }
    if (win.CONFIG && win.SHEETS) { found = win; break; }
  }
  if (!found) {
    fail("could not read window.CONFIG and window.SHEETS from the page.\n" +
         "         This generator expects the template contract documented at the\n" +
         "         top of this file. Check that both are assigned in a <script>\n" +
         "         block that does not require a DOM.");
  }
  return found;
}

const win = extractConfig(html);
const CONFIG = win.CONFIG || {};
const SHEETS = Array.isArray(win.SHEETS) ? win.SHEETS : [];
const GLOBAL_SELECTIONS = Array.isArray(win.GLOBAL_SELECTIONS) ? win.GLOBAL_SELECTIONS : [];

const host = (args.host && args.host !== true ? args.host : CONFIG.host || "").replace(/^https?:\/\//, "");
if (!host) fail("no tenant host: the page has no CONFIG.host and --host was not given.");
if (!SHEETS.length) fail("the page's window.SHEETS is empty; nothing to export.");

const themeName = args["no-theme"] ? null
  : (args.theme && args.theme !== true ? args.theme : CONFIG.theme || null);

// Verify the frame selector will actually find one container per sheet. The
// containers are built by the page's own JS, so they are not in the source;
// what we CAN check is that the markup template mentions the class and that
// the iframes carry data-src or src.
const selectorToken = OPT.frameSelector.replace(/^[.#]/, "");
if (!html.includes(selectorToken)) {
  fail(`the page never mentions "${OPT.frameSelector}" (--frame-selector).\n` +
       `         The injected runtime would find no sheet containers.`);
}
if (!/<iframe[^>]*\bdata-src\b/.test(html) && !/<iframe[^>]*\bsrc\b/.test(html)) {
  fail("no <iframe> with data-src or src found in the page's markup template.");
}

// ------------------------------------------------------------------ selections

// Qlik wants values typed: a number goes in `number`, a string in `text`.
function toQSelection(sel) {
  const values = (sel.values || []).map((v) => {
    const isNumeric = typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v));
    return isNumeric ? { number: Number(v), isNumeric: true } : { text: String(v), isNumeric: false };
  });
  return {
    fieldName: sel.field,
    defaultIsNumeric: Boolean(values[0]?.isNumeric),
    values,
  };
}

function effectiveSelections(sheet) {
  const merged = [...GLOBAL_SELECTIONS, ...(sheet.selections || [])];
  // A per-sheet selection on the same field replaces the global one.
  const byField = new Map();
  for (const s of merged) if (s && s.field) byField.set(s.field, s);
  return [...byField.values()];
}

// Key by the CONTENT of the export request, never by position: two sections
// wanting the same app+sheet+selections then share one render, and reordering
// SHEETS later cannot slide a snapshot onto the wrong section.
function requestKey(appId, sheetId, selections) {
  const norm = selections.map((s) => `${s.field}=${(s.values || []).join("|")}`).sort().join(";");
  return createHash("sha1").update([appId, sheetId, norm, themeName ?? "", OPT.width, OPT.height, OPT.zoom].join("\n")).digest("hex").slice(0, 12);
}

const plan = SHEETS.map((sheet, i) => {
  const appId = sheet.appid || CONFIG.appid;
  const selections = effectiveSelections(sheet);
  // Per-sheet render size. A single global height cannot suit every sheet:
  // a sheet whose own layout is taller than the render viewport comes back
  // with its lower content simply absent, and nothing reports that. Set
  // `renderHeight` (and `renderWidth`) on the SHEETS entry to match.
  const width = Number(sheet.renderWidth || OPT.width);
  const height = Number(sheet.renderHeight || OPT.height);
  return {
    index: i,
    title: sheet.title || `sheet ${i}`,
    appId,
    sheetId: sheet.id,
    selections,
    width,
    height,
    key: requestKey(appId, sheet.id, selections, width, height),
    skip: OPT.only ? !OPT.only.includes(i) : false,
  };
});

// ------------------------------------------------------------------- Qlik REST

const api = async (path, init = {}) => {
  const r = await fetch(`https://${host}/api/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${OPT.apiKey}`, ...(init.headers || {}) },
  });
  return r;
};

const apiJson = async (path, init) => {
  const r = await api(path, init);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}: ${text.slice(0, 300)}`);
  return data;
};

async function validateTheme() {
  if (!themeName) return null;
  const list = await apiJson("v1/themes");
  const themes = list?.data ?? [];
  const hit = themes.find((t) => t.qextFilename === themeName);
  if (hit) return hit;
  const byOther = themes.find((t) => t.id === themeName || t.name === themeName);
  const names = themes.map((t) => t.qextFilename).filter(Boolean);
  if (byOther) {
    fail(`theme "${themeName}" is a theme ${byOther.id === themeName ? "id" : "display name"}, not a qextFilename.\n` +
         `         Qlik's render options accept ONLY the qextFilename, and silently\n` +
         `         ignore anything else -- your exports would come back unthemed with\n` +
         `         no error at all. Use: ${byOther.qextFilename}`);
  }
  fail(`theme "${themeName}" is not installed on ${host}.\n` +
       `         An unresolvable theme is silently ignored, so this would produce\n` +
       `         unthemed exports with no error.\n` +
       `         Installed qextFilenames: ${names.join(", ") || "(none)"}`);
}

async function exportSheet(item) {
  const body = {
    type: "sense-image-1.0",
    meta: { exportDeadline: "PT10M", outputTtl: "PT1H" },
    output: { type: "image", outputId: "shot", imageOutput: { outFormat: "png", outZoom: OPT.zoom } },
    senseImageTemplate: {
      appId: item.appId,
      ...(item.selections.length
        ? {
            selectionType: "selectionsByState",
            // Fail loudly: a renamed field must not quietly export the wrong
            // numbers into something that looks like a finished report.
            selectionStrategy: "failOnErrors",
            selectionsByState: { $: item.selections.map(toQSelection) },
          }
        : {}),
      visualization: {
        type: "sheet",
        id: item.sheetId,
        widthPx: item.width,
        heightPx: item.height,
        ...(themeName ? { jsOpts: { theme: themeName } } : {}),
      },
    },
  };

  const post = await apiJson("v1/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const requestId = post?.requestId;
  if (!requestId) throw new Error(`no requestId returned: ${JSON.stringify(post).slice(0, 200)}`);

  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await apiJson(`v1/reports/${requestId}/outputs`);
    const out = res?.data?.[0];
    // The outputs list is EMPTY for the first ~20s; an absent record means
    // "still working", not failure.
    if (!out?.status || ["created", "queued", "processing", "inProgress"].includes(out.status)) continue;
    if (out.status !== "done") {
      throw new Error(`report ${out.status}: ${JSON.stringify(out.exportErrors ?? {}).slice(0, 400)}`);
    }
    // `done` does NOT mean complete: unsupported objects (extensions) are
    // skipped and only reported here, while the file downloads at a
    // believable size.
    const warnings = out.exportErrors ?? [];
    const r = await api(`v1/temp-contents/${out.location.split("/").pop()}`);
    if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
    return { buf: Buffer.from(await r.arrayBuffer()), warnings };
  }
  throw new Error("timed out waiting for the report");
}

// -------------------------------------------------------------------- geometry

// Lossless crop: the wrapper takes the aspect ratio of the VISIBLE band and
// the image covers it, so nothing is rescaled non-uniformly -- fonts and chart
// proportions are untouched, and the full PNG is still in the file.
function cropGeometry(pxW, pxH) {
  const top = Math.max(0, Math.min(90, OPT.cropTop));
  const bottom = Math.max(0, Math.min(90, OPT.cropBottom));
  const visible = 1 - (top + bottom) / 100;
  if (visible <= 0.05) fail("--crop-top plus --crop-bottom leaves almost nothing visible.");
  const aspect = `${pxW} / ${Math.round(pxH * visible)}`;
  // Where the visible band sits vertically within the image.
  const objectPosition = top + bottom === 0 ? "50% 50%" : `50% ${((top / (top + bottom)) * 100).toFixed(3)}%`;
  return { aspect, objectPosition, top, bottom };
}

function pngSize(buf) {
  // IHDR width/height live at fixed offsets in every PNG.
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------------- output

const RUNTIME_CSS = `
/* injected by qlik-static-snapshot */
.qs-shot{position:relative;display:block;width:100%;padding:0;border:0;margin:0;
  background:transparent;cursor:pointer;overflow:hidden;line-height:0}
.qs-shot>img{display:block;width:100%;height:100%;object-fit:cover}
.qs-shot:focus-visible{outline:2px solid #2FD14D;outline-offset:2px}
.qs-hint{position:absolute;right:10px;bottom:10px;z-index:2;line-height:1.2;
  font:600 12px/1.2 system-ui,sans-serif;color:#0b2b25;background:rgba(255,255,255,.92);
  border:1px solid rgba(0,0,0,.12);border-radius:999px;padding:6px 12px;
  opacity:0;transition:opacity .15s;pointer-events:none}
.qs-shot:hover .qs-hint,.qs-shot:focus-visible .qs-hint{opacity:1}
.qs-loading .qs-hint{opacity:1}
.sheet-frame.qs-static iframe{display:none}
.qs-offline{opacity:1;background:#fff3cd;border-color:#e0c060;color:#5c4600}
`;

function runtimeJs(payload) {
  return `
/* injected by qlik-static-snapshot -- static shots with click-to-live */
(function () {
  var S = ${JSON.stringify(payload)};
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  ready(function () {
    var frames = Array.prototype.slice.call(document.querySelectorAll(S.frameSelector));
    if (!frames.length) { console.warn("[static] no containers match", S.frameSelector); return; }
    var entries = [];

    frames.forEach(function (frame, i) {
      var iframe = frame.querySelector("iframe");
      var shot = S.shots[i];
      if (!iframe || !shot) return;
      var live = iframe.getAttribute("data-src") || iframe.getAttribute("src") || "";

      // Structure guard: if the page's sheet order no longer matches what was
      // exported, do NOT paint a snapshot onto the wrong sheet.
      if (shot.sheetId && live && live.indexOf(shot.sheetId) === -1) {
        console.warn("[static] sheet mismatch at position " + i + "; expected " + shot.sheetId + ". Leaving it live.");
        return;
      }

      // Defuse the host page's own staggered loader without touching its code:
      // it will dutifully load about:blank into a hidden iframe and release
      // its slot, while the snapshot sits on top.
      iframe.setAttribute("data-live-src", live);
      iframe.setAttribute("data-src", "about:blank");
      iframe.setAttribute("src", "about:blank");

      var box = document.createElement("button");
      box.type = "button";
      box.className = "qs-shot";
      box.style.aspectRatio = shot.aspect;
      box.setAttribute("aria-label", "Show live view of " + (shot.title || "this sheet"));
      var img = document.createElement("img");
      img.src = shot.src;
      img.alt = shot.alt || shot.title || "";
      img.style.objectPosition = S.objectPosition;
      box.appendChild(img);
      var hint = document.createElement("span");
      hint.className = "qs-hint";
      hint.textContent = S.hint;
      box.appendChild(hint);
      frame.appendChild(box);
      frame.classList.remove("is-pending");
      frame.classList.add("qs-static");

      var entry = { frame: frame, iframe: iframe, box: box, hint: hint, live: live, state: "static" };
      entries.push(entry);
      box.addEventListener("click", function () { goLive(entry, true); });
    });

    if (!entries.length) return;

    // Our own release queue. The host page's queue is now inert (it only ever
    // sees about:blank), so ordering is ours to own: the clicked sheet loads
    // alone and gets the machine to itself, then the rest follow.
    var queue = [];
    var inFlight = 0;
    var slots = 1;

    function settle(entry, ms) {
      setTimeout(function () { inFlight--; slots = S.maxConcurrent; pump(); }, ms);
    }

    function goLive(entry, immediate) {
      if (entry.state !== "static") return;
      if (!navigator.onLine) {
        entry.hint.textContent = S.offlineHint;
        entry.hint.className = "qs-hint qs-offline";
        entry.frame.classList.add("qs-loading");
        return;
      }
      entry.state = "loading";
      entry.frame.classList.add("qs-loading");
      entry.hint.textContent = S.loadingHint;
      inFlight++;
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        entry.state = "live";
        entry.frame.classList.remove("is-pending", "qs-loading", "qs-static");
        if (entry.box.parentNode) entry.box.parentNode.removeChild(entry.box);
        settle(entry, slots === 1 ? S.firstSettleMs : S.settleMs);
        if (immediate) enqueueRest(entry);
      };
      entry.iframe.addEventListener("load", finish, { once: true });
      // A frame blocked by CSP or a dead auth redirect never fires load.
      setTimeout(finish, S.loadTimeoutMs);
      entry.iframe.setAttribute("src", entry.live);
      entry.iframe.removeAttribute("data-src");
    }

    function enqueueRest(first) {
      entries.forEach(function (e) {
        if (e !== first && e.state === "static" && queue.indexOf(e) === -1) queue.push(e);
      });
    }

    function pump() {
      while (inFlight < slots && queue.length) goLive(queue.shift(), false);
    }

    window.qlikStaticGoLiveAll = function () {
      if (entries[0]) goLive(entries[0], true); else pump();
    };
  });
})();
`;
}

function injectIntoBody(source, css, js) {
  const style = `<style>${css}</style>`;
  const script = `<script>${js}</script>`;
  const marker = /<\/body\s*>/i;
  if (!marker.test(source)) fail("the page has no </body> to inject into.");
  return source.replace(marker, `${style}\n${script}\n</body>`);
}

// ------------------------------------------------------------------------ main

const results = [];
const cache = new Map();

if (OPT.dryRun) {
  console.log(`\n  ${basename(srcPath)}  ->  ${basename(OPT.out)}`);
  console.log(`  host ${host}   theme ${themeName ?? "(none)"}   ${OPT.width}x${OPT.height} @${OPT.zoom}x` +
              `   crop top ${OPT.cropTop}% bottom ${OPT.cropBottom}%\n`);
  for (const p of plan) {
    console.log(`  ${String(p.index).padStart(2)} ${p.skip ? "[skipped] " : ""}${p.title}`);
    console.log(`     app ${p.appId}  sheet ${p.sheetId}  ${p.width}x${p.height}  key ${p.key}`);
    for (const s of p.selections) console.log(`     select ${s.field} = ${(s.values || []).join(", ")}`);
  }
  console.log("");
  process.exit(0);
}

if (!OPT.apiKey) {
  fail("no credential. Set QLIK_API_KEY (or pass --api-key).\n" +
       "         The page's iframes use the viewer's browser session; this\n" +
       "         generator cannot borrow that and needs its own API key.\n" +
       "         See the AUTHENTICATION note at the top of this file.");
}

const theme = await validateTheme();
console.log(`\n  ${basename(srcPath)}  ->  ${basename(OPT.out)}`);
console.log(`  host ${host}   theme ${theme ? theme.qextFilename : "(none)"}   ` +
            `${OPT.width}x${OPT.height} @${OPT.zoom}x   crop ${OPT.cropTop}%/${OPT.cropBottom}%\n`);

for (const p of plan) {
  if (p.skip) { console.log(`  ${String(p.index).padStart(2)} ${p.title} -- skipped`); results.push({ ...p, buf: null }); continue; }
  if (cache.has(p.key)) {
    console.log(`  ${String(p.index).padStart(2)} ${p.title} -- reusing ${p.key}`);
    results.push({ ...p, ...cache.get(p.key) });
    continue;
  }
  const t0 = Date.now();
  process.stdout.write(`  ${String(p.index).padStart(2)} ${p.title} ... `);
  try {
    const { buf, warnings } = await exportSheet(p);
    const size = pngSize(buf);
    const rec = { buf, size, warnings, geometry: cropGeometry(size.w, size.h) };
    cache.set(p.key, rec);
    results.push({ ...p, ...rec });
    console.log(`${size.w}x${size.h}  ${(buf.length / 1024).toFixed(0)} KB  ${((Date.now() - t0) / 1000).toFixed(0)}s` +
                (warnings.length ? `  (${warnings.length} export warning(s))` : ""));
    for (const w of warnings) {
      const chart = w?.meta?.appErrors?.[0]?.parameters;
      console.log(`       warning ${w.code}: ${w.title}${chart ? ` [${chart.chartType || ""} ${chart.chartID || ""}]` : ""}`);
    }
  } catch (e) {
    console.log("FAILED");
    fail(`sheet ${p.index} ("${p.title}") could not be exported:\n         ${e.message}`);
  }
}

const exported = results.filter((r) => r.buf);
if (!exported.length) fail("nothing was exported.");

let assetDir = null;
if (OPT.assets === "folder") {
  assetDir = join(dirname(resolve(OPT.out)), basename(OPT.out).replace(/\.html?$/i, "") + "-assets");
  mkdirSync(assetDir, { recursive: true });
}

const shots = results.map((r) => {
  if (!r.buf) return null;
  let src;
  if (OPT.assets === "folder") {
    const file = `${r.key}.png`;
    writeFileSync(join(assetDir, file), r.buf);
    src = `${basename(assetDir)}/${file}`;
  } else {
    src = `data:image/png;base64,${r.buf.toString("base64")}`;
  }
  return { key: r.key, sheetId: r.sheetId, title: r.title, aspect: r.geometry.aspect, src };
});

const payload = {
  frameSelector: OPT.frameSelector,
  objectPosition: cropGeometry(OPT.width, OPT.height).objectPosition,
  shots,
  hint: "Click for the live view",
  loadingHint: "Loading live view...",
  offlineHint: "Offline -- the live view needs a connection",
  firstSettleMs: 2500,
  settleMs: 800,
  maxConcurrent: 2,
  loadTimeoutMs: 15000,
};

const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const banner = `<!-- static snapshot generated ${stamp} by qlik-static-snapshot from ${basename(srcPath)}\n` +
  `     theme=${theme ? theme.qextFilename : "(none)"} size=${OPT.width}x${OPT.height}@${OPT.zoom}x ` +
  `crop=${OPT.cropTop}%/${OPT.cropBottom}% assets=${OPT.assets} -->\n`;

const outHtml = banner + injectIntoBody(html, RUNTIME_CSS, runtimeJs(payload));
writeFileSync(resolve(OPT.out), outHtml, "utf8");

const kb = (Buffer.byteLength(outHtml, "utf8") / 1024).toFixed(0);
console.log(`\n  wrote ${OPT.out}  (${kb} KB, ${exported.length} shot(s)${assetDir ? `, assets in ${basename(assetDir)}/` : " inlined"})`);
const totalWarnings = exported.reduce((n, r) => n + (r.warnings?.length || 0), 0);
if (totalWarnings) console.log(`  ${totalWarnings} export warning(s) above -- some objects were skipped by Qlik.`);
console.log("");

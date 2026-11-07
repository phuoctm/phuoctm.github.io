// Read the input page contract (docs/input-page-contract.md) into a
// normalised page config. Browser-safe: the script evaluation itself is
// injected (src/node/page-config.js runs it in a node:vm sandbox).

/**
 * @typedef {{ field: string, values: (string|number)[] }} Selection
 * @typedef {{ index: number, sheetId: string, appId: string, title: string,
 *   subtitle: string, selections: Selection[], scopeKey: string }} Section
 * @typedef {{ host: string, appId: string, page: object,
 *   globalSelections: Selection[], sections: Section[] }} PageConfig
 * @typedef {{ appid?: string, host?: string, select?: string[] }} Overrides
 */

/** Strip HTML comments FIRST: a page that documents itself may mention
 * "<script>" inside a comment and a naive scan would start mid-prose. */
export function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** Inline script blocks that assign window.CONFIG or window.SHEETS. */
export function configScriptBlocks(html) {
  return [...stripHtmlComments(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((code) => /window\.(CONFIG|SHEETS)\s*=/.test(code));
}

/** Numeric-looking -> number, else text (same rule as the live page). */
export function isNumericValue(v) {
  return typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v));
}

/** Parse a "Field,v1,v2" override; "clearall" returns null. */
export function parseSelectArg(arg) {
  if (arg.trim().toLowerCase() === "clearall") return null;
  const [field, ...values] = arg.split(",");
  if (!field || !values.length) throw new Error(`--select expects Field,v1[,v2...], got "${arg}"`);
  return { field: field.trim(), values: values.map((v) => (isNumericValue(v.trim()) ? Number(v.trim()) : v.trim())) };
}

/** Global selections, then the section's own; a section entry on a field
 * replaces the global entry for that field. */
export function effectiveSelections(global = [], own = []) {
  const byField = new Map();
  for (const s of [...global, ...own]) byField.set(s.field, { field: s.field, values: [...s.values] });
  return [...byField.values()];
}

/** Stable key for "same app, same selections": fields and values sorted. */
export function scopeKey(appId, selections) {
  const sels = [...selections]
    .map((s) => [s.field, [...s.values].map(String).sort()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify([appId, sels]);
}

/**
 * Normalise what the page assigned on `window`, applying CLI overrides.
 * @param {{CONFIG?: any, SHEETS?: any[], GLOBAL_SELECTIONS?: any[], PAGE?: any}} win
 * @param {Overrides} [overrides]
 * @returns {PageConfig}
 */
export function normalizePageConfig(win, overrides = {}) {
  const config = win.CONFIG || {};
  const sheets = Array.isArray(win.SHEETS) ? win.SHEETS : [];
  let globalSelections = Array.isArray(win.GLOBAL_SELECTIONS) ? win.GLOBAL_SELECTIONS : [];
  if (overrides.select?.length) {
    // Same as the live page: ?select= replaces GLOBAL_SELECTIONS; clearall empties them.
    globalSelections = overrides.select.map(parseSelectArg).filter(Boolean);
  }
  const host = String(overrides.host || config.host || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const appId = overrides.appid || config.appid || "";
  if (!host) throw new Error("no tenant host: the page has no CONFIG.host and --host was not given");
  if (!sheets.length) throw new Error("the page's window.SHEETS is empty");
  const sections = sheets.map((s, index) => {
    const app = overrides.appid || s.appid || appId;
    if (!app) throw new Error(`section ${index} has no app id (CONFIG.appid, SHEETS[].appid or --appid)`);
    const selections = effectiveSelections(globalSelections, s.selections || []);
    return {
      index, sheetId: s.id, appId: app, title: s.title || "", subtitle: s.subtitle || "",
      selections, scopeKey: scopeKey(app, selections),
    };
  });
  return { host, appId, page: win.PAGE || {}, globalSelections, sections };
}

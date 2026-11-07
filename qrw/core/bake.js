// Report payload { meta, datasets } and its injection into a hand-written
// report template. Browser-safe: the live adapter builds the same payload.

/** The exact placeholder a template carries inside
 * <script type="application/json" id="qrw-data">. */
export const PLACEHOLDER = "__QRW_DATA__";

const DATA_SCRIPT = /<script\b[^>]*\bid\s*=\s*["']qrw-data["'][^>]*>([\s\S]*?)<\/script>/gi;

/** "Year: 2026 · Product: Alpha, Beta", or "No selections". */
export function selectionsLabel(selections = []) {
  if (!selections.length) return "No selections";
  return selections.map((s) => `${s.field}: ${s.values.join(", ")}`).join(" · ");
}

/**
 * The payload a report renders: `meta` (mode, fetch time, timings, host,
 * apps, counts, a selections label per scope, links per section) and the
 * fetched `datasets` as written to data.json.
 * @param {any} spec @param {any} data fetchSpec result
 * @param {{mode?: "snapshot"|"live"}} [opts]
 */
export function buildPayload(spec, data, { mode = "snapshot" } = {}) {
  const scopes = spec.scopes || {};
  const meta = {
    mode,
    fetchedAt: data.fetchedAt,
    totalMs: data.timings?.totalMs ?? null,
    host: data.host ?? spec.host,
    appIds: [...new Set(Object.values(scopes).map((s) => s.appId))],
    queryCount: Object.keys(data.datasets || {}).length,
    sourceSheetCount: new Set((spec.sections || []).map((s) => s.sheetId).filter(Boolean)).size,
    selections: Object.fromEntries(Object.entries(scopes).map(([id, s]) => [id, selectionsLabel(s.selections)])),
    sections: (spec.sections || []).map((s) => ({
      index: s.index, title: s.title ?? "", scope: s.scope, datasetIds: s.datasetIds || [],
      analysis: data.links?.[s.index]?.analysis ?? null, single: data.links?.[s.index]?.single ?? null,
    })),
    ...(data.columnMap ? { columnMap: data.columnMap } : {}),
  };
  return { meta, datasets: data.datasets || {} };
}

/** JSON safe inside a <script> element: every "<" becomes <, so no
 * "</script>" or "<!--" in the data can end or alter the element. */
export function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The slot a template carries inside a classic <script> for
 * `qrw bake --inline-runtime`. */
export const RUNTIME_SLOT = "/*__QRW_RUNTIME__*/";

/**
 * Inline the runtime source into the template's single RUNTIME_SLOT, so the
 * baked report is one self-contained file. Refuses a template without
 * exactly one slot, and a source that could end its script element.
 * @param {string} template @param {string} source qrw-runtime.js
 */
export function inlineRuntime(template, source) {
  const count = template.split(RUNTIME_SLOT).length - 1;
  if (count !== 1) throw new Error(`template must contain exactly one ${RUNTIME_SLOT} slot inside a <script> (found ${count})`);
  if (/<\/script/i.test(source)) throw new Error("runtime source contains a closing script tag; cannot inline it");
  return template.replace(RUNTIME_SLOT, () => source);
}

/**
 * Replace the template's single placeholder with the payload. The
 * replacement is a function, so "$&"-style patterns in the data stay inert.
 * Refuses a template without exactly one `__QRW_DATA__` (anywhere in the
 * file) or whose placeholder is not the whole content of the qrw-data script.
 * @param {string} template @param {any} payload
 */
export function embedPayload(template, payload) {
  const count = template.split(PLACEHOLDER).length - 1;
  if (count !== 1) throw new Error(`template must contain exactly one ${PLACEHOLDER} placeholder (found ${count})`);
  const blocks = [...template.matchAll(DATA_SCRIPT)];
  const holder = blocks.filter((m) => m[1].trim() === PLACEHOLDER);
  if (blocks.length !== 1 || holder.length !== 1 || !/type\s*=\s*["']application\/json["']/i.test(holder[0][0])) {
    throw new Error(`template needs one <script type="application/json" id="qrw-data">${PLACEHOLDER}</script>`);
  }
  return template.replace(PLACEHOLDER, () => scriptJson(payload));
}

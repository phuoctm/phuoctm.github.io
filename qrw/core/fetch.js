// Run a spec: one session per scope (app + selections) with the selections in
// the default state, the scopes in parallel; within a scope, selections first
// (strictly sequential), then every dataset through its own session
// hypercube, in parallel.
import { applySelections } from "./scopes.js";
import { sectionLinks } from "./links.js";
import { withSessionObject } from "./session-object.js";

/** The engine refuses a data page above 10 000 cells (qWidth * qHeight).
 * https://qlik.dev/apis/json-rpc/qix/genericobject/#gethypercubedata */
export const MAX_CELLS_PER_PAGE = 10000;

const strip = (item) => Object.fromEntries(Object.entries(item).filter(([k]) => k.startsWith("q")));

/** Sort indexes valid for a straight cube of `width` columns: a pivot's
 * pseudo-dimension (-1) and out-of-range indexes are dropped. */
export function normalizeSort(sort, width) {
  if (!Array.isArray(sort)) return null;
  const out = sort.filter((i) => Number.isInteger(i) && i >= 0 && i < width);
  return out.length ? [...new Set(out)] : null;
}

/** Session hypercube properties for a dataset: dimensions then measures,
 * straight-table mode, no qColumnOrder, default state. */
export function cubeProperties(ds) {
  const f = ds.flags || {};
  const sort = normalizeSort(ds.sort, ds.dimensions.length + ds.measures.length);
  return {
    qInfo: { qType: "qrw-dataset" },
    qHyperCubeDef: {
      qMode: "S",
      qDimensions: ds.dimensions.map(strip),
      qMeasures: ds.measures.map(strip),
      qSuppressZero: Boolean(f.suppressZero),
      qSuppressMissing: Boolean(f.suppressMissing),
      ...(f.calcCondition ? { qCalcCondition: f.calcCondition } : {}),
      ...(f.calcCond ? { qCalcCond: f.calcCond } : {}),
      ...(f.contextSetExpression ? { qContextSetExpression: f.contextSetExpression } : {}),
      ...(f.populateMissing ? { qPopulateMissing: true } : {}),
      ...(f.suppressMeasureTotals ? { qSuppressMeasureTotals: true } : {}),
      ...(f.dynamicScript?.length ? { qDynamicScript: f.dynamicScript } : {}),
      ...(sort ? { qInterColumnSortOrder: sort } : {}),
      qInitialDataFetch: [],
    },
  };
}

const cell = (c) => [c.qText ?? "", typeof c.qNum === "number" && Number.isFinite(c.qNum) ? c.qNum : null];

const exprOf = (x) => (typeof x === "string" ? x : x?.qv ?? "");

/** Evaluate an expression in the default state (evaluateEx; results come
 * either as { qValue } or as the value itself depending on the client). */
async function evaluate(doc, expr) {
  const r = await doc.evaluateEx(String(expr).replace(/^\s*=/, ""));
  return r?.qValue ?? r;
}

/**
 * The dataset's calculation condition, evaluated: null when it has none,
 * else { ok, message }. A condition is fulfilled when it evaluates to a
 * non-zero number. The message is the engine's own evaluation when the
 * layout carries it (qCalcCondMsg), else qMsg evaluated as a string
 * expression (https://qlik.dev/apis/json-rpc/qix/schemas/#stringexpr: an
 * expression, never literal text); an evaluation error gives null (the
 * report then shows its default text).
 */
export async function evaluateCalcCondition(doc, ds, cube = null) {
  const f = ds.flags || {};
  const cond = f.calcCondition ? exprOf(f.calcCondition.qCond) : f.calcCond ? exprOf(f.calcCond) : "";
  if (!cond) return null;
  const v = await evaluate(doc, cond);
  const ok = Boolean(v?.qIsNumeric) && Number.isFinite(v.qNumber) && v.qNumber !== 0;
  let message = null;
  const msg = f.calcCondition ? exprOf(f.calcCondition.qMsg) : "";
  if (!ok && typeof cube?.qCalcCondMsg === "string" && cube.qCalcCondMsg) message = cube.qCalcCondMsg;
  else if (!ok && msg.trim()) {
    try { message = (await evaluate(doc, msg))?.qText || null; } catch { message = null; }
  }
  return { ok, message };
}

/** qErrorCode of an unfulfilled calculation condition. */
const CALC_CONDITION_UNFULFILLED = 7005;

/** Every spec column with its engine info: `index` is its position in the
 * spec (dimensions then measures), `hidden` when the engine reports a qError
 * on its info (a measure whose column condition is false). */
function allColumns(cube, ds) {
  const dimInfo = cube?.qDimensionInfo?.length ? cube.qDimensionInfo : null;
  const msInfo = cube?.qMeasureInfo?.length ? cube.qMeasureInfo : null;
  const nd = ds.dimensions.length;
  return [
    ...ds.dimensions.map((d, i) => ({ info: dimInfo?.[i], spec: d, id: `d${i}`, kind: "dimension", index: i })),
    ...ds.measures.map((m, i) => ({ info: msInfo?.[i], spec: m, id: `m${i}`, kind: "measure", index: nd + i })),
  ].map((c) => ({ id: c.id, kind: c.kind, index: c.index, label: c.info?.qFallbackTitle ?? c.spec.label,
    format: c.info?.qNumFormat ?? null, hidden: Boolean(c.info?.qError) }));
}

const publicColumn = ({ hidden, ...c }) => c;

function columnsOf(cube, ds) {
  return allColumns(cube, ds).map(publicColumn);
}

/**
 * The columns the data matrix actually has: a measure with a false column
 * condition ("show column if") is DROPPED from the matrix and only flagged
 * by a qError on its qMeasureInfo entry, so labelling the matrix from every
 * info entry shifts the labels onto the wrong values. The shown columns must
 * account for exactly qSize.qcx, else the run fails.
 */
export function shownColumns(cube, ds) {
  const all = allColumns(cube, ds);
  const shown = all.filter((c) => !c.hidden);
  if (shown.length !== cube.qSize.qcx) {
    throw new Error(`dataset ${ds.id}: ${shown.length} shown column(s) but the engine returned ` +
      `${cube.qSize.qcx} (cannot label the data safely)`);
  }
  return { columns: shown.map(publicColumn), hidden: all.filter((c) => c.hidden).map((c) => c.label) };
}

/** Fetch one dataset on a doc whose selections are already applied. */
export function fetchDataset(doc, ds) {
  return withSessionObject(doc, cubeProperties(ds), async (obj) => {
    const layout = await obj.getLayout();
    const cube = layout.qHyperCube;
    if (cube.qError) {
      // An unfulfilled calculation condition is what Qlik's own client shows
      // as the condition message: not a run failure. Never refetch without it.
      // Only error 7005 can mean that; any other error fails the run.
      const cond = cube.qError.qErrorCode === CALC_CONDITION_UNFULFILLED ? await evaluateCalcCondition(doc, ds, cube) : null;
      if (cond && !cond.ok) {
        return { unavailable: { reason: "calcCondition", message: cond.message }, columns: columnsOf(cube, ds), rows: [] };
      }
      throw new Error(`dataset ${ds.id}: engine error ${JSON.stringify(cube.qError)}`);
    }
    const { columns, hidden } = shownColumns(cube, ds);
    const width = cube.qSize.qcx;
    const total = cube.qSize.qcy;
    const limit = ds.maxRows ? Math.min(ds.maxRows, total) : total;
    const pageHeight = Math.max(1, Math.floor(MAX_CELLS_PER_PAGE / Math.max(1, width)));
    const rows = [];
    for (let top = 0; top < limit; top += pageHeight) {
      const qHeight = Math.min(pageHeight, limit - top);
      const [page] = await obj.getHyperCubeData("/qHyperCubeDef", [{ qTop: top, qLeft: 0, qWidth: width, qHeight }]);
      // Never trust the request: a short, misplaced or narrower page (the
      // whole returned rectangle, qArea) is a gap.
      const got = page?.qMatrix?.length ?? 0;
      const a = page?.qArea;
      const areaOk = a && a.qTop === top && a.qLeft === 0 && a.qWidth === width && a.qHeight === qHeight;
      if (got !== qHeight || !areaOk || page.qMatrix.some((r) => r.length !== width)) {
        const area = a ? ` area ${JSON.stringify({ qTop: a.qTop, qLeft: a.qLeft, qWidth: a.qWidth, qHeight: a.qHeight })}` : " no area";
        throw new Error(`dataset ${ds.id}: page at row ${top} returned ${got} of ${qHeight} row(s),${area} ` +
          `(expected ${width} column(s) from column 0)`);
      }
      for (const r of page.qMatrix) rows.push(r.map(cell));
    }
    const out = { columns, rows, truncated: limit < total };
    if (hidden.length) out.hidden = hidden;
    if (cube.qGrandTotalRow?.length) out.totals = cube.qGrandTotalRow.map(cell);
    return out;
  });
}

const sectionPriority = (s, i) => (Number.isFinite(s.priority) && s.priority >= 1 ? s.priority : i + 1);

/**
 * Each dataset's priority (1 = first view): the best priority of the
 * sections that use it, a section's priority being its `priority` or else
 * its position (1-based). With no sections every dataset is priority 1; a
 * dataset no section uses comes after every section. `override` (a report's
 * QRW.priority) lists dataset ids, or arrays of ids, first view first: entry
 * k gets priority k + 1 and unlisted datasets follow in their spec-derived
 * order. Original (pre-merge) ids resolve through spec.columnMap.
 * @param {any} spec @param {(string|string[])[]|null} [override]
 * @returns {Map<string, number>}
 */
export function datasetPriorities(spec, override = null) {
  const sections = spec.sections || [];
  const last = sections.length ? Math.max(...sections.map(sectionPriority)) + 1 : 1;
  const out = new Map(spec.datasets.map((ds) => [ds.id, last]));
  sections.forEach((s, i) => {
    for (const id of s.datasetIds || []) if (out.has(id)) out.set(id, Math.min(out.get(id), sectionPriority(s, i)));
  });
  if (Array.isArray(override) && override.length) {
    const resolve = (id) => (spec.columnMap && Object.hasOwn(spec.columnMap, id) ? spec.columnMap[id].dataset : id);
    const listed = new Map();
    override.forEach((entry, k) => {
      for (const id of [entry].flat()) if (out.has(resolve(id)) && !listed.has(resolve(id))) listed.set(resolve(id), k + 1);
    });
    for (const [id, p] of out) out.set(id, listed.get(id) ?? override.length + p);
  }
  return out;
}

/**
 * Run a spec, first view first. Every scope's session opens at once (opening
 * does not compete for calculation). The first view (every dataset of the
 * best priority present) is requested on its scope's session as soon as the
 * scope is selected, and later datasets follow at once on the same session,
 * best priority first (default: `firstWaveTimeoutMs` 0, `maxConcurrent`
 * Infinity, no hold: measured fastest, as the time goes into opening
 * sessions). Waves are an option for engines where calculation is the
 * bottleneck: with `firstWaveTimeoutMs` > 0 later datasets start when the
 * first wave has arrived or that long after the start, with at most
 * `maxConcurrent` fetches in flight, and a scope that serves only later
 * datasets applies its selections when they are released.
 * `onScopeReady(id, echo)` and `onDataset(id, dataset)` report progress; the
 * result is the same whatever the order. Any dataset error rejects the whole
 * run (a partial result is a failure; no fetch is still in flight when it
 * rejects) and engine socket errors propagate untouched.
 * @param {any} spec
 * @param {(appId: string, scopeId: string) => Promise<any>} getDoc one Doc
 *   per scope: its own session with its own identity
 * @param {{now?: () => number, onDataset?: (id: string, dataset: any) => void,
 *   onScopeReady?: (id: string, echo: any) => void, priority?: (string|string[])[]|null,
 *   firstWaveTimeoutMs?: number, maxConcurrent?: number}} [opts]
 */
export async function fetchSpec(spec, getDoc, { now = () => performance.now(), onDataset, onScopeReady,
  priority = null, firstWaveTimeoutMs = 0, maxConcurrent = Infinity } = {}) {
  const t0 = now();
  for (const ds of spec.datasets) {
    if (!spec.scopes[ds.scope]) throw new Error(`dataset ${ds.id} names unknown scope ${ds.scope}`);
  }
  const scopes = {};
  const datasets = {};
  const timings = { connectMs: 0, scopesMs: 0, scopes: {}, datasets: {}, firstWaveMs: 0, totalMs: 0 };
  const prio = datasetPriorities(spec, priority);
  const best = Math.min(...prio.values());
  const firstWave = spec.datasets.filter((ds) => prio.get(ds.id) === best);
  // Stable sort: equal priorities keep spec order.
  const queue = spec.datasets.filter((ds) => prio.get(ds.id) !== best).sort((a, b) => prio.get(a.id) - prio.get(b.id));
  const firstScopes = new Set(firstWave.map((ds) => ds.scope));
  const docs = new Map();
  /** @type {Promise<void>[]} */
  const tasks = [];
  let failure = null;
  let inFlight = 0;
  let waveLeft = firstWave.length;
  let released = false;
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const fail = (e) => { if (!failure) failure = { e }; release(); };
  const start = (fn) => { tasks.push(fn().catch(fail)); };
  const openGate = () => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    release();
    pump();
  };
  const runDataset = async (ds) => {
    inFlight++;
    try {
      const s = now();
      const d = await fetchDataset(docs.get(ds.scope), ds);
      datasets[ds.id] = d;
      timings.datasets[ds.id] = now() - s;
      onDataset?.(ds.id, d);
      if (prio.get(ds.id) === best && --waveLeft === 0) {
        timings.firstWaveMs = now() - t0;
        openGate();
      }
    } finally {
      inFlight--;
    }
    pump();
  };
  function pump() {
    if (!released || failure) return;
    for (let i = 0; i < queue.length && inFlight < maxConcurrent;) {
      const ds = queue[i];
      if (!docs.has(ds.scope)) { i++; continue; }
      queue.splice(i, 1);
      start(() => runDataset(ds));
    }
  }
  const hold = firstWaveTimeoutMs > 0 && queue.length && firstWave.length;
  const timer = hold ? setTimeout(openGate, firstWaveTimeoutMs) : null;
  if (!hold) openGate();
  try {
    for (const [id, scope] of Object.entries(spec.scopes)) {
      start(async () => {
        const s0 = now();
        const doc = await getDoc(scope.appId, id);
        const connectMs = now() - s0;
        if (!firstScopes.has(id)) await gate;
        if (failure) return;
        const s1 = now();
        const echo = await applySelections(doc, scope.selections);
        const selectMs = now() - s1;
        scopes[id] = { appId: scope.appId, selected: echo.selected, retriedAsText: echo.retriedAsText,
          ...(Object.keys(echo.defaults).length ? { defaults: echo.defaults } : {}) };
        timings.scopes[id] = { connectMs, selectMs };
        timings.connectMs = Math.max(timings.connectMs, connectMs);
        timings.scopesMs = Math.max(timings.scopesMs, selectMs);
        docs.set(id, doc);
        onScopeReady?.(id, scopes[id]);
        if (failure) return;
        for (const ds of firstWave) if (ds.scope === id) start(() => runDataset(ds));
        pump();
      });
    }
    // Tasks start further tasks: wait until no new one appeared.
    for (let n = -1; n !== tasks.length;) {
      n = tasks.length;
      await Promise.all(tasks);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (failure) throw failure.e;
  const missing = spec.datasets.filter((ds) => !Object.hasOwn(datasets, ds.id));
  if (missing.length) throw new Error(`internal: dataset(s) never fetched: ${missing.map((ds) => ds.id).join(", ")}`);
  timings.totalMs = now() - t0;
  // Links built from the representation that actually matched (scope echo).
  const links = {};
  for (const section of spec.sections || []) {
    const scope = spec.scopes[section.scope];
    if (!scope || !section.sheetId) continue;
    links[section.index] = sectionLinks(spec.host, { appId: scope.appId, sheetId: section.sheetId, selections: scope.selections },
      scopes[section.scope]?.retriedAsText || []);
  }
  const out = { fetchedAt: new Date().toISOString(), host: spec.host, scopes, datasets, links, timings };
  if (spec.columnMap) out.columnMap = resolveColumnMap(spec.columnMap, datasets);
  return out;
}

/**
 * The optimised spec's columnMap translated to positions in the FETCHED
 * datasets: spec column indexes become data column positions, and a column
 * the engine hid (column condition false) is dropped and listed in `hidden`
 * (the source chart does not show it either).
 * @param {Record<string, {dataset: string, columns: number[]}>} columnMap
 * @param {Record<string, any>} datasets
 */
export function resolveColumnMap(columnMap, datasets) {
  const out = {};
  for (const [id, { dataset, columns }] of Object.entries(columnMap)) {
    const ds = datasets[dataset] || { columns: [] };
    const pos = new Map(ds.columns.map((c, i) => [c.index, i]));
    // Hidden spec indexes, ascending, pair one to one with ds.hidden labels.
    const hiddenIdx = [...Array(ds.columns.length + (ds.hidden?.length ?? 0)).keys()].filter((i) => !pos.has(i));
    const entry = { dataset, columns: columns.filter((i) => pos.has(i)).map((i) => pos.get(i)) };
    const hidden = columns.filter((i) => !pos.has(i)).map((i) => ds.hidden?.[hiddenIdx.indexOf(i)] ?? `column ${i}`);
    if (hidden.length) entry.hidden = hidden;
    out[id] = entry;
  }
  return out;
}

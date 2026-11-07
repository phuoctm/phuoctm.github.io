// The report data spec (docs/spec-format.md): draft one dataset per data
// object, then optimise by merging compatible datasets.
import { sectionLinks } from "./links.js";
import { normalizeSort } from "./fetch.js";

/** Dimension/measure label from the source or its master item. */
function labelOf(item, master, kind) {
  if (item.qLibraryId) return master?.[item.qLibraryId]?.label || item.qLibraryId;
  if (kind === "dimension") return item.qDef?.qFieldLabels?.[0] || item.qDef?.qFieldDefs?.[0] || "";
  return item.qDef?.qLabel || item.qDef?.qDef || "";
}

/** Cube-level flags that change the row set; datasets merge only when equal. */
function cubeFlags(cube) {
  return {
    suppressZero: Boolean(cube.qSuppressZero),
    suppressMissing: Boolean(cube.qSuppressMissing),
    calcCondition: cube.qCalcCondition ?? null, // NxCalcCond
    calcCond: cube.qCalcCond ?? null, // older ValueExpr form
    contextSetExpression: cube.qContextSetExpression ?? null,
    populateMissing: Boolean(cube.qPopulateMissing),
    suppressMeasureTotals: Boolean(cube.qSuppressMeasureTotals),
    dynamicScript: cube.qDynamicScript?.length ? cube.qDynamicScript : null,
  };
}

/** @param {any} inventory output of buildInventory */
export function draftSpec(inventory) {
  const scopes = {};
  const scopeIdByKey = new Map();
  const datasets = [];
  const sections = [];
  for (const section of inventory.sections) {
    let scopeId = scopeIdByKey.get(section.scopeKey);
    if (!scopeId) {
      scopeId = `s${scopeIdByKey.size + 1}`;
      scopeIdByKey.set(section.scopeKey, scopeId);
      scopes[scopeId] = { appId: section.appId, selections: section.selections };
    }
    const app = inventory.apps[section.appId];
    const datasetIds = [];
    const objectIds = [];
    for (const objectId of section.objectIds) {
      const obj = app.objects[objectId];
      const cube = obj?.hyperCube;
      if (!cube || (!cube.qDimensions.length && !cube.qMeasures.length)) continue;
      if (cube.unsupported?.length) {
        throw new Error(`object ${objectId}: unsupported hypercube propert${cube.unsupported.length > 1 ? "ies" : "y"} ` +
          `${cube.unsupported.join(", ")}; the workbench cannot reproduce its data faithfully`);
      }
      const id = `d${section.index}_${objectId}`.replace(/[^A-Za-z0-9_-]/g, "_");
      const sort = normalizeSort(cube.qInterColumnSortOrder, cube.qDimensions.length + cube.qMeasures.length);
      datasets.push({
        id, scope: scopeId,
        dimensions: cube.qDimensions.map((d) => ({ ...d, label: labelOf(d, app.masterItems.dimensions, "dimension") })),
        // A master measure's expression is recorded (non-q key: never sent to
        // the engine) so `optimize` can check it for chart-relative functions.
        measures: cube.qMeasures.map((m) => ({ ...m, label: labelOf(m, app.masterItems.measures, "measure"),
          ...(m.qLibraryId ? { masterExpression: app.masterItems.measures[m.qLibraryId]?.expression ?? null } : {}) })),
        flags: cubeFlags(cube),
        ...(sort ? { sort } : {}),
        source: { appId: section.appId, sheetId: section.sheetId, sectionIndex: section.index,
          objectIds: [objectId], type: obj.type, ...(obj.pivot ? { pivot: true } : {}) },
      });
      datasetIds.push(id);
      objectIds.push(objectId);
    }
    sections.push({
      index: section.index, title: section.title, subtitle: section.subtitle,
      sheetId: section.sheetId, scope: scopeId, datasetIds, objectIds,
      link: sectionLinks(inventory.host, section),
    });
  }
  return { version: 1, host: inventory.host, scopes, datasets, sections };
}

/** Presentation-only keys (at any depth) that never change the data:
 * client column ids, auto-sort and colouring/series styling. `label` is the
 * report's own display label. Everything else, `q*` keys included at every
 * depth (qFieldDefs, qNumFormat, qAttributeExpressions...), is compared. */
const PRESENTATION_KEYS = new Set(["label", "cId", "autoSort", "color", "coloring", "series", "representation"]);

/** Canonical form: presentation keys dropped recursively, keys sorted. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) if (!PRESENTATION_KEYS.has(k)) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

/** Definition of a column without presentation keys, for equality checks. */
const defKey = (item) => JSON.stringify(canonical(item));

/** The sort order as the column DEFINITIONS it sorts by (indexes differ
 * between datasets with different measure lists). */
function sortKey(ds) {
  if (!ds.sort?.length) return null;
  const cols = [...ds.dimensions, ...ds.measures];
  return ds.sort.map((i) => defKey(cols[i]));
}

/** Functions whose result depends on the chart's other columns or rows: a
 * merged cube changes what they refer to (Column(1) would point at another
 * chart's measure). */
const CHART_RELATIVE = /\b(Column|Above|Below|Before|After|Top|Bottom|RowNo|NoOfRows)\s*\(/i;

/** Every string inside a value (expressions at any depth). */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

/**
 * Why a dataset must stay alone, or null when it may merge: a measure (or
 * its resolved master measure) uses a chart-relative function, a master
 * measure is unresolved, a dimension has a limit (ranked by the first
 * measure), or zero suppression is on (it depends on all measures).
 */
export function mergeBlocker(ds) {
  if (ds.flags?.suppressZero) return "suppress-zero";
  if (ds.dimensions.some((d) => (d.qOtherTotalSpec?.qOtherMode ?? "OTHER_OFF") !== "OTHER_OFF")) return "dimension limit";
  for (const m of ds.measures) {
    if (m.qLibraryId && typeof m.masterExpression !== "string") return `unresolved master measure ${m.qLibraryId}`;
    const { label, ...defs } = m;
    if (strings(defs).some((s) => CHART_RELATIVE.test(s))) return "chart-relative function";
  }
  return null;
}

/**
 * Merge datasets with the same app, scope, identical dimension list,
 * identical cube-level flags, identical sort order (as column definitions)
 * and identical maxRows into one dataset with the union of measures, and
 * only when none of them has a mergeBlocker().
 * `columnMap[originalId] = { dataset, columns }` keeps each original
 * dataset addressable (column indexes into the merged dataset, dimensions
 * first then measures). Never merges across scopes, differing dimensions,
 * sorts (inter-record functions such as Above() depend on it) or limits.
 */
export function optimize(spec) {
  const groups = new Map();
  for (const ds of spec.datasets) {
    const key = mergeBlocker(ds) ? JSON.stringify(["alone", ds.id]) : JSON.stringify([spec.scopes[ds.scope].appId, ds.scope,
      ds.dimensions.map(defKey), canonical(ds.flags), sortKey(ds), ds.maxRows ?? null]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ds);
  }
  const datasets = [];
  const columnMap = {};
  const renamed = new Map();
  let n = 0;
  for (const group of groups.values()) {
    if (group.length === 1) {
      const ds = group[0];
      datasets.push(ds);
      renamed.set(ds.id, ds.id);
      columnMap[ds.id] = { dataset: ds.id, columns: [...Array(ds.dimensions.length + ds.measures.length).keys()] };
      continue;
    }
    const first = group[0];
    const merged = { ...first, id: `m${++n}`, measures: [], source: { ...first.source, objectIds: [], datasetIds: [] } };
    const measureIndex = new Map();
    const nd = first.dimensions.length;
    for (const ds of group) {
      const cols = [...Array(nd).keys()];
      for (const m of ds.measures) {
        const k = defKey(m);
        if (!measureIndex.has(k)) { measureIndex.set(k, merged.measures.length); merged.measures.push(m); }
        cols.push(nd + measureIndex.get(k));
      }
      columnMap[ds.id] = { dataset: merged.id, columns: cols };
      merged.source.objectIds.push(...ds.source.objectIds);
      merged.source.datasetIds.push(ds.id);
      renamed.set(ds.id, merged.id);
    }
    // The first dataset's sort indexes refer to its own measures; remap them.
    if (first.sort) merged.sort = first.sort.map((i) => columnMap[first.id].columns[i]);
    datasets.push(merged);
  }
  const sections = spec.sections.map((s) => ({
    ...s, sourceDatasetIds: s.datasetIds, datasetIds: [...new Set(s.datasetIds.map((id) => renamed.get(id)))],
  }));
  return { ...spec, optimized: true, datasets, sections, columnMap };
}

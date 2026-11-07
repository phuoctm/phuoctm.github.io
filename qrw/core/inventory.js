// Inventory the source sheets: sheet layout, every object on it (recursing
// into containers), hypercube definitions and the master items they use.
//
// Gotcha: a chart's data columns follow qColumnOrder, not "dimensions then
// measures". The inventory records DEFINITIONS only; the fetcher builds its
// own cubes (no qColumnOrder), so column order is what the spec defines.

const CONTAINER_TYPES = new Set(["container", "sn-layout-container", "sn-tabbed-container"]);

/** Keys of a dimension/measure definition worth keeping. */
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

const DIM_KEYS = ["qLibraryId", "qDef", "qNullSuppression", "qOtherTotalSpec", "qShowAll",
  "qIncludeElemValue", "qCalcCondition", "qCalcCond", "qAttributeExpressions", "qAttributeDimensions"];
const MEASURE_KEYS = ["qLibraryId", "qDef", "qSortBy", "qCalcCondition", "qCalcCond",
  "qAttributeExpressions", "qAttributeDimensions"];
const CUBE_KEYS = ["qMode", "qSuppressZero", "qSuppressMissing", "qCalcCondition", "qCalcCond",
  "qInterColumnSortOrder", "qColumnOrder", "qContextSetExpression", "qPopulateMissing",
  "qSuppressMeasureTotals", "qDynamicScript"];
/** Cube keys that only shape presentation or paging, never the row set. */
const PRESENTATION_CUBE_KEYS = new Set(["qInitialDataFetch", "qStateName", "qTitle", "qNoOfLeftDims",
  "qAlwaysFullyExpanded", "qIndentMode", "qShowTotalsAbove", "qMaxStackedCells", "qExpansionState",
  "qPseudoDimPos", "qSortbyYValue", "qReductionMode", "qLayoutExclude", "qColumnWidths"]);

/** Copy of a hypercube definition with only the data-relevant parts; any
 * other `q*` key is listed in `unsupported` (draftSpec refuses it). */
export function cubeDefinition(def) {
  const unsupported = Object.keys(def).filter((k) => k.startsWith("q") && k !== "qDimensions" && k !== "qMeasures" &&
    !CUBE_KEYS.includes(k) && !PRESENTATION_CUBE_KEYS.has(k));
  if (def.qMode && !["S", "P", "K"].includes(def.qMode)) unsupported.push(`qMode=${def.qMode}`);
  // A chart in its own alternate state cannot be reproduced in the default state.
  if (def.qStateName && def.qStateName !== "$") unsupported.push(`qStateName=${def.qStateName}`);
  return {
    ...pick(def, CUBE_KEYS),
    ...(unsupported.length ? { unsupported } : {}),
    qDimensions: (def.qDimensions || []).map((d) => pick(d, DIM_KEYS)),
    qMeasures: (def.qMeasures || []).map((m) => pick(m, MEASURE_KEYS)),
  };
}

/**
 * Read one object and (recursively) its children.
 * @param {any} doc @param {string} id @param {Map<string, any>} out
 * @param {{dimensions: Record<string, any>, measures: Record<string, any>}} master
 */
async function readObject(doc, id, out, master, parentId = null) {
  if (out.has(id)) return;
  const obj = await doc.getObject(id);
  // Effective properties include those inherited through qExtendsId (master
  // visualizations): https://qlik.dev/apis/json-rpc/qix/genericobject/#geteffectiveproperties
  const [layout, props] = await Promise.all([obj.getLayout(), obj.getEffectiveProperties()]);
  const type = layout.visualization || props.visualization || layout.qInfo?.qType || props.qInfo?.qType;
  /** @type {any} */
  const rec = {
    id, type, parentId,
    title: layout.title ?? "", subtitle: layout.subtitle ?? "", footnote: layout.footnote ?? "",
  };
  if (props.qHyperCubeDef) {
    rec.hyperCube = cubeDefinition(props.qHyperCubeDef);
    if (type === "pivot-table" || props.qHyperCubeDef.qMode === "P" || props.qHyperCubeDef.qMode === "K") {
      rec.pivot = true; // fetched as a straight table (qMode "S")
    }
    for (const d of rec.hyperCube.qDimensions) if (d.qLibraryId) master.dimensions[d.qLibraryId] ??= null;
    for (const m of rec.hyperCube.qMeasures) if (m.qLibraryId) master.measures[m.qLibraryId] ??= null;
  }
  if (typeof layout.markdown === "string") rec.text = layout.markdown;
  out.set(id, rec);
  const children = await childIds(obj, layout, props, type);
  if (children.length) {
    rec.children = children;
    for (const c of children) await readObject(doc, c, out, master, id);
  }
}

/**
 * Object ids a container shows, deduplicated in order of appearance, from
 * every place they can be referenced: `properties.cells[].name` (layout
 * containers), `properties.children[].refId` (containers), the layout child
 * list and the engine's child generic objects
 * (https://qlik.dev/apis/json-rpc/qix/genericobject/#getchildinfos).
 */
async function childIds(obj, layout, props, type) {
  const ids = [];
  for (const c of props.cells || []) if (c?.name) ids.push(c.name);
  for (const c of props.children || []) if (c?.refId) ids.push(c.refId);
  for (const c of layout.qChildList?.qItems || []) if (c?.qInfo?.qId) ids.push(c.qInfo.qId);
  if ((CONTAINER_TYPES.has(type) || layout.qChildList) && typeof obj.getChildInfos === "function") {
    for (const c of await obj.getChildInfos()) if (c?.qId) ids.push(c.qId);
  }
  return [...new Set(ids)];
}

/** Fill the master item map: label and expression per library id. */
async function readMasterItems(doc, master) {
  for (const id of Object.keys(master.dimensions)) {
    const p = await (await doc.getDimension(id)).getProperties();
    master.dimensions[id] = {
      label: p.qMetaDef?.title ?? "", fieldDefs: p.qDim?.qFieldDefs ?? [],
      fieldLabels: p.qDim?.qFieldLabels ?? [], labelExpression: p.qDim?.qLabelExpression ?? "",
    };
  }
  for (const id of Object.keys(master.measures)) {
    const p = await (await doc.getMeasure(id)).getProperties();
    master.measures[id] = {
      label: p.qMeasure?.qLabel || p.qMetaDef?.title || "", expression: p.qMeasure?.qDef ?? "",
      numFormat: p.qMeasure?.qNumFormat ?? null, labelExpression: p.qMeasure?.qLabelExpression ?? "",
    };
  }
}

/** Read the sheet: title and cell grid (col/row/colspan/rowspan or bounds). */
async function readSheet(doc, sheetId) {
  const sheet = await doc.getObject(sheetId);
  const [layout, props] = await Promise.all([sheet.getLayout(), sheet.getProperties()]);
  const cells = (props.cells || layout.cells || []).map((c) =>
    pick(c, ["name", "type", "col", "row", "colspan", "rowspan", "bounds"]));
  return { title: layout.qMeta?.title ?? layout.title ?? props.qMetaDef?.title ?? "", cells };
}

/**
 * Build the inventory for a page config.
 * @param {(appId: string) => Promise<any>} getDoc one Doc per app
 * @param {import("./page-config.js").PageConfig} pageConfig
 */
export async function buildInventory(getDoc, pageConfig) {
  /** @type {Record<string, {sheets: Record<string, any>, objects: Record<string, any>, masterItems: any}>} */
  const apps = {};
  const sections = [];
  for (const section of pageConfig.sections) {
    const doc = await getDoc(section.appId);
    const app = (apps[section.appId] ??= { sheets: {}, objects: {}, masterItems: { dimensions: {}, measures: {} } });
    if (!app.sheets[section.sheetId]) {
      const sheet = await readSheet(doc, section.sheetId);
      const objects = new Map();
      for (const cell of sheet.cells) await readObject(doc, cell.name, objects, app.masterItems);
      sheet.objectIds = [...objects.keys()];
      for (const [id, rec] of objects) app.objects[id] = rec;
      app.sheets[section.sheetId] = sheet;
    }
    sections.push({ ...section, objectIds: app.sheets[section.sheetId].objectIds });
  }
  for (const appId of Object.keys(apps)) await readMasterItems(await getDoc(appId), apps[appId].masterItems);
  return { version: 1, host: pageConfig.host, sections, apps };
}

// Apply a scope's selections in the DEFAULT state "$" of the scope's own
// session and verify them.
//
// Why no alternate states: calculated variables ("$(vX)" whose definition
// starts with "=") are evaluated in the default state, not in the object's
// alternate state, so a chart in an alternate state can return plausible but
// wrong figures. One session per scope with default-state selections matches
// what the source sheet shows (docs/spec-format.md).
//
// Selection calls on one session must be strictly sequential: overlapping
// ones fail with error 15 "Request aborted. (Exclusive request aborted
// family requests)". Every selection call goes through `exclusive(doc)`.
import { isNumericValue } from "./page-config.js";
import { withSessionObject } from "./session-object.js";

/** FieldValue list for Field.selectValues. byText forces text matching. */
export function toFieldValues(values, byText = false) {
  return values.map((v) =>
    !byText && isNumericValue(v)
      ? { qText: String(v), qIsNumeric: true, qNumber: Number(v) }
      : { qText: String(v), qIsNumeric: false });
}

/** @type {WeakMap<object, Promise<any>>} */
const queues = new WeakMap();

/** Run `fn` after every earlier selection task on the same doc has settled. */
export function exclusive(doc, fn) {
  const prev = queues.get(doc) || Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(doc, run.catch(() => {}));
  return run;
}

/**
 * Read the current default-state selections through a session selection
 * object (qSelectionObjectDef, the CurrentSelections pattern;
 * https://qlik.dev/apis/json-rpc/qix/schemas/#SelectionObjectDef).
 * @returns {Promise<Record<string, {count: number, values: string[]}>>}
 */
export function readSelections(doc) {
  return withSessionObject(doc, {
    qInfo: { qType: "qrw-current-selections" },
    qSelectionObjectDef: {},
  }, async (obj) => {
    const layout = await obj.getLayout();
    /** @type {Record<string, {count: number, values: string[], locked?: boolean, oneAndOnlyOne?: boolean}>} */
    const out = {};
    for (const s of layout.qSelectionObject?.qSelections || []) {
      let values = (s.qSelectedFieldSelectionInfo || []).map((i) => i.qName);
      // The value list can stop short of the count (selection threshold):
      // read the complete set from the field itself.
      if (values.length < s.qSelectedCount) values = (await selectedCells(doc, s.qField, s.qSelectedCount)).map((c) => c.qText);
      out[s.qField] = {
        count: s.qSelectedCount, values,
        ...(s.qLocked ? { locked: true } : {}), ...(s.qOneAndOnlyOne ? { oneAndOnlyOne: true } : {}),
      };
    }
    return out;
  });
}

/** Selected states of a list object cell (selected, locked, and both while
 * excluded by another field). */
const SELECTED_STATES = new Set(["S", "L", "XS", "XL"]);
const PAGE_ROWS = 5000;

/**
 * The selected values of a field as structured cells {qText, qNum}: a
 * session list object sorted by state (selected first), paged until `count`
 * selected values are read. Never parses a display string, so any value
 * text (separators included) survives.
 * https://qlik.dev/apis/json-rpc/qix/genericobject/#getlistobjectdata
 */
export function selectedCells(doc, field, count) {
  return withSessionObject(doc, {
    qInfo: { qType: "qrw-field-selected" },
    qListObjectDef: { qDef: { qFieldDefs: [field], qSortCriterias: [{ qSortByState: 1 }] }, qInitialDataFetch: [] },
  }, async (obj) => {
    const layout = await obj.getLayout();
    const total = layout.qListObject?.qSize?.qcy ?? 0;
    /** @type {{qText: string, qNum: number|null}[]} */
    const out = [];
    for (let top = 0; top < total && out.length < count; top += PAGE_ROWS) {
      const [page] = await obj.getListObjectData("/qListObjectDef", [{ qTop: top, qLeft: 0, qWidth: 1, qHeight: PAGE_ROWS }]);
      const rows = page?.qMatrix || [];
      for (const [c] of rows) {
        if (c && SELECTED_STATES.has(c.qState)) out.push({ qText: c.qText ?? "", qNum: typeof c.qNum === "number" ? c.qNum : null });
      }
      if (!rows.length) break;
    }
    return out;
  });
}

const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

/** A selectValues result that reports a rejected selection. */
const rejected = (r) => r === false || r?.qReturn === false;

/** A selected cell is the requested value: same text, or same number for a
 * numeric request (duals such as a quarter "Q3" with the number 3). */
const isValue = (cell, v) => cell.qText === String(v) || (isNumericValue(v) && cell.qNum === Number(v));

/**
 * Unlock and clear the default state, select every field and verify. A
 * numeric match that selects nothing (dual fields such as a quarter shown as
 * "Q3") is retried by text. The values each select produced are recorded;
 * after the last field the COMPLETE selected value set of every requested
 * field must still be exactly that set (a later select can clear or replace
 * an earlier one), and no other field may carry a selection, except fields
 * with "always one selected value" (the engine reselects them after a
 * clear): those are echoed as `defaults`. Any mismatch throws, naming field
 * and values: never fetch unfiltered or differently filtered data.
 * @param {any} doc QIX Doc of this scope's own session
 * @param {{field: string, values: (string|number)[]}[]} selections
 */
export function applySelections(doc, selections) {
  return exclusive(doc, async () => {
    // clearAll(lockedAlso = true) clears locked selections too; this session
    // is ours alone. https://qlik.dev/apis/json-rpc/qix/doc/#clearall
    await doc.clearAll(true);
    const retried = [];
    /** @type {Map<string, Set<string>>} */
    const produced = new Map();
    const expectedCount = (sel) => new Set(sel.values.map(String)).size;
    const fail = (sel, got, when) => new Error(`selection failed${when}: field "${sel.field}" values ` +
      `${JSON.stringify(sel.values)} selected ${got} of ${expectedCount(sel)} expected value(s)`);
    for (const sel of selections) {
      const field = await doc.getField(sel.field);
      const expected = expectedCount(sel);
      let ok = !rejected(await field.selectValues(toFieldValues(sel.values), false, false));
      let now = (await readSelections(doc))[sel.field];
      if ((!ok || (now?.count ?? 0) !== expected) && sel.values.some(isNumericValue)) {
        await field.clear();
        ok = !rejected(await field.selectValues(toFieldValues(sel.values, true), false, false));
        now = (await readSelections(doc))[sel.field];
        if (ok && (now?.count ?? 0) === expected) retried.push(sel.field);
      }
      // A rejected select (e.g. on an "always one selected value" field) can
      // leave the old value selected with the right count: never accept it.
      if (!ok) throw new Error(`selection failed: the engine rejected field "${sel.field}" values ${JSON.stringify(sel.values)}`);
      if ((now?.count ?? 0) !== expected) throw fail(sel, now?.count ?? 0, "");
      produced.set(sel.field, new Set(now.values));
    }
    const selected = await readSelections(doc);
    for (const sel of selections) {
      const got = selected[sel.field];
      if ((got?.count ?? 0) !== expectedCount(sel)) throw fail(sel, got?.count ?? 0, " (lost after later selections)");
      if (!sameSet(new Set(got.values), /** @type {Set<string>} */ (produced.get(sel.field)))) {
        throw new Error(`selection failed (changed after later selections): field "${sel.field}" values ` +
          `${JSON.stringify(sel.values)} now selects ${JSON.stringify(got.values)}`);
      }
      // The right number of values is not enough: each requested value must
      // be one of the selected ones (by text, or by number when numeric).
      const cells = await selectedCells(doc, sel.field, got.count);
      const missing = [...new Set(sel.values.map(String))].filter((v) => !cells.some((c) => isValue(c, v)));
      if (missing.length) {
        throw new Error(`selection failed (other values selected): field "${sel.field}" values ` +
          `${JSON.stringify(sel.values)} selects ${JSON.stringify(cells.map((c) => c.qText))}`);
      }
    }
    const requested = new Set(selections.map((s) => s.field));
    /** @type {Record<string, string[]>} */
    const defaults = {};
    for (const [f, s] of Object.entries(selected)) {
      if (requested.has(f)) continue;
      if (s.oneAndOnlyOne) { defaults[f] = s.values; continue; }
      throw new Error(`selection failed: field "${f}" is selected (${JSON.stringify(s.values)}${s.locked ? ", locked" : ""}) ` +
        "but the scope does not request it");
    }
    return { selected, defaults, retriedAsText: retried };
  });
}

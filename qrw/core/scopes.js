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
      // read the complete set (GetFieldSelections, max values = the count).
      if (values.length < s.qSelectedCount) values = await allSelectedValues(doc, s.qField, s.qSelectedCount);
      out[s.qField] = {
        count: s.qSelectedCount, values,
        ...(s.qLocked ? { locked: true } : {}), ...(s.qOneAndOnlyOne ? { oneAndOnlyOne: true } : {}),
      };
    }
    return out;
  });
}

const SEP = "\u0001";

/** Every selected value of a field as text, through GetFieldSelections. */
async function allSelectedValues(doc, field, count) {
  const name = `[${String(field).replace(/]/g, "]]")}]`;
  const r = await doc.evaluateEx(`GetFieldSelections(${name}, chr(1), ${count})`);
  const text = String((r?.qValue ?? r)?.qText ?? "");
  return text ? text.split(SEP) : [];
}

const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

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
      await field.selectValues(toFieldValues(sel.values), false, false);
      let now = (await readSelections(doc))[sel.field];
      if ((now?.count ?? 0) !== expected && sel.values.some(isNumericValue)) {
        await field.clear();
        await field.selectValues(toFieldValues(sel.values, true), false, false);
        now = (await readSelections(doc))[sel.field];
        if ((now?.count ?? 0) === expected) retried.push(sel.field);
      }
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

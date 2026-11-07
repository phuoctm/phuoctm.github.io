// "Analyse in Qlik" links back to the source sheet with the section's
// selections applied.
//
// App Integration API:
//   <base>/sense/app/{appid}/sheet/{sheetid}/state/analysis/
//   options/clearselections                 (options are applied first)
//   select/{field}/{value1;value2}          multiple values: semicolon separated
//   numeric values as numbers (/2), text values in square brackets (/[Feb])
//   select/{f1}/{...}/select/{f2}/{...}     several fields: chained segments
// https://help.qlik.com/en-US/sense-developer/May2026/Subsystems/Mashups/Content/Sense_Mashups/AppIntegrationAPI/app-integration.htm
// Single Integration API: /single/?appid=&sheet=&opt=&select=clearall&select=Field,v1,v2
// https://help.qlik.com/en-US/sense-developer/May2026/Subsystems/APIs/Content/Sense_ClientAPIs/single-integration-api.htm
// Each field and text value is encodeURIComponent-encoded and text values are
// bracketed so ";" or "/" inside a value cannot break the segment.
import { isNumericValue } from "./page-config.js";

const enc = (s) => encodeURIComponent(String(s));

/** A value in the representation that matched: numeric unless the field was
 * matched by text (dual fields, `textFields` from the scope echo). */
function linkValue(field, v, textFields) {
  return isNumericValue(v) && !textFields.includes(field) ? String(Number(v)) : `[${enc(v)}]`;
}

/** Full-client sheet URL with selections (App Integration API). */
export function sheetLink(host, appId, sheetId, selections = [], textFields = []) {
  let url = `https://${host}/sense/app/${enc(appId)}/sheet/${enc(sheetId)}/state/analysis/options/clearselections`;
  for (const s of selections) {
    url += `/select/${enc(s.field)}/${s.values.map((v) => linkValue(s.field, v, textFields)).join(";")}`;
  }
  return url;
}

/** Single Integration API form; select=clearall first so unrelated
 * selections do not persist, then one select parameter per field. */
export function singleLink(host, appId, sheetId, selections = [], opt = "ctxmenu,currsel") {
  const q = new URLSearchParams({ appid: appId, sheet: sheetId, opt });
  q.append("select", "clearall");
  for (const s of selections) q.append("select", [s.field, ...s.values].join(","));
  return `https://${host}/single/?${q.toString()}`;
}

/** Both link forms for a section. */
export function sectionLinks(host, section, textFields = []) {
  return {
    analysis: sheetLink(host, section.appId, section.sheetId, section.selections, textFields),
    single: singleLink(host, section.appId, section.sheetId, section.selections),
  };
}

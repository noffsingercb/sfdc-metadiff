// src/parsers/lwc.js
// Parser for Lightning Web Component files.
// Handles both .js source files and .js-meta.xml companion files.
// Routed by path (/lwc/ directory) rather than suffix — .js is not unique.

const { XMLParser } = require('fast-xml-parser');
const { ENTITY_LIMIT_OPTS } = require('../xmlParserLimits');

const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: true, ...ENTITY_LIMIT_OPTS });

// ---------------------------------------------------------------------------
// Regex patterns for .js source files
// ---------------------------------------------------------------------------

// @api prop or @api get accessor
const API_PROP_RE = /@api\s+(?:get\s+)?(\w+)/g;

// @wire(AdapterName, ...) — captures adapter identifier only
const WIRE_RE     = /@wire\s*\(\s*(\w+)/g;

// import method from '@salesforce/apex/ClassName.methodName'
const APEX_RE     = /import\s+\w+\s+from\s+['"]@salesforce\/apex\/([^'"]+)['"]/g;

// import FIELD from '@salesforce/schema/Object.Field'
const SCHEMA_RE   = /import\s+\w+\s+from\s+['"]@salesforce\/schema\/([^'"]+)['"]/g;

// export default class ClassName
const CLASS_RE    = /export\s+default\s+class\s+(\w+)/;

const LIFECYCLE_HOOKS = [
  'connectedCallback', 'disconnectedCallback',
  'renderedCallback', 'errorCallback',
];

// ---------------------------------------------------------------------------
// JS source parser
// ---------------------------------------------------------------------------

function parseJs(code) {
  const result = {};

  const classMatch = code.match(CLASS_RE);
  if (classMatch) result.className = classMatch[1];

  let m;

  const apiProps = [];
  API_PROP_RE.lastIndex = 0;
  while ((m = API_PROP_RE.exec(code)) !== null) {
    if (!apiProps.includes(m[1])) apiProps.push(m[1]);
  }
  if (apiProps.length) result.__apiProps = apiProps.sort();

  const wireAdapters = [];
  WIRE_RE.lastIndex = 0;
  while ((m = WIRE_RE.exec(code)) !== null) {
    if (!wireAdapters.includes(m[1])) wireAdapters.push(m[1]);
  }
  if (wireAdapters.length) result.__wireAdapters = wireAdapters.sort();

  const apexImports = [];
  APEX_RE.lastIndex = 0;
  while ((m = APEX_RE.exec(code)) !== null) {
    if (!apexImports.includes(m[1])) apexImports.push(m[1]);
  }
  if (apexImports.length) result.__apexImports = apexImports.sort();

  const schemaImports = [];
  SCHEMA_RE.lastIndex = 0;
  while ((m = SCHEMA_RE.exec(code)) !== null) {
    if (!schemaImports.includes(m[1])) schemaImports.push(m[1]);
  }
  if (schemaImports.length) result.__schemaImports = schemaImports.sort();

  // Presence-only: which lifecycle hooks are implemented
  const hooks = LIFECYCLE_HOOKS.filter(hook => new RegExp(`\\b${hook}\\s*\\(`).test(code));
  if (hooks.length) result.__lifecycleHooks = hooks;

  return result;
}

// ---------------------------------------------------------------------------
// Meta XML parser — .js-meta.xml
// <targets><target>x</target></targets> is nested, handled explicitly here.
// ---------------------------------------------------------------------------

function parseMeta(xml) {
  const raw = xmlParser.parse(xml)?.LightningComponentBundle ?? {};
  const result = {};

  if (raw.apiVersion !== undefined) result.apiVersion = String(raw.apiVersion);
  if (raw.isExposed  !== undefined) result.isExposed  = String(raw.isExposed);

  const targetsRaw = raw.targets?.target;
  if (targetsRaw !== undefined) {
    const arr = Array.isArray(targetsRaw) ? targetsRaw : [targetsRaw];
    result.__targets = arr.map(String).sort();
  }

  return result;
}

// ---------------------------------------------------------------------------
// parse(code, filename) — routes to JS or meta parser
// ---------------------------------------------------------------------------

function parse(code, filename) {
  if (!code) return {};
  if (filename && filename.endsWith('.js-meta.xml')) return parseMeta(code);
  return parseJs(code);
}

// ---------------------------------------------------------------------------
// diff(oldCode, newCode, filename)
// ---------------------------------------------------------------------------

function diff(oldCode, newCode, filename) {
  const oldR = oldCode ? parse(oldCode, filename) : {};
  const newR = parse(newCode, filename);
  const changes = [];

  if (filename && filename.endsWith('.js-meta.xml')) {
    for (const key of ['apiVersion', 'isExposed']) {
      const o = oldR[key], n = newR[key];
      if      (o === undefined && n !== undefined) changes.push({ type: 'ADDED',    element: key, newValue: n });
      else if (o !== undefined && n === undefined) changes.push({ type: 'REMOVED',  element: key, oldValue: o });
      else if (o !== undefined && o !== n)         changes.push({ type: 'MODIFIED', element: key, oldValue: o, newValue: n });
    }
    diffSet('target', oldR.__targets, newR.__targets, changes);
  } else {
    const o = oldR.className, n = newR.className;
    if (o && n && o !== n) changes.push({ type: 'MODIFIED', element: 'className', oldValue: o, newValue: n });

    diffSet('api_prop',       oldR.__apiProps,       newR.__apiProps,       changes);
    diffSet('wire_adapter',   oldR.__wireAdapters,   newR.__wireAdapters,   changes);
    diffSet('apex_import',    oldR.__apexImports,    newR.__apexImports,    changes);
    diffSet('schema_import',  oldR.__schemaImports,  newR.__schemaImports,  changes);
    diffSet('lifecycle_hook', oldR.__lifecycleHooks, newR.__lifecycleHooks, changes);
  }

  return changes;
}

function diffSet(label, oldArr, newArr, changes) {
  const oldSet = new Set(oldArr ?? []);
  const newSet = new Set(newArr ?? []);
  for (const item of newSet) {
    if (!oldSet.has(item)) changes.push({ type: 'ADDED',   element: label, newValue: item });
  }
  for (const item of oldSet) {
    if (!newSet.has(item)) changes.push({ type: 'REMOVED', element: label, oldValue: item });
  }
}

module.exports = { parse, diff };
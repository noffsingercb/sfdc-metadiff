// src/parsers/flow.js
// Semantic parser for Salesforce Flow metadata (.flow-meta.xml).
// Follows the same parse()/diff() contract as field.js and validationRule.js.

const { XMLParser } = require('fast-xml-parser');
const { ENTITY_LIMIT_OPTS } = require('../xmlParserLimits');

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true, ...ENTITY_LIMIT_OPTS });

// ---------------------------------------------------------------------------
// Top-level scalar keys tracked for semantic changes
// ---------------------------------------------------------------------------
const TOP_LEVEL_SCALARS = ['status', 'label', 'description', 'apiVersion'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function toNameMap(rawVal, extractFn) {
  const arr = toArray(rawVal);
  const map = {};
  for (const el of arr) {
    const name = String(el.name ?? el.fullName ?? 'unnamed');
    map[name] = extractFn(el);
  }
  return map;
}

function countArray(val) {
  return toArray(val).length;
}

// ---------------------------------------------------------------------------
// Element extractors — each reads measurable/enumerable properties verbatim.
// Never prose. Never interpretation.
// ---------------------------------------------------------------------------

function extractDecision(el) {
  const rules = toArray(el.rules);
  return {
    outcome_count: rules.length,
    outcome_names: rules.map(r => String(r.name)),
  };
}

function extractAssignment(el) {
  return {
    assignment_count: countArray(el.assignmentItems),
  };
}

function extractRecordLookup(el) {
  return {
    object: String(el.object ?? el.inputReference ?? ''),
    filter_count: countArray(el.filters),
    output_field_count: countArray(el.outputAssignments),
    store_output_automatically: String(el.storeOutputAutomatically ?? 'false'),
  };
}

function extractRecordCreate(el) {
  return {
    object: String(el.object ?? el.inputReference ?? ''),
    input_field_count: countArray(el.inputAssignments),
  };
}

function extractRecordUpdate(el) {
  return {
    object: String(el.object ?? el.inputReference ?? ''),
    filter_count: countArray(el.filters),
    field_count: countArray(el.inputAssignments),
  };
}

function extractRecordDelete(el) {
  return {
    object: String(el.object ?? el.inputReference ?? ''),
    filter_count: countArray(el.filters),
  };
}

function extractSubflow(el) {
  return {
    flowName: String(el.flowName ?? ''),
    input_count: countArray(el.inputAssignments),
    output_count: countArray(el.outputAssignments),
  };
}

function extractFormula(el) {
  return {
    dataType: String(el.dataType ?? ''),
    expression: String(el.expression ?? ''),
  };
}

function extractVariable(el) {
  return {
    dataType: String(el.dataType ?? ''),
    isInput: String(el.isInput ?? 'false'),
    isOutput: String(el.isOutput ?? 'false'),
  };
}

function extractScheduledPath(el) {
  return {
    offsetNumber: String(el.offsetNumber ?? ''),
    offsetUnit: String(el.offsetUnit ?? ''),
    recordField: String(el.recordField ?? ''),
  };
}

function extractScreen(el) {
  return {
    field_count: countArray(el.fields),
    allowBack: String(el.allowBack ?? 'true'),
    allowFinish: String(el.allowFinish ?? 'true'),
    allowPause: String(el.allowPause ?? 'true'),
  };
}

function extractCustomError(el) {
  const msgs = toArray(el.customErrorMessages);
  return {
    message_count: msgs.length,
    isFieldError: String(msgs[0]?.isFieldError ?? 'false'),
    fieldSelection: msgs[0]?.fieldSelection ? String(msgs[0].fieldSelection) : undefined,
  };
}

function extractLoop(el) {
  return {
    collectionReference: String(el.collectionReference ?? ''),
    iterationOrder: String(el.iterationOrder ?? 'Asc'),
  };
}

function extractTextTemplate(el) {
  return {
    isViewedAsPlainText: String(el.isViewedAsPlainText ?? 'false'),
  };
}

// ---------------------------------------------------------------------------
// Start element extractor — singleton, not named-element
// ---------------------------------------------------------------------------
function extractStart(raw) {
  const start = raw.start;
  if (!start) return null;
  return {
    triggerType: String(start.triggerType ?? raw.triggerType ?? ''),
    object: String(start.object ?? ''),
    recordTriggerType: String(start.recordTriggerType ?? ''),
    schedule_count: countArray(start.scheduledPaths),
    filter_count: countArray(start.filters),
  };
}

// ---------------------------------------------------------------------------
// Element type registry
// ---------------------------------------------------------------------------
const ELEMENT_TYPES = [
  { key: 'decisions',      label: 'decision',      extract: extractDecision },
  { key: 'assignments',    label: 'assignment',    extract: extractAssignment },
  { key: 'recordLookups',  label: 'recordLookup',  extract: extractRecordLookup },
  { key: 'recordCreates',  label: 'recordCreate',  extract: extractRecordCreate },
  { key: 'recordUpdates',  label: 'recordUpdate',  extract: extractRecordUpdate },
  { key: 'recordDeletes',  label: 'recordDelete',  extract: extractRecordDelete },
  { key: 'subflows',       label: 'subflow',       extract: extractSubflow },
  { key: 'formulas',       label: 'formula',       extract: extractFormula },
  { key: 'variables',      label: 'variable',      extract: extractVariable },
  { key: 'scheduledPaths', label: 'scheduledPath', extract: extractScheduledPath },
  { key: 'screens',        label: 'screen',        extract: extractScreen },
  { key: 'customErrors',   label: 'customError',   extract: extractCustomError },
  { key: 'loops',          label: 'loop',          extract: extractLoop },
  { key: 'textTemplates',  label: 'textTemplate',  extract: extractTextTemplate },
];

// ---------------------------------------------------------------------------
// parse(xml) — returns structured representation of a flow
// ---------------------------------------------------------------------------
function parse(xml) {
  const raw = parser.parse(xml)?.Flow ?? {};
  const result = {};

  // Top-level scalars
  for (const key of TOP_LEVEL_SCALARS) {
    if (raw[key] !== undefined) result[key] = String(raw[key]);
  }

  // Process type (often at top level)
  if (raw.processType) result.processType = String(raw.processType);

  // Start element
  result.__start = extractStart(raw);

  // Named element maps
  for (const { key, extract } of ELEMENT_TYPES) {
    result[`__${key}`] = toNameMap(raw[key], extract);
  }

  return result;
}

// ---------------------------------------------------------------------------
// describeElement — renders extracted properties as pipe-delimited string
// ---------------------------------------------------------------------------
function describeElement(extracted) {
  return Object.entries(extracted)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join(' | ');
}

// ---------------------------------------------------------------------------
// diff(oldXml, newXml) — returns SemanticChange[]
// ---------------------------------------------------------------------------
function diff(oldXml, newXml) {
  const oldF = oldXml ? parse(oldXml) : {};
  const newF = parse(newXml);
  const changes = [];

  // Top-level scalar diffs
  for (const key of [...TOP_LEVEL_SCALARS, 'processType']) {
    const o = oldF[key], n = newF[key];
    if (o === undefined && n !== undefined) {
      changes.push({ type: 'ADDED', element: key, newValue: n });
    } else if (o !== undefined && n === undefined) {
      changes.push({ type: 'REMOVED', element: key, oldValue: o });
    } else if (o !== undefined && n !== undefined && o !== n) {
      changes.push({ type: 'MODIFIED', element: key, oldValue: o, newValue: n });
    }
  }

  // Start element diff
  const oldStart = oldF.__start;
  const newStart = newF.__start;
  if (oldStart || newStart) {
    const oDesc = oldStart ? describeElement(oldStart) : null;
    const nDesc = newStart ? describeElement(newStart) : null;
    if (!oDesc && nDesc) {
      changes.push({ type: 'ADDED', element: 'start', newValue: nDesc });
    } else if (oDesc && !nDesc) {
      changes.push({ type: 'REMOVED', element: 'start', oldValue: oDesc });
    } else if (oDesc && nDesc && oDesc !== nDesc) {
      changes.push({ type: 'MODIFIED', element: 'start', oldValue: oDesc, newValue: nDesc });
    }
  }

  // Named element map diffs
  for (const { key, label } of ELEMENT_TYPES) {
    const oldMap = oldF[`__${key}`] ?? {};
    const newMap = newF[`__${key}`] ?? {};

    for (const [name, newEl] of Object.entries(newMap)) {
      if (!oldMap[name]) {
        changes.push({ type: 'ADDED', element: `${label}:"${name}"`,
          newValue: describeElement(newEl) });
      } else if (JSON.stringify(oldMap[name]) !== JSON.stringify(newMap[name])) {
        changes.push({ type: 'MODIFIED', element: `${label}:"${name}"`,
          oldValue: describeElement(oldMap[name]),
          newValue: describeElement(newMap[name]) });
      }
    }
    for (const name of Object.keys(oldMap)) {
      if (!newMap[name]) {
        changes.push({ type: 'REMOVED', element: `${label}:"${name}"`,
          oldValue: describeElement(oldMap[name]) });
      }
    }
  }

  return changes;
}

module.exports = { parse, diff };
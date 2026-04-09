// src/parsers/field.js
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

// Scalar keys that carry meaningful semantic changes
const SCALAR_KEYS = [
  'label', 'type', 'required', 'description', 'inlineHelpText',
  'length', 'precision', 'scale', 'formula', 'referenceTo',
  'relationshipName', 'defaultValue', 'trackHistory',
  'trackFeedHistory', 'externalId', 'unique', 'caseSensitive',
  'visibleLines', 'summaryOperation', 'summarizedField',
];

function parse(xml) {
  const raw = parser.parse(xml)?.CustomField ?? {};
  const result = {};

  for (const key of SCALAR_KEYS) {
    if (raw[key] !== undefined) result[key] = String(raw[key]);
  }

  // Normalize picklist values from valueSet or globalValueSet
  result.__picklist = extractPicklistValues(raw);
  return result;
}

function extractPicklistValues(raw) {
  const values = [];
  const def = raw?.valueSet?.valueSetDefinition?.value;
  if (!def) return values;

  const arr = Array.isArray(def) ? def : [def];
  for (const v of arr) {
    values.push({
      fullName: String(v.fullName),
      label: String(v.label ?? v.fullName),
      isDefault: v.default === true || v.default === 'true',
      isActive: !(v.isActive === false || v.isActive === 'false'),
    });
  }
  return values;
}

function diff(oldXml, newXml) {
  const oldF = oldXml ? parse(oldXml) : {};
  const newF = parse(newXml);
  const changes = [];

  // Scalar diffs
  for (const key of SCALAR_KEYS) {
    const o = oldF[key], n = newF[key];
    if (o === undefined && n !== undefined) {
      changes.push({ type: 'ADDED', element: key, newValue: n });
    } else if (o !== undefined && n === undefined) {
      changes.push({ type: 'REMOVED', element: key, oldValue: o });
    } else if (o !== n) {
      changes.push({ type: 'MODIFIED', element: key, oldValue: o, newValue: n });
    }
  }

  // Picklist diffs
  const oldPL = oldF.__picklist ?? [];
  const newPL = newF.__picklist ?? [];
  const oldMap = Object.fromEntries(oldPL.map(v => [v.fullName, v]));
  const newMap = Object.fromEntries(newPL.map(v => [v.fullName, v]));

  for (const [name, v] of Object.entries(newMap)) {
    if (!oldMap[name]) {
      changes.push({ type: 'ADDED', element: `picklist_value:"${name}"`,
        newValue: formatPLValue(v) });
    } else {
      const o = oldMap[name];
      if (o.isDefault !== v.isDefault || o.isActive !== v.isActive) {
        changes.push({ type: 'MODIFIED', element: `picklist_value:"${name}"`,
          oldValue: formatPLValue(o), newValue: formatPLValue(v) });
      }
    }
  }
  for (const [name] of Object.entries(oldMap)) {
    if (!newMap[name]) {
      changes.push({ type: 'REMOVED', element: `picklist_value:"${name}"`,
        oldValue: formatPLValue(oldMap[name]) });
    }
  }

  return changes;
}

function formatPLValue(v) {
  const parts = [v.isDefault ? 'default' : 'not default'];
  if (!v.isActive) parts.push('inactive');
  return parts.join(', ');
}

module.exports = { parse, diff };
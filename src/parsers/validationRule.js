// src/parsers/validationRule.js
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false });

const SCALAR_KEYS = [
  'active', 'description', 'errorConditionFormula',
  'errorMessage', 'errorDisplayField',
];

function parse(xml) {
  const raw = parser.parse(xml)?.ValidationRule ?? {};
  const result = {};
  for (const key of SCALAR_KEYS) {
    if (raw[key] !== undefined) result[key] = String(raw[key]);
  }
  return result;
}

function diff(oldXml, newXml) {
  const oldR = oldXml ? parse(oldXml) : {};
  const newR = parse(newXml);
  const changes = [];

  for (const key of SCALAR_KEYS) {
    const o = oldR[key], n = newR[key];
    if (o === undefined && n !== undefined) {
      changes.push({ type: 'ADDED', element: key, newValue: n });
    } else if (o !== undefined && n === undefined) {
      changes.push({ type: 'REMOVED', element: key, oldValue: o });
    } else if (o !== n) {
      changes.push({ type: 'MODIFIED', element: key, oldValue: o, newValue: n });
    }
  }

  return changes;
}

module.exports = { parse, diff };
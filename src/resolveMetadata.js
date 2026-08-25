// src/resolveMetadata.js
// Derives API name, parent object, and metadata type from a Salesforce
// metadata file path.
//
// Shared by src/cli.js, src/mcp-server.js and scripts/run-org-compare.js.
// This lived as three near-identical copies, which is how the path-based
// parent-object fix reached two of them and silently missed the third: org
// compare runs reported apiName "field-meta" and promoted the field's own
// name to parent object. One copy, one place to fix.

const path = require('path');

function resolveMetadata(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const basename   = path.basename(normalized);
  const parts      = basename.split('.');

  // Decomposed child metadata (fields, validation rules, etc.) is named
  // "<ApiName>.<type>-meta.xml" and lives under ".../objects/<Parent>/<group>/".
  // The parent object comes from the PATH, not the filename -- splitting the
  // basename yields apiName "field-meta" and the wrong parent.
  const objMatch       = normalized.match(/(?:^|\/)objects\/([^/]+)\//);
  const parentFromPath = objMatch ? objMatch[1] : '';
  const strip = (suffix) => basename.slice(0, basename.length - suffix.length);

  if (basename.endsWith('.field-meta.xml'))          return { apiName: strip('.field-meta.xml'),          parentObject: parentFromPath, metadataType: 'CustomField' };
  if (basename.endsWith('.validationRule-meta.xml')) return { apiName: strip('.validationRule-meta.xml'), parentObject: parentFromPath, metadataType: 'ValidationRule' };
  if (basename.endsWith('.flow-meta.xml'))           return { apiName: strip('.flow-meta.xml'),           parentObject: '',             metadataType: 'Flow' };
  if (basename.endsWith('.flexipage-meta.xml'))      return { apiName: strip('.flexipage-meta.xml'),      parentObject: '',             metadataType: 'FlexiPage' };
  if (basename.endsWith('.flexipage'))               return { apiName: strip('.flexipage'),               parentObject: '',             metadataType: 'FlexiPage' };
  if (basename.endsWith('.cls'))                     return { apiName: strip('.cls'),                     parentObject: '',             metadataType: 'ApexClass' };
  if (basename.endsWith('.trigger'))                 return { apiName: strip('.trigger'),                 parentObject: '',             metadataType: 'ApexTrigger' };
  // Fallback for config-driven types (Tier 1/2) that have no explicit case
  // above. The token before ".xml" is the suffix, e.g. "reportType-meta" --
  // strip the "-meta" and upper-case the first letter so the MDIF reports
  // "ReportType" rather than the raw filename fragment "reportType-meta".
  const suffixToken = parts.slice(-2, -1)[0] ?? '';
  const typeToken   = suffixToken.replace(/-meta$/, '');
  const metadataType = typeToken
    ? typeToken.charAt(0).toUpperCase() + typeToken.slice(1)
    : 'Unknown';

  return { apiName: parts[0], parentObject: '', metadataType };
}

module.exports = { resolveMetadata };

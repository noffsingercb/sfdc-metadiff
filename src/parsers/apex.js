// src/parsers/apex.js
// Semantic parser for Salesforce Apex classes (.cls) and triggers (.trigger).
// Uses regex-based extraction — no AST, no XML parser.
// Same parse()/diff() contract as field.js, validationRule.js, and flow.js.

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Method signatures — public/global/protected methods (not private internals)
const METHOD_RE = /^\s*(public|global|protected|private)\s+(static\s+)?(override\s+)?(testMethod\s+)?([\w<>\[\],\s]+?)\s+(\w+)\s*\(([^)]*)\)/gm;

// SOQL queries — extract the target object from FROM clause
const SOQL_RE = /\[.*?SELECT\b.*?\bFROM\b\s+(\w+)/gis;

// DML operations — insert, update, delete, upsert, undelete
const DML_RE = /\b(insert|update|delete|upsert|undelete)\s+(\w+)/gi;

// Class-level annotations
const ANNOTATION_RE = /^\s*@(AuraEnabled|InvocableMethod|InvocableVariable|TestSetup|IsTest|Future|RemoteAction|ReadOnly|HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|RestResource|NamespaceAccessible|SuppressWarnings)/gm;

// Implements / extends
const CLASS_DEF_RE = /(?:class|interface)\s+\w+(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([\w\s,.]+))?\s*\{/i;

// Trigger definition — trigger Name on Object (events)
const TRIGGER_DEF_RE = /trigger\s+(\w+)\s+on\s+(\w+)\s*\(([^)]+)\)/i;

// Test methods — @IsTest or testMethod keyword
const TEST_METHOD_RE = /(@IsTest|testMethod)/gi;

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function extractMethods(code) {
  const methods = [];
  const seen = new Set();
  let match;
  
  // Reset regex state
  METHOD_RE.lastIndex = 0;
  while ((match = METHOD_RE.exec(code)) !== null) {
    const visibility = match[1];
    const isStatic = !!match[2];
    const isOverride = !!match[3];
    const returnType = match[5].trim();
    const name = match[6];
    const params = match[7].trim();
    
    // Build a normalized signature
    const sig = `${visibility}${isStatic ? ' static' : ''}${isOverride ? ' override' : ''} ${returnType} ${name}(${params})`;
    
    // Deduplicate (regex can match inside strings/comments)
    if (seen.has(name + params)) continue;
    seen.add(name + params);
    
    methods.push({
      name,
      visibility,
      isStatic,
      isOverride,
      returnType,
      params,
      signature: sig,
    });
  }
  return methods;
}

function extractSoqlTargets(code) {
  const targets = new Set();
  let match;
  SOQL_RE.lastIndex = 0;
  while ((match = SOQL_RE.exec(code)) !== null) {
    targets.add(match[1]);
  }
  return [...targets].sort();
}

function extractDmlOps(code) {
  const ops = [];
  const seen = new Set();
  let match;
  DML_RE.lastIndex = 0;
  while ((match = DML_RE.exec(code)) !== null) {
    const op = match[1].toLowerCase();
    const target = match[2];
    const key = `${op}:${target}`;
    if (!seen.has(key)) {
      seen.add(key);
      ops.push({ operation: op, target });
    }
  }
  return ops;
}

function extractAnnotations(code) {
  const annotations = new Set();
  let match;
  ANNOTATION_RE.lastIndex = 0;
  while ((match = ANNOTATION_RE.exec(code)) !== null) {
    annotations.add(match[1]);
  }
  return [...annotations].sort();
}

function extractClassDef(code) {
  const match = code.match(CLASS_DEF_RE);
  if (!match) return { extends: null, implements: [] };
  return {
    extends: match[1] || null,
    implements: match[2] ? match[2].split(',').map(s => s.trim()).filter(Boolean) : [],
  };
}

function extractTriggerDef(code) {
  const match = code.match(TRIGGER_DEF_RE);
  if (!match) return null;
  return {
    name: match[1],
    object: match[2],
    events: match[3].split(',').map(s => s.trim()),
  };
}

// ---------------------------------------------------------------------------
// parse(code) — returns structured representation
// ---------------------------------------------------------------------------
function parse(code) {
  if (!code) return {};
  
  const classDef = extractClassDef(code);
  const triggerDef = extractTriggerDef(code);
  const methods = extractMethods(code);
  const soqlTargets = extractSoqlTargets(code);
  const dmlOps = extractDmlOps(code);
  const annotations = extractAnnotations(code);
  
  const result = {};
  
  // Class hierarchy
  if (classDef.extends) result.extends = classDef.extends;
  if (classDef.implements.length > 0) result.implements = classDef.implements.join(', ');
  
  // Trigger info
  if (triggerDef) {
    result.triggerObject = triggerDef.object;
    result.triggerEvents = triggerDef.events.join(', ');
  }
  
  // Annotations (as comma-separated string for scalar diffing)
  if (annotations.length > 0) result.annotations = annotations.join(', ');
  
  // Store structured data in __ prefixed keys (skipped by cli.js for NEW/DELETED)
  result.__methods = Object.fromEntries(methods.map(m => [m.name, m]));
  result.__soqlTargets = soqlTargets;
  result.__dmlOps = dmlOps;
  
  return result;
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

function diffScalars(oldR, newR, changes) {
  const KEYS = ['extends', 'implements', 'triggerObject', 'triggerEvents', 'annotations'];
  for (const key of KEYS) {
    const o = oldR[key], n = newR[key];
    if (o === undefined && n !== undefined) {
      changes.push({ type: 'ADDED', element: key, newValue: n });
    } else if (o !== undefined && n === undefined) {
      changes.push({ type: 'REMOVED', element: key, oldValue: o });
    } else if (o !== undefined && n !== undefined && o !== n) {
      changes.push({ type: 'MODIFIED', element: key, oldValue: o, newValue: n });
    }
  }
}

function diffMethods(oldMethods, newMethods, changes) {
  for (const [name, m] of Object.entries(newMethods)) {
    if (!oldMethods[name]) {
      changes.push({ type: 'ADDED', element: `method:"${name}"`,
        newValue: `"${m.signature}"` });
    } else if (oldMethods[name].signature !== m.signature) {
      changes.push({ type: 'MODIFIED', element: `method:"${name}"`,
        oldValue: `"${oldMethods[name].signature}"`,
        newValue: `"${m.signature}"` });
    }
    // Note: body-only changes are NOT surfaced as semantic changes.
    // The raw diff carries that signal. This is by design — see MDIF spec.
  }
  for (const name of Object.keys(oldMethods)) {
    if (!newMethods[name]) {
      changes.push({ type: 'REMOVED', element: `method:"${name}"`,
        oldValue: `"${oldMethods[name].signature}"` });
    }
  }
}

function diffSet(label, oldArr, newArr, changes) {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  for (const item of newSet) {
    if (!oldSet.has(item)) {
      changes.push({ type: 'ADDED', element: label, newValue: item });
    }
  }
  for (const item of oldSet) {
    if (!newSet.has(item)) {
      changes.push({ type: 'REMOVED', element: label, oldValue: item });
    }
  }
}

function diffDmlOps(oldOps, newOps, changes) {
  const toKey = (op) => `${op.operation} ${op.target}`;
  const oldSet = new Set(oldOps.map(toKey));
  const newSet = new Set(newOps.map(toKey));
  for (const item of newSet) {
    if (!oldSet.has(item)) {
      changes.push({ type: 'ADDED', element: 'dml_operation', newValue: item });
    }
  }
  for (const item of oldSet) {
    if (!newSet.has(item)) {
      changes.push({ type: 'REMOVED', element: 'dml_operation', oldValue: item });
    }
  }
}

// ---------------------------------------------------------------------------
// diff(oldCode, newCode) — returns SemanticChange[]
// ---------------------------------------------------------------------------
function diff(oldCode, newCode) {
  const oldR = oldCode ? parse(oldCode) : {};
  const newR = parse(newCode);
  const changes = [];
  
  // Scalar diffs (extends, implements, annotations, trigger info)
  diffScalars(oldR, newR, changes);
  
  // Method diffs
  diffMethods(oldR.__methods ?? {}, newR.__methods ?? {}, changes);
  
  // SOQL target diffs
  diffSet('soql_target', oldR.__soqlTargets ?? [], newR.__soqlTargets ?? [], changes);
  
  // DML operation diffs
  diffDmlOps(oldR.__dmlOps ?? [], newR.__dmlOps ?? [], changes);
  
  return changes;
}

module.exports = { parse, diff };
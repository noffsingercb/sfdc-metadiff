// src/format.js
// Formats SemanticChange arrays into MDIF output blocks.
// This module knows the MDIF spec. Parsers and CLI do not.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

const MAX_SCALAR_LENGTH        = 500;   // normal mode
const MAX_SCALAR_LENGTH_COMPACT = 150;  // compact mode
const MAX_RAW_DIFF_LINES       = 30;
const OMIT_RAW_DIFF_TYPES      = ['Flow', 'Lightning Page'];

// The marker tells the LLM exactly how much was cut so it can request more.
function truncateValue(str, compact = false) {
  const maxLen = compact ? MAX_SCALAR_LENGTH_COMPACT : MAX_SCALAR_LENGTH;
  if (!str || str.length <= maxLen) return str;
  const omitted = str.length - maxLen;
  return `${str.slice(0, maxLen)} [TRUNCATED \u2014 ${str.length} chars total, ${omitted} chars omitted]`;
}

function getInlineDiff(oldContent, newContent, maxLines = MAX_RAW_DIFF_LINES) {
  const tmpOld = path.join(os.tmpdir(), `mdif_old_${Date.now()}`);
  const tmpNew = path.join(os.tmpdir(), `mdif_new_${Date.now()}`);
  try {
    fs.writeFileSync(tmpOld, oldContent ?? '');
    fs.writeFileSync(tmpNew, newContent ?? '');
    let raw = '';
    try {
      execSync(`git diff --no-index --unified=3 "${tmpOld}" "${tmpNew}"`, { encoding: 'utf8' });
    } catch (e) {
      raw = e.stdout ?? '';  // git diff exits 1 when differences exist -- expected
    }
    const lines = raw.split('\n').slice(4);  // drop 4-line header
    const shown = lines.slice(0, maxLines);
    let result = shown.join('\n').trimEnd();
    if (lines.length > maxLines) {
      const omitted = lines.length - maxLines;
      result += `\n[TRUNCATED \u2014 ${lines.length} diff lines total, ${omitted} lines omitted. Semantic changes above are the primary signal.]`;
    }
    return result;
  } finally {
    try { fs.unlinkSync(tmpOld); } catch {}
    try { fs.unlinkSync(tmpNew); } catch {}
  }
}

// ---------------------------------------------------------------------------
// formatBlock(blockData, formatOpts)
//   formatOpts.compact {boolean} -- omit all raw sections, tighter truncation
// ---------------------------------------------------------------------------
function formatBlock(blockData, formatOpts = {}) {
  const { compact = false } = formatOpts;
  const {
    changeType,
    apiName,
    parentObject,
    componentType,
    metadataType,
    semanticChanges = [],
    oldContent,
    newContent,
  } = blockData;

  const L = [];
  const push   = (s) => L.push(s);
  const indent = (s) => L.push('  ' + s);

  push('---');
  push(`CHANGE_TYPE: ${changeType}`);
  push(`COMPONENT_TYPE: ${componentType}`);
  push(`METADATA_TYPE: ${metadataType}`);
  push(`API_NAME: ${apiName}`);
  if (parentObject) push(`PARENT_OBJECT: ${parentObject}`);

  if (changeType === 'NEW') {
    push('CURRENT_STATE:');
    for (const c of semanticChanges) {
      indent(`${c.element}: ${truncateValue(c.newValue ?? '', compact)}`);
    }
    if (!compact && newContent) {
      const srcLines = newContent.split('\n');
      const maxSrcLines = 60;
      push('RAW_SOURCE:');
      for (const line of srcLines.slice(0, maxSrcLines)) indent(line);
      if (srcLines.length > maxSrcLines) {
        indent(`[TRUNCATED \u2014 ${srcLines.length} source lines total, ${srcLines.length - maxSrcLines} lines omitted]`);
      }
    }

  } else if (changeType === 'DELETED') {
    push('LAST_KNOWN_STATE:');
    for (const c of semanticChanges) {
      indent(`${c.element}: ${truncateValue(c.oldValue ?? '', compact)}`);
    }

  } else {
    // MODIFIED
    push('SEMANTIC_CHANGES:');
    for (const c of semanticChanges) {
      if (c.type === 'ADDED') {
        indent(`[ADDED] ${c.element}: ${truncateValue(c.newValue, compact)}`);
      } else if (c.type === 'REMOVED') {
        indent(`[REMOVED] ${c.element}: ${truncateValue(c.oldValue, compact)}`);
      } else {
        indent(`[MODIFIED] ${c.element}: ${truncateValue(c.oldValue, compact)} \u2192 ${truncateValue(c.newValue, compact)}`);
      }
    }

    if (compact) {
      // Compact mode: no raw diff of any kind
      push('RAW_DIFF: [OMITTED -- compact mode]');
    } else if (OMIT_RAW_DIFF_TYPES.includes(componentType)) {
      if (oldContent && newContent) {
        const totalLines = oldContent.split('\n').length + newContent.split('\n').length;
        push(`RAW_DIFF: [OMITTED \u2014 ${totalLines} combined source lines. Semantic changes are the primary signal for ${componentType}.]`);
      }
    } else if (oldContent && newContent) {
      const rawDiff = getInlineDiff(oldContent, newContent);
      if (rawDiff.trim()) {
        push('RAW_DIFF:');
        for (const line of rawDiff.split('\n')) indent(line);
      }
    }
  }

  push('---');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// formatDocument(blocks, opts)
//   opts.compact      {boolean} -- enable compact mode
//   opts.skippedCount {number}  -- files skipped (no parser); included in header
// ---------------------------------------------------------------------------
function formatDocument(blocks, opts = {}) {
  const { compact = false, skippedCount = 0 } = opts;

  // Build batch summary
  const changeCounts = { NEW: 0, MODIFIED: 0, DELETED: 0 };
  const typeByChange = {};  // { changeType: { componentType: count } }

  for (const b of blocks) {
    changeCounts[b.changeType] = (changeCounts[b.changeType] ?? 0) + 1;
    if (!typeByChange[b.changeType]) typeByChange[b.changeType] = {};
    typeByChange[b.changeType][b.componentType] =
      (typeByChange[b.changeType][b.componentType] ?? 0) + 1;
  }

  const summaryLines = [];
  for (const [ct, count] of Object.entries(changeCounts)) {
    if (!count) continue;
    const breakdown = Object.entries(typeByChange[ct] ?? {})
      .map(([type, n]) => `${type} x${n}`)
      .join(', ');
    summaryLines.push(`  ${ct.padEnd(10)} ${String(count).padEnd(4)} ${breakdown}`);
  }

  const headerLines = [
    'MDIF_VERSION: 0.1',
    `GENERATED_AT: ${new Date().toISOString()}`,
    `BLOCK_COUNT:  ${blocks.length}`,
  ];
  if (skippedCount > 0) headerLines.push(`SKIPPED:      ${skippedCount}`);
  if (compact)          headerLines.push('MODE:         compact');
  headerLines.push('');
  headerLines.push('BATCH_SUMMARY:');
  headerLines.push(...summaryLines);
  headerLines.push('');

  const header = headerLines.join('\n');
  const body   = blocks.map(b => formatBlock(b, { compact })).join('\n\n');
  return header + body;
}

module.exports = { formatBlock, formatDocument };
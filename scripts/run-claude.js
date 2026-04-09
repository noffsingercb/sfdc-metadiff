// scripts/run-claude.js
// Standalone test runner for the claude adapter.
//
// Usage:
//   node scripts/run-claude.js --manual test-data/old test-data/new
//   node scripts/run-claude.js --manual test-data/old test-data/new --compact
//   node scripts/run-claude.js --manual test-data/old test-data/new --output result.json

const path = require('path');
const { getChangedFiles, getChangedFilesManual } = require('../src/git');
const { getParser } = require('../src/differ');

// Reuse the same resolveMetadata and buildSemanticChanges from cli.js
function resolveMetadata(filePath) {
  const basename = path.basename(filePath);
  const parts    = basename.split('.');
  if (basename.endsWith('field-meta.xml'))         return { apiName: parts[1], parentObject: parts[0], metadataType: 'CustomField' };
  if (basename.endsWith('validationRule-meta.xml')) return { apiName: parts[1], parentObject: parts[0], metadataType: 'ValidationRule' };
  if (basename.endsWith('flow-meta.xml'))           return { apiName: parts[0], parentObject: '',       metadataType: 'Flow' };
  if (basename.endsWith('.cls'))                    return { apiName: parts[0], parentObject: '',       metadataType: 'ApexClass' };
  if (basename.endsWith('.trigger'))                return { apiName: parts[0], parentObject: '',       metadataType: 'ApexTrigger' };
  return { apiName: parts[0], parentObject: '', metadataType: parts.slice(-2, -1)[0] ?? 'Unknown' };
}

function buildSemanticChanges(status, parser, oldContent, newContent, filePath) {
  const filename = path.basename(filePath);
  if (status === 'A') {
    const parsed = parser.parse(newContent, filename);
    return Object.entries(parsed)
      .filter(([k]) => !k.startsWith('__'))
      .map(([element, val]) => ({ type: 'ADDED', element, newValue: String(val ?? '') }));
  }
  if (status === 'D') {
    const parsed = parser.parse(oldContent, filename);
    return Object.entries(parsed)
      .filter(([k]) => !k.startsWith('__'))
      .map(([element, val]) => ({ type: 'REMOVED', element, oldValue: String(val ?? '') }));
  }
  return parser.diff(oldContent, newContent, filename);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const args        = process.argv.slice(2);
const flag        = (n) => args.indexOf(n);
const flagVal     = (n) => { const i = flag(n); return i !== -1 ? args[i + 1] : null; };
const flagExists  = (n) => args.includes(n);

const manualIdx   = flag('--manual');
const outputFile  = flagVal('--output');
const compact     = flagExists('--compact');
const model       = flagVal('--model');   // optional: override model

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  let changedFiles;

  if (manualIdx !== -1) {
    const oldDir = args[manualIdx + 1];
    const newDir = args[manualIdx + 2];
    if (!oldDir || !newDir) {
      console.error('Usage: node scripts/run-claude.js --manual <old-dir> <new-dir>');
      process.exit(1);
    }
    console.log(`[run-claude] Manual mode: ${oldDir} vs ${newDir}${compact ? ' [compact]' : ''}`);
    changedFiles = getChangedFilesManual(oldDir, newDir);
  } else {
    console.log('[run-claude] Git mode: reading last commit...');
    changedFiles = getChangedFiles(process.cwd());
  }

  const blocks = [];
  let skipped = 0;

  for (const file of changedFiles) {
    const config = getParser(file.filePath);
    if (!config) { skipped++; continue; }

    const { parser, componentType } = config;
    const { apiName, parentObject, metadataType } = resolveMetadata(file.filePath);
    const statusLabel = file.status === 'A' ? 'NEW' : file.status === 'D' ? 'DELETED' : 'MODIFIED';

    const semanticChanges = buildSemanticChanges(
      file.status, parser, file.oldContent, file.newContent, file.filePath
    );
    if (semanticChanges.length === 0 && file.status === 'M') continue;

    blocks.push({ changeType: statusLabel, apiName, parentObject, componentType,
      metadataType, semanticChanges, oldContent: file.oldContent, newContent: file.newContent });
  }

  if (blocks.length === 0) {
    console.log('[run-claude] No blocks to process.');
    process.exit(0);
  }

  const { consume } = require('../adapters/claude');

  const result = await consume(blocks, {
    compact,
    skippedCount: skipped,
    ...(model ? { model } : {}),
  });

  if (outputFile) {
    require('fs').writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[run-claude] Result written to: ${outputFile}`);
  } else {
    // Pretty-print each output to the console
    console.log('\n' + '='.repeat(60));
    for (const out of result.outputs) {
      console.log(`\n${out.component}`);
      console.log(`Action: ${out.action}  Confidence: ${out.confidence}`);
      console.log(`\nChange Summary:\n${out.changeSummary}`);
      console.log(`\nChange Log Entry:\n${out.changeLogEntry}`);
      if (Object.keys(out.updatedSections).length > 0) {
        console.log('\nUpdated Sections:');
        for (const [k, v] of Object.entries(out.updatedSections)) {
          console.log(`  ${k}: ${v.slice(0, 120)}${v.length > 120 ? '...' : ''}`);
        }
      }
      console.log('-'.repeat(40));
    }
    if (result.batchReport?.reviewerNotes) {
      console.log(`\nReviewer Notes:\n${result.batchReport.reviewerNotes}`);
    }
    console.log('='.repeat(60));
  }
})();
#!/usr/bin/env node
// src/cli.js
// Entry point for sfdc-metadiff.
//
// Usage:
//   node src/cli.js                                        # git mode
//   node src/cli.js --manual <old-dir> <new-dir>          # manual / POC mode
//   node src/cli.js --output <file.mdif>                  # write to file
//   node src/cli.js --compact                             # omit all raw diffs
//   node src/cli.js --manual old/ new/ --output out.mdif --compact

const path = require('path');
const { getChangedFiles, getChangedFilesManual } = require('./git');
const { getParser } = require('./differ');
const { formatDocument } = require('./format');

const args       = process.argv.slice(2);
const flag       = (name) => args.indexOf(name);
const flagVal    = (name) => { const i = flag(name); return i !== -1 ? args[i + 1] : null; };
const flagExists = (name) => args.includes(name);

const manualIdx  = flag('--manual');
const outputFile = flagVal('--output');
const compact    = flagExists('--compact');
const repoRoot   = process.cwd();

// ---------------------------------------------------------------------------
// resolveMetadata -- derives API name, parent object, and metadata type
// from a Salesforce metadata filename.
// ---------------------------------------------------------------------------
function resolveMetadata(filePath) {
  const basename = path.basename(filePath);
  const parts    = basename.split('.');

  if (basename.endsWith('field-meta.xml'))          return { apiName: parts[1], parentObject: parts[0], metadataType: 'CustomField' };
  if (basename.endsWith('validationRule-meta.xml'))  return { apiName: parts[1], parentObject: parts[0], metadataType: 'ValidationRule' };
  if (basename.endsWith('flow-meta.xml'))            return { apiName: parts[0], parentObject: '',       metadataType: 'Flow' };
  if (basename.endsWith('.cls'))                     return { apiName: parts[0], parentObject: '',       metadataType: 'ApexClass' };
  if (basename.endsWith('.trigger'))                 return { apiName: parts[0], parentObject: '',       metadataType: 'ApexTrigger' };
  return { apiName: parts[0], parentObject: '', metadataType: parts.slice(-2, -1)[0] ?? 'Unknown' };
}

// ---------------------------------------------------------------------------
// buildSemanticChanges -- calls parser.parse() for NEW/DELETED,
// parser.diff() for MODIFIED.
// ---------------------------------------------------------------------------
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
// Main
// ---------------------------------------------------------------------------
let changedFiles;

if (manualIdx !== -1) {
  const oldDir = args[manualIdx + 1];
  const newDir = args[manualIdx + 2];
  if (!oldDir || !newDir || oldDir.startsWith('--') || newDir.startsWith('--')) {
    console.error('Usage: node src/cli.js --manual <old-dir> <new-dir>');
    process.exit(1);
  }
  console.log(`[sfdc-metadiff] Manual mode: ${oldDir}  vs  ${newDir}${compact ? '  [compact]' : ''}`);
  changedFiles = getChangedFilesManual(oldDir, newDir);
} else {
  console.log(`[sfdc-metadiff] Git mode: reading last commit...${compact ? '  [compact]' : ''}`);
  changedFiles = getChangedFiles(repoRoot);
}

if (changedFiles.length === 0) {
  console.log('[sfdc-metadiff] No changed files found.');
  process.exit(0);
}

console.log(`[sfdc-metadiff] ${changedFiles.length} file(s) found\n`);

const blocks = [];
let skipped = 0;

for (const file of changedFiles) {
  const config = getParser(file.filePath);

  if (!config) {
    console.log(`  [skip]      ${path.basename(file.filePath)}  (no parser for this type)`);
    skipped++;
    continue;
  }

  const { parser, componentType } = config;
  const { apiName, parentObject, metadataType } = resolveMetadata(file.filePath);
  const label       = parentObject ? `${parentObject}.${apiName}` : apiName;
  const statusLabel = file.status === 'A' ? 'NEW' : file.status === 'D' ? 'DELETED' : 'MODIFIED';

  const semanticChanges = buildSemanticChanges(
    file.status, parser, file.oldContent, file.newContent, file.filePath
  );

  if (semanticChanges.length === 0 && file.status === 'M') {
    console.log(`  [no-change] ${label}  (no tracked properties differ)`);
    continue;
  }

  console.log(`  [${statusLabel.padEnd(8)}] ${label}  (${componentType})`);

  blocks.push({
    changeType: statusLabel,
    apiName,
    parentObject,
    componentType,
    metadataType,
    semanticChanges,
    oldContent: file.oldContent,
    newContent: file.newContent,
  });
}

if (blocks.length === 0) {
  console.log('\n[sfdc-metadiff] No blocks to write.');
  process.exit(0);
}

const document = formatDocument(blocks, { compact, skippedCount: skipped });
const divider  = '='.repeat(60);
const modeTag  = compact ? ' [compact]' : '';

if (outputFile) {
  require('fs').writeFileSync(outputFile, document, 'utf8');
  console.log(`\n${divider}`);
  console.log(`\u2705  MDIF written to: ${outputFile}${modeTag}`);
  console.log(`   ${blocks.length} block(s) | ${skipped} skipped`);
  console.log(divider);
} else {
  console.log(`\n${divider}\n`);
  console.log(document);
  console.log(`\n${divider}`);
  console.log(`\u2705  ${blocks.length} block(s) | ${skipped} skipped${modeTag}`);
  console.log(divider);
}
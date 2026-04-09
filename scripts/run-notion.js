// scripts/run-notion.js
// Orchestration runner for writing MDIF data to the Salesforce Metadata Wiki.
//
// Two pipeline modes:
//   default  -- MDIF → Claude → Notion  (requires ANTHROPIC_API_KEY + NOTION_TOKEN)
//   --raw    -- MDIF → Notion directly  (requires NOTION_TOKEN only)
//
// Usage:
//   node scripts/run-notion.js --manual <old-dir> <new-dir>
//   node scripts/run-notion.js --manual <old-dir> <new-dir> --raw
//   node scripts/run-notion.js --manual <old-dir> <new-dir> --dry-run
//   node scripts/run-notion.js --manual <old-dir> <new-dir> --compact
//   node scripts/run-notion.js --manual <old-dir> <new-dir> --raw --dry-run

const path = require('path');
const { getChangedFiles, getChangedFilesManual } = require('../src/git');
const { getParser } = require('../src/differ');

// Derives API name, parent object, and metadata type from a Salesforce filename.
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

// Calls parser.parse() for NEW/DELETED files and parser.diff() for MODIFIED files.
function buildSemanticChanges(status, parser, oldContent, newContent, filePath) {
  const filename = path.basename(filePath);
  if (status === 'A') {
    const parsed = parser.parse(newContent, filename);
    return Object.entries(parsed).filter(([k]) => !k.startsWith('__'))
      .map(([element, val]) => ({ type: 'ADDED', element, newValue: String(val ?? '') }));
  }
  if (status === 'D') {
    const parsed = parser.parse(oldContent, filename);
    return Object.entries(parsed).filter(([k]) => !k.startsWith('__'))
      .map(([element, val]) => ({ type: 'REMOVED', element, oldValue: String(val ?? '') }));
  }
  return parser.diff(oldContent, newContent, filename);
}

const args       = process.argv.slice(2);
const flag       = (n) => args.indexOf(n);
const flagExists = (n) => args.includes(n);

const manualIdx  = flag('--manual');
const compact    = flagExists('--compact');
const dryRun     = flagExists('--dry-run');
const rawMode    = flagExists('--raw');

(async () => {
  let changedFiles;

  if (manualIdx !== -1) {
    const oldDir = args[manualIdx + 1];
    const newDir = args[manualIdx + 2];
    const modeLabel = rawMode ? ' [raw]' : '';
    console.log(`[run-notion] Manual mode: ${oldDir} vs ${newDir}${modeLabel}${dryRun ? ' [DRY RUN]' : ''}`);
    changedFiles = getChangedFilesManual(oldDir, newDir);
  } else {
    console.log('[run-notion] Git mode: reading last commit...');
    changedFiles = getChangedFiles(process.cwd());
  }

  const blocks = [];
  let skipped = 0;

  for (const file of changedFiles) {
    const config = getParser(file.filePath);
    if (!config) { skipped++; continue; }
    const { parser, componentType } = config;
    const { apiName, parentObject, metadataType } = resolveMetadata(file.filePath);
    const statusLabel     = file.status === 'A' ? 'NEW' : file.status === 'D' ? 'DELETED' : 'MODIFIED';
    const semanticChanges = buildSemanticChanges(file.status, parser, file.oldContent, file.newContent, file.filePath);
    if (semanticChanges.length === 0 && file.status === 'M') continue;
    blocks.push({ changeType: statusLabel, apiName, parentObject, componentType, metadataType,
      semanticChanges, oldContent: file.oldContent, newContent: file.newContent });
  }

  if (blocks.length === 0) {
    console.log('[run-notion] No blocks to process.');
    return;
  }

  if (rawMode) {
    // Raw mode: MDIF → Notion directly, no Claude required
    console.log(`\n[run-notion] Raw mode: writing ${blocks.length} block(s) to Notion directly...`);
    const { consumeRaw } = require('../adapters/notion');
    await consumeRaw(blocks, { dryRun });
    if (dryRun) console.log('\n[run-notion] DRY RUN complete — no pages were created or modified.');
  } else {
    // Full pipeline: MDIF → Claude → Notion
    console.log(`\n[run-notion] Step 1: Claude interpretation (${blocks.length} block(s))...`);
    const { consume: claudeConsume } = require('../adapters/claude');
    const claudeResult = await claudeConsume(blocks, { compact, skippedCount: skipped });

    if (!claudeResult.outputs.length) {
      console.log('[run-notion] Claude returned no outputs. Nothing to write to Notion.');
      return;
    }

    console.log(`\n[run-notion] Step 2: Writing to Notion (${claudeResult.outputs.length} output(s))...`);
    const { consume: notionConsume } = require('../adapters/notion');
    await notionConsume(claudeResult.outputs, { dryRun });

    if (dryRun) console.log('\n[run-notion] DRY RUN complete — no pages were created or modified.');
  }
})();
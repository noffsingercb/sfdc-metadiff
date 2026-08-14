// scripts/run-org-compare.js
// CLI runner for the org compare source.
// Retrieves metadata from one or two Salesforce orgs and runs the full
// MDIF pipeline on the differences.
//
// Usage:
//   # Compare org against local project files
//   node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg
//
//   # Compare two orgs
//   node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg --target-org prodOrg
//
//   # Compare org against a git ref
//   node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg --git-ref HEAD
//
//   # Feed into an adapter
//   node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg --adapter notion
//   node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg --adapter webhook --url https://...

const path = require('path');
const { getChangedFilesOrgCompare } = require('../src/sources/orgCompare');
const { getParser } = require('../src/differ');
const { formatDocument } = require('../src/format');

const { resolveMetadata } = require('../src/resolveMetadata');

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
const flagVal    = (n) => { const i = flag(n); return i !== -1 ? args[i + 1] : null; };
const flagExists = (n) => args.includes(n);

const packageXml = flagVal('--package-xml');
const sourceOrg  = flagVal('--source-org');
const targetOrg  = flagVal('--target-org');  // present = twoOrg mode
const gitRef     = flagVal('--git-ref');     // present = orgVsGit mode
const adapter    = flagVal('--adapter') ?? 'stdout';
const webhookUrl = flagVal('--url');
const compact    = flagExists('--compact');
const dryRun     = flagExists('--dry-run');

if (!packageXml) {
  console.error('[run-org-compare] --package-xml <path> is required.');
  process.exit(1);
}
if (!sourceOrg) {
  console.error('[run-org-compare] --source-org <alias> is required.');
  process.exit(1);
}

// Determine mode from flags
const mode = targetOrg ? 'twoOrg' : gitRef ? 'orgVsGit' : 'orgVsLocal';

console.log(`[run-org-compare] mode=${mode} sourceOrg=${sourceOrg}${targetOrg ? ' targetOrg=' + targetOrg : ''}${gitRef ? ' gitRef=' + gitRef : ''}`);

(async () => {
  const changedFiles = getChangedFilesOrgCompare({
    mode,
    packageXmlPath: packageXml,
    sourceOrg,
    targetOrg,
    gitRef,
    repoRoot: process.cwd(),
  });

  if (changedFiles.length === 0) {
    console.log('[run-org-compare] No differences found.');
    return;
  }

  console.log(`[run-org-compare] ${changedFiles.length} file(s) differ. Building blocks...`);

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
    console.log('[run-org-compare] No blocks to process after parsing.');
    return;
  }

  console.log(`[run-org-compare] ${blocks.length} block(s) ready. Adapter: ${adapter}`);

  if (adapter === 'stdout') {
    const { consume } = require('../adapters/stdout');
    await consume(blocks, { compact, skippedCount: skipped });

  } else if (adapter === 'notion') {
    if (dryRun) {
      console.log('[run-org-compare] [dry-run] Would write to Notion.');
      const { consume } = require('../adapters/notion');
      await consume([], { dryRun: true });
    } else {
      const { consumeRaw } = require('../adapters/notion');
      await consumeRaw(blocks);
    }

  } else if (adapter === 'claude') {
    const { consume: claudeConsume } = require('../adapters/claude');
    const result = await claudeConsume(blocks, { compact, skippedCount: skipped });
    if (result.outputs.length > 0) {
      const { consume: notionConsume } = require('../adapters/notion');
      await notionConsume(result.outputs, { dryRun });
    }

  } else if (adapter === 'webhook') {
    if (!webhookUrl) {
      console.error('[run-org-compare] --url <endpoint> is required when --adapter webhook');
      process.exit(1);
    }
    const { consume: webhookConsume } = require('../adapters/webhook');
    await webhookConsume(blocks, { url: webhookUrl, compact, skippedCount: skipped });

  } else {
    console.error(`[run-org-compare] Unknown adapter: "${adapter}". Use stdout, notion, claude, or webhook.`);
    process.exit(1);
  }
})();
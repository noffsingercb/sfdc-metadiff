// scripts/run-webhook.js
// Webhook runner -- builds MDIF blocks from changed files and POSTs them
// to any HTTP endpoint via the webhook adapter.
//
// Three payload modes:
//   json    -- structured JSON with semantic data (default)
//             good for Zapier, Make, custom APIs
//   mdif    -- full MDIF document as plain text
//             good for systems that consume structured text
//   claude  -- runs MDIF through Claude first, then POSTs interpreted outputs
//             requires ANTHROPIC_API_KEY in addition to WEBHOOK_URL
//
// URL and auth can be passed as flags or environment variables:
//   WEBHOOK_URL         -- target endpoint (overridden by --url)
//   WEBHOOK_AUTH_HEADER -- value for Authorization header (overridden by --auth)
//
// Usage:
//   node scripts/run-webhook.js --manual <old-dir> <new-dir> --url <endpoint>
//   node scripts/run-webhook.js --manual <old-dir> <new-dir> --url <endpoint> --mode mdif
//   node scripts/run-webhook.js --manual <old-dir> <new-dir> --url <endpoint> --mode claude
//   node scripts/run-webhook.js --manual <old-dir> <new-dir> --url <endpoint> --compact
//   node scripts/run-webhook.js --manual <old-dir> <new-dir> --url <endpoint> --dry-run
//   node scripts/run-webhook.js --manual <old-dir> <new-dir> --url <endpoint> --auth "Bearer token"

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

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------
const args       = process.argv.slice(2);
const flag       = (n) => args.indexOf(n);
const flagVal    = (n) => { const i = flag(n); return i !== -1 ? args[i + 1] : null; };
const flagExists = (n) => args.includes(n);

const manualIdx  = flag('--manual');
const compact    = flagExists('--compact');
const dryRun     = flagExists('--dry-run');
const mode       = flagVal('--mode') ?? 'json';           // json | mdif | claude
const url        = flagVal('--url')  ?? process.env.WEBHOOK_URL;
const authHeader = flagVal('--auth') ?? process.env.WEBHOOK_AUTH_HEADER ?? null;

const VALID_MODES = ['json', 'mdif', 'claude'];

// ---------------------------------------------------------------------------
// Validation -- fail fast with clear messages before touching any files
// ---------------------------------------------------------------------------
if (!url) {
  console.error(
    '[run-webhook] No endpoint URL provided.\n' +
    'Pass --url <endpoint> or set the WEBHOOK_URL environment variable.'
  );
  process.exit(1);
}

if (!VALID_MODES.includes(mode)) {
  console.error(`[run-webhook] Unknown mode: "${mode}". Valid modes: ${VALID_MODES.join(', ')}`);
  process.exit(1);
}

if (mode === 'claude' && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    '[run-webhook] Mode "claude" requires ANTHROPIC_API_KEY.\n' +
    'Set the environment variable or switch to --mode json or --mode mdif.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  let changedFiles;

  if (manualIdx !== -1) {
    const oldDir = args[manualIdx + 1];
    const newDir = args[manualIdx + 2];
    if (!oldDir || !newDir || oldDir.startsWith('--') || newDir.startsWith('--')) {
      console.error('Usage: node scripts/run-webhook.js --manual <old-dir> <new-dir> --url <endpoint>');
      process.exit(1);
    }
    console.log(`[run-webhook] Manual mode: ${oldDir} vs ${newDir}  [mode: ${mode}]${dryRun ? ' [DRY RUN]' : ''}`);
    changedFiles = getChangedFilesManual(oldDir, newDir);
  } else {
    console.log(`[run-webhook] Git mode: reading last commit...  [mode: ${mode}]${dryRun ? ' [DRY RUN]' : ''}`);
    changedFiles = getChangedFiles(process.cwd());
  }

  // ---------------------------------------------------------------------------
  // Build blocks
  // ---------------------------------------------------------------------------
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
    console.log('[run-webhook] No blocks to process.');
    return;
  }

  console.log(`[run-webhook] ${blocks.length} block(s) built. ${skipped} file(s) skipped.`);

  const headers = authHeader ? { 'Authorization': authHeader } : {};
  const { consume: webhookConsume } = require('../adapters/webhook');

  // ---------------------------------------------------------------------------
  // Claude mode: MDIF -> Claude interpretation -> POST outputs as JSON
  // ---------------------------------------------------------------------------
  if (mode === 'claude') {
    console.log(`\n[run-webhook] Step 1: Claude interpretation (${blocks.length} block(s))...`);
    const { consume: claudeConsume } = require('../adapters/claude');
    const claudeResult = await claudeConsume(blocks, { compact, skippedCount: skipped });

    if (!claudeResult.outputs.length) {
      console.log('[run-webhook] Claude returned no outputs. Nothing to POST.');
      return;
    }

    console.log(`\n[run-webhook] Step 2: POSTing ${claudeResult.outputs.length} output(s) to ${url}...`);

    if (!dryRun) {
      await webhookConsume(blocks, {
        url,
        mode: 'claude',
        headers,
        compact,
        skippedCount: skipped,
        claudeOutputs: claudeResult.outputs,
      });
    } else {
      console.log(`[run-webhook] [dry-run] Would POST claude outputs to: ${url}`);
      console.log(JSON.stringify({ outputCount: claudeResult.outputs.length }, null, 2));
    }

  // ---------------------------------------------------------------------------
  // JSON or MDIF mode: POST MDIF blocks directly
  // ---------------------------------------------------------------------------
  } else {
    console.log(`\n[run-webhook] POSTing ${mode} payload to ${url}...`);

    if (!dryRun) {
      await webhookConsume(blocks, { url, mode, headers, compact, skippedCount: skipped });
    } else {
      // Dry run: build and print the full payload without sending
      const { formatDocument } = require('../src/format');

      if (mode === 'mdif') {
        const doc = formatDocument(blocks, { compact, skippedCount: skipped });
        console.log(`[run-webhook] [dry-run] Would POST mdif payload to: ${url}`);
        console.log('---');
        console.log(doc);
      } else {
        const payload = {
          generatedAt: new Date().toISOString(),
          blockCount:  blocks.length,
          skipped,
          compact,
          blocks: blocks.map(b => ({
            changeType:      b.changeType,
            componentType:   b.componentType,
            apiName:         b.apiName,
            parentObject:    b.parentObject || null,
            metadataType:    b.metadataType,
            semanticChanges: b.semanticChanges,
          })),
        };
        console.log(`[run-webhook] [dry-run] Would POST json payload to: ${url}`);
        console.log(JSON.stringify(payload, null, 2));
      }
    }
  }

  if (dryRun) console.log('\n[run-webhook] DRY RUN complete -- nothing was sent.');
})();
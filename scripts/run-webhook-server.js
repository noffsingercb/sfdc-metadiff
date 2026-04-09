// scripts/run-webhook-server.js
// HTTP server that receives inbound webhooks from Gearset and/or Copado,
// runs the MDIF pipeline on the changed components, and feeds results
// into the configured downstream adapter.
//
// Usage:
//   node scripts/run-webhook-server.js
//   node scripts/run-webhook-server.js --port 4000
//   node scripts/run-webhook-server.js --adapter notion
//   node scripts/run-webhook-server.js --adapter webhook --url https://...
//
// Environment variables:
//   WEBHOOK_SERVER_PORT    HTTP port to listen on (default: 3000)
//   GEARSET_ORG_ALIAS      sf CLI alias for the org Gearset deploys to
//   GEARSET_SECRET         Optional shared secret for Gearset payload validation
//   COPADO_ORG_ALIAS       sf CLI alias for the org Copado deploys to
//   COPADO_SECRET          Optional shared secret for Copado payload validation
//   WEBHOOK_URL            Downstream webhook URL (when --adapter webhook)
//   NOTION_TOKEN           Notion integration token (when --adapter notion)
//   ANTHROPIC_API_KEY      Anthropic key (when --adapter claude)

const http = require('http');
const path = require('path');
const { createGearsetReceiver } = require('../src/sources/gearsetWebhook');
const { createCopadoReceiver }  = require('../src/sources/copadoWebhook');
const { getParser } = require('../src/differ');

const args       = process.argv.slice(2);
const flagVal    = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };
const flagExists = (n) => args.includes(n);

const port       = parseInt(flagVal('--port') ?? process.env.WEBHOOK_SERVER_PORT ?? '3000', 10);
const adapter    = flagVal('--adapter') ?? 'stdout';
const webhookUrl = flagVal('--url') ?? process.env.WEBHOOK_URL;
const compact    = flagExists('--compact');
const dryRun     = flagExists('--dry-run');

const gearsetOrg    = process.env.GEARSET_ORG_ALIAS;
const gearsetSecret = process.env.GEARSET_SECRET;
const copadoOrg     = process.env.COPADO_ORG_ALIAS;
const copadoSecret  = process.env.COPADO_SECRET;

// ---------------------------------------------------------------------------
// resolveMetadata / buildSemanticChanges -- same helpers as all other runners.
// ---------------------------------------------------------------------------
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
// buildBlocksFromChangedFiles -- shared pipeline step: changed files -> MDIF blocks.
// ---------------------------------------------------------------------------
function buildBlocksFromChangedFiles(changedFiles) {
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
  return { blocks, skipped };
}

// ---------------------------------------------------------------------------
// dispatchToAdapter -- sends MDIF blocks to the configured adapter.
// ---------------------------------------------------------------------------
async function dispatchToAdapter(blocks, skipped) {
  if (blocks.length === 0) {
    console.log('[webhook-server] No blocks after parsing -- nothing to dispatch.');
    return;
  }
  console.log(`[webhook-server] Dispatching ${blocks.length} block(s) to adapter: ${adapter}`);

  if (adapter === 'stdout') {
    const { consume } = require('../adapters/stdout');
    await consume(blocks, { compact, skippedCount: skipped });

  } else if (adapter === 'notion') {
    const { consumeRaw } = require('../adapters/notion');
    await consumeRaw(blocks, { dryRun });

  } else if (adapter === 'claude') {
    const { consume: claudeConsume } = require('../adapters/claude');
    const result = await claudeConsume(blocks, { compact, skippedCount: skipped });
    if (result.outputs.length > 0) {
      const { consume: notionConsume } = require('../adapters/notion');
      await notionConsume(result.outputs, { dryRun });
    }

  } else if (adapter === 'webhook') {
    if (!webhookUrl) throw new Error('[webhook-server] WEBHOOK_URL or --url required for webhook adapter.');
    const { consume: webhookConsume } = require('../adapters/webhook');
    await webhookConsume(blocks, { url: webhookUrl, compact, skippedCount: skipped });
  }
}

// ---------------------------------------------------------------------------
// Create route handlers
// ---------------------------------------------------------------------------
const gearsetHandler = gearsetOrg
  ? createGearsetReceiver({
      orgAlias: gearsetOrg,
      secret:   gearsetSecret,
      repoRoot: process.cwd(),
      onBlocks: async (changedFiles) => {
        const { blocks, skipped } = buildBlocksFromChangedFiles(changedFiles);
        await dispatchToAdapter(blocks, skipped);
      },
    })
  : null;

const copadoHandler = copadoOrg
  ? createCopadoReceiver({
      orgAlias: copadoOrg,
      secret:   copadoSecret,
      repoRoot: process.cwd(),
      onBlocks: async (changedFiles) => {
        const { blocks, skipped } = buildBlocksFromChangedFiles(changedFiles);
        await dispatchToAdapter(blocks, skipped);
      },
    })
  : null;

// ---------------------------------------------------------------------------
// HTTP server -- routes by path
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  console.log(`[webhook-server] ${req.method} ${req.url}`);

  if (req.url === '/gearset' || req.url === '/gearset/') {
    if (!gearsetHandler) {
      console.warn('[webhook-server] Gearset handler not configured (GEARSET_ORG_ALIAS not set).');
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Gearset handler not configured');
      return;
    }
    return gearsetHandler(req, res);
  }

  if (req.url === '/copado' || req.url === '/copado/') {
    if (!copadoHandler) {
      console.warn('[webhook-server] Copado handler not configured (COPADO_ORG_ALIAS not set).');
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Copado handler not configured');
      return;
    }
    return copadoHandler(req, res);
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      adapter,
      gearset: gearsetOrg ? 'configured' : 'not configured',
      copado:  copadoOrg  ? 'configured' : 'not configured',
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(port, () => {
  console.log(`[webhook-server] Listening on port ${port}`);
  console.log(`  /gearset  -> ${gearsetOrg ? 'Gearset receiver (org: ' + gearsetOrg + ')' : 'NOT CONFIGURED (set GEARSET_ORG_ALIAS)'}`);
  console.log(`  /copado   -> ${copadoOrg  ? 'Copado receiver  (org: ' + copadoOrg  + ')' : 'NOT CONFIGURED (set COPADO_ORG_ALIAS)'}`);
  console.log(`  /health   -> status check`);
  console.log(`  adapter   -> ${adapter}${webhookUrl ? ' (' + webhookUrl + ')' : ''}`);
});
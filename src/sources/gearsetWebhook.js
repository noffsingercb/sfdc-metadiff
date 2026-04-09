// src/sources/gearsetWebhook.js
// Inbound HTTP receiver for Gearset outgoing webhook events.
//
// Gearset fires a POST to your endpoint when a CI job deployment event occurs.
// The payload contains the component list and deployment metadata but NOT file content.
// This module:
//   1. Parses the Gearset payload
//   2. Builds a temporary package.xml from the component list
//   3. Retrieves current file content from the target org via sf CLI
//   4. Gets previous content from git (HEAD of the connected repo)
//   5. Returns the standard { filePath, status, oldContent, newContent } shape
//
// Gearset setup:
//   In Gearset CI job settings -> Add outgoing webhook -> set URL to http://your-server:PORT/gearset
//
// Gearset payload shape (as documented):
// {
//   "deploymentId": "...",
//   "status": "Succeeded" | "Failed" | "Validating" | ...,
//   "sourceOrg": { "name": "...", "orgId": "..." },
//   "targetOrg": { "name": "...", "orgId": "..." },
//   "deployedComponents": [
//     { "type": "ApexClass", "apiName": "MyClass", "action": "Deploy" | "Delete" },
//     ...
//   ]
// }

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// buildPackageXml -- constructs a minimal package.xml from a component list.
// components: [{ type, apiName }]
// ---------------------------------------------------------------------------
function buildPackageXml(components, apiVersion = '59.0') {
  // Group by type
  const byType = {};
  for (const { type, apiName } of components) {
    if (!byType[type]) byType[type] = [];
    byType[type].push(apiName);
  }

  const typeBlocks = Object.entries(byType).map(([type, members]) => {
    const memberLines = members.map(m => `        <members>${m}</members>`).join('\n');
    return `    <types>\n${memberLines}\n        <name>${type}</name>\n    </types>`;
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    typeBlocks,
    `    <version>${apiVersion}</version>`,
    '</Package>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// retrieveComponents -- writes a temp package.xml and runs sf retrieve.
// Returns the temp output directory path.
// ---------------------------------------------------------------------------
function retrieveComponents(components, orgAlias, apiVersion) {
  const tmpDir     = path.join(os.tmpdir(), `gearset_recv_${Date.now()}`);
  const pkgXmlPath = path.join(tmpDir, 'package.xml');
  const outDir     = path.join(tmpDir, 'retrieved');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(pkgXmlPath, buildPackageXml(components, apiVersion));

  console.log(`[gearsetWebhook] Retrieving ${components.length} component(s) from org: ${orgAlias}`);
  execSync(
    `sf project retrieve start --manifest "${pkgXmlPath}" --target-org "${orgAlias}" --output-dir "${outDir}"`,
    { encoding: 'utf8', stdio: 'pipe' }
  );
  return outDir;
}

// ---------------------------------------------------------------------------
// walkDir -- recursively collect all file paths under a directory.
// ---------------------------------------------------------------------------
function walkDir(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, results);
    else results.push(full);
  }
  return results;
}

// ---------------------------------------------------------------------------
// processGearsetPayload -- parses a Gearset webhook payload and returns
// the standard changed-file shape.
//
// opts:
//   orgAlias    {string}  sf CLI alias for the target org. Required.
//   repoRoot    {string}  git repo root for old content lookup. Default: process.cwd().
//   gitRef      {string}  git ref for "before" state. Default: 'HEAD'.
//   apiVersion  {string}  Salesforce API version for retrieve. Default: '59.0'.
//   onlySuccess {boolean} Skip payload if deployment status is not 'Succeeded'. Default: true.
//
// Returns: Array<{ filePath, status, oldContent, newContent }> or null if skipped.
// ---------------------------------------------------------------------------
function processGearsetPayload(payload, opts = {}) {
  const {
    orgAlias,
    repoRoot   = process.cwd(),
    gitRef     = 'HEAD',
    apiVersion = '59.0',
    onlySuccess = true,
  } = opts;

  if (!orgAlias) throw new Error('[gearsetWebhook] opts.orgAlias is required.');

  if (onlySuccess && payload.status !== 'Succeeded') {
    console.log(`[gearsetWebhook] Skipping payload with status: ${payload.status}`);
    return null;
  }

  const components = payload.deployedComponents ?? [];
  if (components.length === 0) {
    console.log('[gearsetWebhook] No deployed components in payload.');
    return [];
  }

  // Separate deployed (new/modified) from deleted components
  const deployed = components.filter(c => c.action !== 'Delete');
  const deleted  = components.filter(c => c.action === 'Delete');

  const entries = [];
  let retrievedDir = null;

  try {
    if (deployed.length > 0) {
      retrievedDir = retrieveComponents(deployed, orgAlias, apiVersion);

      for (const filePath of walkDir(retrievedDir)) {
        const relPath    = path.relative(retrievedDir, filePath);
        const projectPath = path.join(repoRoot, relPath);
        const newContent = fs.readFileSync(filePath, 'utf8');
        const gitRelPath = relPath.replace(/\\/g, '/');

        let oldContent = null;
        let status = 'M';
        try {
          oldContent = execSync(`git show "${gitRef}":"${gitRelPath}"`, {
            cwd: repoRoot, encoding: 'utf8',
          });
          if (oldContent === newContent) continue; // unchanged -- skip
        } catch {
          status = 'A'; // not in git -- new component
        }

        entries.push({ filePath: projectPath, status, oldContent, newContent });
      }
    }

    // Deleted components: get old content from git
    for (const { type, apiName } of deleted) {
      // Try to find the file in git at the given ref by resolving path conventions
      // This is best-effort; resolveDestructivePath from sfdxGitDelta.js can be reused
      // if needed. For now, log and skip unresolvable types.
      console.log(`[gearsetWebhook] Deleted component (manual review may be needed): ${type}:${apiName}`);
    }

  } finally {
    // Clean up retrieved files
    if (retrievedDir) {
      const tmpDir = path.dirname(retrievedDir);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// createGearsetReceiver -- creates an HTTP request handler for Gearset webhooks.
//
// opts: same as processGearsetPayload opts, plus:
//   secret    {string}  Optional shared secret to validate X-Gearset-Signature header.
//   onBlocks  {function}  Async callback(blocks) called with the built block list.
//                         This is where you plug in the parser + adapter pipeline.
//
// Returns: a Node.js http.IncomingMessage handler function.
// Intended for use with http.createServer() or run-webhook-server.js.
// ---------------------------------------------------------------------------
function createGearsetReceiver(opts = {}) {
  const { secret, onBlocks, ...processOpts } = opts;

  return async function gearsetHandler(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // Collect request body
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        // Optional signature verification
        if (secret) {
          const sig = req.headers['x-gearset-signature'] ?? req.headers['x-hub-signature-256'] ?? '';
          const crypto = require('crypto');
          const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
          if (sig !== expected) {
            console.warn('[gearsetWebhook] Signature mismatch -- request rejected.');
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
          }
        }

        const payload = JSON.parse(body);
        console.log(`[gearsetWebhook] Received payload: deploymentId=${payload.deploymentId} status=${payload.status}`);

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK'); // Acknowledge immediately; processing is async

        // Process and build block list
        const changedFiles = processGearsetPayload(payload, processOpts);
        if (!changedFiles || changedFiles.length === 0) {
          console.log('[gearsetWebhook] No changed files to process.');
          return;
        }

        if (onBlocks) await onBlocks(changedFiles);

      } catch (err) {
        console.error('[gearsetWebhook] Error processing payload:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    });
  };
}

module.exports = { processGearsetPayload, createGearsetReceiver, buildPackageXml };
// src/sources/copadoWebhook.js
// Inbound HTTP receiver for Copado Essentials and Copado enterprise webhooks.
//
// Copado setup (Essentials):
//   Deploy Options tab -> Advanced Options -> enable "Outgoing webhooks" -> set URL
//   to http://your-server:PORT/copado
//
// Copado setup (enterprise):
//   Deployment Steps -> URL Callout step -> configure URL and payload template
//
// Default Copado Essentials payload shape:
// {
//   "status":           "Success" | "Failed" | "In Progress",
//   "deploymentAction": "Deploy" | "Validate",
//   "sourceOrg":        "...",
//   "destinationOrg":   "...",
//   "components": [
//     { "type": "ApexClass", "name": "MyClass", "status": "Succeeded" },
//     ...
//   ]
// }
//
// Note: Copado's payload template is user-configurable. If your Copado instance
// uses a custom template, update parseCopadoPayload() to match.

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Re-use the package.xml builder and retrieve helper from gearsetWebhook.
// Both sources share the same retrieval pattern.
const { buildPackageXml } = require('./gearsetWebhook');

// ---------------------------------------------------------------------------
// retrieveComponents -- writes a temp package.xml and runs sf retrieve.
// Returns the temp output directory path.
// (Duplicated here rather than shared to keep sources self-contained for
// cases where only one webhook source is used.)
// ---------------------------------------------------------------------------
function retrieveComponents(components, orgAlias, apiVersion) {
  const tmpDir     = path.join(os.tmpdir(), `copado_recv_${Date.now()}`);
  const pkgXmlPath = path.join(tmpDir, 'package.xml');
  const outDir     = path.join(tmpDir, 'retrieved');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(pkgXmlPath, buildPackageXml(components, apiVersion));

  console.log(`[copadoWebhook] Retrieving ${components.length} component(s) from org: ${orgAlias}`);
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
// parseCopadoPayload -- normalises a Copado payload into a standard shape.
// Returns { status, orgAlias, components: [{ type, apiName }] }.
//
// Handles both Copado Essentials and Copado enterprise default payload shapes.
// If your Copado instance uses a custom payload template, update this function.
// ---------------------------------------------------------------------------
function parseCopadoPayload(payload) {
  // Copado Essentials: components[].name + components[].type
  // Copado enterprise: may use different field names depending on template
  const rawComponents = payload.components ?? payload.deployedComponents ?? [];

  const components = rawComponents
    .filter(c => (c.status ?? 'Succeeded') !== 'Failed') // skip failed components
    .map(c => ({
      type:    c.type ?? c.componentType,
      apiName: c.name ?? c.apiName ?? c.fullName,
      action:  c.action ?? payload.deploymentAction ?? 'Deploy',
    }))
    .filter(c => c.type && c.apiName);

  // Normalise org alias: prefer destinationOrg (where components live post-deploy)
  const orgAlias = payload.destinationOrg ?? payload.targetOrg ?? payload.sourceOrg;

  const status = payload.status ?? payload.deploymentStatus;

  return { status, orgAlias, components };
}

// ---------------------------------------------------------------------------
// processCopadoPayload -- parses a Copado webhook payload and returns
// the standard changed-file shape.
//
// opts:
//   orgAlias    {string}  Override org alias (if not in payload or needs mapping).
//   repoRoot    {string}  git repo root for old content lookup. Default: process.cwd().
//   gitRef      {string}  git ref for "before" state. Default: 'HEAD'.
//   apiVersion  {string}  Salesforce API version for retrieve. Default: '59.0'.
//   onlySuccess {boolean} Skip payload if status is not 'Success'. Default: true.
//
// Returns: Array<{ filePath, status, oldContent, newContent }> or null if skipped.
// ---------------------------------------------------------------------------
function processCopadoPayload(payload, opts = {}) {
  const {
    orgAlias: orgAliasOverride,
    repoRoot   = process.cwd(),
    gitRef     = 'HEAD',
    apiVersion = '59.0',
    onlySuccess = true,
  } = opts;

  const { status, orgAlias: payloadOrg, components } = parseCopadoPayload(payload);
  const orgAlias = orgAliasOverride ?? payloadOrg;

  if (!orgAlias) {
    throw new Error(
      '[copadoWebhook] Could not determine org alias from payload.\n' +
      'Pass opts.orgAlias explicitly if your Copado payload uses a custom template.'
    );
  }

  if (onlySuccess && status !== 'Success' && status !== 'Succeeded') {
    console.log(`[copadoWebhook] Skipping payload with status: ${status}`);
    return null;
  }

  const toRetrieve = components.filter(c => c.action !== 'Delete');
  if (toRetrieve.length === 0) {
    console.log('[copadoWebhook] No components to retrieve.');
    return [];
  }

  const entries = [];
  let retrievedDir = null;

  try {
    retrievedDir = retrieveComponents(toRetrieve, orgAlias, apiVersion);

    for (const filePath of walkDir(retrievedDir)) {
      const relPath     = path.relative(retrievedDir, filePath);
      const projectPath = path.join(repoRoot, relPath);
      const newContent  = fs.readFileSync(filePath, 'utf8');
      const gitRelPath  = relPath.replace(/\\/g, '/');

      let oldContent = null;
      let status = 'M';
      try {
        oldContent = execSync(`git show "${gitRef}":"${gitRelPath}"`, {
          cwd: repoRoot, encoding: 'utf8',
        });
        if (oldContent === newContent) continue;
      } catch {
        status = 'A';
      }

      entries.push({ filePath: projectPath, status, oldContent, newContent });
    }

  } finally {
    if (retrievedDir) {
      const tmpDir = path.dirname(retrievedDir);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// createCopadoReceiver -- creates an HTTP request handler for Copado webhooks.
//
// opts: same as processCopadoPayload opts, plus:
//   secret   {string}    Optional shared secret to validate payload.
//   onBlocks {function}  Async callback(changedFiles) called after processing.
//
// Returns: a Node.js http.IncomingMessage handler function.
// ---------------------------------------------------------------------------
function createCopadoReceiver(opts = {}) {
  const { secret, onBlocks, ...processOpts } = opts;

  return async function copadoHandler(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        // Optional shared-secret validation (Copado sends it in payload body
        // or as a custom header depending on your template)
        if (secret) {
          let payloadObj;
          try { payloadObj = JSON.parse(body); } catch { payloadObj = {}; }
          const payloadSecret = payloadObj.secret ?? req.headers['x-copado-secret'] ?? '';
          if (payloadSecret !== secret) {
            console.warn('[copadoWebhook] Secret mismatch -- request rejected.');
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
          }
        }

        const payload = JSON.parse(body);
        console.log(`[copadoWebhook] Received payload: status=${payload.status ?? payload.deploymentStatus}`);

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');

        const changedFiles = processCopadoPayload(payload, processOpts);
        if (!changedFiles || changedFiles.length === 0) {
          console.log('[copadoWebhook] No changed files to process.');
          return;
        }

        if (onBlocks) await onBlocks(changedFiles);

      } catch (err) {
        console.error('[copadoWebhook] Error processing payload:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    });
  };
}

module.exports = { processCopadoPayload, createCopadoReceiver, parseCopadoPayload };
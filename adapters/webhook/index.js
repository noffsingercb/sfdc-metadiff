// adapters/webhook/index.js
// Webhook adapter -- POSTs MDIF data to any HTTP endpoint.
// Zero Salesforce knowledge. Zero destination assumptions.
// Works with Slack incoming webhooks, Zapier, Make, custom endpoints.
//
// Three payload modes:
//   'json'    -- structured JSON with parsed blocks (default)
//   'mdif'    -- raw MDIF document as plain text body
//   'claude'  -- structured claude ==OUTPUT== objects as JSON

const https = require('https');
const http  = require('http');
const { formatDocument } = require('../../src/format');

// ---------------------------------------------------------------------------
// HTTP POST helper (no external dependencies)
// ---------------------------------------------------------------------------

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://');
    const lib = isHttps ? https : http;
    const parsed = new URL(url);
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   typeof body === 'string' ? 'text/plain' : 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// consume(blocks, opts)
//
// opts:
//   url           {string}   Required. HTTP/HTTPS endpoint to POST to.
//   mode          {string}   'json' | 'mdif' | 'claude'. Default: 'json'.
//   headers       {object}   Additional HTTP headers (e.g. Authorization).
//   compact       {boolean}  Pass compact mode to formatDocument. Default: false.
//   skippedCount  {number}   Skipped file count for batch summary. Default: 0.
//   claudeOutputs {Array}    Required when mode is 'claude'.
//
// Returns: { status, body } from the HTTP response.
// ---------------------------------------------------------------------------

async function consume(blocks, opts = {}) {
  const {
    url,
    mode         = 'json',
    headers      = {},
    compact      = false,
    skippedCount = 0,
    claudeOutputs = null,
  } = opts;

  if (!url) throw new Error('[webhook adapter] opts.url is required.');

  let payload;

  if (mode === 'json') {
    // Structured JSON -- strips raw file content, keeps semantic data
    payload = {
      generatedAt:  new Date().toISOString(),
      blockCount:   blocks.length,
      skipped:      skippedCount,
      compact,
      blocks: blocks.map(b => ({
        changeType:       b.changeType,
        componentType:    b.componentType,
        apiName:          b.apiName,
        parentObject:     b.parentObject || null,
        metadataType:     b.metadataType,
        semanticChanges:  b.semanticChanges,
      })),
    };

  } else if (mode === 'mdif') {
    // Full MDIF document as plain text
    payload = formatDocument(blocks, { compact, skippedCount });

  } else if (mode === 'claude') {
    if (!claudeOutputs) {
      throw new Error('[webhook adapter] opts.claudeOutputs is required when mode is "claude".');
    }
    payload = {
      generatedAt: new Date().toISOString(),
      outputs:     claudeOutputs,
    };

  } else {
    throw new Error(`[webhook adapter] Unknown mode: "${mode}". Use 'json', 'mdif', or 'claude'.`);
  }

  console.log(`[webhook adapter] POST ${mode} payload to ${url}`);

  const result = await post(url, payload, headers);

  if (result.status >= 200 && result.status < 300) {
    console.log(`[webhook adapter] \u2705 HTTP ${result.status}`);
  } else {
    console.warn(`[webhook adapter] \u26a0\ufe0f HTTP ${result.status} -- ${result.body.slice(0, 200)}`);
  }

  return result;
}

module.exports = { consume };
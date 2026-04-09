// adapters/claude/index.js
// Claude adapter -- sends an MDIF document to the Anthropic API using the
// MDIF Processing Playbook as the system prompt, then parses the structured
// ==OUTPUT== blocks from the response.
//
// Usage (programmatic):
//   const { consume } = require('./adapters/claude');
//   const result = await consume(blocks, { apiKey: process.env.ANTHROPIC_API_KEY });
//
// Returns: { outputs, batchReport, rawResponse }

const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { formatDocument } = require('../../src/format');

const DEFAULT_MODEL        = 'claude-opus-4-5';
const DEFAULT_MAX_TOKENS   = 8192;
const DEFAULT_PLAYBOOK_PATH = path.join(__dirname, '../../spec/MDIF-playbook-v0.1.md');

// ---------------------------------------------------------------------------
// Playbook loader
// ---------------------------------------------------------------------------

function loadPlaybook(playbookPath) {
  const resolved = playbookPath ?? DEFAULT_PLAYBOOK_PATH;
  if (!fs.existsSync(resolved)) {
    throw new Error(`[claude adapter] Playbook not found at: ${resolved}\nSave spec/MDIF-playbook-v0.1.md first.`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

// Parse all ==OUTPUT== ... ==END OUTPUT== blocks from the LLM response.
function parseOutputBlocks(response) {
  const outputs = [];
  const pattern = /==OUTPUT==([\.\s\S]*?)==END OUTPUT==/g;
  let match;
  while ((match = pattern.exec(response)) !== null) {
    outputs.push(parseOneOutputBlock(match[1].trim()));
  }
  return outputs;
}

function parseOneOutputBlock(block) {
  const result = {
    component:       extractLine(block, 'COMPONENT'),
    parentObject:    extractLine(block, 'PARENT_OBJECT'),
    action:          extractLine(block, 'ACTION'),
    confidence:      extractLine(block, 'CONFIDENCE'),
    changeSummary:   extractSection(block, 'CHANGE_SUMMARY',   ['CHANGE_LOG_ENTRY', 'UPDATED_SECTIONS']),
    changeLogEntry:  extractSection(block, 'CHANGE_LOG_ENTRY', ['UPDATED_SECTIONS']),
    updatedSections: parseUpdatedSections(block),
  };
  return result;
}

// Extract a single-line header value: "KEY: value"
function extractLine(block, key) {
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

// Extract a multi-line section between a label and the next label (or end).
function extractSection(block, label, nextLabels) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nextAlts = nextLabels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(
    `${escapedLabel}:\\s*([\\s\\S]*?)(?=(?:${nextAlts}):|$)`
  );
  const match = block.match(pattern);
  return match ? match[1].trim() : null;
}

// Parse named sub-sections within UPDATED_SECTIONS.
function parseUpdatedSections(block) {
  const sectionsMatch = block.match(/UPDATED_SECTIONS:[\s\S]*?$/);
  if (!sectionsMatch) return {};

  const text = sectionsMatch[0].replace(/^UPDATED_SECTIONS:\s*/, '');
  const KNOWN_LABELS = ['Overview', 'Technical Details', 'Related Metadata', 'Notes'];
  const result = {};

  for (let i = 0; i < KNOWN_LABELS.length; i++) {
    const label = KNOWN_LABELS[i];
    const next  = KNOWN_LABELS.slice(i + 1);
    const nextAlts = next.length
      ? next.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
      : 'XXXXNOMATCH';
    const pattern = new RegExp(
      `${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*([\\s\\S]*?)(?=(?:${nextAlts}):|$)`
    );
    const match = text.match(pattern);
    if (match) {
      const key = label.toLowerCase().replace(/\s+/g, '_');
      const val = match[1].trim();
      if (val) result[key] = val;
    }
  }
  return result;
}

// Parse the ==BATCH_REPORT== ... ==END BATCH_REPORT== block.
function parseBatchReport(response) {
  const match = response.match(/==BATCH_REPORT==([\s\S]*?)==END BATCH_REPORT==/);
  if (!match) return null;

  const block = match[1];
  const getNum = (label) => {
    const m = block.match(new RegExp(`${label}:\\s*(\\d+)`));
    return m ? parseInt(m[1]) : 0;
  };

  const notesMatch = block.match(/REVIEWER_NOTES:\s*([\s\S]*?)$/);
  const reviewerNotes = notesMatch ? notesMatch[1].trim() || null : null;

  return {
    processed:     getNum('Processed'),
    created:       getNum('Created'),
    updated:       getNum('Updated'),
    archived:      getNum('Archived'),
    skipped:       getNum('Skipped'),
    lowConfidence: getNum('Low Confidence'),
    reviewerNotes,
  };
}

// ---------------------------------------------------------------------------
// consume(blocks, opts)
//
// opts:
//   apiKey       {string}  Anthropic API key. Defaults to ANTHROPIC_API_KEY env var.
//   model        {string}  Claude model ID. Default: claude-opus-4-5
//   maxTokens    {number}  Max response tokens. Default: 8192
//   playbookPath {string}  Path to playbook file. Default: spec/MDIF-playbook-v0.1.md
//   compact      {boolean} Pass compact mode to formatDocument. Default: false
//   skippedCount {number}  Skipped file count for batch summary. Default: 0
//
// Returns: { outputs, batchReport, rawResponse }
// ---------------------------------------------------------------------------

async function consume(blocks, opts = {}) {
  const {
    apiKey       = process.env.ANTHROPIC_API_KEY,
    model        = DEFAULT_MODEL,
    maxTokens    = DEFAULT_MAX_TOKENS,
    playbookPath = null,
    compact      = false,
    skippedCount = 0,
  } = opts;

  if (!apiKey) {
    throw new Error(
      '[claude adapter] API key not found.\n' +
      'Set ANTHROPIC_API_KEY environment variable or pass apiKey in opts.'
    );
  }

  const playbook     = loadPlaybook(playbookPath);
  const mdifDocument = formatDocument(blocks, { compact, skippedCount });

  const client = new Anthropic({ apiKey });

  console.log(`[claude adapter] Sending ${blocks.length} block(s) to ${model}...`);

  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: playbook,
    messages: [
      { role: 'user', content: mdifDocument },
    ],
  });

  const rawResponse = message.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');

  const outputs     = parseOutputBlocks(rawResponse);
  const batchReport = parseBatchReport(rawResponse);

  console.log(`[claude adapter] ${outputs.length} output block(s) parsed.`);

  if (batchReport) {
    const { created, updated, archived, skipped, lowConfidence } = batchReport;
    console.log(
      `[claude adapter] created:${created} updated:${updated} archived:${archived}` +
      ` skipped:${skipped} low-confidence:${lowConfidence}`
    );
  }

  if (message.stop_reason === 'max_tokens') {
    console.warn('[claude adapter] WARNING: Response was cut off at max_tokens. ' +
      'Some OUTPUT blocks may be incomplete. Consider increasing maxTokens or using --compact.');
  }

  return { outputs, batchReport, rawResponse };
}

module.exports = { consume, parseOutputBlocks, parseBatchReport };
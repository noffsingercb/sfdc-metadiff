// src/differ.js
// Routes metadata files to the correct parser.
// Resolution order: Tier 3 (custom) → Tier 2 (namedElementXml) → Tier 1 (genericXml) → extension map

const path = require('path');

const fieldParser      = require('./parsers/field');
const vrParser         = require('./parsers/validationRule');
const flowParser       = require('./parsers/flow');
const apexParser       = require('./parsers/apex');
const genericXml       = require('./parsers/genericXml');
const namedElementXml  = require('./parsers/namedElementXml');
const lwcParser       = require('./parsers/lwc');

const CUSTOM_PARSER_MAP = {
  'field-meta.xml':          { parser: fieldParser, componentType: 'Custom Field' },
  'validationRule-meta.xml': { parser: vrParser,    componentType: 'Validation Rule' },
  'flow-meta.xml':           { parser: flowParser,  componentType: 'Flow' },
};

const EXTENSION_MAP = {
  '.cls':     { parser: apexParser, componentType: 'Apex Class' },
  '.trigger': { parser: apexParser, componentType: 'Apex Trigger' },
};

function getParser(filePath) {
  const basename = path.basename(filePath);

  for (const [suffix, config] of Object.entries(CUSTOM_PARSER_MAP)) {
    if (basename.endsWith(suffix)) return config;
  }

  // Drop the first dot-segment to get the type suffix:
  // "Admin.profile-meta.xml" → "profile-meta.xml"
  const suffix = extractSuffix(basename);
  if (suffix) {
    const namedParser = namedElementXml.getParserForSuffix(suffix);
    if (namedParser) return { parser: namedParser, componentType: namedParser.componentType };

    const genParser = genericXml.getParserForSuffix(suffix);
    if (genParser) return { parser: genParser, componentType: genParser.componentType };
  }
  // LWC files live under lwc/ directories. Path-based routing because
  // .js alone is not a safe suffix to route on in a Salesforce project.
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPath.includes('/lwc/')) {
    if (basename.endsWith('.js-meta.xml')) {
      return { parser: lwcParser, componentType: 'Lightning Web Component' };
    }
    if (basename.endsWith('.js') && !basename.endsWith('.test.js')) {
      return { parser: lwcParser, componentType: 'Lightning Web Component' };
    }
  }
  const ext = path.extname(basename);
  if (EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];

  return null; // unsupported type — skipped silently by cli.js
}

function extractSuffix(basename) {
  const firstDot = basename.indexOf('.');
  if (firstDot === -1) return null;
  return basename.slice(firstDot + 1);
}

module.exports = { getParser };
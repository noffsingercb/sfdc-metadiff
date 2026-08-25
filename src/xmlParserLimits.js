// src/xmlParserLimits.js
// Shared entity-expansion ceiling for every parser that reads Salesforce
// metadata XML via fast-xml-parser.
//
// fast-xml-parser caps total entity references (&amp;, &lt;, ...) per
// document at maxEntityCount: 1000 by default, as a guard against
// "billion laughs" style decompression bombs. That default is tuned for
// arbitrary untrusted XML, not for large-but-legitimate Salesforce
// metadata: a FlexiPage with many components, or an ApprovalProcess with
// several criteria using escaped "&&" logic, can exceed 1000 entity
// references without anything being wrong. GTM-0376 hit this on exactly
// that shape of content and failed with:
//   "Entity expansion limit exceeded: 1028 > 1000"
//
// Raise the ceiling well above what a legitimate large component needs,
// while still bounded (not disabled) -- a real decompression bomb still
// gets caught, just at a higher threshold.
//
// CAUTION: the limit is only honoured through this exact shape. fast-xml-parser
// reads it as this.options.processEntities.maxTotalExpansions -- NOT a top-level
// maxEntityCount option. Passing { maxEntityCount: 10000 } as a sibling of
// ignoreAttributes/parseTagValue is silently ignored: the default
// processEntities: true (boolean) takes a hardcoded internal branch with
// maxTotalExpansions fixed at 1000 and never looks at a sibling maxEntityCount
// key. Confirmed by testing both shapes directly against fast-xml-parser's
// source (src/xmlparser/OptionsBuilder.js normalizeProcessEntities /
// src/xmlparser/OrderedObjParser.js replaceEntitiesValue) -- the top-level key
// silently parses without effect, so this bug would not surface as an error,
// only as the limit never actually moving.
const ENTITY_LIMIT_OPTS = {
  processEntities: { enabled: true, maxTotalExpansions: 10000 },
};

module.exports = { ENTITY_LIMIT_OPTS };

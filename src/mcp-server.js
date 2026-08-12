#!/usr/bin/env node
// src/mcp-server.js
// sfdc-metadiff MCP server.
// Exposes the parser pipeline as MCP tools for any LLM client.
//
// Transport options:
//   stdio (default) -- for Claude Desktop and local clients
//   http            -- for remote/hosted use (set MCP_HTTP=1 and MCP_PORT=<port>)
//
// Usage:
//   node src/mcp-server.js                    # stdio transport
//   MCP_HTTP=1 MCP_PORT=3100 node src/mcp-server.js   # HTTP transport
//
// Claude Desktop config (~/.config/claude-desktop/config.json on Mac):
//   {
//     "mcpServers": {
//       "sfdc-metadiff": {
//         "command": "node",
//         "args": ["/absolute/path/to/sfdc-metadiff/src/mcp-server.js"]
//       }
//     }
//   }

const path = require('path');
const { McpServer }              = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport }   = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                      = require('zod');

const { getParser }       = require('./differ');
const { formatDocument }  = require('./format');

// ---------------------------------------------------------------------------
// Shared pipeline helpers (same logic as cli.js runners)
// ---------------------------------------------------------------------------

function resolveMetadata(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const basename   = path.basename(normalized);
  const parts      = basename.split('.');

  // Decomposed child metadata (fields, validation rules, etc.) is named
  // "<ApiName>.<type>-meta.xml" and lives under ".../objects/<Parent>/<group>/".
  // The parent object comes from the PATH, not the filename.
  const objMatch      = normalized.match(/(?:^|\/)objects\/([^/]+)\//);
  const parentFromPath = objMatch ? objMatch[1] : '';
  const strip = (suffix) => basename.slice(0, basename.length - suffix.length);

  if (basename.endsWith('.field-meta.xml'))          return { apiName: strip('.field-meta.xml'),          parentObject: parentFromPath, metadataType: 'CustomField' };
  if (basename.endsWith('.validationRule-meta.xml')) return { apiName: strip('.validationRule-meta.xml'), parentObject: parentFromPath, metadataType: 'ValidationRule' };
  if (basename.endsWith('.flow-meta.xml'))           return { apiName: strip('.flow-meta.xml'),           parentObject: '',             metadataType: 'Flow' };
  if (basename.endsWith('.flexipage-meta.xml'))      return { apiName: strip('.flexipage-meta.xml'),      parentObject: '',             metadataType: 'FlexiPage' };
  if (basename.endsWith('.flexipage'))               return { apiName: strip('.flexipage'),               parentObject: '',             metadataType: 'FlexiPage' };
  if (basename.endsWith('.cls'))                     return { apiName: strip('.cls'),                     parentObject: '',             metadataType: 'ApexClass' };
  if (basename.endsWith('.trigger'))                 return { apiName: strip('.trigger'),                 parentObject: '',             metadataType: 'ApexTrigger' };
  return { apiName: parts[0], parentObject: '', metadataType: parts.slice(-2, -1)[0] ?? 'Unknown' };
}

function buildSemanticChanges(status, parser, oldContent, newContent, filePath) {
  const filename = path.basename(filePath);
  if (status === 'A') {
    const parsed = parser.parse(newContent, filename);
    return Object.entries(parsed)
      .filter(([k]) => !k.startsWith('__'))
      .map(([element, val]) => ({ type: 'ADDED', element, newValue: String(val ?? '') }));
  }
  if (status === 'D') {
    const parsed = parser.parse(oldContent, filename);
    return Object.entries(parsed)
      .filter(([k]) => !k.startsWith('__'))
      .map(([element, val]) => ({ type: 'REMOVED', element, oldValue: String(val ?? '') }));
  }
  return parser.diff(oldContent, newContent, filename);
}

// Build MDIF blocks from a list of changed files (the standard pipeline step).
function buildBlocks(changedFiles) {
  const blocks  = [];
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

// Format blocks into an MDIF document string and return as MCP tool result.
function blocksToToolResult(blocks, skipped, compact = false) {
  if (blocks.length === 0) {
    return { content: [{ type: 'text', text: 'No semantic changes detected in the provided content.' }] };
  }
  const doc = formatDocument(blocks, { compact, skippedCount: skipped });
  return { content: [{ type: 'text', text: doc }] };
}

// Return a structured error result.
function errorResult(message) {
  return { content: [{ type: 'text', text: `[sfdc-metadiff error] ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Synthetic filename builder for Mode A (direct XML input).
// The parsers and differ use filenames to route to the right parser.
// We synthesize a filename that matches the expected suffix patterns.
// ---------------------------------------------------------------------------
const METADATA_TYPE_TO_SUFFIX = {
  CustomField:              'Account.MyField__c.field-meta.xml',
  ValidationRule:           'Account.MyRule.validationRule-meta.xml',
  Flow:                     'MyFlow.flow-meta.xml',
  FlexiPage:                'MyPage.flexipage-meta.xml',
  ApexClass:                'MyClass.cls',
  ApexTrigger:              'MyTrigger.trigger',
  LightningWebComponent:    'myComponent.js',
  Profile:                  'Admin.profile-meta.xml',
  PermissionSet:            'MyPS.permissionset-meta.xml',
  Workflow:                 'Account.workflow-meta.xml',
  AssignmentRules:          'Case.assignmentRules-meta.xml',
  AutoResponseRules:        'Case.autoResponseRules-meta.xml',
  EscalationRules:          'Case.escalationRules-meta.xml',
  SharingRules:             'Account.sharingRules-meta.xml',
  CustomLabel:              'CustomLabels.labels-meta.xml',
  RecordType:               'Account.Premium.recordType-meta.xml',
  GlobalValueSet:           'MyPicklist.globalValueSet-meta.xml',
  QuickAction:              'Account.NewCase.quickAction-meta.xml',
  CustomPermission:         'MyPermission.customPermission-meta.xml',
};

function syntheticFilePath(metadataType, apiName, parentObject) {
  // Build a synthetic path that differ.js will recognise.
  // The actual content comes from the caller -- the path just drives routing.
  const template = METADATA_TYPE_TO_SUFFIX[metadataType];
  if (!template) {
    // Fall back: use the type as a suffix
    return `${apiName || 'component'}.${metadataType.toLowerCase()}-meta.xml`;
  }

  if (metadataType === 'CustomField' || metadataType === 'ValidationRule' || metadataType === 'RecordType') {
    const obj    = parentObject || 'Account';
    const member = apiName      || template.split('.')[1];
    const suffix = template.split('.').slice(1).join('.');
    return `${obj}.${member}.${suffix}`;
  }

  if (apiName) {
    const suffix = template.split('.').slice(1).join('.');
    return `${apiName}.${suffix}`;
  }

  return template;
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name:    'sfdc-metadiff',
  version: '0.1.0',
});

// ---------------------------------------------------------------------------
// MODE A — Tool 1: parse_metadata_diff
// Parse two versions of a metadata file and return MDIF.
// ---------------------------------------------------------------------------

server.tool(
  'parse_metadata_diff',
  'Parse old and new versions of a Salesforce metadata file and return structured MDIF (MetaDiff Interchange Format) blocks. Use this when you have the raw file content of both versions and want cheap, token-efficient semantic change extraction.',
  {
    metadataType: z.string().describe(
      'Salesforce metadata type. Examples: CustomField, ValidationRule, Flow, ApexClass, ApexTrigger, LightningWebComponent, Profile, PermissionSet, Workflow, GlobalValueSet, RecordType, QuickAction.'
    ),
    oldContent: z.string().describe(
      'Full content of the old version of the file (XML source for metadata types, source code for Apex/LWC). Pass an empty string for newly added components.'
    ),
    newContent: z.string().describe(
      'Full content of the new version of the file. Pass an empty string for deleted components.'
    ),
    apiName: z.string().optional().describe(
      'API name of the component (e.g. My_Field__c, CaseEscalationHandler). Used in MDIF output labels. Inferred from content if omitted.'
    ),
    parentObject: z.string().optional().describe(
      'Parent object API name for child metadata types (CustomField, ValidationRule, RecordType). E.g. "Account", "Case". Omit for org-level components.'
    ),
    compact: z.boolean().optional().describe(
      'If true, omit all RAW_DIFF sections and apply aggressive scalar truncation. Reduces output size by ~60%. Recommended for large batches or token-sensitive contexts.'
    ),
  },
  async ({ metadataType, oldContent, newContent, apiName, parentObject, compact = false }) => {
    try {
      const filePath = syntheticFilePath(metadataType, apiName, parentObject);
      const config   = getParser(filePath);

      if (!config) {
        return errorResult(
          `No parser found for metadata type "${metadataType}". ` +
          `Supported types: ${Object.keys(METADATA_TYPE_TO_SUFFIX).join(', ')}.`
        );
      }

      const { parser, componentType } = config;
      const status      = !oldContent ? 'A' : !newContent ? 'D' : 'M';
      const { apiName: resolvedApi, parentObject: resolvedParent } = resolveMetadata(filePath);
      const statusLabel  = status === 'A' ? 'NEW' : status === 'D' ? 'DELETED' : 'MODIFIED';

      const semanticChanges = buildSemanticChanges(
        status, parser,
        oldContent  || null,
        newContent  || null,
        filePath
      );

      const block = {
        changeType:    statusLabel,
        apiName:       apiName      || resolvedApi,
        parentObject:  parentObject || resolvedParent,
        componentType,
        metadataType,
        semanticChanges,
        oldContent:    oldContent   || null,
        newContent:    newContent   || null,
      };

      return blocksToToolResult([block], 0, compact);

    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ---------------------------------------------------------------------------
// MODE A — Tool 2: parse_raw_diff
// Parse a unified diff string and return MDIF.
// ---------------------------------------------------------------------------

server.tool(
  'parse_raw_diff',
  'Parse a unified diff string (as produced by git diff) for a Salesforce metadata file and return structured MDIF blocks. Use this when you have a diff but not the full file contents.',
  {
    diffText: z.string().describe(
      'A unified diff string (git diff --unified output). Must include the +++ / --- header lines so the filename can be extracted for parser routing.'
    ),
    metadataType: z.string().optional().describe(
      'Salesforce metadata type hint (e.g. CustomField, Flow, ApexClass). If omitted, inferred from the filename in the diff header.'
    ),
    compact: z.boolean().optional().describe(
      'If true, omit RAW_DIFF sections in output and apply aggressive truncation.'
    ),
  },
  async ({ diffText, metadataType, compact = false }) => {
    try {
      // Extract filename from diff header: "+++ b/path/to/file.field-meta.xml"
      const headerMatch = diffText.match(/^\+\+\+ b\/(.+)$/m) || diffText.match(/^\+\+\+ (.+)$/m);
      if (!headerMatch) {
        return errorResult('Could not extract filename from diff header. Ensure the diff includes +++ b/<path> lines.');
      }

      const filePath = headerMatch[1].trim();
      const config   = getParser(filePath);

      if (!config) {
        const hint = metadataType ? ` (metadataType hint: ${metadataType})` : '';
        return errorResult(
          `No parser found for file: "${path.basename(filePath)}"${hint}. ` +
          'Check that the filename has the correct Salesforce metadata suffix.'
        );
      }

      const { parser, componentType } = config;

      // Reconstruct old and new content from unified diff
      const lines      = diffText.split('\n');
      const hunkStart  = lines.findIndex(l => l.startsWith('@@'));
      if (hunkStart === -1) {
        return errorResult('No diff hunks found. Is this a valid unified diff?');
      }

      const hunkLines  = lines.slice(hunkStart);
      const oldLines   = [];
      const newLines   = [];
      for (const line of hunkLines) {
        if (line.startsWith('@@')) continue;
        if (line.startsWith('-'))  oldLines.push(line.slice(1));
        else if (line.startsWith('+')) newLines.push(line.slice(1));
        else { oldLines.push(line.slice(1) || ''); newLines.push(line.slice(1) || ''); }
      }

      // Note: diff reconstruction is partial (only changed hunks, not full file).
      // For semantic parsers this is usually sufficient -- they extract named elements
      // that appear in the changed hunks. For accuracy, prefer parse_metadata_diff
      // with full file content.
      const oldContent = oldLines.join('\n');
      const newContent = newLines.join('\n');

      const { apiName, parentObject } = resolveMetadata(filePath);
      const filename       = path.basename(filePath);
      const semanticChanges = parser.diff(oldContent, newContent, filename);

      const effectiveMetadataType = metadataType || filename.split('.').slice(-2, -1)[0] || 'Unknown';

      const block = {
        changeType:    'MODIFIED',
        apiName,
        parentObject,
        componentType,
        metadataType:  effectiveMetadataType,
        semanticChanges,
        oldContent,
        newContent,
      };

      return blocksToToolResult([block], 0, compact);

    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ---------------------------------------------------------------------------
// MODE B — Tool 3: diff_git_refs
// Diff two git refs and return MDIF for all changed Salesforce metadata.
// ---------------------------------------------------------------------------

server.tool(
  'diff_git_refs',
  'Diff two git refs in a Salesforce DX repository and return MDIF blocks for all changed metadata files. Uses the same parser pipeline as the CLI. Requires git to be installed and the repo to be accessible from the server machine.',
  {
    repoPath: z.string().describe(
      'Absolute path to the git repository root on the server machine. E.g. "/Users/ben/sfdc-project".'
    ),
    fromRef: z.string().optional().describe(
      'The base git ref (older state). Defaults to "HEAD~1" (previous commit).'
    ),
    toRef: z.string().optional().describe(
      'The target git ref (newer state). Defaults to "HEAD" (current commit).'
    ),
    compact: z.boolean().optional().describe(
      'If true, omit RAW_DIFF sections and apply aggressive truncation. Recommended for large commits.'
    ),
  },
  async ({ repoPath, fromRef = 'HEAD~1', toRef = 'HEAD', compact = false }) => {
    try {
      const { getChangedFilesByRef } = require('./git');
      const changedFiles = getChangedFilesByRef(repoPath, { from: fromRef, to: toRef });
      const { blocks, skipped } = buildBlocks(changedFiles);
      return blocksToToolResult(blocks, skipped, compact);
    } catch (err) {
      return errorResult(`Git diff failed: ${err.message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// MODE B — Tool 4: compare_org_to_local
// Retrieve metadata from a Salesforce org and diff against local project.
// ---------------------------------------------------------------------------

server.tool(
  'compare_org_to_local',
  'Retrieve Salesforce metadata from an authenticated org and compare it against local project files. Returns MDIF blocks for all components that differ. Requires sf CLI authenticated to the target org.',
  {
    orgAlias: z.string().describe(
      'Salesforce CLI org alias or username (must be authenticated via sf org login).'
    ),
    packageXmlPath: z.string().describe(
      'Absolute path to a package.xml file that defines which components to retrieve and compare.'
    ),
    projectDir: z.string().optional().describe(
      'Absolute path to the local Salesforce DX project root. Defaults to process.cwd().'
    ),
    compact: z.boolean().optional().describe(
      'If true, omit RAW_DIFF sections and apply aggressive truncation.'
    ),
  },
  async ({ orgAlias, packageXmlPath, projectDir, compact = false }) => {
    try {
      const { getChangedFilesOrgCompare } = require('./sources/orgCompare');
      const changedFiles = getChangedFilesOrgCompare({
        mode:           'orgVsLocal',
        packageXmlPath,
        sourceOrg:      orgAlias,
        localProjectDir: projectDir || process.cwd(),
      });
      const { blocks, skipped } = buildBlocks(changedFiles);
      return blocksToToolResult(blocks, skipped, compact);
    } catch (err) {
      return errorResult(`Org compare failed: ${err.message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// MODE B — Tool 4b: compare_orgs
// Retrieve the same package.xml from TWO orgs and diff them (server-side).
// ---------------------------------------------------------------------------

server.tool(
  'compare_orgs',
  'Retrieve the same set of components (defined by a package.xml) from TWO authenticated Salesforce orgs and diff them, returning MDIF blocks for components that differ. Both retrievals and the diff run server-side, so only the compact MDIF crosses into the client context -- ideal for documenting what differs between a sandbox and production without a git repo. Requires sf CLI authenticated to both orgs.',
  {
    sourceOrg: z.string().describe(
      'Org alias or username for the "new" side of the diff (e.g. the sandbox with pending changes). Additions and modifications are reported relative to this org.'
    ),
    targetOrg: z.string().describe(
      'Org alias or username for the "old"/baseline side of the diff (e.g. production).'
    ),
    packageXmlPath: z.string().describe(
      'Absolute path to a package.xml file that defines which components to retrieve from BOTH orgs and compare.'
    ),
    compact: z.boolean().optional().describe(
      'If true, omit RAW_DIFF sections and apply aggressive truncation. Recommended to minimize tokens.'
    ),
  },
  async ({ sourceOrg, targetOrg, packageXmlPath, compact = false }) => {
    try {
      const { getChangedFilesOrgCompare } = require('./sources/orgCompare');
      const changedFiles = getChangedFilesOrgCompare({
        mode:           'twoOrg',
        packageXmlPath,
        sourceOrg,
        targetOrg,
      });
      const { blocks, skipped } = buildBlocks(changedFiles);
      return blocksToToolResult(blocks, skipped, compact);
    } catch (err) {
      return errorResult(`Org-to-org compare failed: ${err.message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// MODE B — Tool 5: get_component
// Retrieve a single component from an org and return its MDIF representation.
// ---------------------------------------------------------------------------

server.tool(
  'get_component',
  'Retrieve a single Salesforce metadata component from an authenticated org and return its current state as MDIF blocks. Useful for on-demand documentation of specific components without a full diff. Requires sf CLI.',
  {
    orgAlias: z.string().describe(
      'Salesforce CLI org alias or username.'
    ),
    apiName: z.string().describe(
      'API name of the component to retrieve. E.g. "My_Field__c", "CaseEscalationHandler", "Case_Assignment_Flow".'
    ),
    metadataType: z.string().describe(
      'Salesforce metadata type. E.g. "CustomField", "ApexClass", "Flow", "ValidationRule".'
    ),
    parentObject: z.string().optional().describe(
      'Parent object API name for child types (CustomField, ValidationRule, RecordType). E.g. "Case". Required for child metadata types.'
    ),
    compact: z.boolean().optional().describe(
      'If true, apply aggressive truncation to the output.'
    ),
  },
  async ({ orgAlias, apiName, metadataType, parentObject, compact = false }) => {
    try {
      const { execSync } = require('child_process');
      const fs   = require('fs');
      const os   = require('os');

      // Build a minimal package.xml for this single component
      const memberName = parentObject ? `${parentObject}.${apiName}` : apiName;
      const packageXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
        '    <types>',
        `        <members>${memberName}</members>`,
        `        <name>${metadataType}</name>`,
        '    </types>',
        '    <version>59.0</version>',
        '</Package>',
      ].join('\n');

      // sf requires --output-dir inside the current DX project root, so the
      // temp dir is anchored to cwd (not os.tmpdir()). Add ".metadiff-tmp" to
      // the project's .forceignore/.gitignore so residue is never tracked.
      const tmpDir     = path.join(process.cwd(), '.metadiff-tmp', `mcp_get_${Date.now()}`);
      const pkgXmlPath = path.join(tmpDir, 'package.xml');
      const outDir     = path.join(tmpDir, 'retrieved');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(pkgXmlPath, packageXml);

      try {
        const { withForceignoreDisabled } = require('./sources/orgCompare');
        withForceignoreDisabled(() =>
          execSync(
            `sf project retrieve start --manifest "${pkgXmlPath}" --target-org "${orgAlias}" --output-dir "${outDir}"`,
            { encoding: 'utf8', stdio: 'pipe' }
          )
        );
      } catch (e) {
        return errorResult(
          `sf retrieve failed for ${metadataType}:${memberName} from org "${orgAlias}".\n` +
          `Ensure the org is authenticated and the component exists.\n${e.message}`
        );
      }

      // Find the retrieved file
      const allFiles = [];
      function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else allFiles.push(full);
        }
      }
      walk(outDir);

      const retrieved = allFiles.filter(f => {
        const b = path.basename(f);
        return !b.endsWith('.cls-meta.xml') && !b.endsWith('.trigger-meta.xml') && !b.endsWith('.js-meta.xml');
      });

      if (retrieved.length === 0) {
        return errorResult(`No files retrieved for ${metadataType}:${memberName}. Component may not exist in org "${orgAlias}".`);
      }

      // Build as NEW blocks (current state snapshot)
      const changedFiles = retrieved.map(filePath => ({
        filePath,
        status:     'A',
        oldContent: null,
        newContent: fs.readFileSync(filePath, 'utf8'),
      }));

      const { blocks, skipped } = buildBlocks(changedFiles);

      return blocksToToolResult(blocks, skipped, compact);

    } catch (err) {
      return errorResult(err.message);
    } 
  }
);

// ---------------------------------------------------------------------------
// Transport selection and startup
// ---------------------------------------------------------------------------

async function main() {
  const useHttp = process.env.MCP_HTTP === '1';

  if (useHttp) {
    // HTTP/SSE transport for remote/hosted use
    const port = parseInt(process.env.MCP_PORT ?? '3100', 10);
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const http = require('http');

    const httpServer = http.createServer(async (req, res) => {
      if (req.url === '/mcp' || req.url === '/mcp/') {
        const transport = new StreamableHTTPServerTransport({ sessionIdHeader: 'mcp-session-id' });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'sfdc-metadiff', version: '0.1.0' }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    httpServer.listen(port, () => {
      console.error(`[sfdc-metadiff MCP] HTTP server listening on port ${port}`);
      console.error(`[sfdc-metadiff MCP] Endpoint: http://localhost:${port}/mcp`);
    });

  } else {
    // stdio transport (default) -- for Claude Desktop and local MCP clients
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[sfdc-metadiff MCP] stdio transport ready.');
  }
}

main().catch(err => {
  console.error('[sfdc-metadiff MCP] Fatal:', err.message);
  process.exit(1);
});
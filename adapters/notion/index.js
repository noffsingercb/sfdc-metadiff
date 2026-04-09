// adapters/notion/index.js
// Notion adapter -- looks up wiki pages by API_NAME + PARENT_OBJECT,
// creates or updates pages in the Salesforce Metadata Wiki.
//
// Two entry points:
//   consume(outputs, opts)    -- takes claude ==OUTPUT== objects (full pipeline)
//   consumeRaw(blocks, opts)  -- takes raw MDIF blocks, no Claude required
//
// Requires: @notionhq/client, NOTION_TOKEN env var or apiKey in opts.

const { Client } = require('@notionhq/client');

// ---------------------------------------------------------------------------
// DATABASE CONFIG
// Replace each placeholder with your real Notion database ID.
// Find IDs in the browser URL bar when viewing each database.
// ---------------------------------------------------------------------------
const DATABASE_CONFIG = {
  fields: {
    databaseId:    'FIELDS_DB_ID',
    titleProp:     'Field Name',
    apiNameProp:   'API Name',
    parentProp:    'Parent Object',
    statusProp:    'Status',
    lastSyncedProp:'Last Synced',
    activeStatus:  '✅ Active',
    archiveStatus: '🙅 Deprecated',
  },
  validationRules: {
    databaseId:    'VR_DB_ID',
    titleProp:     'Rule Name',
    apiNameProp:   'API Name',
    parentProp:    'Parent Object',
    statusProp:    'Status',
    lastSyncedProp:'Last Synced',
    activeStatus:  '✅ Active',
    archiveStatus: '🙅 Inactive',
  },
  flows: {
    databaseId:    'FLOWS_DB_ID',
    titleProp:     'Flow Name',
    apiNameProp:   'API Name',
    parentProp:    'Parent Object',
    statusProp:    'Status',
    lastSyncedProp:'Last Synced',
    activeStatus:  '✅ Active',
    archiveStatus: '📦 Obsolete',
  },
  apex: {
    databaseId:    'APEX_DB_ID',
    titleProp:     'Component Name',
    apiNameProp:   'API Name',
    parentProp:    'Parent Object',
    statusProp:    'Status',
    lastSyncedProp:'Last Synced',
    activeStatus:  '✅ Active',
    archiveStatus: '🙅 Deprecated',
  },
  config: {
    databaseId:    'CONFIG_DB_ID',
    titleProp:     'Config Name',
    apiNameProp:   'API Name',
    parentProp:    'Parent Object',
    statusProp:    'Status',
    lastSyncedProp:'Last Synced',
    activeStatus:  '✅ Active',
    archiveStatus: '🙅 Inactive',
  },
};

// ---------------------------------------------------------------------------
// Component type routing
// Maps MDIF COMPONENT_TYPE values to the right database config key.
// ---------------------------------------------------------------------------
const COMPONENT_TYPE_ROUTE = {
  'Custom Field':             'fields',
  'Validation Rule':          'validationRules',
  'Flow':                     'flows',
  'Apex Class':               'apex',
  'Apex Trigger':             'apex',
  'Lightning Web Component':  'apex',
  'Profile':                  'config',
  'Permission Set':           'config',
  'Workflow':                 'config',
  'Assignment Rules':         'config',
  'Auto-Response Rules':      'config',
  'Escalation Rules':         'config',
  'Sharing Rules':            'config',
  'Custom Label':             'config',
  'Role':                     'config',
  'Queue':                    'config',
  'Public Group':             'config',
  'Custom Tab':               'config',
  'Record Type':              'fields',
  'Global Value Set':         'config',
  'Standard Value Set':       'config',
  'Quick Action':             'config',
  'Custom Permission':        'config',
  'External Data Source':     'config',
};

// Extra properties to set on CREATE for specific component types.
const EXTRA_PROPS_ON_CREATE = {
  'Apex Class':              () => ({ 'Type': { select: { name: 'Apex Class' } } }),
  'Apex Trigger':            () => ({ 'Type': { select: { name: 'Apex Trigger' } } }),
  'Lightning Web Component': () => ({ 'Type': { select: { name: 'LWC' } } }),
  'Profile':                 () => ({ 'Config Type': { select: { name: 'Permission Set' } } }),
  'Permission Set':          () => ({ 'Config Type': { select: { name: 'Permission Set' } } }),
  'Custom Label':            () => ({ 'Config Type': { select: { name: 'Custom Label' } } }),
  'Role':                    () => ({ 'Config Type': { select: { name: 'Other' } } }),
  'Queue':                   () => ({ 'Config Type': { select: { name: 'Queue' } } }),
  'Global Value Set':        () => ({ 'Config Type': { select: { name: 'Global Value Set' } } }),
  'Custom Permission':       () => ({ 'Config Type': { select: { name: 'Custom Permission' } } }),
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

// Find an existing wiki page by API Name + Parent Object.
// For org-level components with no parent, matches on API Name only.
async function lookupPage(notion, componentType, apiName, parentObject) {
  const dbKey = COMPONENT_TYPE_ROUTE[componentType];
  if (!dbKey) return null;
  const db = DATABASE_CONFIG[dbKey];

  const filters = [
    { property: db.apiNameProp, rich_text: { equals: apiName } },
  ];

  if (parentObject) {
    filters.push({ property: db.parentProp, rich_text: { equals: parentObject } });
  }

  const response = await notion.databases.query({
    database_id: db.databaseId,
    filter: filters.length === 1 ? filters[0] : { and: filters },
  });

  return response.results[0] ?? null;
}

// ---------------------------------------------------------------------------
// Page write helpers
// ---------------------------------------------------------------------------

// Extract a clean display name from the claude component string.
// e.g. "CaseEscalationHandler (Apex Class)" -> "CaseEscalationHandler"
function extractDisplayName(componentStr, apiName) {
  if (!componentStr) return apiName;
  const match = componentStr.match(/^(.+?)\s*\(/);
  return match ? match[1].trim() : componentStr;
}

// Build the Notion properties object for a new page.
function buildCreateProperties(db, displayName, apiName, parentObject, status, componentType) {
  const today = new Date().toISOString().split('T')[0];
  const props = {
    [db.titleProp]:      { title: [{ text: { content: displayName } }] },
    [db.apiNameProp]:    { rich_text: [{ text: { content: apiName } }] },
    [db.statusProp]:     { select: { name: status } },
    [db.lastSyncedProp]: { date: { start: today } },
  };
  if (parentObject) {
    props[db.parentProp] = { rich_text: [{ text: { content: parentObject } }] };
  }
  const extraFn = EXTRA_PROPS_ON_CREATE[componentType];
  if (extraFn) Object.assign(props, extraFn());
  return props;
}

// Build page content blocks from a claude output object.
function buildPageContent(output) {
  const blocks = [];

  blocks.push({
    object: 'block', type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content:
        '⚠️ Needs Human Input\nPurpose: [Add why this component exists]\nBusiness Impact: [Add what would break if removed]'
      }}],
      icon: { emoji: '✏️' },
      color: 'yellow_background',
    },
  });

  if (output.updatedSections?.overview) {
    blocks.push({ object: 'block', type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'Overview' } }] } });
    blocks.push({ object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: output.updatedSections.overview } }] } });
  }

  if (output.updatedSections?.technical_details) {
    blocks.push({ object: 'block', type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'Technical Details' } }] } });
    blocks.push({ object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: output.updatedSections.technical_details } }] } });
  }

  if (output.updatedSections?.related_metadata) {
    blocks.push({ object: 'block', type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'Related Metadata' } }] } });
    blocks.push({ object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: output.updatedSections.related_metadata } }] } });
  }

  blocks.push({ object: 'block', type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: 'Change Log' } }] } });
  if (output.changeLogEntry) {
    blocks.push({ object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: output.changeLogEntry } }] } });
  }

  if (output.updatedSections?.notes) {
    blocks.push({ object: 'block', type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: output.updatedSections.notes } }],
        icon: { emoji: '📌' },
        color: 'blue_background',
      },
    });
  }

  return blocks;
}

// Append a change log callout to the bottom of an existing page.
async function appendChangeLogEntry(notion, pageId, output) {
  const today = new Date().toISOString().split('T')[0];
  const entryText = `${today} — ${output.changeLogEntry ?? output.changeSummary ?? 'Updated.'}`;
  await notion.blocks.children.append({
    block_id: pageId,
    children: [{
      object: 'block', type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: entryText } }],
        icon: { emoji: '📝' },
        color: 'gray_background',
      },
    }],
  });
}

// ---------------------------------------------------------------------------
// Core page operations (used by both consume and consumeRaw)
// ---------------------------------------------------------------------------

async function createWikiPage(notion, output, componentType, apiName, parentObject) {
  const dbKey = COMPONENT_TYPE_ROUTE[componentType];
  if (!dbKey) {
    console.warn(`[notion adapter] No database mapping for: "${componentType}". Skipping.`);
    return null;
  }
  const db = DATABASE_CONFIG[dbKey];
  const displayName = extractDisplayName(output.component, apiName);
  const properties  = buildCreateProperties(db, displayName, apiName, parentObject, db.activeStatus, componentType);
  const children    = buildPageContent(output);
  const page = await notion.pages.create({
    parent: { database_id: db.databaseId },
    properties,
    children,
  });
  console.log(`  [created]  ${componentType}: ${apiName}${parentObject ? ` (${parentObject})` : ''}`);
  return page;
}

async function updateWikiPage(notion, pageId, output, db) {
  const today = new Date().toISOString().split('T')[0];
  await notion.pages.update({
    page_id: pageId,
    properties: { [db.lastSyncedProp]: { date: { start: today } } },
  });
  await appendChangeLogEntry(notion, pageId, output);
  console.log(`  [updated]  ${output.component}`);
}

async function archiveWikiPage(notion, pageId, output, db) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [db.statusProp]:     { select: { name: db.archiveStatus } },
      [db.lastSyncedProp]: { date: { start: new Date().toISOString().split('T')[0] } },
    },
  });
  console.log(`  [archived] ${output.component}`);
}

// ---------------------------------------------------------------------------
// consume(outputs, opts)
//
// Primary entry point for the full Claude → Notion pipeline.
// Takes an array of claude ==OUTPUT== objects.
//
// opts:
//   apiKey  {string}  Notion integration token. Defaults to NOTION_TOKEN env var.
//   dryRun  {boolean} Log actions without writing. Default: false.
// ---------------------------------------------------------------------------
async function consume(outputs, opts = {}) {
  const {
    apiKey = process.env.NOTION_TOKEN,
    dryRun = false,
  } = opts;

  if (!apiKey) {
    throw new Error(
      '[notion adapter] API token not found.\n' +
      'Set NOTION_TOKEN environment variable or pass apiKey in opts.'
    );
  }

  const notion  = new Client({ auth: apiKey });
  const results = { created: [], updated: [], archived: [], skipped: [], errors: [] };

  for (const output of outputs) {
    if (!output.component || !output.action) {
      results.skipped.push({ component: output.component, reason: 'missing component or action' });
      continue;
    }

    // component format from claude: "ApiName (Component Type)"
    const componentMatch = output.component.match(/^(.+?)\s*\((.+)\)$/);
    if (!componentMatch) {
      results.skipped.push({ component: output.component, reason: 'could not parse component string' });
      continue;
    }
    const apiName       = componentMatch[1].trim();
    const componentType = componentMatch[2].trim();
    const parentObject  = output.parentObject ?? null;

    try {
      const existingPage = await lookupPage(notion, componentType, apiName, parentObject);
      const dbKey = COMPONENT_TYPE_ROUTE[componentType];
      const db    = dbKey ? DATABASE_CONFIG[dbKey] : null;

      if (output.action === 'CREATE') {
        if (existingPage) {
          console.log(`  [skip-create] ${output.component} already exists — treating as UPDATE`);
          if (!dryRun && db) await updateWikiPage(notion, existingPage.id, output, db);
          results.updated.push(output.component);
        } else {
          if (!dryRun) await createWikiPage(notion, output, componentType, apiName, parentObject);
          else console.log(`  [dry-run create] ${output.component}`);
          results.created.push(output.component);
        }
      } else if (output.action === 'UPDATE') {
        if (existingPage) {
          if (!dryRun && db) await updateWikiPage(notion, existingPage.id, output, db);
          else console.log(`  [dry-run update] ${output.component}`);
          results.updated.push(output.component);
        } else {
          console.log(`  [skip-update] ${output.component} not found — treating as CREATE`);
          if (!dryRun) await createWikiPage(notion, output, componentType, apiName, parentObject);
          results.created.push(output.component);
        }
      } else if (output.action === 'ARCHIVE') {
        if (existingPage && db) {
          if (!dryRun) await archiveWikiPage(notion, existingPage.id, output, db);
          else console.log(`  [dry-run archive] ${output.component}`);
          results.archived.push(output.component);
        } else {
          results.skipped.push({ component: output.component, reason: 'page not found — nothing to archive' });
        }
      } else {
        results.skipped.push({ component: output.component, reason: `unknown action: ${output.action}` });
      }
    } catch (err) {
      console.error(`  [error] ${output.component}: ${err.message}`);
      results.errors.push({ component: output.component, error: err.message });
    }
  }

  console.log(
    `\n[notion adapter] Done. ` +
    `created:${results.created.length} updated:${results.updated.length} ` +
    `archived:${results.archived.length} skipped:${results.skipped.length} ` +
    `errors:${results.errors.length}`
  );

  return results;
}

// ---------------------------------------------------------------------------
// consumeRaw(blocks, opts)
//
// Raw mode entry point -- writes MDIF semantic changes directly to Notion
// without a Claude interpretation step. Pages are pre-populated with a
// Notion AI prompt callout so AI can interpret on demand from within the page.
//
// opts:
//   apiKey  {string}  Notion integration token. Defaults to NOTION_TOKEN env var.
//   dryRun  {boolean} Log actions without writing. Default: false.
// ---------------------------------------------------------------------------
async function consumeRaw(blocks, opts = {}) {
  const {
    apiKey = process.env.NOTION_TOKEN,
    dryRun = false,
  } = opts;

  if (!apiKey) {
    throw new Error(
      '[notion adapter] API token not found.\n' +
      'Set NOTION_TOKEN environment variable or pass apiKey in opts.'
    );
  }

  const notion  = new Client({ auth: apiKey });
  const results = { created: [], updated: [], archived: [], skipped: [], errors: [] };
  const today   = new Date().toISOString().split('T')[0];

  for (const block of blocks) {
    const { changeType, componentType, apiName, parentObject, semanticChanges } = block;

    const dbKey = COMPONENT_TYPE_ROUTE[componentType];
    const db    = dbKey ? DATABASE_CONFIG[dbKey] : null;

    if (!dbKey) {
      console.warn(`  [skip] No database mapping for: "${componentType}"`);
      results.skipped.push({ component: `${apiName} (${componentType})`, reason: 'no database mapping' });
      continue;
    }

    const action = changeType === 'NEW' ? 'CREATE' : changeType === 'DELETED' ? 'ARCHIVE' : 'UPDATE';

    try {
      const existingPage   = await lookupPage(notion, componentType, apiName, parentObject);
      const rawPageContent = buildRawPageContent(block, today);

      if (action === 'CREATE') {
        if (existingPage) {
          if (!dryRun) {
            await notion.pages.update({ page_id: existingPage.id,
              properties: { [db.lastSyncedProp]: { date: { start: today } } } });
            await appendRawChangeLogEntry(notion, existingPage.id, block, today);
            console.log(`  [updated]  ${componentType}: ${apiName}`);
          } else {
            console.log(`  [dry-run update] ${componentType}: ${apiName}`);
          }
          results.updated.push(`${apiName} (${componentType})`);
        } else {
          if (!dryRun) {
            const properties = buildCreateProperties(db, apiName, apiName, parentObject, db.activeStatus, componentType);
            await notion.pages.create({
              parent: { database_id: db.databaseId },
              properties,
              children: rawPageContent,
            });
            console.log(`  [created]  ${componentType}: ${apiName}`);
          } else {
            console.log(`  [dry-run create] ${componentType}: ${apiName}`);
          }
          results.created.push(`${apiName} (${componentType})`);
        }

      } else if (action === 'UPDATE') {
        if (existingPage) {
          if (!dryRun) {
            await notion.pages.update({ page_id: existingPage.id,
              properties: { [db.lastSyncedProp]: { date: { start: today } } } });
            await appendRawChangeLogEntry(notion, existingPage.id, block, today);
            console.log(`  [updated]  ${componentType}: ${apiName}`);
          } else {
            console.log(`  [dry-run update] ${componentType}: ${apiName}`);
          }
          results.updated.push(`${apiName} (${componentType})`);
        } else {
          if (!dryRun) {
            const properties = buildCreateProperties(db, apiName, apiName, parentObject, db.activeStatus, componentType);
            await notion.pages.create({
              parent: { database_id: db.databaseId },
              properties,
              children: rawPageContent,
            });
            console.log(`  [created]  ${componentType}: ${apiName}`);
          } else {
            console.log(`  [dry-run create] ${componentType}: ${apiName}`);
          }
          results.created.push(`${apiName} (${componentType})`);
        }

      } else if (action === 'ARCHIVE') {
        if (existingPage) {
          if (!dryRun) {
            await notion.pages.update({ page_id: existingPage.id,
              properties: {
                [db.statusProp]:     { select: { name: db.archiveStatus } },
                [db.lastSyncedProp]: { date: { start: today } },
              },
            });
            console.log(`  [archived] ${componentType}: ${apiName}`);
          } else {
            console.log(`  [dry-run archive] ${componentType}: ${apiName}`);
          }
          results.archived.push(`${apiName} (${componentType})`);
        } else {
          results.skipped.push({ component: `${apiName} (${componentType})`, reason: 'page not found' });
        }
      }

    } catch (err) {
      console.error(`  [error] ${apiName} (${componentType}): ${err.message}`);
      results.errors.push({ component: `${apiName} (${componentType})`, error: err.message });
    }
  }

  console.log(
    `\n[notion adapter raw] Done. ` +
    `created:${results.created.length} updated:${results.updated.length} ` +
    `archived:${results.archived.length} skipped:${results.skipped.length} errors:${results.errors.length}`
  );

  return results;
}

// Builds Notion page blocks for raw mode.
// Includes a business context placeholder, a pre-written Notion AI prompt,
// and the verbatim semantic changes formatted as bullets.
function buildRawPageContent(block, today) {
  const { componentType, apiName, parentObject, changeType, semanticChanges } = block;
  const blocks = [];

  // Yellow callout: human-input placeholder (same pattern as full pipeline)
  blocks.push({
    object: 'block', type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content:
        '✏️ Needs Human Input\nPurpose: [Why does this component exist?]\nBusiness Impact: [What breaks if it\'s removed or changed?]'
      }}],
      icon: { emoji: '✏️' }, color: 'yellow_background',
    },
  });

  // Blue callout: pre-written Notion AI prompt ready to fire
  blocks.push({
    object: 'block', type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content:
        '🧠 Notion AI: Please read the Semantic Changes section below and write a plain-English summary of what changed, the likely business impact, and any related metadata to cross-reference.'
      }}],
      icon: { emoji: '🧠' }, color: 'blue_background',
    },
  });

  blocks.push({ object: 'block', type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: 'Semantic Changes' } }] } });

  // Component metadata header
  blocks.push({ object: 'block', type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content:
        `CHANGE_TYPE: ${changeType}\nCOMPONENT_TYPE: ${componentType}\nAPI_NAME: ${apiName}${parentObject ? '\nPARENT_OBJECT: ' + parentObject : ''}`
      }}],
      icon: { emoji: '📎' }, color: 'gray_background',
    },
  });

  // One bullet per semantic change
  for (const c of semanticChanges) {
    let text;
    if (c.type === 'ADDED')        text = `➕ [ADDED] ${c.element}: ${c.newValue ?? ''}`;
    else if (c.type === 'REMOVED') text = `➖ [REMOVED] ${c.element}: ${c.oldValue ?? ''}`;
    else                           text = `⇄ [MODIFIED] ${c.element}: ${c.oldValue ?? ''} → ${c.newValue ?? ''}`;
    blocks.push({ object: 'block', type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text } }] } });
  }

  blocks.push({ object: 'block', type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: 'Change Log' } }] } });
  blocks.push({ object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content:
      `${today} — Auto-created from MDIF (raw mode). ${semanticChanges.length} semantic change(s) detected.`
    } }] } });

  return blocks;
}

// Appends a raw change log callout to an existing page in raw mode updates.
async function appendRawChangeLogEntry(notion, pageId, block, today) {
  const { semanticChanges } = block;
  const lines = semanticChanges.map(c => {
    if (c.type === 'ADDED')        return `+ ${c.element}: ${c.newValue ?? ''}`;
    if (c.type === 'REMOVED')      return `- ${c.element}: ${c.oldValue ?? ''}`;
    return `± ${c.element}: ${c.oldValue ?? ''} → ${c.newValue ?? ''}`;
  });

  await notion.blocks.children.append({
    block_id: pageId,
    children: [{
      object: 'block', type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content:
          `${today} — MDIF raw update (${semanticChanges.length} change(s)):\n${lines.join('\n')}`
        } }],
        icon: { emoji: '📝' }, color: 'gray_background',
      },
    }],
  });
}

module.exports = { consume, consumeRaw, lookupPage, DATABASE_CONFIG, COMPONENT_TYPE_ROUTE };
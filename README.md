# sfdc-metadiff

An open-source CLI tool that sits between your Salesforce DevOps workflow and any downstream
documentation or knowledge system. It parses metadata changes semantically and emits a
structured, LLM-friendly format called **MDIF (MetaDiff Interchange Format)**.

> **Core principle:** each layer stays in its lane. The source knows nothing about parsers.
> The parser knows nothing about Claude or Notion. The format spec knows nothing about either.
> Adapter consumers know nothing about Salesforce.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [Upstream Sources](#upstream-sources)
- [Adapters](#adapters)
- [How It Works](#how-it-works)
- [Supported Metadata Types](#supported-metadata-types)
- [MDIF Format](#mdif-format)
- [Known Limitations](#known-limitations)
- [Extending the Tool](#extending-the-tool)
- [Project Structure](#project-structure)

---

## What It Does

1. Detects which Salesforce metadata files changed (via git, sfdx-git-delta, org compare, or inbound webhook)
2. Routes each file to the correct semantic parser for its type
3. Produces an MDIF document -- a plain-text, LLM-optimized diff format
4. Optional adapters consume those blocks -- writing to Notion, calling Claude, POSTing to a webhook, etc.

## What It Does Not Do

- Does not deploy to Salesforce
- Does not manage environments or sandboxes
- Does not require Gearset, Copado, or any paid DevOps tooling
- Does not embed destination IDs (Notion page IDs, Jira tickets, etc.) into its output

---

## Prerequisites

| Dependency          | Required          | Notes                                                        |
|---------------------|-------------------|--------------------------------------------------------------|
| Node.js >= 18       | Yes               | Runtime                                                      |
| git                 | Yes               | Change detection in git mode                                 |
| Salesforce CLI      | For org sources   | Required for `orgCompare` and webhook sources                |
| sfdx-git-delta      | Recommended       | Superior git-based detection; falls back to plain `git diff` |
| fast-xml-parser     | Yes               | Installed via `npm install`                                  |
| @notionhq/client    | Optional          | Only required for the `notion` adapter                       |
| @anthropic-ai/sdk   | Optional          | Only required for the `claude` adapter                       |

---

## Installation

    cd ~/sfdc-metadiff
    npm install

There is no global install yet. Run directly with `node src/cli.js`.

Optional: install sfdx-git-delta for superior change detection:

    npm install -g sfdx-git-delta

---

## Quick Start

### Manual mode (no git required -- good for POC testing)

Place old and new versions of your metadata files in two directories:

    test-data/
      old/   <- previous versions of changed files
      new/   <- current versions

Run:

    node src/cli.js --manual test-data/old test-data/new

To write output to a file:

    node src/cli.js --manual test-data/old test-data/new --output changes.mdif

To reduce output size (omit raw diffs, tighter truncation):

    node src/cli.js --manual test-data/old test-data/new --compact

### Git mode (reads last commit automatically)

    node src/cli.js
    node src/cli.js --output changes.mdif

Git mode reads `git diff HEAD~1 HEAD` from the working directory.
Requires at least one commit in the repo.

### Org compare mode (no git required)

Compare live org metadata against your local project files:

    node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg

Compare two orgs directly:

    node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg --target-org prodOrg

Requires Salesforce CLI authenticated to the target org(s).

---

## CLI Reference

    node src/cli.js [options]

    Options:
      --manual <old-dir> <new-dir>   Compare two directories instead of reading git history
      --output <file>                Write MDIF output to a file instead of stdout
      --compact                      Omit all RAW_DIFF sections and tighten scalar truncation
                                     to 150 chars. Optimized for token-cost-sensitive LLM pipelines.

### Examples

    # Compare two local folders, print to stdout
    node src/cli.js --manual test-data/old test-data/new

    # Compare two local folders, write to file
    node src/cli.js --manual test-data/old test-data/new --output changes.mdif

    # Compact mode -- smaller output, lower token cost
    node src/cli.js --manual test-data/old test-data/new --compact

    # Git mode -- diff last commit, print to stdout
    node src/cli.js

    # Git mode -- diff last commit, write to file
    node src/cli.js --output changes.mdif

### Console Output

The CLI prints a summary line per file processed:

    [sfdc-metadiff] 4 file(s) found

      [NEW     ] Account.Churn_Risk_Score__c  (Custom Field)
      [MODIFIED] Case_Assignment_Flow         (Flow)
      [MODIFIED] CaseEscalationHandler        (Apex Class)
      [skip    ] package.xml                  (no parser for this type)

Files with no supported parser are skipped silently.

---

## Upstream Sources

Sources are the change-detection layer. They produce a list of changed files
that the parser pipeline consumes. All sources output the same shape:

    { filePath, status ('A'|'M'|'D'), oldContent, newContent }

Pick the source that matches your workflow. Parsers and adapters are unaffected by which source you use.

### Available sources

| Source                   | Runner script                   | Requires                     | Best for                                                 |
|--------------------------|---------------------------------|------------------------------|----------------------------------------------------------|
| `git.js` (built-in)      | `src/cli.js`                    | git                          | Standard git-based DevOps workflows                      |
| `sfdxGitDelta.js`        | any runner (drop-in for git.js) | sfdx-git-delta               | Large repos, partial deployments, DX source format       |
| `orgCompare.js`          | `scripts/run-org-compare.js`    | sf CLI + authenticated org   | Solo devs, admins, org drift detection without git       |
| `gearsetWebhook.js`      | `scripts/run-webhook-server.js` | sf CLI + authenticated org   | Teams using Gearset CI jobs                              |
| `copadoWebhook.js`       | `scripts/run-webhook-server.js` | sf CLI + authenticated org   | Teams using Copado Essentials or Copado enterprise       |

### Org compare modes

    # Compare org against local project files (detect drift)
    node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg

    # Compare two orgs
    node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg --target-org prodOrg

    # Compare org against a git ref
    node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg --git-ref HEAD

    # Feed results directly into an adapter
    node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg --adapter notion
    node scripts/run-org-compare.js --package-xml package.xml --source-org myOrg --adapter webhook --url https://...

### Inbound webhook server (Gearset / Copado)

    # Start the server -- receives Gearset POSTs at /gearset, Copado at /copado
    # Set env vars for the org(s) the tools deploy to:
    GEARSET_ORG_ALIAS=myOrg NOTION_TOKEN=secret_... node scripts/run-webhook-server.js --adapter notion

    # Health check
    curl http://localhost:3000/health

    # Custom port
    node scripts/run-webhook-server.js --port 4000 --adapter stdout

In Gearset: CI job settings -> Add outgoing webhook -> URL: `http://your-server:3000/gearset`
In Copado Essentials: Deploy Options -> Advanced Options -> Outgoing webhooks -> URL: `http://your-server:3000/copado`

---

## Adapters

Adapters are optional consumers of MDIF blocks. Each adapter implements one function:

    async function consume(blocks, opts) { ... }

Anyone can write an adapter for any destination using only the MDIF spec --
no dependency on this package required.

### Available adapters

| Adapter   | Runner script            | Requires               | Notes                                                    |
|-----------|--------------------------|------------------------|----------------------------------------------------------|
| `stdout`  | `src/cli.js`             | Nothing                | Writes formatted MDIF to stdout. Default output.         |
| `claude`  | `scripts/run-claude.js`  | `ANTHROPIC_API_KEY`    | Batches blocks through Claude; returns interpreted prose.|
| `notion`  | `scripts/run-notion.js`  | `NOTION_TOKEN`         | Creates/updates Salesforce Metadata Wiki pages.          |
| `webhook` | `scripts/run-webhook.js` | `WEBHOOK_URL`          | POSTs payload to any HTTP endpoint (Zapier, Slack, etc). |

### Notion adapter modes

    # Full pipeline: MDIF -> Claude -> Notion (requires both keys)
    node scripts/run-notion.js --manual test-data/old test-data/new

    # Raw mode: MDIF -> Notion directly, no Claude key needed
    # Pages include a pre-written Notion AI prompt for on-demand interpretation
    node scripts/run-notion.js --manual test-data/old test-data/new --raw

    # Dry run (preview without writing)
    node scripts/run-notion.js --manual test-data/old test-data/new --dry-run

### Webhook adapter modes

    # JSON mode (default) -- structured semantic data
    node scripts/run-webhook.js --manual test-data/old test-data/new --url https://hooks.zapier.com/...

    # MDIF mode -- full plain-text document
    node scripts/run-webhook.js --manual test-data/old test-data/new --url https://... --mode mdif

    # Claude mode -- interpret first, then POST
    node scripts/run-webhook.js --manual test-data/old test-data/new --url https://... --mode claude

    # With auth header
    node scripts/run-webhook.js --manual test-data/old test-data/new --url https://... --auth "Bearer token"

    # Dry run -- prints full payload without sending
    node scripts/run-webhook.js --manual test-data/old test-data/new --url https://... --dry-run

---

## How It Works

    Source (git / sgd / org compare / inbound webhook)
           |
           v
     src/sources/     <- or src/git.js for plain git mode
           |
           | { filePath, status, oldContent, newContent }[]
           v
       differ.js        <- routes each file to the correct parser by suffix / path
           |
           v
      parsers/*.js      <- extracts semantic changes (verbatim values, never interpreted)
           |
           v
       format.js        <- writes MDIF blocks per the v0.1 spec
           |
           v
      stdout / .mdif
           |
           v
       adapters/        <- optional consumers: stdout, claude, notion, webhook

### Layer Responsibilities

| Layer            | Knows About                            | Does Not Know About         |
|------------------|----------------------------------------|-----------------------------|
| `src/sources/`   | Change detection for one source type   | Parsers, MDIF format        |
| `src/git.js`     | File system, git CLI                   | Parsers, MDIF format        |
| `differ.js`      | File suffixes and paths                | MDIF format, adapters       |
| `parsers/*.js`   | XML/code structure of one type         | MDIF format, other types    |
| `format.js`      | MDIF v0.1 spec, truncation rules       | Salesforce, parsers         |
| `adapters/`      | Destination API (Claude, Notion, etc.) | Salesforce, parsers         |

### Parser Design

All parsers export the same two functions:

    parser.parse(content)                  // -> structured representation of the file
    parser.diff(oldContent, newContent)    // -> SemanticChange[]

A `SemanticChange` looks like:

    { type: 'ADDED' | 'REMOVED' | 'MODIFIED', element: string, oldValue?: string, newValue?: string }

Parsers extract and label values **verbatim from the source**. They never summarize,
infer meaning, or generate prose. All interpretation is done by the LLM consumer.

---

## Supported Metadata Types

### Tier 3 -- Custom Parsers

Structurally unique types with hand-built parsers.

| Type                    | File Pattern                          | Parser                      | Notes                                     |
|-------------------------|---------------------------------------|-----------------------------|-------------------------------------------|
| Custom Field            | `*.field-meta.xml`                    | `parsers/field.js`          | Includes picklist value diffing           |
| Validation Rule         | `*.validationRule-meta.xml`           | `parsers/validationRule.js` |                                           |
| Flow                    | `*.flow-meta.xml`                     | `parsers/flow.js`           | Named-element graph; 14 element types     |
| Apex Class              | `*.cls`                               | `parsers/apex.js`           | Regex-based; methods, SOQL, DML           |
| Apex Trigger            | `*.trigger`                           | `parsers/apex.js`           | Shared parser with Apex Class             |
| Lightning Page          | `*.flexipage-meta.xml`, `*.flexipage` | `parsers/flexiPage.js`      | Facet graph resolved to readable paths    |
| Lightning Web Component | `lwc/**/*.js`, `lwc/**/*.js-meta.xml` | `parsers/lwc.js`            | Path-routed; handles JS source + meta XML |

### Tier 2 -- Named-Element XML (parsers/namedElementXml.js)

Config-driven. Types with repeating named sub-elements.

| Type                | File Pattern                       |
|---------------------|------------------------------------|
| Profile             | `*.profile-meta.xml`               |
| Permission Set      | `*.permissionset-meta.xml`         |
| Workflow            | `*.workflow-meta.xml`              |
| Assignment Rules    | `*.assignmentRules-meta.xml`       |
| Auto-Response Rules | `*.autoResponseRules-meta.xml`     |
| Escalation Rules    | `*.escalationRules-meta.xml`       |
| Sharing Rules       | `*.sharingRules-meta.xml`          |

### Tier 1 -- Generic Scalar XML (parsers/genericXml.js)

Config-driven. Types with flat scalar fields.

| Type                 | File Pattern                        |
|----------------------|-------------------------------------|
| Custom Label         | `*.label-meta.xml`                  |
| Role                 | `*.role-meta.xml`                   |
| Queue                | `*.queue-meta.xml`                  |
| Public Group         | `*.group-meta.xml`                  |
| Custom Tab           | `*.tab-meta.xml`                    |
| Record Type          | `*.recordType-meta.xml`             |
| Business Process     | `*.businessProcess-meta.xml`        |
| Sharing Reason       | `*.sharingReason-meta.xml`          |
| Compact Layout       | `*.compactLayout-meta.xml`          |
| Custom Application   | `*.app-meta.xml`                    |
| Global Value Set     | `*.globalValueSet-meta.xml`         |
| Standard Value Set   | `*.standardValueSet-meta.xml`       |
| Quick Action         | `*.quickAction-meta.xml`            |
| Custom Permission    | `*.customPermission-meta.xml`       |
| External Data Source | `*.externalDataSource-meta.xml`     |
| Milestone Type       | `*.milestoneType-meta.xml`          |

All other file types are skipped silently.

---

## MDIF Format

Full spec: `spec/MDIF-v0.1.md`

A `.mdif` file contains one or more blocks, each describing one changed component.

### Block structure

    MDIF_VERSION: 0.1
    GENERATED_AT: 2026-03-18T21:00:00.000Z
    BLOCK_COUNT: 1

    ---
    CHANGE_TYPE:    MODIFIED
    COMPONENT_TYPE: Custom Field
    METADATA_TYPE:  CustomField
    API_NAME:       Status__c
    PARENT_OBJECT:  Case
    SEMANTIC_CHANGES:
      [MODIFIED] required: false -> true
      [MODIFIED] description: (empty) -> "Tracks escalation lifecycle for support cases"
      [ADDED]    picklist_value:"Escalated": active, not default
    RAW_DIFF:
      - <required>false</required>
      + <required>true</required>
      ...
    ---

### Change types

| CHANGE_TYPE | State block       | Notes                                                   |
|-------------|-------------------|---------------------------------------------------------|
| NEW         | CURRENT_STATE     | All extracted properties verbatim. Includes RAW_SOURCE. |
| MODIFIED    | SEMANTIC_CHANGES  | Diff of tracked properties. Includes RAW_DIFF.          |
| DELETED     | LAST_KNOWN_STATE  | All properties from last known state. No RAW_DIFF.      |

### Compact mode

Pass `--compact` to omit all RAW_DIFF/RAW_SOURCE sections and tighten scalar
truncation to 150 characters. Useful when feeding output to an LLM API directly
to minimize token cost.

### Truncation

- Scalar values are capped at 500 characters with a `[TRUNCATED -- X chars total]` marker
- `RAW_DIFF` is capped at 30 lines with a count of omitted lines
- Flows and Lightning Pages omit `RAW_DIFF` entirely by default -- semantic changes
  are the primary signal
- `RAW_SOURCE` for NEW blocks is capped at 60 lines
- Every truncation includes a marker so the LLM knows exactly what was cut

---

## Known Limitations

### All parsers
- Files with no supported parser are skipped silently.
- Manual mode compares by filename only -- files must have the same name in both
  directories to be diffed as MODIFIED (otherwise they appear as DELETED + NEW).

### parsers/flow.js
- The `description` field is often used as a running changelog and can be very long.
  Scalar truncation handles it, but downstream LLMs should treat the most recent
  entries (at the top) as authoritative.
- Subflow reference extractor is implemented but not yet tested against real subflow
  XML with `flowName` elements.
- Flow element ordering is non-deterministic in some tools. The parser diffs by
  element name (not position), so ordering changes produce no false positives.

### parsers/apex.js
- Inner class methods may be double-counted by the method regex.
- Dynamic SOQL (`Database.query(...)`) is not detected -- only inline
  `[SELECT ... FROM ...]` syntax.
- Very complex generic type signatures may not parse cleanly.
- Method body changes are intentionally not diffed semantically.
  The raw diff carries that signal.
- `.cls-meta.xml` companion file (API version) is not currently read.

### parsers/lwc.js
- `@api` on method declarations (not property/getter patterns) is not detected.
- Dynamic or computed Apex import paths are not detected -- static imports only.
- `.html` template files are not parsed. Component composition changes appear
  in raw diff only.
- `@wire` configuration objects (second argument) are not diffed -- only the
  adapter identifier is tracked.

### parsers/flexiPage.js
- Placements are keyed on `<what> @ <containment path>`, so moving a field to a
  different section reads as a REMOVED plus an ADDED, not a MODIFIED.
- Path segments come from a component's `label`/`title` property. Renaming a
  section relabels every placement beneath it, so one rename can surface as a
  batch of ADDED/REMOVED pairs.
- Facet-pointer properties are dropped from component output because their values
  are GUIDs that churn on every edit. The referenced facet is diffed separately.
- Org API version drift is reported as real change. Comparing a sandbox against a
  production org on an older release surfaces MODIFIED components for properties
  Salesforce added on its own (e.g. `hideSlackAction` on `force:highlightsPanel`)
  that no one authored.
- Column components (`flexipage:column`) are treated as pure scaffolding and are
  never reported on their own -- only through what they contain.

### parsers/namedElementXml.js
- Rule criteria within AssignmentRules, AutoResponseRules, and EscalationRules
  are not diffed. Only the active flag is tracked. Criteria changes appear in
  raw diff only.
- CustomObject is not yet supported (planned for a future milestone).
  Flexipage is handled by its own Tier 3 parser (`parsers/flexiPage.js`).

### parsers/genericXml.js
- Any scalar field not listed in a type's `scalarKeys` config is silently ignored.
  Add it to the config if you need it.

### src/git.js
- Git mode reads HEAD~1..HEAD only. Multi-commit diffs are not supported.
- Rename (R) and copy (C) status codes are treated as MODIFIED.

### src/sources/sfdxGitDelta.js
- Deleted component path resolution covers the most common metadata types.
  Exotic types not in the `TYPE_SUFFIX` map will log a warning and be skipped;
  add entries to the map as needed.

### src/sources/orgCompare.js
- Retrieve time depends on org size and the scope of the package.xml.
  Large package.xml files may hit Salesforce API timeout limits.
- Requires `sf` CLI authenticated to the target org(s).

### src/sources/gearsetWebhook.js / copadoWebhook.js
- Both receivers retrieve file content from the org after receiving the webhook;
  the payload itself contains only the component list, not the XML.
- If your Copado instance uses a custom payload template, update `parseCopadoPayload()`
  to match.
- Not intended for direct internet exposure; use a reverse proxy or ngrok for local dev.

---

## Extending the Tool

### Add a new Tier 1 type (flat scalar XML)

Edit `src/parsers/genericXml.js`.

1. Add an entry to CONFIGS:

    'MyType': {
      typeName:   'My Type',
      rootTag:    'MyType',
      scalarKeys: ['label', 'description', 'active'],
      listKeys:   [],
      picklistKeys: [],
    },

2. Add one line to SUFFIX_MAP:

    'myType-meta.xml': 'MyType',

That's it. `differ.js` picks it up automatically.

### Add a new Tier 2 type (named sub-elements)

Edit `src/parsers/namedElementXml.js`:

1. Add any new repeating XML tags to ALWAYS_ARRAY_TAGS.
2. Add a CONFIGS entry with a namedElements array.
3. Add one line to SUFFIX_MAP.

### Add a new Tier 3 custom parser

1. Create `src/parsers/myType.js` -- export `parse(content)` and
   `diff(oldContent, newContent)`.
2. Add an entry to CUSTOM_PARSER_MAP in `src/differ.js`.
3. Add a resolveMetadata case in `src/cli.js` if the filename pattern is
   non-standard.

### Add a new upstream source

Any function that returns `{ filePath, status, oldContent, newContent }[]`
can feed directly into `differ.js`. See `src/git.js` for the reference shape
and `src/sources/orgCompare.js` for a full example with cleanup handling.

Existing sources to reference or extend:
- `src/sources/sfdxGitDelta.js` -- sgd-based detection
- `src/sources/orgCompare.js` -- sf CLI retrieve + diff (3 modes)
- `src/sources/gearsetWebhook.js` -- inbound Gearset CI job events
- `src/sources/copadoWebhook.js` -- inbound Copado deployment events

### Add a new adapter

Create `adapters/myAdapter/index.js` and export:

    async function consume(blocks, opts) { ... }

The `blocks` array has the same shape produced by `format.js`. See
`adapters/stdout/index.js` for the minimal reference implementation.

---

## Project Structure

    sfdc-metadiff/
    |-- src/
    |   |-- parsers/
    |   |   |-- field.js              Tier 3 -- Custom Fields (picklist diffing)
    |   |   |-- validationRule.js     Tier 3 -- Validation Rules
    |   |   |-- flow.js               Tier 3 -- Flows (named-element graph)
    |   |   |-- apex.js               Tier 3 -- Apex Classes + Triggers
    |   |   |-- lwc.js                Tier 3 -- Lightning Web Components
    |   |   |-- flexiPage.js          Tier 3 -- Lightning Pages (facet graph)
    |   |   |-- genericXml.js         Tier 1 -- Config-driven flat scalar XML (16 types)
    |   |   `-- namedElementXml.js    Tier 2 -- Config-driven named sub-element XML (7 types)
    |   |-- resolveMetadata.js       Shared file-path -> apiName/parent/type resolution
    |   |-- sources/
    |   |   |-- sfdxGitDelta.js       Source -- sgd-based change detection
    |   |   |-- orgCompare.js         Source -- sf CLI retrieve; org vs org/local/git
    |   |   |-- gearsetWebhook.js     Source -- inbound Gearset CI job events
    |   |   `-- copadoWebhook.js      Source -- inbound Copado deployment events
    |   |-- differ.js                 Routes files to the correct parser
    |   |-- format.js                 Writes MDIF output per the v0.1 spec
    |   |-- git.js                    Plain git change detection (built-in source)
    |   `-- cli.js                    Entry point; argument parsing and orchestration
    |-- adapters/
    |   |-- stdout/                   Writes formatted MDIF to stdout (zero config)
    |   |-- claude/                   Batches blocks through Claude API
    |   |-- notion/                   Creates/updates Salesforce Metadata Wiki pages
    |   `-- webhook/                  POSTs MDIF payload to any HTTP endpoint
    |-- scripts/
    |   |-- run-notion.js             Orchestrates MDIF -> Claude -> Notion (or --raw)
    |   |-- run-webhook.js            Orchestrates MDIF -> webhook adapter
    |   |-- run-claude.js             Runs MDIF through Claude, writes output to stdout
    |   |-- run-org-compare.js        Org compare source -> any adapter
    |   `-- run-webhook-server.js     Inbound webhook server (Gearset + Copado)
    |-- hooks/
    |   `-- post-commit               (planned) Installable git hook template
    |-- spec/
    |   `-- MDIF-v0.1.md              The format spec, versioned independently
    |-- test-data/
    |   |-- old/                      Sample old metadata files for manual mode testing
    |   `-- new/                      Sample new metadata files for manual mode testing
    |-- package.json
    `-- README.md

---

## Dependencies

    {
      "dependencies": {
        "fast-xml-parser": "^4.x"
      },
      "optionalDependencies": {
        "@notionhq/client": "^2.x",
        "@anthropic-ai/sdk": "^0.x"
      }
    }

All core functionality uses Node.js built-ins (fs, path, child_process).
Optional dependencies are only required if you use the `notion` or `claude` adapters.
The `orgCompare` and webhook sources require the Salesforce CLI (`sf`) to be installed
and authenticated separately -- it is not an npm dependency.

---

## MDIF Spec

The MDIF format is versioned independently of this tool. Current version: v0.1.
The spec lives at `spec/MDIF-v0.1.md` and will eventually be published as a
standalone document so any consumer can reference it without depending on
this package.

Version compatibility:
- Minor versions (v0.1 -> v0.2): add fields; existing consumers remain valid
- Major versions (v0.x -> v1.0): may change structure; consumers should check header

---

## License

MIT
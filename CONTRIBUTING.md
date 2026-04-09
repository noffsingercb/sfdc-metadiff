# Contributing to sfdc-metadiff

Thank you for your interest. This guide covers the project architecture,
how to add new capabilities, and the contribution workflow.

---

## Architecture overview

sfdc-metadiff has three independent layers. Contributors rarely need to touch more than one:

    Sources -> Parsers -> Adapters

- **Sources** (`src/sources/`, `src/git.js`) -- detect which files changed and provide old/new content.
- **Parsers** (`src/parsers/`) -- extract semantic meaning from one metadata type. Pure functions.
- **Adapters** (`adapters/`) -- consume MDIF blocks and write to a destination.

Each layer has a strict contract. As long as you honour the contract, your contribution
is independent of the rest of the codebase.

---

## Testing your changes

There are no automated tests yet. Use manual mode with the bundled test data:

    # Confirm the pipeline still runs end-to-end
    node src/cli.js --manual test-data/old test-data/new

    # Add your own test files to test-data/old and test-data/new
    # Files must have the same name in both dirs to be treated as MODIFIED

For adapters, use `--dry-run` to verify output without writing:

    node scripts/run-notion.js --manual test-data/old test-data/new --dry-run
    node scripts/run-webhook.js --manual test-data/old test-data/new --url https://... --dry-run

---

## Adding a new metadata type

### Tier 1 -- flat scalar XML (e.g. a new Settings type)

Edit `src/parsers/genericXml.js`:

1. Add an entry to the `CONFIGS` object:

        'MyType': {
          typeName:   'My Type',
          rootTag:    'MyType',
          scalarKeys: ['label', 'active', 'description'],
          listKeys:   [],
          picklistKeys: [],
        },

2. Add one line to `SUFFIX_MAP`:

        'myType-meta.xml': 'MyType',

`differ.js` picks it up automatically. No other changes needed.

### Tier 2 -- named sub-element XML (e.g. a new rules type)

Edit `src/parsers/namedElementXml.js`:

1. Add any new repeating XML tags to `ALWAYS_ARRAY_TAGS`.
2. Add a `CONFIGS` entry specifying the `namedElements` array (the XML tag used as a key).
3. Add one line to `SUFFIX_MAP`.

### Tier 3 -- custom parser (structurally unique type)

1. Create `src/parsers/myType.js`. Export two functions:

        // Returns a flat object of { element: value } for a NEW file
        function parse(content, filename) { ... }

        // Returns SemanticChange[] for a MODIFIED file
        // SemanticChange: { type: 'ADDED'|'REMOVED'|'MODIFIED', element, oldValue?, newValue? }
        function diff(oldContent, newContent, filename) { ... }

        module.exports = { parse, diff };

2. Add an entry to `CUSTOM_PARSER_MAP` in `src/differ.js`.
3. Add a `resolveMetadata` case in `src/cli.js` if the filename pattern is non-standard.

**Rules for parsers:**
- Never interpret, summarize, or infer meaning from values. Extract verbatim.
- Never import from `format.js`, adapters, or other parsers.
- `parse()` and `diff()` must be pure synchronous functions.

---

## Adding a new upstream source

Create `src/sources/mySource.js`. Export a function that returns:

    [
      {
        filePath:   string,        // absolute path to the metadata file
        status:     'A'|'M'|'D',  // added, modified, deleted
        oldContent: string | null, // null for new files
        newContent: string | null, // null for deleted files
      },
      ...
    ]

See `src/git.js` for the simplest reference implementation and
`src/sources/orgCompare.js` for a full example with async retrieval and cleanup.

Create a corresponding runner in `scripts/run-my-source.js` following
the pattern of `scripts/run-org-compare.js`.

---

## Adding a new adapter

Create `adapters/myAdapter/index.js`. Export one function:

    async function consume(blocks, opts = {}) {
      // blocks: MDIF block objects from format.js
      // opts: adapter-specific options (apiKey, dryRun, etc.)
    }

    module.exports = { consume };

See `adapters/stdout/index.js` for the minimal reference implementation.

**Rules for adapters:**
- Never import from parsers or `src/`.
- All knowledge of the destination API lives in the adapter.
- Support `opts.dryRun` where possible.

---

## Code conventions

- **No build step.** Plain Node.js CommonJS (`require`/`module.exports`).
- **No external dependencies** in core (`src/`). Use Node built-ins only.
  Optional deps (`@notionhq/client`, `@anthropic-ai/sdk`) are confined to adapters.
- **Logging prefix pattern:** every `console.log` starts with `[moduleName]`
  (e.g. `[notion adapter]`, `[sfdxGitDelta]`, `[run-org-compare]`).
- **Temp file cleanup:** always use a `finally` block to clean up temp dirs
  created during a run.
- **Fail fast with clear messages:** validate required opts at the top of each
  function with a clear error message before doing any I/O.

---

## Pull request process

1. Fork the repo and create a branch: `git checkout -b feat/my-feature`
2. Test with `node src/cli.js --manual test-data/old test-data/new`
3. Update `README.md` if you added a new source, parser type, or adapter
4. Open a PR with a short description of what changed and why
5. For new parsers, include a sample `.field-meta.xml` / `.flow-meta.xml` etc.
   in `test-data/` so reviewers can verify the output

---

## Reporting issues

Open an issue on GitHub. Include:
- The metadata type and file pattern that failed
- The command you ran
- The MDIF output (or error) you got
- A sanitised copy of the input file if possible
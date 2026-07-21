// src/sources/orgCompare.js
// Retrieves Salesforce metadata from one or two orgs and produces a
// { filePath, status, oldContent, newContent } diff for the parser pipeline.
//
// Three comparison modes:
//   twoOrg      -- retrieve same package.xml from sourceOrg and targetOrg, then diff
//   orgVsLocal  -- retrieve from org, compare against local project files
//   orgVsGit    -- retrieve from org, compare against a git ref (default: HEAD)
//
// Requires: sf CLI authenticated to the target org(s)
//   sf org login web --alias myOrg

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// withForceignoreDisabled -- runs fn() with any project-root .forceignore
// temporarily moved aside, then restores it.
//
// WHY: a source-format `sf project retrieve start --output-dir` writes ZERO
// files whenever ANY .forceignore is present in the project root (confirmed
// against sf CLI 2.143.6 -- even a .forceignore containing only "node_modules/"
// suppresses all retrieved source). Because we retrieve into our own temp dir
// (.metadiff-tmp) and diff there, the project .forceignore is irrelevant to
// correctness but silently breaks the retrieve. Neutralize it for the duration
// of the retrieve only; restore it in finally so the user's config is intact.
// ---------------------------------------------------------------------------
function withForceignoreDisabled(fn) {
  const fi  = path.join(process.cwd(), '.forceignore');
  const bak = path.join(process.cwd(), `.forceignore.metadiff-bak-${process.pid}`);
  let moved = false;
  try {
    if (fs.existsSync(fi)) { fs.renameSync(fi, bak); moved = true; }
    return fn();
  } finally {
    if (moved) { try { fs.renameSync(bak, fi); } catch {} }
  }
}

// ---------------------------------------------------------------------------
// retrieveToDir -- runs sf project retrieve start and returns the output directory.
// packageXmlPath: path to a package.xml that defines what to retrieve.
// orgAlias: authenticated org alias or username.
// outDir: directory to retrieve into (created if absent).
// ---------------------------------------------------------------------------
function retrieveToDir(packageXmlPath, orgAlias, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log(`[orgCompare] Retrieving from org: ${orgAlias}`);
  try {
    withForceignoreDisabled(() =>
      execSync(
        `sf project retrieve start --manifest "${packageXmlPath}" --target-org "${orgAlias}" --output-dir "${outDir}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      )
    );
  } catch (e) {
    throw new Error(
      `[orgCompare] sf retrieve failed for org "${orgAlias}".\n` +
      `Ensure the org is authenticated and the package.xml is valid.\n${e.message}`
    );
  }
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
// diffDirs -- compares two directories by relative file path and content.
// Returns { filePath, status, oldContent, newContent }[] using newDir as reference.
// filePath values use the newDir (or oldDir for deletions) absolute path.
// ---------------------------------------------------------------------------
function diffDirs(oldDir, newDir) {
  const entries = [];

  const newFiles = walkDir(newDir);
  const oldFileSet = new Map(); // relPath -> absPath
  for (const f of walkDir(oldDir)) {
    oldFileSet.set(path.relative(oldDir, f), f);
  }

  for (const newFilePath of newFiles) {
    const relPath    = path.relative(newDir, newFilePath);
    const newContent = fs.readFileSync(newFilePath, 'utf8');

    if (!oldFileSet.has(relPath)) {
      entries.push({ filePath: newFilePath, status: 'A', oldContent: null, newContent });
    } else {
      const oldContent = fs.readFileSync(oldFileSet.get(relPath), 'utf8');
      if (oldContent !== newContent) {
        entries.push({ filePath: newFilePath, status: 'M', oldContent, newContent });
      }
      oldFileSet.delete(relPath); // mark as seen
    }
  }

  // Remaining entries in oldFileSet were not in newDir -- deleted
  for (const [relPath, oldFilePath] of oldFileSet) {
    const oldContent = fs.readFileSync(oldFilePath, 'utf8');
    entries.push({ filePath: oldFilePath, status: 'D', oldContent, newContent: null });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// getChangedFilesOrgCompare -- main export.
//
// opts:
//   mode            {string}  'twoOrg' | 'orgVsLocal' | 'orgVsGit'
//   packageXmlPath  {string}  Required. Path to package.xml listing what to retrieve.
//   sourceOrg       {string}  Required. Org alias/username for the "new" state.
//   targetOrg       {string}  Required for twoOrg mode. The "old" state org.
//   localProjectDir {string}  Required for orgVsLocal. Root of local DX project.
//   gitRef          {string}  Required for orgVsGit. Git ref for old state. Default: 'HEAD'.
//   repoRoot        {string}  Required for orgVsGit. Repo root. Default: process.cwd().
//
// Returns: Array<{ filePath, status, oldContent, newContent }>
// ---------------------------------------------------------------------------
function getChangedFilesOrgCompare(opts = {}) {
  const {
    mode           = 'orgVsLocal',
    packageXmlPath,
    sourceOrg,
    targetOrg,
    localProjectDir = process.cwd(),
    gitRef         = 'HEAD',
    repoRoot       = process.cwd(),
  } = opts;

  if (!packageXmlPath || !fs.existsSync(packageXmlPath)) {
    throw new Error('[orgCompare] opts.packageXmlPath is required and must point to a valid package.xml.');
  }
  if (!sourceOrg) {
    throw new Error('[orgCompare] opts.sourceOrg is required (authenticated org alias or username).');
  }

  // NOTE: the sf CLI requires --output-dir to live INSIDE the current DX
  // project root, so temp retrieve dirs are anchored to cwd (not os.tmpdir()).
  // The whole tmpBase is removed in the finally block below.
  const tmpBase  = path.join(process.cwd(), '.metadiff-tmp', `orgCompare_${Date.now()}`);
  const newDir   = path.join(tmpBase, 'new');

  try {
    // Retrieve "new" state from source org
    retrieveToDir(packageXmlPath, sourceOrg, newDir);

    if (mode === 'twoOrg') {
      if (!targetOrg) throw new Error('[orgCompare] opts.targetOrg is required for twoOrg mode.');
      const oldDir = path.join(tmpBase, 'old');
      retrieveToDir(packageXmlPath, targetOrg, oldDir);
      return diffDirs(oldDir, newDir);
    }

    if (mode === 'orgVsLocal') {
      // Compare org retrieve against local project files
      // Walk the new dir and find matching local files
      const entries = [];
      for (const newFilePath of walkDir(newDir)) {
        const relPath    = path.relative(newDir, newFilePath);
        const localPath  = path.join(localProjectDir, relPath);
        const newContent = fs.readFileSync(newFilePath, 'utf8');

        if (!fs.existsSync(localPath)) {
          // Exists in org but not locally -- treat as new in org
          entries.push({ filePath: localPath, status: 'A', oldContent: null, newContent });
        } else {
          const oldContent = fs.readFileSync(localPath, 'utf8');
          if (oldContent !== newContent) {
            entries.push({ filePath: localPath, status: 'M', oldContent, newContent });
          }
        }
      }
      return entries;
    }

    if (mode === 'orgVsGit') {
      // Compare org retrieve against a specific git ref
      const entries = [];
      for (const newFilePath of walkDir(newDir)) {
        const relPath    = path.relative(newDir, newFilePath);
        const projectPath = path.join(repoRoot, relPath);
        const newContent = fs.readFileSync(newFilePath, 'utf8');
        const gitRelPath = relPath.replace(/\\/g, '/');

        let oldContent = null;
        let status = 'M';
        try {
          oldContent = execSync(`git show "${gitRef}":"${gitRelPath}"`, {
            cwd: repoRoot, encoding: 'utf8',
          });
        } catch {
          status = 'A'; // not in git ref -- new
        }

        if (status === 'A' || oldContent !== newContent) {
          entries.push({ filePath: projectPath, status, oldContent, newContent });
        }
      }
      return entries;
    }

    throw new Error(`[orgCompare] Unknown mode: "${mode}". Use 'twoOrg', 'orgVsLocal', or 'orgVsGit'.`);

  } finally {
    // Always clean up temp dirs
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { getChangedFilesOrgCompare, withForceignoreDisabled };
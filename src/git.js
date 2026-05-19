// src/git.js
// Provides changed-file lists for the differ.
// Two modes: git (reads last commit) and manual (compares two directories).

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// getChangedFiles — git mode.
// Reads the file list from the last commit in the current repo.
// Returns an array of: { filePath, status, oldContent, newContent }
//   status: 'A' (added), 'M' (modified), 'D' (deleted)
// ---------------------------------------------------------------------------
function getChangedFiles(repoRoot) {
  const root = repoRoot ?? process.cwd();
  let output;
  try {
    output = execSync('git diff --name-status HEAD~1 HEAD', {
      cwd: root,
      encoding: 'utf8',
    });
  } catch (e) {
    console.error('[sfdc-metadiff] git diff failed. Do you have at least one commit?');
    process.exit(1);
  }

  const entries = [];
  for (const line of output.trim().split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const statusCode = parts[0][0]; // first char: A, M, D, R, C...
    const filePath = parts[parts.length - 1]; // last column is the current path
    const absPath = path.join(root, filePath);

    let oldContent = null;
    let newContent = null;

    if (statusCode === 'A') {
      newContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
    } else if (statusCode === 'D') {
      try {
        oldContent = execSync(`git show HEAD~1:"${filePath}"`, { cwd: root, encoding: 'utf8' });
      } catch { /* file may not exist in history */ }
    } else if (statusCode === 'M') {
      newContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
      try {
        oldContent = execSync(`git show HEAD~1:"${filePath}"`, { cwd: root, encoding: 'utf8' });
      } catch {}
    }
    // R (rename) and C (copy) are treated as MODIFIED for simplicity in POC
    else if (statusCode === 'R' || statusCode === 'C') {
      newContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
      try {
        const oldPath = parts[1];
        oldContent = execSync(`git show HEAD~1:"${oldPath}"`, { cwd: root, encoding: 'utf8' });
      } catch {}
    }

    if (statusCode === 'A' || statusCode === 'M' || statusCode === 'D' ||
        statusCode === 'R' || statusCode === 'C') {
      entries.push({ filePath, status: statusCode === 'A' ? 'A' :
                                        statusCode === 'D' ? 'D' : 'M',
                     oldContent, newContent });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// getChangedFilesManual — directory comparison mode (POC / no git required).
// Compares files in newDir against oldDir by filename.
// Files in newDir not in oldDir = ADDED.
// Files in both dirs that differ = MODIFIED.
// Files in oldDir not in newDir = DELETED.
// ---------------------------------------------------------------------------
function getChangedFilesManual(oldDir, newDir) {
  const entries = [];

  const newFiles = fs.existsSync(newDir) ? fs.readdirSync(newDir) : [];
  const oldFiles = new Set(fs.existsSync(oldDir) ? fs.readdirSync(oldDir) : []);

  for (const file of newFiles) {
    const newPath = path.join(newDir, file);
    const newContent = fs.readFileSync(newPath, 'utf8');

    if (!oldFiles.has(file)) {
      // New file — no old version
      entries.push({ filePath: newPath, status: 'A', oldContent: null, newContent });
    } else {
      const oldContent = fs.readFileSync(path.join(oldDir, file), 'utf8');
      if (oldContent !== newContent) {
        entries.push({ filePath: newPath, status: 'M', oldContent, newContent });
      }
      // If identical, skip — nothing changed
    }
  }

  for (const file of oldFiles) {
    if (!newFiles.includes(file)) {
      const oldContent = fs.readFileSync(path.join(oldDir, file), 'utf8');
      entries.push({ filePath: path.join(oldDir, file), status: 'D', oldContent, newContent: null });
    }
  }

  return entries;
}
// getChangedFilesByRef -- like getChangedFiles but accepts arbitrary git refs.
// Used by the MCP server's diff_git_refs tool.
function getChangedFilesByRef(repoRoot, opts = {}) {
  const { from = 'HEAD~1', to = 'HEAD' } = opts;
  const { execSync } = require('child_process');
  const fs = require('fs');

  // Get list of changed files between refs
  let diffOutput;
  try {
    diffOutput = execSync(
      `git diff --name-status "${from}" "${to}"`,
      { cwd: repoRoot, encoding: 'utf8' }
    );
  } catch (e) {
    throw new Error(`[git] diff failed: ${e.message}`);
  }

  const lines = diffOutput.trim().split('\n').filter(Boolean);
  const results = [];

  for (const line of lines) {
    const [statusCode, ...pathParts] = line.split('\t');
    const filePath = path.join(repoRoot, pathParts[pathParts.length - 1]);
    const status   = statusCode.startsWith('A') ? 'A' : statusCode.startsWith('D') ? 'D' : 'M';
    const gitRel   = pathParts[pathParts.length - 1];

    let oldContent = null;
    let newContent = null;

    try {
      if (status !== 'A') {
        oldContent = execSync(`git show "${from}":"${gitRel}"`, { cwd: repoRoot, encoding: 'utf8' });
      }
      if (status !== 'D') {
        newContent = execSync(`git show "${to}":"${gitRel}"`, { cwd: repoRoot, encoding: 'utf8' });
      }
    } catch (e) {
      console.warn(`[git] Could not read content for ${gitRel}: ${e.message}`);
      continue;
    }

    results.push({ filePath, status, oldContent, newContent });
  }

  return results;
}
module.exports = { getChangedFiles, getChangedFilesManual, getChangedFilesByRef };
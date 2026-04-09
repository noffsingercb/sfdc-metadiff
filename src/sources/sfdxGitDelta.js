// src/sources/sfdxGitDelta.js
// Change detection via sfdx-git-delta (sgd).
// Produces the same { filePath, status, oldContent, newContent } shape as git.js.
//
// Advantages over plain git diff:
//   - Understands Salesforce DX source directory structure
//   - Correctly identifies destructive changes (deleted components)
//   - Handles partial deployments and selective component tracking
//   - Deduplicates companion files (e.g. .cls + .cls-meta.xml -> one component)
//
// Requires: sfdx-git-delta installed globally
//   npm install -g sfdx-git-delta

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === 'types' || name === 'members' });

// ---------------------------------------------------------------------------
// Metadata type -> file suffix mapping (DX source format).
// Used to resolve destructive component entries to file paths.
// ---------------------------------------------------------------------------
const TYPE_SUFFIX = {
  CustomField:            'field-meta.xml',
  ValidationRule:         'validationRule-meta.xml',
  Flow:                   'flow-meta.xml',
  ApexClass:              'cls',
  ApexTrigger:            'trigger',
  LightningComponentBundle: 'js',
  Profile:                'profile-meta.xml',
  PermissionSet:          'permissionset-meta.xml',
  Workflow:               'workflow-meta.xml',
  AssignmentRules:        'assignmentRules-meta.xml',
  AutoResponseRules:      'autoResponseRules-meta.xml',
  EscalationRules:        'escalationRules-meta.xml',
  SharingRules:           'sharingRules-meta.xml',
  CustomLabel:            'labels-meta.xml',
  RecordType:             'recordType-meta.xml',
  GlobalValueSet:         'globalValueSet-meta.xml',
  QuickAction:            'quickAction-meta.xml',
  CustomPermission:       'customPermission-meta.xml',
};

// Metadata types whose members include a parent object prefix (ObjectName.MemberName).
// Used to reconstruct the DX directory path for destructive changes.
const CHILD_TYPES = new Set(['CustomField', 'ValidationRule', 'RecordType', 'SharingRules']);

// Map type to its DX subdirectory under force-app/main/default/objects/<Object>/
const CHILD_DIR = {
  CustomField:    'fields',
  ValidationRule: 'validationRules',
  RecordType:     'recordTypes',
  SharingRules:   'sharingRules',
};

// Map type to its top-level DX directory under force-app/main/default/
const TYPE_DIR = {
  Flow:                   'flows',
  ApexClass:              'classes',
  ApexTrigger:            'triggers',
  LightningComponentBundle: 'lwc',
  Profile:                'profiles',
  PermissionSet:          'permissionsets',
  Workflow:               'workflows',
  AssignmentRules:        'assignmentRules',
  AutoResponseRules:      'autoResponseRules',
  EscalationRules:        'escalationRules',
  SharingRules:           'sharingRules',
  GlobalValueSet:         'globalValueSets',
  QuickAction:            'quickActions',
  CustomPermission:       'customPermissions',
};

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
// resolveDestructivePath -- given a metadata type + member from destructiveChanges.xml,
// find the file's path relative to the repo root.
// Returns null if the type is unknown or path cannot be resolved.
// ---------------------------------------------------------------------------
function resolveDestructivePath(type, member, sourceRoot) {
  const suffix = TYPE_SUFFIX[type];
  if (!suffix) return null;

  if (CHILD_TYPES.has(type)) {
    // member = 'ObjectName.MemberName'
    const [objectName, memberName] = member.split('.');
    if (!objectName || !memberName) return null;
    const subDir = CHILD_DIR[type] || type.toLowerCase() + 's';
    return path.join(sourceRoot, 'objects', objectName, subDir, `${memberName}.${suffix}`);
  }

  if (type === 'LightningComponentBundle') {
    // LWC main JS file
    return path.join(sourceRoot, 'lwc', member, `${member}.js`);
  }

  const dir = TYPE_DIR[type];
  if (!dir) return null;
  return path.join(sourceRoot, dir, `${member}.${suffix}`);
}

// ---------------------------------------------------------------------------
// getChangedFilesSgd -- main export.
//
// opts:
//   from       {string}  git ref for the base/old state. Default: 'HEAD~1'.
//   to         {string}  git ref for the target/new state. Default: 'HEAD'.
//   sourceRoot {string}  path to DX source root relative to repoRoot.
//                        Default: 'force-app/main/default'.
//   outputDir  {string}  where sgd writes its output. Default: system temp dir.
//
// Returns: Array<{ filePath, status, oldContent, newContent }>
// ---------------------------------------------------------------------------
function getChangedFilesSgd(repoRoot, opts = {}) {
  const {
    from       = 'HEAD~1',
    to         = 'HEAD',
    sourceRoot = path.join(repoRoot, 'force-app', 'main', 'default'),
    outputDir  = path.join(os.tmpdir(), `sgd_${Date.now()}`),
  } = opts;

  // Ensure sgd is available
  try {
    execSync('sgd --version', { stdio: 'ignore' });
  } catch {
    throw new Error(
      '[sfdxGitDelta] sfdx-git-delta (sgd) not found.\n' +
      'Install it with: npm install -g sfdx-git-delta'
    );
  }

  // Run sgd -- generates delta source directory and destructive changes XML
  console.log(`[sfdxGitDelta] Running sgd: ${from}..${to}`);
  try {
    execSync(
      `sgd --from "${from}" --to "${to}" --repo "${repoRoot}" --output "${outputDir}" --generate-delta`,
      { cwd: repoRoot, encoding: 'utf8' }
    );
  } catch (e) {
    throw new Error(`[sfdxGitDelta] sgd failed: ${e.message}`);
  }

  const deltaSourceDir      = path.join(outputDir, 'source');
  const destructiveXmlPath  = path.join(outputDir, 'destructiveChanges', 'destructiveChanges.xml');
  const entries = [];

  // -------------------------------------------------------------------------
  // ADDED and MODIFIED files: present in the sgd delta source directory.
  // -------------------------------------------------------------------------
  for (const deltaFilePath of walkDir(deltaSourceDir)) {
    // Derive the path relative to the delta source dir
    const relToSourceRoot = path.relative(deltaSourceDir, deltaFilePath);
    // Map back to the actual project file (same relative structure)
    const projectFilePath = path.join(repoRoot, 'force-app', 'main', 'default', relToSourceRoot);

    const newContent = fs.existsSync(projectFilePath)
      ? fs.readFileSync(projectFilePath, 'utf8')
      : fs.readFileSync(deltaFilePath, 'utf8'); // fall back to delta copy

    let oldContent = null;
    let status = 'M';

    // Relative to repo root for git show
    const gitRelPath = path.relative(repoRoot, projectFilePath).replace(/\\/g, '/');
    try {
      oldContent = execSync(`git show "${from}":"${gitRelPath}"`, {
        cwd: repoRoot, encoding: 'utf8',
      });
    } catch {
      // File did not exist in the base ref -- it's new
      status = 'A';
    }

    entries.push({ filePath: projectFilePath, status, oldContent, newContent });
  }

  // -------------------------------------------------------------------------
  // DELETED components: listed in destructiveChanges.xml.
  // -------------------------------------------------------------------------
  if (fs.existsSync(destructiveXmlPath)) {
    const xml = fs.readFileSync(destructiveXmlPath, 'utf8');
    const parsed = xmlParser.parse(xml);
    const types = parsed?.Package?.types ?? [];

    for (const typeEntry of types) {
      const typeName = typeEntry?.name;
      const members  = Array.isArray(typeEntry?.members)
        ? typeEntry.members
        : typeEntry?.members ? [typeEntry.members] : [];

      for (const member of members) {
        const filePath = resolveDestructivePath(typeName, member, sourceRoot);
        if (!filePath) {
          console.warn(`[sfdxGitDelta] Could not resolve path for deleted: ${typeName}:${member}`);
          continue;
        }

        const gitRelPath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
        let oldContent = null;
        try {
          oldContent = execSync(`git show "${from}":"${gitRelPath}"`, {
            cwd: repoRoot, encoding: 'utf8',
          });
        } catch {
          console.warn(`[sfdxGitDelta] Could not retrieve old content for deleted: ${gitRelPath}`);
        }

        if (oldContent) {
          entries.push({ filePath, status: 'D', oldContent, newContent: null });
        }
      }
    }
  }

  // Clean up temp output dir
  try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}

  console.log(`[sfdxGitDelta] ${entries.length} file(s) detected.`);
  return entries;
}

module.exports = { getChangedFilesSgd };
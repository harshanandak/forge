'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const SCHEMA = 'forge.plan.v1';
const ARTIFACT_FILES = Object.freeze(['plan.md', 'tasks.md']);

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function readUtf8(absolutePath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(absolutePath));
  } catch (error) {
    throw new Error(`Plan artifact must be valid UTF-8: ${absolutePath} (${error.message})`);
  }
}

function normalizeRelativePath(projectRoot, candidate) {
  const absolute = path.resolve(projectRoot, candidate);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Plan artifact paths must stay inside the project root');
  }
  return relative.split(path.sep).join('/');
}

function artifactPath(projectRoot, relativePath) {
  return path.join(projectRoot, ...relativePath.split('/'));
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Resolve every existing component below the project root. Refuse links/reparse
// points even when their target happens to remain inside the repo: allowing them
// would make a later target swap bypass the containment decision.
function assertSafeArtifactPath(projectRoot, absolutePath) {
  const rootAbsolute = path.resolve(projectRoot);
  const candidateAbsolute = path.resolve(absolutePath);
  if (!isContained(rootAbsolute, candidateAbsolute)) {
    throw new Error('Plan artifact path escapes the project root');
  }
  const rootReal = fs.realpathSync.native(rootAbsolute);
  const segments = path.relative(rootAbsolute, candidateAbsolute).split(path.sep).filter(Boolean);
  let current = rootAbsolute;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error('Plan artifact path contains a symbolic link or reparse point');
    }
    const currentReal = fs.realpathSync.native(current);
    if (!isContained(rootReal, currentReal)) {
      throw new Error('Plan artifact path resolves outside the project root');
    }
  }
}

function snapshotDigest(artifacts) {
  const canonical = JSON.stringify(artifacts.map(({ path: artifact, sha256: digest }) => ({ path: artifact, sha256: digest })));
  return sha256(canonical);
}

function createSnapshot({ projectRoot, workFolder }) {
  const folder = normalizeRelativePath(projectRoot, workFolder);
  const artifacts = ARTIFACT_FILES.map((filename) => {
    const relativePath = `${folder}/${filename}`;
    const absolutePath = artifactPath(projectRoot, relativePath);
    assertSafeArtifactPath(projectRoot, absolutePath);
    if (!fs.existsSync(absolutePath)) return null;
    if (!fs.lstatSync(absolutePath).isFile()) {
      throw new Error(`Plan artifact must be a regular file: ${relativePath}`);
    }
    const content = readUtf8(absolutePath);
    return { path: relativePath, content, sha256: sha256(content) };
  });
  if (artifacts.some((entry) => entry === null)) return null;
  return { schema: SCHEMA, digest: snapshotDigest(artifacts), artifacts };
}

function findPlanWorkFolder(projectRoot, featureSlug) {
  if (!projectRoot || !featureSlug) return null;
  const workRoot = path.join(projectRoot, 'docs', 'work');
  if (!fs.existsSync(workRoot)) return null;
  const suffix = `-${featureSlug}`;
  const matches = fs.readdirSync(workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === featureSlug || entry.name.endsWith(suffix)))
    .map((entry) => `docs/work/${entry.name}`)
    .filter((folder) => ARTIFACT_FILES.every((filename) => fs.existsSync(artifactPath(projectRoot, `${folder}/${filename}`))))
    .sort();
  return matches.length === 1 ? matches[0] : null;
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== SCHEMA || !Array.isArray(snapshot.artifacts)) {
    throw new Error('Kernel plan snapshot is invalid');
  }
  if (snapshot.artifacts.length !== ARTIFACT_FILES.length) {
    throw new Error('Kernel plan snapshot is invalid');
  }
  const expectedNames = new Set(ARTIFACT_FILES);
  const observedNames = new Set();
  for (const artifact of snapshot.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || typeof artifact.content !== 'string'
      || sha256(artifact.content) !== artifact.sha256) {
      throw new Error('Kernel plan snapshot is invalid');
    }
    const filename = path.posix.basename(artifact.path);
    if (!expectedNames.has(filename) || observedNames.has(filename)) {
      throw new Error('Kernel plan snapshot is invalid');
    }
    observedNames.add(filename);
  }
  if (snapshot.digest !== snapshotDigest(snapshot.artifacts)) {
    throw new Error('Kernel plan snapshot is invalid');
  }
  return snapshot;
}

function readPlanSnapshot(driver, issueId) {
  if (!driver || typeof driver.loadPlanSnapshot !== 'function') return null;
  const snapshot = driver.loadPlanSnapshot({ issue_id: issueId }, {});
  return snapshot ? validateSnapshot(snapshot) : null;
}

function inspectArtifacts(projectRoot, snapshot) {
  const missing = [];
  const drifted = [];
  for (const artifact of snapshot.artifacts) {
    const relative = normalizeRelativePath(projectRoot, artifact.path);
    const absolute = artifactPath(projectRoot, relative);
    assertSafeArtifactPath(projectRoot, absolute);
    if (!fs.existsSync(absolute)) {
      missing.push({ ...artifact, absolute });
      continue;
    }
    const content = readUtf8(absolute);
    if (sha256(content) !== artifact.sha256) drifted.push(artifact.path);
  }
  return { missing, drifted };
}

function materializeMissing(projectRoot, missing) {
  const staged = [];
  const created = [];
  try {
    for (const artifact of missing) {
      assertSafeArtifactPath(projectRoot, artifact.absolute);
      fs.mkdirSync(path.dirname(artifact.absolute), { recursive: true });
      assertSafeArtifactPath(projectRoot, artifact.absolute);
      const temporary = `${artifact.absolute}.forge-${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, artifact.content, { encoding: 'utf8', flag: 'wx' });
      staged.push({ temporary, destination: artifact.absolute });
    }
    for (const entry of staged) {
      // link is create-only (fails EEXIST), unlike rename which may overwrite a
      // file another process materialized after our drift check.
      fs.linkSync(entry.temporary, entry.destination);
      fs.rmSync(entry.temporary, { force: true });
      created.push(entry.destination);
    }
  } catch (error) {
    for (const entry of staged) {
      if (fs.existsSync(entry.temporary)) fs.rmSync(entry.temporary, { force: true });
    }
    for (const destination of created) {
      if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
    }
    throw error;
  }
}

function guidance(message, repairCommand) {
  return `${message} ${repairCommand}`;
}

function reconcilePlanAuthority({
  driver,
  issueId,
  projectRoot,
  workFolder,
  mode = 'dev',
  repairCommand = `forge plan "<feature>" --issue ${issueId}`,
} = {}) {
  if (!driver || !issueId || !projectRoot) {
    throw new Error('Plan authority requires a Kernel driver, issue id, and project root');
  }
  const existing = readPlanSnapshot(driver, issueId);
  if (!existing) {
    const snapshot = workFolder ? createSnapshot({ projectRoot, workFolder }) : null;
    if (!snapshot) {
      throw new Error(guidance('Plan authority is missing. Create plan.md and tasks.md, then run:', repairCommand));
    }
    if (typeof driver.recordPlanSnapshotTransition !== 'function') {
      throw new Error('Kernel driver cannot persist plan authority');
    }
    driver.recordPlanSnapshotTransition({ issue_id: issueId, snapshot }, {});
    return { status: 'captured', snapshot };
  }

  const { missing, drifted } = inspectArtifacts(projectRoot, existing);
  if (drifted.length > 0) {
    throw new Error(guidance('Plan artifacts drifted from Kernel authority. Reconcile the files, then run:', repairCommand));
  }
  if (missing.length > 0) {
    materializeMissing(projectRoot, missing);
    return { status: 'materialized', snapshot: existing };
  }
  return { status: mode === 'plan' ? 'reconciled' : 'verified', snapshot: existing };
}

module.exports = {
  SCHEMA,
  createSnapshot,
  findPlanWorkFolder,
  readPlanSnapshot,
  reconcilePlanAuthority,
};

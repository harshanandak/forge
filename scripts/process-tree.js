'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync: defaultSpawnSync } = require('node:child_process');

const MANIFEST_ENV = 'FORGE_TEST_PROCESS_MANIFEST';
const TOKEN_ENV = 'FORGE_TEST_PROCESS_TOKEN';
const INSTANCE_ENV = 'FORGE_TEST_PROCESS_INSTANCE';
const SESSION_ENV = 'FORGE_SESSION_ID';
const MANIFEST_VERSION = 1;
const DEFAULT_MANIFEST_DIR = path.join(os.tmpdir(), 'forge-test-processes');

function nowIso() {
  return new Date().toISOString();
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeIdentity(value) {
  return nonEmptyString(typeof value === 'string' ? value.trim() : value);
}

function isUsableIdentity(value) {
  const identity = normalizeIdentity(value);
  return identity && !identity.startsWith('unverified:') ? identity : null;
}

function isValidManifestEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!nonEmptyString(entry.id) || !nonEmptyString(entry.token)) return false;
  if (!['reserved', 'running'].includes(entry.status)) return false;
  if (!nonEmptyString(entry.startedAt)) return false;
  if (entry.instanceId != null && !nonEmptyString(entry.instanceId)) return false;
  if (entry.status === 'reserved') {
    if (entry.pid == null) return entry.identity == null;
    return normalizePid(entry.pid) === entry.pid
      && (entry.identity == null || normalizeIdentity(entry.identity) !== null);
  }
  return normalizePid(entry.pid) === entry.pid && normalizeIdentity(entry.identity) !== null;
}

function isValidManifest(manifest) {
  return Boolean(
    manifest
      && manifest.version === MANIFEST_VERSION
      && nonEmptyString(manifest.token)
      && (manifest.instanceId == null || nonEmptyString(manifest.instanceId))
      && manifest.owner
      && typeof manifest.owner === 'object'
      && normalizePid(manifest.owner.pid) === manifest.owner.pid
      && nonEmptyString(manifest.owner.startedAt)
      && (manifest.owner.identity == null || normalizeIdentity(manifest.owner.identity) !== null)
      && Array.isArray(manifest.children)
      && manifest.children.every(isValidManifestEntry),
  );
}

function inspectResource(resourcePath, fsApi = fs) {
  const stat = fsApi.lstatSync || fsApi.statSync;
  if (typeof stat !== 'function') {
    try {
      return {
        exists: typeof fsApi.existsSync === 'function' ? fsApi.existsSync(resourcePath) : true,
        metadata: null,
      };
    } catch {
      return { exists: false, metadata: null };
    }
  }
  try {
    return { exists: true, metadata: stat.call(fsApi, resourcePath) };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { exists: false, metadata: null };
    }
    return { exists: null, metadata: null };
  }
}

function isOwnedMetadata(metadata, processApi = process, {
  allowSharedAncestor = false,
  allowTrustedSymlink = false,
} = {}) {
  if (!allowTrustedSymlink
    && metadata && typeof metadata.isSymbolicLink === 'function' && metadata.isSymbolicLink()) return false;
  if (allowTrustedSymlink) return true;
  const currentUid = typeof processApi.getuid === 'function' ? processApi.getuid() : null;
  if (currentUid == null || typeof metadata?.uid !== 'number' || metadata.uid === currentUid) return true;
  if (!allowSharedAncestor) return false;
  const mode = metadata?.mode;
  if (typeof mode !== 'number') return false;
  const writableByOthers = (mode & 0o022) !== 0;
  const sticky = (mode & 0o1000) !== 0;
  return !writableByOthers || sticky;
}

function isTrustedSystemSymlink(resourcePath, metadata, fsApi = fs) {
  if (path.sep !== '/' || metadata?.uid !== 0
    || typeof metadata?.isSymbolicLink !== 'function' || !metadata.isSymbolicLink()
    || typeof fsApi.readlinkSync !== 'function') return false;
  const normalizedPath = path.posix.normalize(resourcePath);
  if (!['/var', '/tmp'].includes(normalizedPath)) return false;
  let target;
  try {
    target = fsApi.readlinkSync(resourcePath);
  } catch {
    return false;
  }
  return path.posix.resolve(path.posix.dirname(normalizedPath), target)
    === `/private${normalizedPath}`;
}

function pathComponents(resourcePath) {
  const absolutePath = path.resolve(resourcePath);
  const parsed = path.parse(absolutePath);
  const components = [parsed.root];
  let current = parsed.root;
  for (const segment of absolutePath.slice(parsed.root.length).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    components.push(current);
  }
  return components;
}

function isOwnedPath(resourcePath, fsApi = fs, processApi = process) {
  if (typeof resourcePath !== 'string' || resourcePath.length === 0) return false;
  const stat = fsApi.lstatSync || fsApi.statSync;
  if (typeof stat !== 'function') return true;
  let missing = false;
  const components = pathComponents(resourcePath);
  for (const [index, component] of components.entries()) {
    const inspected = inspectResource(component, fsApi);
    if (inspected.exists === false) {
      missing = true;
      continue;
    }
    const allowSharedAncestor = index < components.length - 1;
    const trustedSystemSymlink = allowSharedAncestor
      && isTrustedSystemSymlink(component, inspected.metadata, fsApi);
    if (inspected.exists !== true || missing || !isOwnedMetadata(inspected.metadata, processApi, {
      allowSharedAncestor,
      allowTrustedSymlink: trustedSystemSymlink,
    })) {
      return false;
    }
  }
  return true;
}

function isOwnedManifestPath(manifestPath, fsApi = fs, processApi = process) {
  return isOwnedPath(path.dirname(manifestPath), fsApi, processApi)
    && isOwnedPath(manifestPath, fsApi, processApi);
}

function readProcessManifest(manifestPath, fsApi = fs, processApi = process) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) return null;
  if (!isOwnedManifestPath(manifestPath, fsApi, processApi)) return null;
  try {
    const manifest = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8'));
    return isValidManifest(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

function writeProcessManifest(manifestPath, manifest, fsApi = fs, processApi = process) {
  const manifestDir = path.dirname(manifestPath);
  if (!isOwnedPath(manifestPath, fsApi, processApi)) {
    throw new Error('process manifest path is not owned by the current user');
  }
  let directory = inspectResource(manifestDir, fsApi);
  if (directory.exists === null) throw new Error('process manifest directory cannot be inspected');
  if (directory.exists === false) {
    fsApi.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
    directory = inspectResource(manifestDir, fsApi);
  }
  if (directory.exists !== true
    || !isOwnedPath(manifestDir, fsApi, processApi)
    || (typeof directory.metadata?.isDirectory === 'function' && !directory.metadata.isDirectory())) {
    throw new Error('process manifest directory is not a user-owned directory');
  }
  if (typeof fsApi.chmodSync === 'function') {
    if (!isOwnedPath(manifestDir, fsApi, processApi)) {
      throw new Error('process manifest directory is not a user-owned directory');
    }
    fsApi.chmodSync(manifestDir, 0o700);
  }
  if (!isOwnedPath(manifestPath, fsApi, processApi)) {
    throw new Error('process manifest path is not owned by the current user');
  }
  fsApi.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
}

function pathExists(manifestPath, fsApi = fs) {
  try {
    if (typeof fsApi.existsSync === 'function') return fsApi.existsSync(manifestPath);
    fsApi.accessSync(manifestPath);
    return true;
  } catch {
    return false;
  }
}

function defaultIsAlive(pid, processApi) {
  try {
    processApi.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readProcIdentity(pid, fsApi) {
  try {
    const stat = fsApi.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen >= 0) {
      const startTime = nonEmptyString(stat.slice(closeParen + 2).trim().split(/\s+/)[19]);
      if (startTime) return `proc:${startTime}`;
    }
  } catch {
    // Fall through to ps on platforms without procfs.
  }
  return null;
}

function readPsIdentity(pid, spawnSync) {
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      shell: false, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true,
    });
    const value = result && !result.error && result.status === 0
      ? normalizeIdentity(result.stdout) : null;
    return value ? `ps:${value}` : null;
  } catch {
    return null;
  }
}

function readWindowsIdentity(pid, spawnSync) {
  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true });
    const value = result && !result.error && result.status === 0
      ? normalizeIdentity(result.stdout) : null;
    return value ? `windows:${value}` : null;
  } catch {
    return null;
  }
}

function defaultGetProcessIdentity(pid, options = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return null;
  const platform = options.platform || process.platform;
  const fsApi = options.fsApi || fs;
  const spawnSync = options.spawnSync || defaultSpawnSync;
  if (platform !== 'win32') return readProcIdentity(normalizedPid, fsApi)
    || readPsIdentity(normalizedPid, spawnSync);
  return readWindowsIdentity(normalizedPid, spawnSync);
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

function createInitialManifest(token, processApi, getProcessIdentity, instanceId) {
  const ownerPid = normalizePid(processApi.pid);
  let ownerIdentity;
  try {
    ownerIdentity = normalizeIdentity(getProcessIdentity(ownerPid));
  } catch {
    ownerIdentity = null;
  }
  return {
    version: MANIFEST_VERSION,
    token,
    instanceId,
    owner: {
      pid: ownerPid,
      identity: ownerIdentity,
      startedAt: nowIso(),
    },
    children: [],
  };
}

function createProcessTree(options = {}) {
  const fsApi = options.fsApi || fs;
  const processApi = options.processApi || process;
  const platform = options.platform || process.platform;
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const env = options.env || process.env;
  const allInstances = options.allInstances === true;
  const instanceId = allInstances ? null : String(options.instanceId || randomUUID());
  const hasCustomIdentity = typeof options.getProcessIdentity === 'function';
  const getProcessIdentity = options.getProcessIdentity || ((pid) => defaultGetProcessIdentity(pid, {
    platform,
    fsApi,
    spawnSync,
  }));
  const captureIdentity = (pid) => {
    let identity;
    try {
      identity = normalizeIdentity(getProcessIdentity(pid));
    } catch {
      identity = null;
    }
    // Synthetic child handles may not be visible to the host process table.
    // Keep their reservation, but never treat this marker as kill
    // authorization if no stable evidence was available.
    if (!identity && !hasCustomIdentity) return `unverified:${pid}`;
    return identity;
  };
  // A Forge claim records FORGE_SESSION_ID. Use that same stable runtime token
  // for the root manifest, while preserving an inherited manifest token for
  // nested process trees that are already attached to their parent run.
  const inheritedToken = nonEmptyString(options.token) || nonEmptyString(env[TOKEN_ENV]);
  const token = String(inheritedToken || env[SESSION_ENV] || randomUUID());
  const explicitManifestPath = nonEmptyString(options.manifestPath);
  const environmentManifestPath = nonEmptyString(env[MANIFEST_ENV]);
  const manifestDir = options.manifestDir || DEFAULT_MANIFEST_DIR;

  if (!explicitManifestPath && !environmentManifestPath && options.reconcile !== false) {
    reconcileProcessManifests({
      ...options,
      manifestDir,
      fsApi,
      platform,
      processApi,
      spawnSync,
      getProcessIdentity,
      allInstances: true,
    });
  }

  const manifestPath = explicitManifestPath
    || environmentManifestPath
    || path.join(manifestDir, `run-${normalizePid(processApi.pid) || process.pid}-${token}.json`);
  const markerExists = pathExists(manifestPath, fsApi);
  const existing = readProcessManifest(manifestPath, fsApi, processApi);
  // An environment-provided path may belong to another run. Treat that as
  // unverifiable and fail closed; never overwrite or reap another run's marker.
  const inheritedManifestVerified = explicitManifestPath
    || !environmentManifestPath
    || Boolean(inheritedToken && existing?.token === inheritedToken);
  const usable = inheritedManifestVerified
    && (!markerExists || (existing && existing.token === token));
  let manifest = existing && existing.token === token
    ? existing
    : (usable ? createInitialManifest(token, processApi, getProcessIdentity, instanceId) : null);
  let sequence = manifest ? manifest.children.length : 0;
  let cleanupSignal = null;
  let cleanupComplete = false;

  function ownsEntry(entry, latest = manifest) {
    return Boolean(allInstances || (entry && entry.instanceId === instanceId)
      || (entry && entry.instanceId == null && latest?.instanceId === instanceId));
  }

  if (usable) {
    try {
      writeProcessManifest(manifestPath, manifest, fsApi, processApi);
    } catch {
      // A missing/unwritable marker makes ownership unverifiable. All cleanup
      // operations remain fail-closed, and the caller still receives its normal
      // child-process status.
      manifest = null;
    }
  } else {
    manifest = null;
  }

  function currentManifest() {
    if (!usable || !manifest) return null;
    const latest = readProcessManifest(manifestPath, fsApi, processApi);
    return latest && latest.token === token ? latest : null;
  }

  function persist(next) {
    if (!next || !usable || !manifest) return false;
    try {
      writeProcessManifest(manifestPath, next, fsApi, processApi);
      manifest = next;
      return true;
    } catch {
      manifest = null;
      return false;
    }
  }

  function reserveChild(metadata = {}) {
    const latest = currentManifest();
    if (!latest) return null;
    const entry = {
      id: `${token}:${sequence++}:${randomUUID()}`,
      token,
      instanceId,
      kind: metadata.kind || 'child',
      label: metadata.label || null,
      command: metadata.command || null,
      pid: null,
      status: 'reserved',
      startedAt: nowIso(),
      registeredAt: null,
      identity: null,
    };
    latest.children.push(entry);
    return persist(latest) ? { id: entry.id } : null;
  }

  function registerChild(reservation, child) {
    const latest = currentManifest();
    const id = reservation && reservation.id;
    const pid = normalizePid(child && child.pid);
    if (!latest || typeof id !== 'string' || !pid) return null;
    const entry = latest.children.find((candidate) => candidate.id === id);
    if (!entry || !ownsEntry(entry, latest) || entry.token !== token || entry.status !== 'reserved') return null;
    const identity = captureIdentity(pid);
    if (!identity) return null;
    entry.pid = pid;
    entry.identity = identity;
    entry.status = 'running';
    entry.registeredAt = nowIso();
    return persist(latest) ? { ...entry } : null;
  }

  function unregisterChild(reservation) {
    const latest = currentManifest();
    const id = reservation && reservation.id;
    if (!latest || typeof id !== 'string') return false;
    const entry = latest.children.find((candidate) => candidate.id === id);
    if (!ownsEntry(entry, latest)) return false;
    const next = { ...latest, children: latest.children.filter((candidate) => candidate.id !== id) };
    return persist(next);
  }

  function envFor(childEnv = env) {
    if (!usable || !manifest) {
      const stripped = { ...childEnv };
      delete stripped[MANIFEST_ENV];
      delete stripped[TOKEN_ENV];
      delete stripped[INSTANCE_ENV];
      return stripped;
    }
    return {
      ...childEnv,
      [MANIFEST_ENV]: manifestPath,
      [TOKEN_ENV]: token,
      [INSTANCE_ENV]: instanceId,
    };
  }

  function isVerifiableEntry(latest, entry) {
    if (!(
      latest
        && latest.version === MANIFEST_VERSION
        && latest.token === token
        && entry
        && entry.token === token
        && ownsEntry(entry, latest)
        && typeof entry.id === 'string'
        && entry.status === 'running'
        && normalizePid(entry.pid) === entry.pid
        && typeof entry.startedAt === 'string'
        && entry.startedAt.length > 0
    )) return false;

    const storedIdentity = isUsableIdentity(entry.identity);
    if (!storedIdentity) return false;
    let currentIdentity;
    try {
      currentIdentity = isUsableIdentity(getProcessIdentity(entry.pid));
    } catch {
      currentIdentity = null;
    }
    return currentIdentity !== null && currentIdentity === storedIdentity;
  }

  function isEntryAlive(entry) {
    try {
      return (options.isAlive || defaultIsAlive)(entry.pid, processApi);
    } catch {
      return true;
    }
  }

  function killOwnedEntry(entry, signal) {
    const pid = normalizePid(entry && entry.pid);
    if (!pid || pid === normalizePid(processApi.pid) || !isVerifiableEntry(currentManifest(), entry)) {
      return false;
    }
    if (!(options.isAlive || defaultIsAlive)(pid, processApi)) return false;

    try {
      if (platform === 'win32') {
        const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
        return Boolean(result && !result.error && result.status === 0);
      }
      processApi.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  function cleanup(signal = 'SIGTERM') {
    const force = signal === 'SIGKILL';
    if (cleanupComplete || (cleanupSignal === signal && !force)) {
      return { killed: [] };
    }
    cleanupSignal = signal;
    const latest = currentManifest();
    if (!latest) return { killed: [] };

    const killed = [];
    for (const entry of latest.children) {
      if (killOwnedEntry(entry, signal)) killed.push(entry.pid);
    }

    const verifiedCache = new Map();
    const aliveCache = new Map();
    const verifiedOnce = (entry, manifestForEntry) => {
      if (!verifiedCache.has(entry.id)) {
        verifiedCache.set(entry.id, isVerifiableEntry(manifestForEntry, entry));
      }
      return verifiedCache.get(entry.id);
    };
    const aliveOnce = (entry) => {
      if (!aliveCache.has(entry.id)) aliveCache.set(entry.id, isEntryAlive(entry));
      return aliveCache.get(entry.id);
    };
    let finalManifest = currentManifest();
    if (finalManifest) {
      const liveEntries = finalManifest.children.filter((entry) => !(
        entry.status === 'running'
        && !verifiedOnce(entry, finalManifest)
        && !aliveOnce(entry)
      ));
      if (liveEntries.length !== finalManifest.children.length) {
        persist({ ...finalManifest, children: liveEntries });
        finalManifest = currentManifest();
      }
    }
    const hasUnverifiableLiveEntry = finalManifest?.children.some(
      (entry) => entry.status === 'running' && !verifiedOnce(entry, finalManifest)
        && aliveOnce(entry),
    );
    const hasLiveRunningEntry = finalManifest?.children.some(
      (entry) => entry.status === 'running'
        && verifiedOnce(entry, finalManifest)
        && aliveOnce(entry),
    );
    const hasOutstandingReservation = finalManifest?.children.some(
      (entry) => entry.status === 'reserved',
    );
    const hasFailedLiveEntry = finalManifest?.children.some(
      (entry) => entry.status === 'running'
        && verifiedOnce(entry, finalManifest)
        && aliveOnce(entry)
        && !killed.includes(entry.pid),
    );
    const safeToRemove = finalManifest
      && !hasUnverifiableLiveEntry
      && !hasOutstandingReservation
      && !hasFailedLiveEntry
      && (force || !hasLiveRunningEntry);
    if (safeToRemove && finalManifest.token === token) {
      try {
        fsApi.rmSync(manifestPath, { force: true });
        cleanupComplete = !pathExists(manifestPath, fsApi);
      } catch {
        // A stale marker is safe to leave behind; its token still prevents a
        // later run from touching this process tree.
      }
    }
    return { killed };
  }

  function abortChild(reservation, child, signal = 'SIGKILL') {
    const pid = normalizePid(child && child.pid);
    const retainReservation = (identityOverride = null) => {
      const latest = currentManifest();
      const id = reservation && reservation.id;
      const entry = latest?.children.find((candidate) => candidate.id === id);
      if (!latest || !entry || !ownsEntry(entry, latest) || entry.token !== token || entry.status !== 'reserved') {
        return false;
      }
      entry.pid = pid;
      entry.identity = identityOverride || captureIdentity(pid) || `unverified:${pid}`;
      entry.status = 'running';
      entry.registeredAt = nowIso();
      persist(latest);
      return true;
    };

    // Capture stable identity before direct kill so the process-group/tree kill
    // can reap descendants while the reservation is still verifiable.
    const identity = pid ? captureIdentity(pid) : null;
    const retained = pid && identity ? retainReservation(identity) : false;
    const finalizeAbort = (result) => {
      if (pid && !retained) retainReservation(identity);
      cleanup('SIGKILL');
      unregisterChild(reservation);
      cleanup('SIGKILL');
      return result;
    };
    const groupResult = retained ? cleanup(signal) : { killed: [] };
    if (pid && groupResult.killed.includes(pid)) {
      unregisterChild(reservation);
      cleanup('SIGKILL');
      return true;
    }

    let killSucceeded = false;
    try {
      if (child && typeof child.kill === 'function') {
        killSucceeded = child.kill(signal) === true;
      }
    } catch {
      killSucceeded = false;
    }

    if (killSucceeded || !pid) return finalizeAbort(killSucceeded);

    const alive = (() => {
      try {
        return (options.isAlive || defaultIsAlive)(normalizePid(child.pid), processApi);
      } catch {
        return true;
      }
    })();
    if (!alive) return finalizeAbort(killSucceeded);

    if (!retained) retainReservation(identity);
    if (currentManifest()?.children.some((entry) => entry.pid === pid && entry.status === 'running')) {
      // If identity evidence was available, cleanup can attempt a verified
      // tree kill. Otherwise retain the reservation for later reconciliation.
      cleanup('SIGKILL');
    }
    return killSucceeded;
  }

  function installSignalHandlers(onSignal) {
    if (!processApi || typeof processApi.on !== 'function') return () => {};
    const handlers = new Map();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        cleanup(signal === 'SIGINT' ? 'SIGTERM' : signal);
        if (typeof onSignal === 'function') onSignal(signal);
        else processApi.exitCode = signalExitCode(signal);
      };
      handlers.set(signal, handler);
      processApi.on(signal, handler);
    }
    return () => {
      if (typeof processApi.removeListener !== 'function') return;
      for (const [signal, handler] of handlers) processApi.removeListener(signal, handler);
    };
  }

  return {
    cleanup,
    envFor,
    installSignalHandlers,
    registerChild,
    reserveChild,
    unregisterChild,
    abortChild,
    manifestPath,
    instanceId,
    token,
  };
}

function reapProcessManifest(manifestPath, options = {}) {
  const fsApi = options.fsApi || fs;
  const processApi = options.processApi || process;
  const existing = readProcessManifest(manifestPath, fsApi, processApi);
  if (!existing) return { killed: [], reaped: false };

  const ownerPid = normalizePid(existing.owner.pid);
  const currentPid = normalizePid(processApi.pid);
  if (!ownerPid || ownerPid === currentPid) return { killed: [], reaped: false };

  const isAlive = options.isAlive || defaultIsAlive;
  const ownerAlive = (() => {
    try {
      return isAlive(ownerPid, processApi);
    } catch {
      return true;
    }
  })();
  if (ownerAlive) {
    // A live owner is not an orphan. Treat identity uncertainty as live too;
    // this avoids killing a process that reused the owner's PID.
    return { killed: [], reaped: false };
  }

  const tree = createProcessTree({
    ...options,
    manifestPath,
    token: existing.token,
    allInstances: true,
    reconcile: false,
  });
  const result = tree.cleanup(options.signal || 'SIGKILL');
  return { ...result, reaped: !pathExists(manifestPath, fsApi) };
}

function reconcileProcessManifests(options = {}) {
  const fsApi = options.fsApi || fs;
  const processApi = options.processApi || process;
  const manifestDir = options.manifestDir || DEFAULT_MANIFEST_DIR;
  if (!isOwnedPath(manifestDir, fsApi, processApi)) return { reaped: 0 };
  let entries;
  try {
    entries = fsApi.readdirSync(manifestDir, { withFileTypes: true });
  } catch {
    return { reaped: 0 };
  }

  let reaped = 0;
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (!name || !name.endsWith('.json')) continue;
    if (typeof entry !== 'string' && entry.isFile && !entry.isFile()) continue;
    const manifestPath = path.join(manifestDir, name);
    const result = reapProcessManifest(manifestPath, {
      ...options,
      fsApi,
      processApi,
      manifestDir,
      reconcile: false,
    });
    if (result.reaped) reaped += 1;
  }
  return { reaped };
}

module.exports = {
  DEFAULT_MANIFEST_DIR,
  INSTANCE_ENV,
  MANIFEST_ENV,
  MANIFEST_VERSION,
  TOKEN_ENV,
  createProcessTree,
  defaultGetProcessIdentity,
  isValidManifest,
  readProcessManifest,
  reapProcessManifest,
  reconcileProcessManifests,
  signalExitCode,
};

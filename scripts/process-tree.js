'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync: defaultSpawnSync } = require('node:child_process');

const MANIFEST_ENV = 'FORGE_TEST_PROCESS_MANIFEST';
const TOKEN_ENV = 'FORGE_TEST_PROCESS_TOKEN';
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
  if (entry.status === 'reserved') return entry.pid == null && entry.identity == null;
  return normalizePid(entry.pid) === entry.pid && normalizeIdentity(entry.identity) !== null;
}

function isValidManifest(manifest) {
  return Boolean(
    manifest
      && manifest.version === MANIFEST_VERSION
      && nonEmptyString(manifest.token)
      && manifest.owner
      && typeof manifest.owner === 'object'
      && normalizePid(manifest.owner.pid) === manifest.owner.pid
      && nonEmptyString(manifest.owner.startedAt)
      && (manifest.owner.identity == null || normalizeIdentity(manifest.owner.identity) !== null)
      && Array.isArray(manifest.children)
      && manifest.children.every(isValidManifestEntry),
  );
}

function readProcessManifest(manifestPath, fsApi = fs) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) return null;
  try {
    const manifest = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8'));
    return isValidManifest(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

function writeProcessManifest(manifestPath, manifest, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(manifestPath), { recursive: true });
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

function defaultGetProcessIdentity(pid, options = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return null;
  const platform = options.platform || process.platform;
  const fsApi = options.fsApi || fs;
  const spawnSync = options.spawnSync || defaultSpawnSync;

  if (platform !== 'win32') {
    try {
      const stat = fsApi.readFileSync(`/proc/${normalizedPid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen >= 0) {
        const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
        const startTime = nonEmptyString(fields[19]);
        if (startTime) return `proc:${startTime}`;
      }
    } catch {
      // Fall through to ps on platforms without procfs.
    }

    try {
      const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(normalizedPid)], {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result && !result.error && result.status === 0) {
        const value = normalizeIdentity(result.stdout);
        if (value) return `ps:${value}`;
      }
    } catch {
      // Unavailable identity evidence is treated as unverifiable.
    }
    return null;
  }

  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${String(normalizedPid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result && !result.error && result.status === 0) {
      const value = normalizeIdentity(result.stdout);
      if (value) return `windows:${value}`;
    }
  } catch {
    // Unavailable identity evidence is treated as unverifiable.
  }
  return null;
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

function createInitialManifest(token, processApi, getProcessIdentity) {
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
  const token = String(options.token || env[TOKEN_ENV] || randomUUID());
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
    });
  }

  const manifestPath = explicitManifestPath
    || environmentManifestPath
    || path.join(manifestDir, `run-${normalizePid(processApi.pid) || process.pid}-${token}.json`);
  const markerExists = pathExists(manifestPath, fsApi);
  const existing = readProcessManifest(manifestPath, fsApi);
  // An environment-provided path may belong to another run. Treat that as
  // unverifiable and fail closed; never overwrite or reap another run's marker.
  const usable = !markerExists || (existing && existing.token === token);
  let manifest = existing && existing.token === token
    ? existing
    : (usable ? createInitialManifest(token, processApi, getProcessIdentity) : null);
  let sequence = manifest ? manifest.children.length : 0;
  let cleanupSignal = null;

  if (usable) {
    try {
      writeProcessManifest(manifestPath, manifest, fsApi);
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
    const latest = readProcessManifest(manifestPath, fsApi);
    return latest && latest.token === token ? latest : null;
  }

  function persist(next) {
    if (!next || !usable || !manifest) return false;
    try {
      writeProcessManifest(manifestPath, next, fsApi);
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
      id: `${token}:${sequence++}`,
      token,
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
    if (!entry || entry.token !== token || entry.status !== 'reserved') return null;
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
    const next = { ...latest, children: latest.children.filter((entry) => entry.id !== id) };
    return persist(next);
  }

  function envFor(childEnv = env) {
    if (!usable || !manifest) return { ...childEnv };
    return {
      ...childEnv,
      [MANIFEST_ENV]: manifestPath,
      [TOKEN_ENV]: token,
    };
  }

  function isVerifiableEntry(latest, entry) {
    if (!(
      latest
        && latest.version === MANIFEST_VERSION
        && latest.token === token
        && entry
        && entry.token === token
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
    if (cleanupSignal === 'SIGKILL' || (cleanupSignal === signal && !force)) {
      return { killed: [] };
    }
    cleanupSignal = signal;
    const latest = currentManifest();
    if (!latest) return { killed: [] };

    const killed = [];
    for (const entry of latest.children) {
      if (killOwnedEntry(entry, signal)) killed.push(entry.pid);
    }

    const finalManifest = currentManifest();
    const hasUnverifiableRunningEntry = finalManifest?.children.some(
      (entry) => entry.status === 'running' && !isVerifiableEntry(finalManifest, entry),
    );
    const hasLiveRunningEntry = finalManifest?.children.some(
      (entry) => entry.status === 'running'
        && isVerifiableEntry(finalManifest, entry)
        && (options.isAlive || defaultIsAlive)(entry.pid, processApi),
    );
    const hasFailedLiveEntry = finalManifest?.children.some(
      (entry) => entry.status === 'running'
        && isVerifiableEntry(finalManifest, entry)
        && (options.isAlive || defaultIsAlive)(entry.pid, processApi)
        && !killed.includes(entry.pid),
    );
    const safeToRemove = finalManifest
      && !hasUnverifiableRunningEntry
      && !hasFailedLiveEntry
      && (force || !hasLiveRunningEntry);
    if (safeToRemove && finalManifest.token === token) {
      try {
        fsApi.rmSync(manifestPath, { force: true });
      } catch {
        // A stale marker is safe to leave behind; its token still prevents a
        // later run from touching this process tree.
      }
    }
    return { killed };
  }

  function abortChild(reservation, child, signal = 'SIGKILL') {
    let killSucceeded = false;
    try {
      if (child && typeof child.kill === 'function') {
        const result = child.kill(signal);
        killSucceeded = result !== false;
      }
    } catch {
      killSucceeded = false;
    }

    unregisterChild(reservation);
    // The child handle above is the exact process returned by spawn, so a
    // direct signal is safe even when registration could not capture start
    // evidence. Remove an empty marker after the reservation is released.
    if (killSucceeded || !normalizePid(child && child.pid)) {
      cleanup('SIGKILL');
      return killSucceeded;
    }

    const alive = (() => {
      try {
        return (options.isAlive || defaultIsAlive)(normalizePid(child.pid), processApi);
      } catch {
        return true;
      }
    })();
    if (!alive) cleanup('SIGKILL');
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
    token,
  };
}

function reapProcessManifest(manifestPath, options = {}) {
  const fsApi = options.fsApi || fs;
  const processApi = options.processApi || process;
  const existing = readProcessManifest(manifestPath, fsApi);
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
    reconcile: false,
  });
  const result = tree.cleanup(options.signal || 'SIGKILL');
  return { ...result, reaped: !pathExists(manifestPath, fsApi) };
}

function reconcileProcessManifests(options = {}) {
  const fsApi = options.fsApi || fs;
  const manifestDir = options.manifestDir || DEFAULT_MANIFEST_DIR;
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
      manifestDir,
      reconcile: false,
    });
    if (result.reaped) reaped += 1;
  }
  return { reaped };
}

module.exports = {
  MANIFEST_ENV,
  MANIFEST_VERSION,
  TOKEN_ENV,
  createProcessTree,
  readProcessManifest,
  reapProcessManifest,
  reconcileProcessManifests,
  signalExitCode,
};

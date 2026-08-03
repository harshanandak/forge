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

function readProcessManifest(manifestPath, fsApi = fs) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) return null;
  try {
    const manifest = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8'));
    if (!manifest || manifest.version !== MANIFEST_VERSION
      || typeof manifest.token !== 'string' || !Array.isArray(manifest.children)) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

function writeProcessManifest(manifestPath, manifest, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fsApi.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
}

function defaultIsAlive(pid, processApi) {
  try {
    processApi.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

function createInitialManifest(token, processApi) {
  return {
    version: MANIFEST_VERSION,
    token,
    owner: {
      pid: normalizePid(processApi.pid),
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
  const token = String(options.token || env[TOKEN_ENV] || randomUUID());
  const manifestPath = options.manifestPath
    || env[MANIFEST_ENV]
    || path.join(DEFAULT_MANIFEST_DIR, `run-${normalizePid(processApi.pid) || process.pid}-${token}.json`);
  const existing = readProcessManifest(manifestPath, fsApi);
  // An environment-provided path may belong to another run. Treat that as
  // unverifiable and fail closed; never overwrite or reap another run's marker.
  const usable = !existing || existing.token === token;
  let manifest = existing && existing.token === token
    ? existing
    : createInitialManifest(token, processApi);
  let sequence = manifest.children.length;
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
    entry.pid = pid;
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
    return Boolean(
      latest
      && latest.version === MANIFEST_VERSION
      && latest.token === token
      && entry
      && entry.token === token
      && typeof entry.id === 'string'
      && entry.status === 'running'
      && normalizePid(entry.pid) === entry.pid
      && typeof entry.startedAt === 'string'
      && entry.startedAt.length > 0,
    );
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
          stdio: 'ignore',
          windowsHide: true,
        });
        return !result || !result.error;
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
    const safeToRemove = finalManifest
      && !hasUnverifiableRunningEntry
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
    manifestPath,
    token,
  };
}

function reapProcessManifest(manifestPath, options = {}) {
  const tree = createProcessTree({ ...options, manifestPath });
  return tree.cleanup(options.signal || 'SIGKILL');
}

module.exports = {
  MANIFEST_ENV,
  MANIFEST_VERSION,
  TOKEN_ENV,
  createProcessTree,
  readProcessManifest,
  reapProcessManifest,
  signalExitCode,
};

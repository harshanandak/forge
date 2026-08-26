'use strict';

/**
 * Shared process-identity probe for shepherd ownership.
 *
 * A bare "this PID exists" answer cannot tell a live owner apart from an
 * unrelated process that inherited the number after the owner died. Every place
 * that decides whether an owner row's controller or watcher is still running
 * must therefore compare the observed process start time against a marker the
 * owner itself wrote: a process that booted materially after that marker cannot
 * be the process that wrote it, so the PID was reused.
 *
 * @module pr-monitor/process-identity
 */

const fs = require('node:fs');

// Owners stamp their marker while running, so an observed process start later
// than the marker by more than this slack proves the PID was reused.
const PID_START_SKEW_MS = 60_000;
const LINUX_USER_HZ = 100;

/**
 * Epoch-ms start time of `pid`, or null when this platform cannot answer. Null is
 * "unknown", never "reused" — callers must not weaken liveness on an unknown.
 * Linux reads /proc without spawning; other platforms have no dependency-free probe
 * here, so they return null and can inject `pidStartedAt` instead.
 *
 * @param {number} pid
 * @returns {number|null}
 */
function defaultPidStartedAt(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	if (process.platform !== 'linux') return null;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
		// Fields after the (possibly space-bearing) comm field; starttime is overall
		// field 22, i.e. index 19 counting from `state`.
		const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
		const ticks = Number(fields[19]);
		const uptimeSeconds = Number(String(fs.readFileSync('/proc/uptime', 'utf8')).trim().split(/\s+/)[0]);
		if (!Number.isFinite(ticks) || !Number.isFinite(uptimeSeconds)) return null;
		return Math.round(Date.now() - uptimeSeconds * 1000 + (ticks / LINUX_USER_HZ) * 1000);
	} catch {
		return null;
	}
}

/**
 * Classify a PID against the identity marker its owner wrote.
 *
 * - `dead`: the PID is gone.
 * - `reused`: the PID exists but its process booted after the marker, so it is a
 *   different process and the owner is gone.
 * - `alive`: the PID exists and nothing disproves its identity.
 * - `unknown`: liveness itself could not be established (non-boolean probe answer
 *   or an unusable PID). Callers decide how to fail; this is never "reused".
 *
 * A missing marker or an unavailable start-time probe (today: every non-Linux
 * platform) yields `alive`, keeping behaviour exactly as it was before identity
 * verification existed. `isPidAlive` rejections propagate to the caller, matching
 * the previous bare probes.
 *
 * @param {{pid: number, startedAt: string|number|null, isPidAlive: Function,
 *   pidStartedAt?: Function}} input
 * @returns {Promise<'alive'|'dead'|'reused'|'unknown'>}
 */
async function processIdentityAlive({ pid, startedAt, isPidAlive, pidStartedAt } = {}) {
	const numericPid = Number(pid);
	if (!Number.isSafeInteger(numericPid) || numericPid <= 0) return 'unknown';
	if (typeof isPidAlive !== 'function') return 'unknown';
	const alive = await isPidAlive(numericPid);
	if (alive === false) return 'dead';
	if (alive !== true) return 'unknown';
	const marker = Date.parse(startedAt);
	if (!Number.isFinite(marker)) return 'alive';
	let observed;
	try {
		observed = await (pidStartedAt || defaultPidStartedAt)(numericPid);
	} catch {
		return 'alive';
	}
	const observedMs = Number(observed);
	if (!Number.isFinite(observedMs)) return 'alive';
	return observedMs > marker + PID_START_SKEW_MS ? 'reused' : 'alive';
}

module.exports = {
	PID_START_SKEW_MS,
	defaultPidStartedAt,
	processIdentityAlive,
};

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
 * Normalize an identity marker to epoch ms.
 *
 * @param {string|number|null|undefined} value ISO timestamp, epoch ms, or numeric string
 * @returns {number|null|typeof NaN} epoch ms, null when no marker was supplied, NaN when unparsable
 */
function markerMs(value) {
	if (value == null) return null;
	if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
	if (typeof value !== 'string') return NaN;
	const trimmed = value.trim();
	if (trimmed === '') return NaN;
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : NaN;
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
 * Identity needs BOTH halves from the same source: a caller that injects
 * `isPidAlive` for fabricated PIDs must inject `pidStartedAt` too, or there is
 * nothing honest to compare and the answer is `alive`. A missing marker or an
 * unavailable start-time probe (today: every non-Linux platform) is `alive` for
 * the same reason, keeping behaviour exactly as it was before identity
 * verification existed. A supplied but unparsable marker is `unknown`, never a
 * silent `alive`. `isPidAlive` rejections propagate to the caller, matching the
 * previous bare probes.
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
	// Never fall back to the built-in probe here: only the caller knows whether its
	// liveness answer and a start-time probe describe the same process.
	if (typeof pidStartedAt !== 'function') return 'alive';
	const marker = markerMs(startedAt);
	if (marker === null) return 'alive';
	if (!Number.isFinite(marker)) return 'unknown';
	let observed;
	try {
		observed = await pidStartedAt(numericPid);
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

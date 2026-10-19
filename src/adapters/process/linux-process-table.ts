import { closeSync, openSync, opendirSync, readSync } from "node:fs";

export interface ProcessTablePort {
  members(
    groupId: number,
    checkBudget: () => void,
  ): Iterable<{ readonly pid: number; readonly state: string }>;
}

// A proc stat record has a short comm plus fixed numeric fields.
// Refuse larger records instead of allocating from an untrusted file size.
export const MAX_PROCESS_STAT_BYTES = 4096;

export function parseProcessStat(
  text: string,
  expectedPid: number,
): { readonly pid: number; readonly groupId: number; readonly state: string } {
  const end = text.lastIndexOf(")");
  const prefix = `${expectedPid} (`;
  if (!text.startsWith(prefix) || end < prefix.length)
    throw new Error("Invalid process stat identity");
  // comm may contain spaces, newlines and closing parentheses. Only the final
  // closing parenthesis separates it from state, ppid and pgrp (fields 3..5).
  const fields = text
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const group = fields[2];
  // A task being released has left its PID namespace: Linux then reports
  // ppid 0 and pgrp -1. It can belong to no group, so -1 never matches one.
  if (
    state === undefined ||
    !/^[A-Zt]$/.test(state) ||
    group === undefined ||
    !/^(?:-1|\d+)$/.test(group) ||
    !Number.isSafeInteger(Number(group))
  )
    throw new Error("Invalid process stat fields");
  return { pid: expectedPid, groupId: Number(group), state };
}

function disappeared(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

function readMember(
  path: string,
  pid: number,
  buffer: Buffer,
  checkBudget: () => void,
): ReturnType<typeof parseProcessStat> | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    checkBudget();
    if (length > MAX_PROCESS_STAT_BYTES)
      throw new Error("Process stat exceeded its safety byte limit");
    return parseProcessStat(buffer.toString("utf8", 0, length), pid);
  } catch (error) {
    // A process can be reaped between directory enumeration and reading.
    // All other failures leave membership unknown, so cleanup fails closed.
    if (!disappeared(error)) throw error;
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function* scanDirectory(
  path: string,
  groupId: number,
  buffer: Buffer,
  checkBudget: () => void,
  threads: boolean,
): ReturnType<ProcessTablePort["members"]> {
  checkBudget();
  const confirmReapedLeader = (): void => {
    const leaderPath = path.slice(0, -"/task".length);
    const leaderPid = Number(leaderPath.slice(leaderPath.lastIndexOf("/") + 1));
    const leader = readMember(
      `${leaderPath}/stat`,
      leaderPid,
      buffer,
      checkBudget,
    );
    if (leader !== undefined && leader.groupId === groupId)
      throw new Error("Could not inspect retained process tasks");
  };
  let directory;
  try {
    directory = opendirSync(path);
  } catch (error) {
    if (threads && disappeared(error)) {
      confirmReapedLeader();
      return;
    }
    throw error;
  }
  let observedTasks = 0;
  try {
    while (true) {
      checkBudget();
      const entry = directory.readSync();
      if (entry === null) break;
      if (!/^[1-9]\d*$/.test(entry.name)) continue;
      const member = readMember(
        `${path}/${entry.name}/stat`,
        Number(entry.name),
        buffer,
        checkBudget,
      );
      if (member === undefined || member.groupId !== groupId) continue;
      observedTasks++;
      // A thread-group leader can be a zombie while another thread still runs.
      // Inspect its tasks rather than mistaking that partial exit for termination.
      if (!threads && member.state === "Z")
        yield* scanDirectory(
          `${path}/${entry.name}/task`,
          groupId,
          buffer,
          checkBudget,
          true,
        );
      else yield member;
    }
  } finally {
    directory.closeSync();
  }
  if (threads && observedTasks === 0) confirmReapedLeader();
}

export const linuxProcessTable: ProcessTablePort = {
  *members(groupId, checkBudget) {
    const buffer = Buffer.alloc(MAX_PROCESS_STAT_BYTES + 1);
    yield* scanDirectory("/proc", groupId, buffer, checkBudget, false);
  },
};

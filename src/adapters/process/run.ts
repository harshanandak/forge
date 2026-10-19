import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ProcessResult, SpawnOptions, ProcessSupervisionReport } from "../../ports/process.ts";
import { ProcessSpawnError } from "./errors.ts";
import { planSpawn } from "./plan.ts";
import type { Platform } from "./platform.ts";
import { openContainment, type ContainmentOptions } from "./containment.ts";
import { killTree } from "./tree-kill.ts";

const DRAIN_GRACE_MS = 250;
const KILL_WAIT_MS = 5000;
const MAX_TIMER_MS = 2147483647;
/** No pool: at most two temporary Node helpers, then zero while idle. */
export const MAX_SUPERVISORS: number = 2;
let activeSupervisors = 0;

/** Keeps the first `limit` bytes of one stream and counts the rest as dropped. */
class Capture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private readonly limit: number;
  truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function validate(options: SpawnOptions): void {
  const bad = (what: string): never => {
    throw new ProcessSpawnError("INVALID_OPTIONS", what);
  };
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    bad("timeoutMs must be a positive number of milliseconds.");
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 0)
    bad("maxOutputBytes must be a non-negative integer.");
  if (!existsSync(options.cwd))
    bad(`the working directory "${options.cwd}" does not exist.`);
  for (const [name, value] of Object.entries(options.env)) {
    if (typeof value !== "string" || name === "" || name.includes("="))
      bad(`environment entry "${name}" is not a plain name=string pair.`);
  }
}


export async function runProcess(
  executable: string, args: readonly string[], options: SpawnOptions, platform: Platform,
  containmentOptions: ContainmentOptions = {},
): Promise<ProcessResult> {
  validate(options);
  if (options.signal?.aborted) throw new ProcessSpawnError("INVALID_OPTIONS", "Process invocation is cancelled");
  if (activeSupervisors >= MAX_SUPERVISORS) throw new ProcessSpawnError("PROCESS_LIMIT_EXCEEDED", "The host already has two active process supervisors");
  activeSupervisors++;
  const started = performance.now();
  let scope: Awaited<ReturnType<typeof openContainment>> | undefined;
  try {
    // Capability setup is complete before even the waiting supervisor is spawned.
    scope = await openContainment(platform, options.containment === "strict", containmentOptions);
    if (options.signal?.aborted) throw new ProcessSpawnError("INVALID_OPTIONS", "Process invocation is cancelled");
    const plan = planSpawn(executable, args, options.env, platform);
    const container = scope;
    return await new Promise<ProcessResult>((resolveRun, rejectRun) => {
      const helper = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./supervisor-child.ts" : "./supervisor-child.js", import.meta.url));
      const child = spawn(process.execPath, [helper], {
        cwd: options.cwd, env: platform === "win32" ? {SystemRoot:process.env.SystemRoot ?? "C:/Windows"} : {},
        stdio:["ignore","pipe","pipe","ipc"], detached:platform !== "win32", windowsHide:true, shell:false,
      });
      const stdout = new Capture(options.maxOutputBytes), stderr = new Capture(options.maxOutputBytes);
      child.stdout?.on("data", (chunk:Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk:Buffer) => stderr.push(chunk));
      let timedOut = false, interrupted = false, attached = false, closing = false;
      let exited = false, pipesClosed = false;
      let commandPid: number | undefined;
      let residentBytes = 0;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let finishExit!: () => void;
      const exitPromise = new Promise<void>(resolve => { finishExit=resolve; });
      let finishPipes!: () => void;
      const pipesPromise = new Promise<void>(resolve => { finishPipes=resolve; });
      child.once("exit", () => { exited=true; finishExit(); if (!closing) void finish(new ProcessSpawnError("SPAWN_FAILED", "Process supervisor exited before completion")); });
      child.once("close", () => { pipesClosed=true; finishPipes(); });
      const pause = async (pending: Promise<void>, ms:number):Promise<void> => {
        let timer:ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([pending, new Promise<void>(resolve => {timer=setTimeout(resolve,ms);})]); }
        finally { if(timer !== undefined) clearTimeout(timer); }
      };
      const finish = async (failure?:Error): Promise<void> => {
        if (closing) return; closing=true;
        clearTimeout(timeout); options.signal?.removeEventListener("abort", cancel);
        let stoppedPids: readonly number[] = [];
        let cleanupFailure:unknown;
        try {
          if (attached) stoppedPids = await container.stop();
          else if (child.pid !== undefined) await killTree(child.pid, platform);
          if (!exited) await pause(exitPromise,KILL_WAIT_MS);
          if (!exited) throw new ProcessSpawnError("TREE_KILL_FAILED", "Supervisor did not exit after termination");
          if (!pipesClosed) await pause(pipesPromise,DRAIN_GRACE_MS);
        } catch(error) { cleanupFailure=error; }
        finally { child.stdout?.destroy(); child.stderr?.destroy(); if(child.connected) child.disconnect(); }
        if (cleanupFailure !== undefined) { rejectRun(cleanupFailure instanceof Error ? cleanupFailure : new ProcessSpawnError("TREE_KILL_FAILED", "Process cleanup failed", cleanupFailure)); return; }
        if (failure) {rejectRun(failure);return;}
        const supervision: ProcessSupervisionReport = {
          mode: options.containment ?? "supervised", backend:container.backend,
          supervisorPid:child.pid!, ...(commandPid === undefined ? {} : {commandPid}), stoppedPids,
          ...(container.backend === "process-group" ? {groupId:child.pid!} : {}),
          confirmed:true,supervisorResidentBytes:residentBytes,
        };
        resolveRun({exitCode:interrupted?null:exitCode,signal:interrupted?"SIGKILL":exitSignal,
          stdout:stdout.text(),stderr:stderr.text(),timedOut,truncated:stdout.truncated||stderr.truncated,
          durationMs:Math.round(performance.now()-started),supervision});
      };
      const cancel = ():void => { interrupted=true; void finish(); };
      const timeout=setTimeout(() => {timedOut=true;cancel();},Math.min(options.timeoutMs,MAX_TIMER_MS));
      options.signal?.addEventListener("abort",cancel,{once:true});
      if (options.signal?.aborted) cancel();
      child.once("error", cause => { void finish(new ProcessSpawnError("SPAWN_FAILED","Could not start process supervisor",cause)); });
      child.on("message", (value:unknown) => {
        if (closing || value===null || typeof value!=="object") return;
        const message=value as Record<string,unknown>;
        if (message.kind==="ready") {
          try {
            if (child.pid===undefined) throw new Error("Supervisor has no PID");
            container.attach(child.pid); attached=true;
            residentBytes=typeof message.residentBytes==="number"?message.residentBytes:0;
            child.send({kind:"start",file:plan.file,args:plan.args,cwd:options.cwd,env:{...options.env},verbatim:plan.windowsVerbatimArguments,...(options.stdin===undefined?{}:{stdin:options.stdin})}, error => { if(error) void finish(new ProcessSpawnError("SPAWN_FAILED","Could not start supervised command",error)); });
          } catch(error) {void finish(error instanceof Error?error:new ProcessSpawnError("CONTAINMENT_UNAVAILABLE","Could not attach supervisor",error));}
        } else if(message.kind==="started" && typeof message.pid==="number") commandPid=message.pid;
        else if(message.kind==="exited") {
          exitCode=typeof message.code==="number"?message.code:null; exitSignal=typeof message.signal==="string"?message.signal:null;
          void finish();
        } else if(message.kind==="failed") void finish(new ProcessSpawnError("SPAWN_FAILED","Could not start supervised command"));
      });
    });
  } finally { try {scope?.close();} finally {activeSupervisors--;} }
}

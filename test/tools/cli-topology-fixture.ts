import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

// This race never changes Git topology. Snapshot only discovery, not lock state,
// history, HEAD, tier policy or diffs, and check the snapshot again after the race.
export function cliTopologyFixture(options: {
  root: string;
  script: string;
  main: string;
  caller: string;
  env: NodeJS.ProcessEnv;
}) {
  const common = join(options.main, ".git");
  const commands = [
    {
      cwd: options.caller,
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    },
    {
      cwd: options.caller,
      args: ["--git-dir", common, "worktree", "list", "--porcelain", "-z"],
    },
    { cwd: options.caller, args: ["rev-parse", "--show-toplevel"] },
    {
      cwd: options.main,
      args: ["worktree", "list", "--porcelain", "-z"],
    },
  ];
  const read = ({ cwd, args }: (typeof commands)[number]) => {
    const result = spawnSync("git", args, {
      cwd,
      env: options.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    if (result.error || result.status !== 0)
      throw new Error(`Cannot read fixture topology: ${result.stderr}`, {
        cause: result.error,
      });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const snapshots = commands.map(read);
  const cached = Object.fromEntries(
    commands.map(({ cwd, args }, i) => [
      JSON.stringify([resolve(cwd), args]),
      snapshots[i],
    ]),
  );
  const calls = join(options.root, "topology-calls");
  const runner = resolve(options.script, "../run-command.ts");
  return {
    calls,
    setup: String.raw`import {mock as topologyMock} from 'bun:test';
import {runCommand as topologyRunCommand} from ${JSON.stringify(runner)};
import {appendFileSync as recordTopologyCall} from 'node:fs';
import {resolve as resolveTopologyCwd} from 'node:path';
const nativeTopologyRun=topologyRunCommand,topology=${JSON.stringify(cached)};
topologyMock.module(${JSON.stringify(runner)},()=>({runCommand:(command,args,options)=>{
 const key=JSON.stringify([resolveTopologyCwd(options.cwd??process.cwd()),args]);
 if(command!=='git'||!Object.hasOwn(topology,key))return nativeTopologyRun(command,args,options);
 recordTopologyCall(${JSON.stringify(calls)},'lookup\n');
 return topology[key];
}}));
`,
    verify() {
      for (const [i, command] of commands.entries())
        if (read(command).stdout !== snapshots[i]!.stdout)
          throw new Error("Fixture Git topology changed during the race");
    },
  };
}

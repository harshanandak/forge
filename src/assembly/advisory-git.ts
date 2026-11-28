import {
  createProcessPort,
  proveAdvisoryGit,
} from "../adapters/process/index.ts";
import {
  openReadChild,
  type ReadChild,
} from "../adapters/process/read-child.ts";
import {
  processGitPin,
  restoreProcessGitPin,
} from "../adapters/process/resolve.ts";
import type { ProcessPort, ResolvedExecutable } from "../ports/process.ts";
import {
  cloneGitCapability,
  createGitScope,
  gitCapability,
} from "./providers.ts";

type Environment = Readonly<Record<string, string>>;
type Initial = {
  op: "initial";
  project: string;
  root: string;
  env: Environment;
};
type Input = Initial | { op: "discovery"; env: Environment } | { op: "launch" };
type ChildInput = Input & { previous?: ResolvedExecutable };
type Resolution = ReturnType<ProcessPort["resolve"]> | null;
type Reply = { result: Resolution } | { failed: true };

export function openAdvisoryGit(
  signal: AbortSignal,
): ReadChild<Input, Resolution> {
  const child = openReadChild<ChildInput, Reply>(
    new URL(import.meta.url),
    signal,
  );
  const previous = processGitPin();
  return {
    async read(input) {
      const reply = await child.read(
        input.op === "initial" && previous ? { ...input, previous } : input,
      );
      if ("failed" in reply) throw new Error("Advisory Git read failed");
      return reply.result;
    },
    close: (deadline) => child.close(deadline),
  };
}

if (import.meta.main && process.send) {
  const port = createProcessPort();
  let root: string;
  let git: ReturnType<typeof gitCapability>;
  let pin: Awaited<ReturnType<typeof proveAdvisoryGit>>;
  const signal = new AbortController().signal;
  async function resolveGit(input: ChildInput): Promise<Resolution> {
    if (input.op === "initial") {
      root = input.root;
      if (input.previous) restoreProcessGitPin(input.previous);
      git = gitCapability(port, input.env, createGitScope(input.project, root));
      const executable = git.executable();
      if (executable.kind !== "resolved") return executable;
      pin = await proveAdvisoryGit(executable, process.platform, signal);
      return pin?.executable ?? null;
    }
    const current =
      input.op === "discovery"
        ? cloneGitCapability(port, root, input.env).executable()
        : git.executable();
    if (current.kind !== "resolved") return current;
    return current.path === pin?.executable.path && pin.unchanged()
      ? pin.executable
      : null;
  }
  process.on("message", (input: ChildInput) => {
    void resolveGit(input).then(
      (result) => process.send?.({ result }),
      () => process.send?.({ failed: true }),
    );
  });
}

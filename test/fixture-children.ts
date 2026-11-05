import {
  spawn,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

/** Retain the children whose working directories and streams belong to a fixture. */
export class FixtureChildren {
  private readonly pending = new Set<Promise<void>>();

  own<T extends ChildProcess>(child: T): T {
    const closed = new Promise<void>((resolve) => {
      child.once("close", resolve);
    });
    this.pending.add(closed);
    void closed.then(() => this.pending.delete(closed));
    return child;
  }

  run(command: string, args: string[], options: SpawnOptionsWithoutStdio) {
    const child = this.own(
      spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }),
    );
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (cause) => {
      error = cause;
    });
    return new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
      error: Error | undefined;
    }>((resolve) => {
      child.once("close", (status) => {
        resolve({ status, stdout, stderr, error });
      });
    });
  }

  async cleanup(remove: () => void): Promise<void> {
    // A leader can exit while a descendant still owns an inherited output pipe.
    while (this.pending.size) await Promise.all([...this.pending]);
    remove();
  }
}

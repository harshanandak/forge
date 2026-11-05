import {
  spawn,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

/** Retain the children whose working directories and streams belong to a fixture. */
export class FixtureChildren {
  private readonly pending = new Map<Promise<void>, (() => void) | undefined>();

  own<T extends ChildProcess>(child: T, stop?: () => void): T {
    const closed = new Promise<void>((resolve) => {
      child.once("close", resolve);
    });
    this.pending.set(closed, stop);
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
    const failures: unknown[] = [];
    while (this.pending.size) {
      const children = [...this.pending];
      for (const [closed, stop] of children) {
        // Request shutdown once, while the parent can still reap its descendants.
        this.pending.set(closed, undefined);
        try {
          stop?.();
        } catch (error) {
          failures.push(error);
        }
      }
      await Promise.all(children.map(([closed]) => closed));
    }
    if (failures.length)
      throw new AggregateError(failures, "Fixture child shutdown failed");
    remove();
  }
}

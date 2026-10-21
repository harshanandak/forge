import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { runWithin } from "../../../tools/pack-smoke/bounded.ts";

for (const event of ["exit", "error"] as const)
  test(`POSIX signals reach the detached group and listeners are removed on ${event}`, async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    const child = Object.assign(new EventEmitter(), { pid: 12345 });
    const spawn = spyOn(childProcess, "spawn").mockReturnValue(
      child as unknown as childProcess.ChildProcess,
    );
    const kill = spyOn(process, "kill").mockReturnValue(true);
    const signals = ["SIGINT", "SIGTERM"] as const;
    const counts = signals.map((signal) => process.listenerCount(signal));
    const result = runWithin("journeys", "bun", [], {}, 10000).catch(
      (error: unknown) => error,
    );
    try {
      for (const [index, signal] of signals.entries()) {
        expect(process.listenerCount(signal)).toBe(counts[index]! + 1);
        process.emit(signal);
        expect(kill).toHaveBeenCalledWith(-child.pid, signal);
      }
      kill.mockImplementation(() => {
        throw new Error("group already exited");
      });
      expect(() => process.emit("SIGINT")).not.toThrow();
    } finally {
      if (event === "exit") child.emit("exit", 0, null);
      else child.emit("error", new Error("spawn failed"));
      await result;
      spawn.mockRestore();
      kill.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
    for (const [index, signal] of signals.entries())
      expect(process.listenerCount(signal)).toBe(counts[index]!);
  }, 30000);

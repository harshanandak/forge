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
        throw Object.assign(new Error("group already exited"), {
          code: "ESRCH",
        });
      });
      expect(() => process.emit("SIGINT")).not.toThrow();
    } finally {
      if (event === "exit") child.emit("exit", 0, null);
      else child.emit("error", new Error("spawn failed"));
      const outcome = await result;
      expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      if (event === "exit") expect(outcome).toBeUndefined();
      else expect((outcome as Error).message).toBe("journeys: spawn failed");
      spawn.mockRestore();
      kill.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
    for (const [index, signal] of signals.entries())
      expect(process.listenerCount(signal)).toBe(counts[index]!);
  }, 30000);

test("POSIX cleanup errors reject and remove signal listeners before returning", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  const child = Object.assign(new EventEmitter(), { pid: 12345 });
  const spawn = spyOn(childProcess, "spawn").mockReturnValue(
    child as unknown as childProcess.ChildProcess,
  );
  const refused = Object.assign(new Error("kill refused"), { code: "EPERM" });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw refused;
  });
  const counts = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ];
  try {
    const result = runWithin("journeys", "bun", [], {}, 10000).catch(
      (error: unknown) => error,
    );
    child.emit("exit", 3, null);
    const error = (await result) as Error;
    expect(error.message).toBe("journeys: process group cleanup failed");
    expect(error.cause).toBe(refused);
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(counts);
  } finally {
    spawn.mockRestore();
    kill.mockRestore();
    Object.defineProperty(process, "platform", platform);
  }
}, 30000);

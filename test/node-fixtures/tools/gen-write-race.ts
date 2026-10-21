// Worker for the gen-write race: each round, writers publish at one barrier while the reader checks every byte it sees.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { writeGenerated } from "../../../tools/gen/write.ts";

type Data = {
  role: "writer" | "reader";
  directory: string;
  content: string;
  rounds: number;
  /** [0] arrivals at the barrier, [1] last released round, [2] last round whose writers all returned. */
  state: SharedArrayBuffer;
};

// The file is absent before its first publish; Windows also refuses an open while a rename replaces it.
const UNREADABLE = new Set(["ENOENT", "EPERM", "EBUSY", "EACCES"]);

const { role, directory, content, rounds, state } = workerData as Data;
const flags = new Int32Array(state);
const until = (index: number, round: number) => {
  for (
    let seen = Atomics.load(flags, index);
    seen < round;
    seen = Atomics.load(flags, index)
  )
    Atomics.wait(flags, index, seen);
};

for (let round = 1; round <= rounds; round += 1) {
  const file = join(directory, `round-${round}`, "output.txt");
  Atomics.add(flags, 0, 1);
  Atomics.notify(flags, 0);
  until(1, round);
  if (role === "writer") {
    writeGenerated(file, content);
    parentPort?.postMessage({ round, incomplete: false });
    continue;
  }
  let incomplete = false;
  while (!incomplete && Atomics.load(flags, 2) < round) {
    try {
      incomplete = readFileSync(file, "utf8") !== content;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        UNREADABLE.has(String(error.code))
      ))
        throw error;
    }
  }
  parentPort?.postMessage({ round, incomplete });
}

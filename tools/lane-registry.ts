import { createCloneFilesLease } from "../src/adapters/fs/clone-files.ts";
import { processStartTime } from "../src/adapters/process/index.ts";

/** Share the block file service's recoverable lock protocol with the repository helpers. */
export function lockLaneRegistry(root: string, common: string): () => void {
  const lease = createCloneFilesLease({
    processStartTime,
    projectRoot: root,
    gitDirectory: common,
    commonDirectory: common,
    read: true,
    write: true,
    signal: new AbortController().signal,
  });
  try {
    lease.service.lock(["forge-lanes-registry.lock"], {
      recoverDeadOwner: true,
    });
    return () => lease.close();
  } catch (error) {
    lease.close();
    throw error;
  }
}

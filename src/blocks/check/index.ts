import entry from "./entry.cts";
import { checkCrypto } from "./support.ts";
import type { CheckServices } from "./types.ts";
export type * from "./types.ts";
export { verifyReceipt } from "./receipt.ts";
export function createCheck(services: CheckServices): CheckBlock {
  return (
    entry as unknown as {
      createCheck: (
        services: CheckServices & { crypto: typeof checkCrypto },
      ) => CheckBlock;
    }
  ).createCheck({ ...services, crypto: checkCrypto });
}

export interface CheckBlock {
  list(config: import("./types.ts").CheckConfig): string[];
  show(id: string): import("./types.ts").CheckReceipt | undefined;
  run(
    input: import("./types.ts").RunInput,
    config: import("./types.ts").CheckConfig,
    scope?: import("./types.ts").CheckInvocationScope,
  ): Promise<import("./types.ts").CheckReceipt>;
}

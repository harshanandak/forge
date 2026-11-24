import type { RefuseNetworkPath } from "./store.ts";
export const refuseNetworkPath: RefuseNetworkPath = () => {
  throw new Error("not_built");
};

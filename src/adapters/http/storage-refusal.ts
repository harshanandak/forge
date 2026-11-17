import type { ForgeError } from "../../generated/types.ts";

export function storageRefusal(code: string): ForgeError | undefined {
  if (code === "QUOTA_EXHAUSTED")
    return {
      code,
      message: "Durable Object daily quota exhausted; retry after 00:00 UTC",
      retry: "safe",
    };
  if (code === "STORAGE_LIMIT_EXCEEDED")
    return {
      code,
      message: "Project storage limit exceeded",
      retry: "never",
    };
}

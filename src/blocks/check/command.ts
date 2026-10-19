import entry from "./entry.cts";
export const commandArguments: (text: string) => string[] = (
  entry as unknown as { commandArguments: (text: string) => string[] }
).commandArguments;
import { ForgeFailure } from "../../contract/failure.ts";
export function invalid(message: string): never {
  throw new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
}

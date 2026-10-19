import { ForgeFailure } from "../../contract/failure.ts";

/** Split a declared executable invocation, never evaluate shell syntax. */
export function commandArguments(text: string): string[] {
  const args: string[] = [];
  let value = "",
    quote = "",
    started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(value);
        value = "";
        started = false;
      }
    } else {
      if (/[|&;<>`$\r\n]/.test(char))
        invalid(
          "Shell syntax needs a project-owned script; declare an argument array instead.",
        );
      value += char;
      started = true;
    }
  }
  if (quote) invalid("Declared command contains an unclosed quote.");
  if (started) args.push(value);
  if (!args[0]) invalid("Declared command has no executable.");
  return args;
}
export function invalid(message: string): never {
  throw new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
}

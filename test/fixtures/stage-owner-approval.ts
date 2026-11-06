import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Flattened packed fixtures carry the test helper, never a source-module import. */
export function stageOwnerApprovalFixture(
  source: string,
  target: string,
  text = readFileSync(source, "utf8"),
): void {
  copyFileSync(
    new URL("./owner-approval.mjs", import.meta.url),
    join(dirname(target), "owner-approval.mjs"),
  );
  writeFileSync(
    target,
    text.replaceAll(
      "../../fixtures/owner-approval.mjs",
      "./owner-approval.mjs",
    ),
  );
}

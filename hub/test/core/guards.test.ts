import { expect, test } from "bun:test";
import { SUMMARY_KEY_MARKER } from "../../src/contract/chat.ts";
import { LIMITS } from "../../src/contract/mcp.ts";
import { createGuards, validateAskAuthority } from "../../src/core/guards.ts";

const timeout = 30_000;
const normal = {
  kind: "choice",
  requestedAction: "choice",
  question: "Which option?",
} as const;

test(
  "G1: authority approvals and mismatched action kinds are refused",
  () => {
    expect(
      validateAskAuthority({ ...normal, requestedAction: "merge" }),
    ).toMatchObject({ code: "AUTHORITY_ASK_REFUSED", retry: "never" });
    expect(
      validateAskAuthority({ ...normal, requestedAction: "work" }),
    ).toMatchObject({ code: "INPUT_INVALID", pointer: "/requestedAction" });
    for (const ask of [
      { ...normal, question: "Merge PR 12?" },
      { ...normal, choices: [{ id: "yes", label: "Deploy" }] },
    ])
      expect(validateAskAuthority(ask)).toMatchObject({
        code: "AUTHORITY_ASK_REFUSED",
      });
    expect(
      validateAskAuthority({ ...normal, question: "Will this emerge?" }),
    ).toBeUndefined();
  },
  timeout,
);

test(
  "G2: a secret in either ask text field is refused without echo",
  () => {
    const guards = createGuards();
    const sample = ["gh", "p_", "a".repeat(36)].join("");
    for (const pointer of ["/question", "/choices/0/label"]) {
      const error = guards.outboundText("Example " + sample, pointer);
      expect(error).toMatchObject({ code: "SECRET_IN_TEXT", retry: "never" });
      expect(JSON.stringify(error)).not.toContain(sample);
    }
  },
  timeout,
);

test(
  "G3: the reserved marker returns the exact field pointer",
  () => {
    const guards = createGuards();
    for (const pointer of ["/question", "/choices/0/label"])
      expect(
        guards.outboundText("Example " + SUMMARY_KEY_MARKER, pointer),
      ).toMatchObject({ code: "INPUT_INVALID", pointer });
    expect(guards.storedText("a".repeat(LIMITS.storedText + 1))).toHaveLength(
      LIMITS.storedText,
    );
  },
  timeout,
);

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Overlay {
  kind: "binding" | "hook";
  text: string;
  separator: boolean;
  values: Record<string, string[]>;
}
interface Api {
  createOverlay(
    original: string,
    kind: Overlay["kind"],
    fragment: string,
    values: Record<string, string[]>,
  ): Overlay;
  appendOverlay(
    original: string,
    overlay: Overlay,
    existing: readonly Overlay[],
  ): string;
  removeOverlays(
    config: string,
    overlays: readonly Overlay[],
    kinds: readonly Overlay["kind"][],
  ): string;
  overlayPresence(
    config: string,
    overlays: readonly Overlay[],
  ): Map<Overlay["kind"], boolean>;
  expectedOverlayValues(
    bound: unknown,
    present: ReadonlyMap<Overlay["kind"], boolean>,
  ): Record<string, string[]>;
}
function load(): Api {
  const source = readFileSync(
      new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
      "utf8",
    ),
    module = { exports: {} as Api };
  runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      source +
        "\nmodule.exports={createOverlay,appendOverlay,removeOverlays,overlayPresence,expectedOverlayValues};",
    ),
    {
      module,
      fail: (code: string, message: string) => {
        throw Object.assign(new Error(message), { code });
      },
    },
  );
  return module.exports;
}
const original =
  "[user]\n name = Original\n[include]\n path = local-identity.inc\n[user]\n email = native@example.com";
const values = {
  "forge.githubAccount": ["alice"],
  "user.email": ["alice@example.com"],
};
const fragment =
  "[forge]\n githubAccount = alice\n[user]\n email = alice@example.com\n";
test("owned overlay leaves repeated sections/include positions untouched and restores a missing final newline", () => {
  const api = load(),
    overlay = api.createOverlay(original, "binding", fragment, values),
    active = api.appendOverlay(original, overlay, []);
  expect(active).toBe(original + "\n" + overlay.text);
  expect(overlay.separator).toBe(true);
  expect(api.removeOverlays(active, [overlay], ["binding", "hook"])).toBe(
    original,
  );
}, 1000);
test("removing account and hook overlays retains the separator needed by later unrelated edits", () => {
  const api = load(),
    binding = api.createOverlay(original, "binding", fragment, values),
    active = api.appendOverlay(original, binding, []);
  const hook = api.createOverlay(
      active,
      "hook",
      "[core]\n hooksPath = /owned/hooks\n",
      { "core.hooksPath": ["/owned/hooks"] },
    ),
    guarded = api.appendOverlay(active, hook, [binding]);
  expect(
    api.removeOverlays(guarded, [binding, hook], ["binding", "hook"]),
  ).toBe(original);
  const later = "[unrelated]\n value = retained\n";
  expect(
    api.removeOverlays(guarded + later, [binding, hook], ["binding", "hook"]),
  ).toBe(original + "\n" + later);
  expect(api.removeOverlays(guarded + later, [binding, hook], ["hook"])).toBe(
    active + later,
  );
}, 1000);
test("unrelated prefix edits and marker text inside values survive removal exactly", () => {
  const api = load(),
    native =
      original +
      '\n[notes]\n message = "# forge/github-accounts config binding begin v1"\n',
    overlay = api.createOverlay(native, "binding", fragment, values);
  const edited =
    api
      .appendOverlay(native, overlay, [])
      .replace("[notes]", "# unrelated comment\n[notes]") +
    "[other]\n key = value\n";
  expect(api.removeOverlays(edited, [overlay], ["binding"])).toBe(
    native.replace("[notes]", "# unrelated comment\n[notes]") +
      "[other]\n key = value\n",
  );
}, 1000);
test("duplicate, partial, and modified owned config fragments fail closed", () => {
  const api = load(),
    overlay = api.createOverlay(original, "binding", fragment, values),
    active = api.appendOverlay(original, overlay, []);
  for (const changed of [
    active + overlay.text,
    active.replace("githubAccount = alice", "githubAccount = mallory"),
    active.replace("binding end v1", "binding end v2"),
  ]) {
    let error: unknown;
    try {
      api.removeOverlays(changed, [overlay], ["binding"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "INPUT_CONFLICT" });
  }
}, 1000);
test("overlapping owned regions cannot erase another overlay during removal", () => {
  const api = load(),
    hook = api.createOverlay(
      "",
      "hook",
      "[core]\n hooksPath = /owned/hooks\n",
      { "core.hooksPath": ["/owned/hooks"] },
    ),
    binding = api.createOverlay(
      original,
      "binding",
      fragment + hook.text,
      values,
    ),
    active = api.appendOverlay(original, binding, []);
  let error: unknown;
  try {
    api.removeOverlays(active, [binding, hook], ["binding", "hook"]);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "INPUT_CONFLICT" });
}, 1000);
test("interrupted activation/cleanup derives expected native values from only the overlays still present", () => {
  const api = load(),
    binding = api.createOverlay(original, "binding", fragment, values),
    active = api.appendOverlay(original, binding, []);
  const hook = api.createOverlay(
    active,
    "hook",
    "[core]\n hooksPath = /owned/hooks\n",
    { "core.hooksPath": ["/owned/hooks"] },
  );
  const bound = {
    version: 2,
    overlays: [binding, hook],
    previous: {
      "forge.githubAccount": [],
      "user.email": ["native@example.com"],
      "core.hooksPath": [],
    },
    installed: {
      "forge.githubAccount": ["alice"],
      "user.email": ["native@example.com", "alice@example.com"],
      "core.hooksPath": ["/owned/hooks"],
    },
  };
  expect(
    api.expectedOverlayValues(
      bound,
      api.overlayPresence(active, [binding, hook]),
    ),
  ).toEqual({
    "forge.githubAccount": ["alice"],
    "user.email": ["native@example.com", "alice@example.com"],
    "core.hooksPath": [],
  });
  expect(
    api.expectedOverlayValues(
      bound,
      api.overlayPresence(original, [binding, hook]),
    ),
  ).toEqual(bound.previous);
  expect(
    api.removeOverlays(original, [binding, hook], ["binding", "hook"]),
  ).toBe(original);
}, 1000);
test("removal refuses unrelated entries that implicitly depend on an owned section header", () => {
  const api = load(),
    overlay = api.createOverlay(original, "binding", fragment, values),
    active = api.appendOverlay(original, overlay, []);
  let error: unknown;
  try {
    api.removeOverlays(
      active + " editor = user-choice\n",
      [overlay],
      ["binding"],
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "INPUT_CONFLICT" });
}, 1000);

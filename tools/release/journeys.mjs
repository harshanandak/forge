import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runWithin } from "../pack-smoke/bounded.ts";
import {
  environmentWithoutBun,
  resolveBun,
} from "../pack-smoke/environment.ts";
import { fileURLToPath } from "node:url";

// Bun JUnit identifies a suite by its file; names are pinned, never discovered from candidate tests.
export const requiredJourneys = [
  ...(process.platform === "win32"
    ? [
        "test/templates/delivery/fresh-import/packed.integration.test.ts::a fresh Node project imports delivery after following the missing-value repair in PowerShell 5.1",
      ]
    : []),
  "test/assembly/cloud-dist/packed.integration.test.ts::installed CLI and MCP read device attachments without acquiring a local project owner",
  "test/assembly/cloud-dist/packed.integration.test.ts::the installed package answers issue show for a bound project from the cloud, on Node with no Bun",
  "test/assembly/cloud-dist/tracker/packed.integration.test.ts::installed tracker persists writes, fences sessions and refuses unavailable or revoked authority",
  "test/assembly/providers/packed.integration.test.ts::packed stock providers: declared capabilities, generated CLI/MCP, bounded clone files, snapshot and scoped processes",
  "test/assembly/session-identity/packed.integration.test.ts::CLI and MCP trim explicit session sharing, refresh holder labels and attribute renew/release to the current caller",
  "test/assembly/session-identity/packed.integration.test.ts::CLI native harness nesting isolates chats while Codex subagents share their root session",
  "test/assembly/session-identity/packed.integration.test.ts::CLI persisted device identity fences all holder writes after same-path device replacement without leaking paths",
  "test/assembly/session-identity/packed.integration.test.ts::CLI upgrades legacy actor/session leases without requiring a generated device ID before renew, close or release",
  "test/assembly/session-identity/packed.integration.test.ts::T3 lease recovery hint: non-T3 holder",
  "test/assembly/session-identity/packed.integration.test.ts::T3 lease recovery hint: outside T3",
  "test/assembly/session-identity/packed.integration.test.ts::T3 lease recovery hint: same chat after switching",
  "test/assembly/session-identity/packed.integration.test.ts::T3 lease recovery hint: separate worker",
  "test/assembly/session-identity/packed.integration.test.ts::T3 no-lease refusal gives no chat recovery hint",
  "test/assembly/session-identity/packed.integration.test.ts::an injected TTY claim on the built CLI refuses unsourced non-TTY holder writes and permits explicit session recovery",
  "test/assembly/session-identity/packed.integration.test.ts::non-TTY CLI and MCP refuse claims without a session source and name FORGE_SESSION",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: a bound use refuses when the bound login is signed out of gh",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: a clone cannot spoof the approved identity with an empty useConfigOnly or a multi-line name",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: a custom commit email is bound only when GitHub lists it",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: a failed API call after the token lookup exposes no token in the error envelope",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: a gh config planted in the clone has no effect on token-bearing calls",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: a gh or git planted in a temp directory never runs during clone discovery",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: a gh planted under a symlinked temp directory never runs",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: a named-login use still records the unpushed-commit and email hazards",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: a non-github.com host fails closed",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: another clone's apply audit does not suppress recovery",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: check handles interrupted apply after write 1",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: check handles interrupted apply after write 2",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: check handles interrupted apply after write 3",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: gh output is validated strictly before it is trusted",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply handles dead lock owners",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply handles live clone lock owners",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply handles live device lock owners",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply refuses changed include without changing files",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply refuses config only without changing files",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply refuses declined binding without changing files",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply refuses different config include without changing files",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply refuses edited record without changing files",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply refuses no binding without changing files",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply refuses record only without changing files",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: interrupted apply refuses unowned include without changing files",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: one approval catches wrong authors and binds every clone",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: plan handles interrupted apply after write 1",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: plan handles interrupted apply after write 2",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: plan handles interrupted apply after write 3",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: plan picks the only account that can push and use verifies the login",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: plan, use and check on a bound clone start only the processes their checks need",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: planted gh and git on PATH never run or see the token",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: the interrupted-apply fixture ran one real use for the whole file",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: the token never reaches stdout, stderr, receipts or the audit",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: use handles interrupted apply after write 1",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: use handles interrupted apply after write 2",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: use handles interrupted apply after write 3",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: use with a login gh holds no token for refuses before it binds anything",
  "test/blocks/accounts/packed.integration.test.ts::installed accounts: use with a named login starts one token lookup and one api user call",
  "test/blocks/l7-work/packed.integration.test.ts::installed work block: CLI readback, lease fixtures and remove-the-fix checks",
  "test/core/async-handlers/packed.integration.test.ts::installed async ABI: supervised cleanup, strict containment, service revocation and CLI/MCP",
  "test/integration/custom-block/packed.integration.test.ts::the installed guide runs the shipped block and explains three manifest mistakes",
  "test/integration/first-run/packed.integration.test.ts::a new user's first run works end to end from the packed package",
  "test/integration/packed.integration.test.ts::packed first slice: npm detection, human admission, CLI/MCP parity and competing revisions",
  "test/node-fixtures/check/finalization/packed.integration.test.ts::packed unscoped slow finalization returns the durable receipt",
  "test/node-fixtures/check/packed.integration.test.ts::installed ecosystem: make",
  "test/node-fixtures/check/packed.integration.test.ts::installed ecosystem: npm+vitest",
  "test/node-fixtures/check/packed.integration.test.ts::installed ecosystem: pnpm+jest",
  "test/node-fixtures/check/packed.integration.test.ts::installed ecosystem: python+pytest",
  "test/node-fixtures/check/packed.integration.test.ts::packed Node check journeys and sharded remove-the-fix proofs",
  "test/node-fixtures/check/review/packed.integration.test.ts::focused packed review proofs run only their relevant surface operations",
  "test/node-fixtures/memory/packed.integration.test.ts::integration: packed memory journeys, each failing with its fix removed",
  "test/node-fixtures/state/packed.integration.test.ts::integration: packed state journeys and targeted remove-the-fix checks",
  "test/templates/delivery/fresh-import/packed.integration.test.ts::a fresh Node project imports delivery after following the missing-value repair in POSIX",
  "test/templates/delivery/packed.integration.test.ts::the delivery template ships in the npm package and runs the project's own npm test",
  "test/templates/delivery/packed.integration.test.ts::the packed delivery workflow recovers its checkpoint in a new session",
  "test/tools/pack-smoke/identity/packed.integration.test.ts::installed identity rejects a substituted commit",
  "test/tools/pack-smoke/identity/packed.integration.test.ts::installed identity rejects a substituted dirty",
  "test/tools/pack-smoke/identity/packed.integration.test.ts::installed identity rejects a substituted version",
  "test/tools/pack-smoke/identity/packed.integration.test.ts::installed identity rejects a substituted runId",
  "test/tools/pack-smoke/identity/packed.integration.test.ts::installed identity rejects a substituted missing",
  "test/tools/release/launcher/packed.integration.test.ts::plain Node release gate reaches each installed identity refusal with a Bun-free consumer PATH",
];

export function assertJourneys(xml) {
  assert.doesNotMatch(
    xml,
    /<skipped\b|skipped=["'][1-9]/,
    "release journey skipped",
  );
  assert.doesNotMatch(
    xml,
    /<(?:failure|error)\b|(?:failures|errors)=["'][1-9]/,
    "release journey failed",
  );
  const attribute = (tag, key) =>
    tag
      .match(new RegExp(`\\b${key}="([^"]*)"`))?.[1]
      ?.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity) => {
        const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        return (
          named[entity] ??
          String.fromCodePoint(
            entity[1] === "x"
              ? parseInt(entity.slice(2), 16)
              : Number(entity.slice(1)),
          )
        );
      });
  const passed = new Set(
    [...xml.matchAll(/<testcase\b[^>]*>/g)].map(
      ([tag]) =>
        `${attribute(tag, "file")?.replaceAll("\\", "/")}::${attribute(tag, "name")}`,
    ),
  );
  for (const required of requiredJourneys)
    assert.ok(
      passed.has(required),
      `missing required release journey: ${required}`,
    );
}

async function main() {
  const [cwd, consumer, tarball] = process.argv.slice(2);
  assert.ok(cwd && consumer && tarball);
  const bun = resolveBun();
  const dir = mkdtempSync(join(tmpdir(), "forge-release-report-"));
  try {
    const report = join(dir, "junit.xml");
    await runWithin(
      "registry installed journeys",
      bun,
      [
        "test",
        "--parallel=2",
        "--timeout",
        "30000",
        "packed.integration.test",
        "--reporter=junit",
        `--reporter-outfile=${report}`,
      ],
      {
        cwd,
        env: {
          ...environmentWithoutBun(process.execPath),
          npm_execpath: bun,
          FORGE_PACKED_CONSUMER: consumer,
          FORGE_PACKED_TARBALL: tarball,
          FORGE_AUTHOR_NPM_ROOT: dirname(process.execPath),
          FORGE_RELEASE_ACCEPTANCE: "1",
        },
      },
      480_000,
    );
    const xml = readFileSync(report, "utf8");
    assertJourneys(xml);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();

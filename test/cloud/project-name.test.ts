import { expect, test } from "bun:test";
import { commandProject } from "../../cloud/src/issue-commands.ts";
import { createWorker } from "../../cloud/src/worker.ts";

// The project name in a route is untrusted. Both routes must accept and refuse the same names, so
// each case runs through the real entry points: commandProject for /p/<name>/command, and the
// Worker for /p/<name>/<route> (a request with no bearer reaches 401 only if the name matched).
const env = { PROJECTS: {} } as never;
const worker = createWorker();
const NAMES: readonly (readonly [string, string, boolean])[] = [
  ["1 character", "a", true],
  ["64 characters", "a".repeat(64), true],
  ["65 characters", "a".repeat(65), false],
  ["empty", "", false],
  ["a leading dot", ".a", false],
  ["a leading hyphen", "-a", false],
  ["a leading underscore", "_a", false],
  ["mixed case and digits", "Ab9", true],
  ["internal dots", "a.b..c", true],
  ["underscores and hyphens", "a_b-c", true],
  ["an encoded trailing newline", "a%0A", false],
  ["a character outside the set", "a!b", false],
  ["an encoded space", "a%20b", false],
  ["an encoded slash", "a%2Fb", false],
  ["a colon", "a:b", false],
];

for (const [label, name, accepted] of NAMES) {
  test(`command route: ${label} is ${accepted ? "accepted" : "refused"}`, () => {
    const request = new Request(`https://w.example/p/${name}/command`);
    expect(commandProject(request)).toBe(accepted ? name : undefined);
  }, 5_000);

  test(`Worker route: ${label} is ${accepted ? "accepted" : "refused"}`, async () => {
    const response = await worker.fetch(
      new Request(`https://w.example/p/${name}/status`),
      env,
    );
    expect(response.status).toBe(accepted ? 401 : 404);
  }, 5_000);
}

test("an extra path segment matches neither route", async () => {
  for (const path of ["/p/a/b/command", "/p/a/command/x"])
    expect(commandProject(new Request(`https://w.example${path}`))).toBe(
      undefined,
    );
  for (const path of ["/p/a/b/status", "/p/a/status/x"])
    expect(
      (await worker.fetch(new Request(`https://w.example${path}`), env)).status,
    ).toBe(404);
}, 5_000);

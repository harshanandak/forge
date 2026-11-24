import { expect, test } from "bun:test";
import { a, b, caller, p1, p2, sessionFixture, value } from "./fixture.ts";

const timeout = 30_000;

test(
  "M8: hello lists purpose only for projects that have it",
  async () => {
    const { sessions } = await sessionFixture();
    expect(value(sessions.hello(caller, { host: "claude" })).projects).toEqual([
      { projectId: p1, name: "Fixture One", purpose: "Shared project context" },
      { projectId: p2, name: "Fixture Two" },
    ]);
    expect(
      value(sessions.hello({ ...caller, person: b }, { host: "claude" }))
        .projects,
    ).toHaveLength(1);
    expect(sessions.isMember(p1, a.personId)).toBe(true);
    expect(sessions.isMember(p2, b.personId)).toBe(false);
  },
  timeout,
);

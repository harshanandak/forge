import { expect, test } from "bun:test";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { baseFixture, type BaseFixture } from "./base-fixture.ts";
import { configPeople, p1, p2 } from "./fixture.ts";

const timeout = 30_000;
const pending =
  "SELECT owner_person_id,target_session_id,project_id,held FROM inbox_items ORDER BY rowid";
const conversations =
  "SELECT person_id,session_id,project_id FROM conversations ORDER BY rowid";

async function pickerFixture(
  names: readonly [string, string],
): Promise<BaseFixture> {
  const f = await baseFixture();
  const projects = f.config.projects.map((project, index) => ({
    ...project,
    name: names[index]!,
  }));
  const restarted = createCoreBase(
    createCoreContext({
      ...f.deps,
      config: { ...f.config, projects },
      people: configPeople(f.config.people),
    }),
  );
  await f.chat.start(restarted.chatHandlers);
  return f;
}

test(
  "B1B-PICK1 an ambiguous picker choice selects nothing and releases nothing",
  async () => {
    const clash = await pickerFixture(["Alpha", "alpha"]);
    await clash.dm("first-clash", "Help clash");
    await clash.dm("pick-clash", "alpha", undefined, "first-clash");
    expect(clash.sql(conversations)).toMatchObject([{ project_id: null }]);
    expect(clash.sql(pending)).toMatchObject([
      { project_id: null, held: 1, target_session_id: null },
      { project_id: null, held: 1, target_session_id: null },
    ]);

    const cross = await pickerFixture(["prj_two", "Fixture Two"]);
    await cross.dm("first-cross", "Help cross");
    await cross.dm("pick-cross", "prj_two", undefined, "first-cross");
    expect(cross.sql(conversations)).toMatchObject([{ project_id: null }]);
    expect(cross.sql(pending)).toMatchObject([
      { project_id: null, held: 1, target_session_id: null },
      { project_id: null, held: 1, target_session_id: null },
    ]);

    const same = await pickerFixture(["prj_one", "Fixture Two"]);
    await same.dm("first-same", "Help same");
    await same.dm("pick-same", "prj_one", undefined, "first-same");
    expect(same.sql(conversations)).toMatchObject([{ project_id: p1 }]);
    expect(same.sql(pending)).toMatchObject([{ project_id: p1, held: 0 }]);

    const single = await baseFixture();
    await single.dm("first-single", "Help single");
    await single.dm("pick-single", p2, undefined, "first-single");
    expect(single.sql(conversations)).toMatchObject([{ project_id: p2 }]);
    expect(single.sql(pending)).toMatchObject([{ project_id: p2, held: 0 }]);

    const purpose = await baseFixture();
    await purpose.dm("first-purpose", "Help purpose");
    await purpose.dm(
      "pick-purpose",
      "Shared project context",
      undefined,
      "first-purpose",
    );
    expect(purpose.sql(conversations)).toMatchObject([{ project_id: null }]);
    expect(purpose.sql(pending)).toMatchObject([
      { project_id: null, held: 1, target_session_id: null },
      { project_id: null, held: 1, target_session_id: null },
    ]);
  },
  timeout,
);

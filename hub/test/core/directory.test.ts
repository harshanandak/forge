import { expect, test } from "bun:test";
import { createPeopleDirectory } from "../../src/core/index.ts";
import { configFixture } from "./config-fixture.ts";

const timeout = 30_000;
const people = [
  { personId: "per_a", displayName: "Alpha", slackUserId: "U00000001" },
  { personId: "per_b", displayName: "Beta", slackUserId: "U00000002" },
  { personId: "per_c", displayName: "Gamma" },
] as const;

test(
  "D1: person and Slack lookups return the same configured person",
  () => {
    const directory = createPeopleDirectory(people);
    expect(directory.all()).toHaveLength(3);
    for (const person of people)
      expect(directory.byPersonId(person.personId)).toEqual(person);
    for (const person of [people[0], people[1]]) {
      expect(directory.byPersonId(person.personId)).toBe(
        directory.bySlackUserId(person.slackUserId),
      );
    }
    const lookup = (id: string) => directory.bySlackUserId(id);
    for (const id of ["", "U00099999", undefined])
      expect(Reflect.apply(lookup, undefined, [id])).toBeUndefined();
  },
  timeout,
);

test(
  "D2: invalid and duplicate bindings name only the field",
  () => {
    const variants = [
      ["slackUserId", people[0].slackUserId],
      ["personId", people[0].personId],
      ["personId", "usr_asha"],
      ["slackUserId", "asha"],
    ] as const;
    for (const [field, rejected] of variants) {
      const second = { ...people[1], [field]: rejected };
      const build = () => createPeopleDirectory([people[0], second]);
      expect(build).toThrow(new RegExp(field));
      expect(build).not.toThrow(new RegExp(rejected));
    }
  },
  timeout,
);

test(
  "D3: Slack ids are exact",
  () => {
    const directory = createPeopleDirectory(configFixture().people);
    expect(directory.bySlackUserId("U00099999")).toBeUndefined();
    expect(directory.bySlackUserId("u00000001")).toBeUndefined();
  },
  timeout,
);

test(
  "T1A-DIR1 resolves exact provider and user pairs without crossing providers",
  () => {
    const alpha = { ...people[0], telegramUserId: "123456" };
    const directory = createPeopleDirectory([alpha, people[1]]);
    expect(directory.byChatUserId("telegram", "123456")).toEqual(alpha);
    expect(directory.byChatUserId("slack", alpha.slackUserId)).toBe(
      directory.bySlackUserId(alpha.slackUserId),
    );
    expect(directory.byChatUserId("slack", "123456")).toBeUndefined();
    expect(
      directory.byChatUserId("telegram", alpha.slackUserId),
    ).toBeUndefined();
    expect(directory.byChatUserId("telegram", "0123456")).toBeUndefined();
    expect(() =>
      createPeopleDirectory([
        alpha,
        { ...people[1], telegramUserId: "123456" },
      ]),
    ).toThrow("telegramUserId");
  },
  timeout,
);

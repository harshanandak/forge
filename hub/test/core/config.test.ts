/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubConfigError } from "../../src/contract/runtime.ts";
import { loadConfig } from "../../src/core/index.ts";
import { hubTestTemp } from "../temp.ts";
import { configFixture } from "./config-fixture.ts";

const timeout = 30_000;
const dirs: string[] = [];
type Edit = readonly [path: string, value: unknown];
type Refusal = readonly [pointer: string, edit: Edit];

function change(root: object, [path, value]: Edit): void {
  const keys = path.slice(1).split("/");
  const key = keys.pop();
  let parent: unknown = root;
  for (const part of keys) {
    if (typeof parent !== "object" || parent === null)
      throw new Error("Invalid fixture path");
    parent = Reflect.get(parent, part);
  }
  if (typeof parent !== "object" || parent === null || key === undefined)
    throw new Error("Invalid fixture edit");
  if (value === undefined) Reflect.deleteProperty(parent, key);
  else Reflect.set(parent, key, value);
}

function writeConfig(edits: readonly Edit[] = []) {
  const dir = hubTestTemp("forge-hub-config-");
  dirs.push(dir);
  const path = join(dir, "hub.json");
  const fixture = configFixture();
  for (const edit of edits) change(fixture, edit);
  writeFileSync(path, JSON.stringify(fixture));
  return { dir, path };
}

function load(edits: readonly Edit[] = []) {
  return loadConfig(writeConfig(edits).path);
}

function refuse(edits: readonly Edit[], pointer: string): HubConfigError {
  try {
    load(edits);
  } catch (error) {
    if (!(error instanceof HubConfigError)) throw error;
    expect(error.pointer).toBe(pointer);
    expect(error.message).toMatch(/^[^\r\n]*[A-Za-z][^\r\n]*$/);
    return error;
  }
  throw new Error("Expected configuration refusal");
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const references: readonly Refusal[] = [
  ["/people/0/personId", ["/people/0/personId", "prj_a"]],
  ["/projects/0/memberIds/1", ["/projects/0/memberIds/1", "per_unknown"]],
  ["/people/1/slackUserId", ["/people/1/slackUserId", "U00000001"]],
  ["/projects/0/frontPersonId", ["/projects/0/frontPersonId", "per_c"]],
  ["/doorbells/0/personId", ["/doorbells/0/personId", "per_unknown"]],
  ["/doorbells/0/projectId", ["/doorbells/0/projectId", "prj_unknown"]],
  ["/doorbells/0/personId", ["/doorbells/0/personId", "per_c"]],
  ["/doorbells/1", ["/doorbells/1", configFixture().doorbells[0]]],
  ["/doorbells/0/frontThreadId", ["/doorbells/0/frontThreadId", ""]],
  [
    "/projects/0/summaryMessage/channelId",
    ["/projects/0/summaryMessage/channelId", "C00000099"],
  ],
];

const required: readonly Refusal[] = [
  ...[
    "/listen",
    "/dataDir",
    "/allowedHosts",
    "/allowedOrigins",
    "/slack/mode",
    "/slack/buttons",
    "/mcp/enabled",
    "/hooks/enabled",
    "/cli/enabled",
    "/people",
    "/projects",
    "/doorbells",
  ].map((pointer): Refusal => [pointer, [pointer, undefined]]),
  ["/allowedHosts", ["/allowedHosts", []]],
];

test(
  "T3: validates identities and references and uses the project channel as the summary fallback",
  () => {
    for (const [pointer, edit] of references) refuse([edit], pointer);
    const result = load([["/projects/0/summaryChannelId", undefined]]);
    const project = result.projects[0];
    expect(project?.summaryChannelId ?? project?.slackChannelId).toBe(
      "C00000001",
    );
    expect(project?.summaryMessage?.channelId).toBe("C00000001");
  },
  timeout,
);

test(
  "T4: config errors keep the same fixed rule and omit input values",
  () => {
    const markers = ["left", "right"].map((variant) => ({
      name: ["Marker", "name", variant].join("-"),
      id: ["C0000", variant === "left" ? "0101" : "0102"].join(""),
      url: ["https://", variant, ".config-marker.test"].join(""),
      dir: ["marker", "directory", variant].join("-"),
    }));
    for (const [pointer, edit] of [...references, ...required]) {
      const messages = markers.map(({ name, id, url, dir }) => {
        const error = refuse(
          [
            ["/projects/1/name", name],
            ["/projects/1/slackChannelId", id],
            ["/publicBaseUrl", url],
            ["/dataDir", dir],
            edit,
          ],
          pointer,
        );
        const serialized = String(error) + JSON.stringify(error);
        for (const value of [name, id, url, dir])
          expect(serialized).not.toContain(value);
        if (typeof edit[1] === "string" && edit[1])
          expect(serialized).not.toContain(edit[1]);
        expect(JSON.stringify(error)).toBe(
          JSON.stringify({ pointer, otherPointer: error.otherPointer }),
        );
        return error.message;
      });
      expect(messages[0]).toBe(messages[1]);
    }
  },
  timeout,
);

test(
  "config refuses a secret-shaped display name without echoing it",
  () => {
    const pointer = "/people/0/displayName";
    const name = "xapp" + "-" + "fixture".repeat(3);
    let caught: unknown;
    try {
      load([[pointer, name]]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HubConfigError);
    expect(caught).toMatchObject({ pointer });
    expect((String(caught) + JSON.stringify(caught)).includes(name)).toBe(
      false,
    );
  },
  timeout,
);

test(
  "T5: requires config fields, explicit block switches and a nonempty host allowlist",
  () => {
    for (const [pointer, edit] of required) refuse([edit], pointer);
    expect(load().allowedOrigins).toEqual([]);
  },
  timeout,
);

test(
  "T6: resolves the data directory next to the config and rejects ambiguous base paths",
  () => {
    const cwd = process.cwd();
    for (const base of [undefined, "", "/forge-hub", "/a/b"]) {
      const { dir, path } = writeConfig([["/basePath", base]]);
      expect(dir).not.toBe(cwd);
      const config = loadConfig(path);
      expect(config.dataDir).toBe(join(dir, "data"));
      expect(config.basePath).toBe(base ?? "");
    }
    for (const base of [
      "/x/",
      "x",
      "/a/../b",
      "/a/./b",
      "/a b",
      "/a%2Fb",
      "//",
    ])
      refuse([["/basePath", base]], "/basePath");
    expect(process.cwd()).toBe(cwd);
  },
  timeout,
);

test(
  "T7: checks public origins and requires one when Slack uses webhooks",
  () => {
    for (const [given, origin] of [
      ["https://hub.example.test", "https://hub.example.test"],
      ["https://hub.example.test:8443", "https://hub.example.test:8443"],
      ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
      ["https://hub.example.test/", "https://hub.example.test"],
    ])
      expect(load([["/publicBaseUrl", given]]).publicBaseUrl).toBe(origin);
    for (const given of [
      "http://hub.example.test",
      "https://hub.example.test/path",
      "https://hub.example.test/one/..",
      "https://hub.example.test/?",
      "https://hub.example.test/#",
      "hub.example.test",
    ])
      refuse([["/publicBaseUrl", given]], "/publicBaseUrl");
    refuse([["/slack/mode", "webhook"]], "/publicBaseUrl");
    for (const mode of ["socket", "off"])
      expect(load([["/slack/mode", mode]]).publicBaseUrl).toBeUndefined();
  },
  timeout,
);

test(
  "T8: requires Slack bindings when Slack is on and preserves optional bindings when off",
  () => {
    refuse([["/people/0/slackUserId", undefined]], "/people/0/slackUserId");
    refuse(
      [["/projects/0/slackChannelId", undefined]],
      "/projects/0/slackChannelId",
    );
    const without = load([
      ["/slack/mode", "off"],
      ["/people/0/slackUserId", undefined],
      ["/projects/0/slackChannelId", undefined],
      ["/projects/0/summaryChannelId", undefined],
      ["/projects/0/summaryMessage", undefined],
    ]);
    expect(without.people[0]?.slackUserId).toBeUndefined();
    expect(without.projects[0]?.slackChannelId).toBeUndefined();
    const withBindings = load([["/slack/mode", "off"]]);
    expect(withBindings.people[0]?.slackUserId).toBe("U00000001");
    expect(withBindings.projects[0]?.slackChannelId).toBe("C00000001");
  },
  timeout,
);

test(
  "CF1: accepts short plain project purposes and refuses long or controlled text by pointer",
  () => {
    const pointer = "/projects/0/purpose";
    for (const value of ["", "a".repeat(280)])
      expect(load([[pointer, value]]).projects[0]?.purpose).toBe(value);
    for (const value of ["a".repeat(281), "marker\ttext", "marker\ntext"]) {
      const error = refuse([[pointer, value]], pointer);
      expect(String(error) + JSON.stringify(error)).not.toContain(value);
    }
  },
  timeout,
);

test(
  "CF2: checks Slack workspace IDs and allows omission with Slack off",
  () => {
    const pointer = "/slack/teamId";
    for (const mode of ["socket", "webhook"]) {
      const settings: readonly Edit[] = [
        ["/slack/mode", mode],
        ["/publicBaseUrl", "https://hub.example.test"],
      ];
      refuse([...settings, [pointer, undefined]], pointer);
      expect(load([...settings, [pointer, "T012ABC9XYZ"]]).slack.teamId).toBe(
        "T012ABC9XYZ",
      );
      for (const value of ["t012abc9xyz", "T123", "T" + "A".repeat(21)])
        refuse([...settings, [pointer, value]], pointer);
    }
    expect(
      load([
        ["/slack/mode", "off"],
        [pointer, undefined],
      ]).slack.teamId,
    ).toBeUndefined();
  },
  timeout,
);

test(
  "CF3: refuses Slack binding collisions with both pointers in file order",
  () => {
    for (const [edit, pointer, otherPointer] of [
      [
        ["/projects/1/slackChannelId", "C00000001"],
        "/projects/1/slackChannelId",
        "/projects/0/slackChannelId",
      ],
      [
        ["/projects/1/slackChannelId", "C00000001"],
        "/projects/1/slackChannelId",
        "/projects/0/summaryChannelId",
      ],
      [
        ["/projects/0/slackChannelId", "C00000003"],
        "/projects/1/summaryChannelId",
        "/projects/0/slackChannelId",
      ],
      [
        ["/people/1/slackUserId", "U00000001"],
        "/people/1/slackUserId",
        "/people/0/slackUserId",
      ],
    ] as const) {
      const edits: readonly Edit[] =
        otherPointer === "/projects/0/summaryChannelId"
          ? [["/projects/0/slackChannelId", "C00000901"], edit]
          : [edit];
      const error = refuse(edits, pointer);
      expect(error.otherPointer).toBe(otherPointer);
      expect(String(error) + JSON.stringify(error)).not.toContain(edit[1]);
    }
  },
  timeout,
);

test(
  "CF4: normalizes exact hosts and origins without adding wildcard matching",
  () => {
    const config = load([
      ["/allowedHosts", ["Hub.Example.Test:8443", "[::1]:3775"]],
      [
        "/allowedOrigins",
        ["https://Hub.Example.Test", "https://hub.example.test:8443/"],
      ],
    ]);
    expect(config.allowedHosts).toEqual([
      "hub.example.test:8443",
      "[::1]:3775",
    ]);
    expect(config.allowedOrigins).toEqual([
      "https://hub.example.test",
      "https://hub.example.test:8443",
    ]);
    for (const origin of [
      "null",
      "hub.example.test",
      "https://hub.example.test/path",
    ])
      refuse([["/allowedOrigins", [origin]]], "/allowedOrigins/0");
    refuse([["/allowedHosts", ["*.example.test"]]], "/allowedHosts/0");
  },
  timeout,
);

test(
  "T1A-CFG1 selects off, Slack and Telegram and infers legacy Slack",
  () => {
    expect(load().chat).toEqual({ adapter: "slack" });
    expect(load([["/chat", { adapter: "slack" }]]).slack).toEqual(
      configFixture().slack,
    );
    for (const adapter of ["off", "telegram"] as const) {
      expect(
        load([
          ["/slack", undefined],
          ["/chat", { adapter }],
        ]).chat,
      ).toEqual({ adapter });
      refuse([["/chat", { adapter }]], "/chat/adapter");
    }
    refuse(
      [
        ["/slack", undefined],
        ["/chat", { adapter: "slack" }],
      ],
      "/slack",
    );
  },
  timeout,
);

test(
  "T1A-CFG2 accepts decimal Telegram text and refuses invalid IDs at their paths",
  () => {
    const user = "/people/0/telegramUserId";
    const chat = "/projects/0/telegramChatId";
    const config = load([
      [user, "1234567890123"],
      [chat, "-1001234567890"],
    ]);
    expect(config.people[0]?.telegramUserId).toBe("1234567890123");
    expect(config.projects[0]?.telegramChatId).toBe("-1001234567890");
    for (const pointer of [user, chat])
      for (const value of [
        123,
        9007199254740992,
        "9007199254740992",
        "1e3",
        "1.2",
        " 123",
        "0123",
        ["123", "456"],
      ])
        refuse([[pointer, value]], pointer);
    refuse([[user, "-123"]], user);
  },
  timeout,
);

test(
  "T1A-CFG3 refuses duplicate Telegram users and multiple bindings per person",
  () => {
    const first = "/people/0/telegramUserId";
    const second = "/people/1/telegramUserId";
    expect(
      refuse(
        [
          [first, "123"],
          [second, "123"],
        ],
        second,
      ).otherPointer,
    ).toBe(first);
    const person = { ...configFixture().people[0], telegramUserId: "456" };
    refuse(
      [
        [first, "123"],
        ["/people/3", person],
      ],
      "/people/3/personId",
    );
  },
  timeout,
);

test(
  "T1A-CFG4 accepts the Telegram secret name through ReadSecret and refuses token config without echoing it",
  () => {
    const token = "synthetic-bot-token";
    const read: import("../../src/contract/runtime.ts").ReadSecret = (name) =>
      name === "TELEGRAM_BOT_TOKEN" ? token : undefined;
    expect(read("TELEGRAM_BOT_TOKEN")).toBe(token);
    const error = refuse(
      [["/chat", { adapter: "telegram", botToken: token }]],
      "/chat/botToken",
    );
    expect(error.message).not.toContain(token);
  },
  timeout,
);

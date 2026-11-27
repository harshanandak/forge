import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Mcp from "../../src/contract/mcp.ts";
import * as Core from "../../src/core/index.ts";
import { createDoorbell, createRemoteHandler } from "../../src/remote/index.ts";
import { HEALTH_PATH } from "../../src/service/routes.ts";
import { serveHub } from "../../src/service/serve.ts";
import { a, b, fixture, p1 } from "../core/fixture.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import {
  digest,
  json,
  key,
  rpc,
  safeOutput,
  token,
  type WireEnvelope,
} from "./fixtures.ts";
import {
  child,
  deny,
  guard,
  hubCommand,
  hubRoot,
  r1,
  r3,
  session,
  silence,
  stop,
} from "./hook-fixtures.ts";

const timeout = 30_000;
const host = "127.0.0.1";
const projectId = p1;
const project = { projectId };
const bin = (name: string) => join(hubRoot, "bin", name + ".mjs");
const countPermits = "select count(*) as count from permits";

const requestAt =
  (origin: string, bearer = token) =>
  (req: Request) => {
    const { headers, body } = req;
    headers.set("authorization", "Bearer " + bearer);
    return fetch(origin + "/mcp", { method: "POST", headers, body });
  };

function result<T>(body: WireEnvelope): T {
  expect(body).toMatchObject({ ok: true, status: "OK" });
  return body.result as T;
}

async function ready(origin: string, exited: () => boolean) {
  for (let i = 0; i < 75 && !exited(); i++) {
    const healthy = await fetch(origin + HEALTH_PATH, {
      signal: AbortSignal.timeout(100),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function workspace(slack = true) {
  const reservation = Bun.serve({
    hostname: host,
    port: 0,
    fetch: () => new Response(),
  });
  const { port, origin } = reservation.url;
  await reservation.stop(true);
  const f = await fixture({
    listen: { host, port: Number(port) },
    allowedHosts: [host + ":" + port],
    ...(slack
      ? { hooks: { enabled: true } }
      : {
          chat: { adapter: "off" },
          slack: { mode: "off", buttons: false },
          people: [{ ...a }, { ...b }],
          projects: [
            {
              ...project,
              name: "Fixture",
              frontPersonId: a.personId,
              memberIds: [a.personId, b.personId],
            },
          ],
          doorbells: [],
        }),
  });
  expect(Core.protectDirectoryChain(f.config.dataDir)).toBe(true);
  const path = (file: string) => join(f.config.dataDir, file);
  const settings = path("settings.json");
  await writeFile(settings, JSON.stringify(f.config));
  const cli = (args: string[], input?: string) =>
    child(f.root, [...hubCommand, ...args, "--config", settings], input);
  const create = (kind: "host" | "token", file: string) => {
    const flags = ["--person", a.personId, "--label", "fixture", "--output"];
    return cli([kind, "create", ...flags, file]);
  };
  return { ...f, path, settings, origin, cli, create };
}

function journey(
  name: string,
  run: (f: Awaited<ReturnType<typeof realHub>>) => Promise<void>,
) {
  test(
    name,
    async () => {
      const f = await realHub();
      try {
        await run(f);
      } finally {
        await f.close();
      }
    },
    timeout,
  );
}

async function realHub() {
  const f = await workspace();
  const { config, origin } = f;
  const chat = new FakeChatPort(config.slack.teamId);
  const doorbell = createDoorbell({ ...f, secret: () => undefined });
  const people = Core.createPeopleDirectory(config.people);
  const core = Core.createHubCore({
    ...f,
    chat,
    people,
    doorbell,
    tracker: Core.nullTracker,
    now: Date.now,
  });
  const remote = createRemoteHandler({ ...f, core });
  const abort = new AbortController();
  let exited = false;
  const serving = serveHub({
    ...f,
    core,
    remote,
    chat,
    stop: abort.signal,
  }).finally(() => {
    exited = true;
  });
  void serving.catch(() => undefined);
  const close = async () => {
    abort.abort();
    try {
      await serving;
    } finally {
      try {
        await remote.close();
      } finally {
        await core.close();
      }
    }
  };
  try {
    expect(await ready(origin, () => exited), "Hub health").toBe(true);
    core.createToken(a.personId, "fixture", digest(token));
    core.createHostKey(a.personId, "fixture", digest(key));
    await writeFile(f.path("hook-host"), key, { mode: 0o600 });
  } catch (error) {
    await close();
    throw error;
  }
  const handle = requestAt(origin);
  const hook = (name: string, input: unknown, file = f.path("hook-host")) =>
    child(f.root, [bin(name)], JSON.stringify(input), {
      FORGE_HUB_URL: origin,
      FORGE_HUB_HOST_KEY_FILE: file,
    });
  const tool = async (name: string, args: object) =>
    (await rpc(handle, name, args)).tool.structuredContent;
  const start = async (hostSessionId = "s1") => {
    const call = await hook("session-start", {
      ...session,
      session_id: hostSessionId,
    });
    expect(call).toMatchObject({ status: 0, stderr: "" });
    const id = /Forge hub session (ses_\w+) \(normal\)/.exec(call.stdout)?.[1];
    if (!id) throw new Error("Expected a registered normal session");
    return id;
  };
  const inbox = async (sessionId: string) =>
    result<Mcp.InboxOutput>(await tool("inbox", { sessionId }));
  let message = 0;
  const emit = (from = "U00000001") =>
    chat.emitMessage({
      eventKey: "fixture-" + ++message,
      slackUserId: from,
      userName: from === "U00000001" ? a.displayName : b.displayName,
      isBot: false,
      text: "Please check this.",
      channelId: "C00000001",
      chatThreadId: "3.000001",
      chatMessageId: "3." + String(message).padStart(6, "0"),
      threadRootMessageId: "3.000001",
      isDirect: false,
      mentionsBot: true,
    });
  return { ...f, chat, hook, tool, start, inbox, emit, close };
}

function conversation(items: Mcp.InboxOutput["items"]) {
  const id = items.at(-1)?.conversationId;
  if (!id) throw new Error("Expected an inbox conversation");
  return id;
}

journey(
  "E1 a foreign Slack item gates writes but allows a reply",
  async (f) => {
    const sessionId = await f.start();
    await f.emit("U00000002");
    const { items, mode } = await f.inbox(sessionId);
    expect(items.at(-1)?.trust).toBe("not_your_owner");
    expect(mode).toBe("reply_only");
    expect(await f.hook("pre-tool", guard(f.root))).toEqual(deny(r1));
    const before = f.chat.writes.length;
    result(
      await f.tool("reply", {
        sessionId,
        conversationId: conversation(items),
        text: "Done.",
      }),
    );
    expect(
      await f.tool("report", {
        sessionId,
        ...project,
        requestAskId: "ask_missing",
        state: "working",
        text: "Working",
      }),
    ).toMatchObject({ error: { code: "REPLY_ONLY" } });
    expect(f.chat.writes.slice(before).map((call) => call.name)).toEqual([
      "postText",
    ]);
  },
);

journey(
  "E2 a foreign session id cannot change either session's delivery",
  async (f) => {
    const other = await f.start("s2");
    const sessionId = await f.start();
    await f.emit("U00000002");
    expect((await f.inbox(sessionId)).mode).toBe("reply_only");
    const before = await f.inbox(other);
    expect(
      await f.hook(
        "pre-tool",
        guard(f.root, "mcp__forge-hub__inbox", { sessionId: other }),
      ),
    ).toEqual(
      deny("Forge hub: pass sessionId " + sessionId + " for this session.\n"),
    );
    expect(await f.inbox(other)).toEqual(before);
    expect(await f.hook("pre-tool", guard(f.root))).toEqual(deny(r1));
  },
);

journey(
  "E3 a choice cannot authorize deployment and an open ask grants no permit",
  async (f) => {
    const sessionId = await f.start();
    const ask = {
      ...project,
      sessionId,
      kind: "choice",
      requestedAction: "choice",
      to: [a.personId],
    };
    const { askId } = result<{ askId: string }>(
      await f.tool("ask", {
        ...ask,
        question: "Which check?",
        choices: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      }),
    );
    const writes = f.chat.writes.length;
    expect(
      await f.tool("ask", { ...ask, question: "Ready to deploy?" }),
    ).toMatchObject({ error: { code: "AUTHORITY_ASK_REFUSED" } });
    expect(
      await f.tool("report", {
        ...project,
        sessionId,
        requestAskId: askId,
        state: "working",
        text: "Working",
      }),
    ).toMatchObject({ error: { code: "PERMIT_REQUIRED" } });
    expect(f.chat.writes).toHaveLength(writes);
    expect(f.db.prepare(countPermits).get()).toEqual({ count: 0 });
  },
);

journey(
  "E4 a Slack item wakes a pending wait and is marked delivered",
  async (f) => {
    const sessionId = await f.start();
    const waiting = f.tool("wait", { sessionId, timeoutMs: 20_000 });
    await Bun.sleep(500);
    const sent = performance.now();
    await f.emit();
    const answer = result<Mcp.WaitOutput>(await waiting);
    expect(answer.status).toBe("ready");
    expect(answer.items).toHaveLength(1);
    expect(performance.now() - sent).toBeLessThan(5000);
    expect(
      f.db
        .prepare(
          "select delivered_to_session_id from inbox_items where item_id = ?",
        )
        .get(answer.items[0]?.itemId ?? ""),
    ).toEqual({ delivered_to_session_id: sessionId });
  },
);

test(
  "E5 the Slack-off Node hub round-trips a CLI message",
  async () => {
    const f = await workspace(false);
    const node = Bun.which("node");
    if (!node) throw new Error("Selected Node is unavailable");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        [
          "PATH",
          "SYSTEMROOT",
          "SYSTEMDRIVE",
          "WINDIR",
          "COMSPEC",
          "USERPROFILE",
          "HOME",
        ].includes(name.toUpperCase()),
      ),
    );
    const proc = Bun.spawn(
      [node, ...hubCommand, "serve", "--config", f.settings],
      { cwd: f.root, env, stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    const streams = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    try {
      const healthy = await ready(f.origin, () => proc.exitCode !== null);
      if (!healthy && proc.exitCode === null) proc.kill();
      const stderr = healthy ? "" : (await streams)[1].trim();
      safeOutput(stderr);
      expect(healthy, `serve exit ${proc.exitCode}: ${stderr}`).toBe(true);
      const path = f.path("person-output");
      const created = await f.create("token", path);
      expect(created.status, created.stderr.trim()).toBe(0);
      const bearer = (await readFile(path, "utf8"))
        .trim()
        .slice("FORGE_HUB_TOKEN=".length);
      const handle = requestAt(f.origin, bearer);
      const tool = async (name: string, args: object) =>
        (await rpc(handle, name, args)).tool.structuredContent;
      const hello = result<Mcp.HelloOutput>(
        await tool("hello", { host: "other", ...project }),
      );
      const flags = ["--person", b.personId, "--project", projectId];
      const inbox = await f.cli(["inbox", ...flags]);
      expect(inbox.status, inbox.stderr.trim()).toBe(0);
      const { sessionId } = result<{ sessionId: string }>(json(inbox.stdout));
      const sent = await f.cli(
        [
          "send",
          ...flags,
          "--session",
          sessionId,
          "--to",
          a.personId,
          "--target-session",
          hello.sessionId,
          "--stdin",
        ],
        "CLI fixture",
      );
      expect(sent.status, sent.stderr.trim()).toBe(0);
      const delivered = result<Mcp.InboxOutput>(
        await tool("inbox", { sessionId: hello.sessionId }),
      );
      expect(delivered).toMatchObject({
        mode: "reply_only",
        items: [{ kind: "cli_message", trust: "cli", text: "CLI fixture" }],
      });
      expect(delivered.items[0]?.notice).toBe(Mcp.CLI_MESSAGE_NOTICE);
      expect(f.db.prepare(countPermits).get()).toEqual({ count: 0 });
    } finally {
      if (proc.exitCode === null) proc.kill();
      await proc.exited;
      safeOutput((await streams).join(""));
    }
  },
  timeout,
);

journey(
  "E6 a real host key registers and revocation denies the guard",
  async (f) => {
    const file = f.path("host-output");
    const created = await f.create("host", file);
    expect(created.status, created.stderr.trim()).toBe(0);
    const registered = await f.hook("session-start", session, file);
    expect(registered.status, registered.stderr.trim()).toBe(0);
    expect(registered.stdout).toMatch(/^Forge hub session ses_/);
    const revoked = await f.cli([
      "host",
      "revoke",
      created.stdout.split(" ")[0] ?? "",
    ]);
    expect(revoked.status, revoked.stderr.trim()).toBe(0);
    expect(await f.hook("session-start", session, file)).toEqual({
      ...silence,
      stdout: "Forge hub unavailable: UNAUTHENTICATED\n",
    });
    expect(await f.hook("pre-tool", guard(f.root), file)).toEqual(
      deny(r3("UNAUTHENTICATED")),
    );
  },
);

journey(
  "E7 Stop mirrors only an owed answer and holds secret-shaped text",
  async (f) => {
    const sessionId = await f.start();
    const owe = async () => {
      await f.emit();
      return conversation((await f.inbox(sessionId)).items);
    };
    const finish = (last_assistant_message: string) =>
      f.hook("stop", { ...stop, last_assistant_message });
    const posts = () => f.chat.writes.filter(({ name }) => name === "postText");
    await owe();
    expect(await finish("Done.")).toEqual(silence);
    expect(posts().map(({ args }) => args[1])).toEqual([
      expect.stringContaining("Done."),
    ]);
    const conversationId = await owe();
    result(
      await f.tool("reply", {
        sessionId,
        conversationId,
        text: "Already answered.",
      }),
    );
    expect(await finish("Do not duplicate.")).toEqual(silence);
    expect(posts()).toHaveLength(2);
    await owe();
    expect(await finish(token)).toEqual(silence);
    expect(posts()).toHaveLength(3);
    expect(posts().at(-1)?.args[1]).toEqual(
      expect.stringContaining("looked like it contained a secret"),
    );
    safeOutput(JSON.stringify(posts()));
    expect((await f.inbox(sessionId)).mode).toBe("normal");
    expect(f.db.prepare(countPermits).get()).toEqual({ count: 0 });
  },
);

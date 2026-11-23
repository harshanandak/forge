import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_TOOL_NAMES } from "../../src/contract/mcp.ts";
import { key } from "./fixtures.ts";
import {
  child,
  failure,
  guard,
  hookFixture,
  hubRoot,
  hung,
  mode,
  r1,
  r2,
  r3,
  silence,
} from "./hook-fixtures.ts";

const timeout = 30_000;
const check = (stderr: string) => ({ status: 2, stdout: "", stderr });
const name = (tool: string) => "mcp__forge-hub__" + tool;

test(
  "P1-P3 hooked tools require their own registered id in both modes",
  async () => {
    const f = await hookFixture();
    try {
      expect(await f.run("pre-tool", guard(f.root, name("hello")))).toEqual(
        check(r2),
      );
      for (const current of ["normal", "reply_only"]) {
        f.respond = () => mode(current);
        for (const tool of ["inbox", "wait", "send"]) {
          expect(
            await f.run(
              "pre-tool",
              guard(f.root, name(tool), { sessionId: "ses_b" }),
            ),
          ).toEqual(check(r2));
        }
        for (const tool of MCP_TOOL_NAMES) {
          expect(
            await f.run(
              "pre-tool",
              guard(f.root, name(tool), { sessionId: "ses_a" }),
            ),
          ).toEqual(silence);
        }
      }
      expect(f.seen).toHaveLength(1 + 2 * (3 + MCP_TOOL_NAMES.length));
      expect(f.seen.every(({ path }) => path === "/hook/mode")).toBe(true);
    } finally {
      await f.close();
    }
  },
  timeout,
);

const failures = [
  ["timeout", "HUB_TIMEOUT", hung],
  ["unauthenticated", "UNAUTHENTICATED", () => failure(401, "UNAUTHENTICATED")],
  ["disabled", "BLOCK_DISABLED", () => failure(503, "BLOCK_DISABLED")],
  ["malformed", "INVALID_RESPONSE", () => Response.json([])],
  ["unregistered", "UNREGISTERED", () => mode("unregistered")],
] as const;
for (const [label, code, respond] of failures) {
  test(
    `P4 ${label} denies both Forge calls and writes`,
    async () => {
      const f = await hookFixture();
      f.respond = (_path, signal) => respond(signal);
      try {
        for (const tool of [name("inbox"), "Write"]) {
          const started = performance.now();
          expect(
            await f.run(
              "pre-tool",
              guard(f.root, tool, { sessionId: "ses_a" }),
            ),
          ).toEqual(check(r3(code)));
          expect(performance.now() - started).toBeLessThan(3500);
        }
        expect(f.seen).toHaveLength(2);
      } finally {
        await f.close();
      }
    },
    timeout,
  );
}

test(
  "P4 key missing/malformed and closed port deny without using a stale result",
  async () => {
    const f = await hookFixture();
    try {
      for (const tool of [name("inbox"), "Write"]) {
        expect(
          await f.run("pre-tool", guard(f.root, tool), {
            FORGE_HUB_HOST_KEY_FILE: join(f.root, "missing"),
          }),
        ).toEqual(check(r3("HOST_KEY_UNAVAILABLE")));
      }
      await writeFile(f.keyPath, "bad");
      for (const tool of [name("inbox"), "Write"])
        expect(await f.run("pre-tool", guard(f.root, tool))).toEqual(
          check(r3("HOST_KEY_UNAVAILABLE")),
        );
      expect(f.seen).toEqual([]);
      await writeFile(f.keyPath, key);
      await f.stopServer();
      for (const tool of [name("inbox"), "Write"])
        expect(await f.run("pre-tool", guard(f.root, tool))).toEqual(
          check(r3("HUB_UNREACHABLE")),
        );
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "P5 foreign read then outage denies a write while a local Read still works",
  async () => {
    const f = await hookFixture();
    await writeFile(join(f.root, "file"), "fixture");
    try {
      expect(await f.run("pre-tool", guard(f.root))).toEqual(silence);
      f.respond = () => mode("reply_only");
      expect(
        await f.run(
          "pre-tool",
          guard(f.root, name("inbox"), { sessionId: "ses_a" }),
        ),
      ).toEqual(silence);
      await f.stopServer();
      expect(await f.run("pre-tool", guard(f.root))).toEqual(
        check(r3("HUB_UNREACHABLE")),
      );
      expect(
        await f.run("pre-tool", guard(f.root, "Read", { file_path: "file" })),
      ).toEqual(silence);
      expect(f.seen).toHaveLength(2);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "P6-P8 lookalikes, writes, tasks, web and every Bash command need clean fresh mode",
  async () => {
    const f = await hookFixture();
    const lookalikes = [
      "mcp__forge-hub-evil__inbox",
      "mcp__forge-hub__x__reply",
      "mcp__other__hello",
      name("merge"),
    ];
    const other = [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Task",
      "WebFetch",
      "WebSearch",
    ];
    const commands = [
      "git status",
      "ls -la",
      "git diff --output=changed.txt",
      "rg --pre ./x foo",
      "printf a\nprintf b",
      "rm -rf build",
    ];
    try {
      f.respond = () => mode("reply_only");
      for (const tool of [...lookalikes, ...other])
        expect(await f.run("pre-tool", guard(f.root, tool))).toEqual(check(r1));
      for (const command of commands)
        expect(
          await f.run("pre-tool", guard(f.root, "Bash", { command })),
        ).toEqual(check(r1));
      f.respond = () => mode();
      for (const tool of [...lookalikes, "Write", "Task", "Bash"])
        expect(
          await f.run(
            "pre-tool",
            guard(f.root, tool, { command: "git status" }),
          ),
        ).toEqual(silence);
      expect(f.seen).toHaveLength(
        2 * lookalikes.length + other.length + commands.length + 3,
      );
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "P9 local Read Glob and Grep work without a mode request",
  async () => {
    const f = await hookFixture();
    try {
      await mkdir(join(f.root, "src"));
      await writeFile(join(f.root, "src", "file.ts"), "fixture");
      f.respond = () => mode("reply_only");
      for (const offline of [false, true]) {
        if (offline) await f.stopServer();
        for (const input of [
          guard(f.root, "Read", { file_path: join(f.root, "src", "file.ts") }),
          guard(f.root, "Glob", { pattern: "**/*.ts" }),
          guard(f.root, "Grep", { path: "src", pattern: "fixture" }),
        ])
          expect(await f.run("pre-tool", input)).toEqual(silence);
      }
      expect(f.seen).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "P10 outside, junction, traversal and missing paths require clean mode",
  async () => {
    const f = await hookFixture();
    const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
    try {
      const file = join(outside, "file");
      await writeFile(file, "fixture");
      await symlink(outside, join(f.root, "link"), "junction");
      const cases = [
        guard(f.root, "Read", { file_path: file }),
        guard(f.root, "Glob", { pattern: "../x/*" }),
        guard(f.root, "Glob", { pattern: file }),
        guard(f.root, "Grep", { path: "..", pattern: "fixture" }),
        guard(f.root, "Read", { file_path: join(f.root, "link", "file") }),
        guard(f.root, "Read", { file_path: "missing" }),
      ];
      for (const current of ["reply_only", "normal"]) {
        f.respond = () => mode(current);
        for (const input of cases)
          expect(await f.run("pre-tool", input)).toEqual(
            current === "normal" ? silence : check(r1),
          );
      }
      expect(f.seen).toHaveLength(2 * cases.length);
    } finally {
      await f.close();
      await rm(outside, { recursive: true, force: true });
    }
  },
  timeout,
);

test(
  "P11 and Y1 malformed stdin denies before network",
  async () => {
    const f = await hookFixture();
    try {
      for (const input of [
        "not json",
        "null",
        "[]",
        '"x"',
        {},
        { ...guard(f.root), tool_name: undefined },
        { ...guard(f.root), session_id: 1 },
        guard(f.root, "Read", "bad"),
        { ...guard(f.root), cwd: 1 },
      ]) {
        expect(await f.run("pre-tool", input)).toEqual(
          check(r3("INVALID_INPUT")),
        );
      }
      expect(f.seen).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "P12 remote HTTP and missing hub URL fail closed",
  async () => {
    const f = await hookFixture();
    try {
      for (const url of ["http://example.invalid", ""])
        expect(
          await f.run("pre-tool", guard(f.root), { FORGE_HUB_URL: url }),
        ).toEqual(check(r3("HUB_URL_INVALID")));
      expect(f.seen).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "P13 redirects cannot forward the key",
  async () => {
    const f = await hookFixture();
    const other = await hookFixture();
    try {
      f.respond = () =>
        new Response(null, { status: 307, headers: { location: other.url } });
      const result = await f.run("pre-tool", guard(f.root));
      expect(result.status).toBe(2);
      expect(result.stderr).toStartWith(
        "Forge hub could not confirm this session",
      );
      expect(f.seen).toHaveLength(1);
      expect(other.seen).toEqual([]);
    } finally {
      await f.close();
      await other.close();
    }
  },
  timeout,
);

test(
  "P14-P15 uses direct modes, current key file, base path and configured exact tool name",
  async () => {
    const f = await hookFixture();
    try {
      const options = {
        FORGE_HUB_URL: f.url + "/forge-hub",
        FORGE_HUB_MCP_SERVER: "other-hub",
      };
      f.respond = () => mode("reply_only");
      expect(
        await f.run(
          "pre-tool",
          guard(f.root, "mcp__other-hub__inbox", { sessionId: "ses_b" }),
          options,
        ),
      ).toEqual(check(r2));
      const fresh = key.slice(0, -1) + "z";
      await writeFile(f.keyPath, fresh);
      expect(
        await f.run(
          "pre-tool",
          guard(f.root, "mcp__other-hub__inbox", { sessionId: "ses_a" }),
          options,
        ),
      ).toEqual(silence);
      expect(
        await f.run(
          "pre-tool",
          guard(f.root, name("inbox"), { sessionId: "ses_a" }),
          options,
        ),
      ).toEqual(check(r1));
      expect(f.seen).toEqual(
        [key, fresh, fresh].map((bearer) => ({
          path: "/forge-hub/hook/mode",
          method: "POST",
          bearer: "Bearer " + bearer,
          type: "application/json",
          body: { host: "claude", hostSessionId: "s1" },
        })),
      );
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "P17, X1 and Y1 launched guard runs once and invalid modes fail closed",
  async () => {
    const f = await hookFixture();
    try {
      f.respond = () => mode("reply_only");
      expect(await f.run("pre-tool", guard(f.root))).toEqual(check(r1));
      expect(f.seen).toHaveLength(1);
      expect(f.seen[0]?.bearer).toBe("Bearer " + key);
      for (const result of [
        null,
        { mode: 1 },
        { mode: "rogue" },
        { mode: "normal", sessionId: 123 },
      ]) {
        f.respond = () => Response.json({ ok: true, status: "OK", result });
        expect(await f.run("pre-tool", guard(f.root))).toEqual(
          check(r3("INVALID_RESPONSE")),
        );
      }
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "Y3 emitted shared library has no launch effect",
  async () => {
    const f = await hookFixture();
    try {
      const result = await child(f.root, [
        "--input-type=module",
        "-e",
        "await import(process.argv[1])",
        new URL("../../dist/hooks/shared.js", import.meta.url).href,
      ]);
      expect(result).toEqual(silence);
      expect(f.seen).toEqual([]);
      expect(hubRoot.length).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  },
  timeout,
);

import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCredentialStore } from "../../src/core/credentials.ts";
import { createGuards } from "../../src/core/guards.ts";
import { loadConfig } from "../../src/core/index.ts";
import { a, caller, configPeople, sessionFixture, value } from "./fixture.ts";

const timeout = 30_000;

test(
  "L1: session, credential, config and text refusals disclose no input",
  async () => {
    const f = await sessionFixture();
    const session = value(f.sessions.hello(caller, { host: "t3" }));
    const stored = f.sessions.session(session.sessionId);
    if (!stored) throw new Error("Missing session");
    const secret = ["gh", "p_", "a".repeat(36)].join("");
    const digest = "a".repeat(64);
    const question = "sample private question";
    const label = "sample private choice";
    const badOrigin = "https://private.example.invalid/path";
    const credential = createCredentialStore({
      ...f,
      people: configPeople(f.config.people),
    });
    expect(credential.createToken(a.personId, label, digest)).toBeDefined();
    expect(credential.findToken(digest)).toBeDefined();
    const guards = createGuards();
    const refused = [
      f.sessions.requireNormalMode(stored),
      guards.outboundText(question + " " + secret, "/question"),
      guards.outboundText(label + " " + secret, "/choices/0/label"),
    ];
    expect(refused.map((entry) => entry?.code)).toEqual([
      "REPLY_ONLY",
      "SECRET_IN_TEXT",
      "SECRET_IN_TEXT",
    ]);
    const configPath = join(f.root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ ...f.config, allowedOrigins: [badOrigin] }),
    );
    let detail = "";
    try {
      loadConfig(configPath);
    } catch (error) {
      if (error instanceof Error) detail = error.message;
    }
    expect(detail).not.toBe("");
    const output = JSON.stringify([f.logged, refused, detail]);
    for (const privateValue of [
      digest,
      label,
      question,
      secret,
      badOrigin,
      f.config.dataDir,
    ])
      expect(output).not.toContain(privateValue);
  },
  timeout,
);

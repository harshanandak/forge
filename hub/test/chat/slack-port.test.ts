import { expect, test } from "bun:test";
import { createSlackAdapter } from "@chat-adapter/slack";
import { chatConfig, slackAdapterConfig } from "../../src/chat/config.ts";
import { CHAT_DEDUPE_TTL_MS } from "../../src/contract/chat-state.ts";
import { fakeSlackServer } from "../fakes/fake-slack-server.ts";
import { fixtureEnv, observeSlackEnv } from "./environment.ts";
import {
  slackCases,
  fixtureSecret,
  sampleAppToken,
  sampleBotToken,
  signingSecret,
  slackFixture,
  startedSlack,
  threadTarget,
} from "./fixtures.ts";
import { checkChatPort } from "./port-contract.ts";

const timeout = 30_000;
const { started: startedCase, idle: idleCase } = slackCases(test, timeout);

for (const mode of ["webhook", "socket"] as const) {
  idleCase(
    `C1 C10 ${mode} sets inactive credentials explicitly and uses the real factory without Slack env reads`,
    (h) => {
      using _env = fixtureEnv({
        SLACK_BOT_TOKEN: "different fixture bot token",
        SLACK_SIGNING_SECRET: "different fixture signing secret",
        SLACK_APP_TOKEN: "different fixture app token",
        SLACK_ENCRYPTION_KEY: "invalid encryption fixture",
        SLACK_SOCKET_FORWARDING_SECRET: "different forwarding fixture",
      });
      using observation = observeSlackEnv();
      const deps = h.deps();
      const config = slackAdapterConfig(deps);
      expect(config).toMatchObject({
        mode,
        botToken: sampleBotToken,
        apiUrl: deps.slackApiUrl,
        signingSecret: mode === "webhook" ? signingSecret : "",
        appToken: mode === "socket" ? sampleAppToken : "",
        webClientOptions: {
          retryConfig: { retries: 0 },
          rejectRateLimitedCalls: true,
          timeout: 10_000,
        },
      });
      expect(typeof config.webClientOptions?.logger?.error).toBe("function");
      expect(typeof config.webClientOptions?.requestInterceptor).toBe(
        "function",
      );
      expect(config).not.toHaveProperty("fetch");
      expect(config).not.toHaveProperty("webhookVerifier");
      const adapter = createSlackAdapter(config);
      expect(chatConfig(adapter, deps)).toMatchObject({
        adapters: { slack: adapter },
        userName: "Forge",
        concurrency: "concurrent",
        dedupeTtlMs: CHAT_DEDUPE_TTL_MS,
      });
      expect(observation.reads).toEqual([]);
    },
    { mode },
  );
}

for (const [label, mode, missing] of [
  ["C2", "webhook", "SLACK_SIGNING_SECRET"],
  ["C3", "webhook", "SLACK_BOT_TOKEN"],
  ["C3", "socket", "SLACK_BOT_TOKEN"],
  ["C4", "socket", "SLACK_APP_TOKEN"],
] as const) {
  test(
    `${label} ${mode} does not take required ${missing} from the environment`,
    async () => {
      const other = "synthetic env fixture";
      await using h = await slackFixture({
        mode,
        secret: (name) => (name === missing ? undefined : fixtureSecret(name)),
      });
      using _env = fixtureEnv({ [missing]: other });
      try {
        h.port();
      } catch (error) {
        if (!(error instanceof Error) || error.message === "not_built")
          throw error;
        expect(error.message).toContain(missing);
        expect(error.message).not.toContain(other);
        expect(h.fake.calls).toEqual([]);
        return;
      }
      throw new Error("port accepted a missing credential");
    },
    timeout,
  );
}

test(
  "C5 Slack API traffic stays on the configured loopback URL",
  async () => {
    await using decoy = await fakeSlackServer();
    using _env = fixtureEnv({ SLACK_API_URL: decoy.url });
    await using h = await startedSlack();
    await h.chat.postText(threadTarget, "Configured URL");
    expect(h.fake.only("chat.postMessage")).toHaveLength(1);
    expect(decoy.calls).toEqual([]);
  },
  timeout,
);

idleCase(
  "C6 the per-process forwarding secret is private, stable and independent of the environment",
  (h) => {
    const forwarding = "synthetic env forwarding";
    using _env = fixtureEnv({
      SLACK_APP_TOKEN: sampleAppToken,
      SLACK_SOCKET_FORWARDING_SECRET: forwarding,
    });
    const first = slackAdapterConfig(h.deps()).socketForwardingSecret;
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(slackAdapterConfig(h.deps()).socketForwardingSecret).toBe(first);
    expect(first).not.toBe(sampleAppToken);
    expect(first).not.toBe(forwarding);
    expect(h.logs).toEqual([]);
  },
);

for (const [mode, buttons] of [
  ["webhook", true],
  ["webhook", false],
  ["socket", true],
] as const) {
  idleCase(
    `C7 capabilities for ${mode} with buttons ${buttons}`,
    (h) => {
      expect(h.port().capabilities).toEqual({
        mode,
        buttons,
        editMessage: true,
        ephemeral: true,
        reactions: true,
        threads: true,
        longAnswers: false,
      });
    },
    { mode, buttons },
  );
}

test(
  "C8 Socket Mode never asks for a signing secret",
  async () => {
    const reads: string[] = [];
    await using h = await slackFixture({
      mode: "socket",
      secret(name) {
        reads.push(name);
        return name === "SLACK_SIGNING_SECRET"
          ? undefined
          : fixtureSecret(name);
      },
    });
    expect(slackAdapterConfig(h.deps()).signingSecret).toBe("");
    expect(reads.toSorted()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
  },
  timeout,
);

startedCase(
  "K2 the shared chat contract runs through the Slack adapter",
  async (h) => {
    await checkChatPort(h.chat);
  },
);

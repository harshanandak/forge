import type { HubConfig } from "../../src/contract/runtime.ts";

export function configFixture(): HubConfig {
  return {
    listen: { host: "127.0.0.1", port: 3775 },
    basePath: "",
    allowedHosts: ["127.0.0.1:3775"],
    allowedOrigins: [],
    dataDir: "data",
    slack: { mode: "socket", buttons: true, teamId: "T012ABC9XYZ" },
    mcp: { enabled: true },
    hooks: { enabled: false },
    cli: { enabled: true },
    people: [
      {
        personId: "per_a",
        displayName: "Fixture Alpha",
        slackUserId: "U00000001",
      },
      {
        personId: "per_b",
        displayName: "Fixture Beta",
        slackUserId: "U00000002",
      },
      {
        personId: "per_c",
        displayName: "Fixture Gamma",
        slackUserId: "U00000003",
      },
    ],
    projects: [
      {
        projectId: "prj_one",
        name: "Fixture One",
        purpose: "Shared project context",
        slackChannelId: "C00000001",
        summaryChannelId: "C00000001",
        summaryMessage: {
          channelId: "C00000001",
          chatThreadId: "1.000001",
          chatMessageId: "1.000001",
        },
        frontPersonId: "per_a",
        memberIds: ["per_a", "per_b"],
      },
      {
        projectId: "prj_two",
        name: "Fixture Two",
        slackChannelId: "C00000002",
        summaryChannelId: "C00000003",
        summaryMessage: {
          channelId: "C00000003",
          chatThreadId: "2.000001",
          chatMessageId: "2.000001",
        },
        frontPersonId: "per_a",
        memberIds: ["per_a", "per_c"],
      },
    ],
    doorbells: [
      {
        personId: "per_a",
        projectId: "prj_one",
        frontThreadId: "thread-fixture",
        urlEnv: "FORGE_DOORBELL_FIXTURE_URL",
        secretEnv: "FORGE_DOORBELL_FIXTURE_SECRET",
      },
    ],
  };
}

export const packedSuites = [
  {
    file: "test/blocks/l12-pr/packed.integration.test.ts",
    label: "packed PR integration",
    consumerEnv: "PR_PACKED_CONSUMER",
  },
  {
    file: "test/node-fixtures/check/packed.integration.test.ts",
    label: "packed check integration",
    consumerEnv: "CHECK_PACKED_CONSUMER",
  },
  {
    file: "test/blocks/l12-git/packed.integration.test.ts",
    label: "packed Git integration",
    consumerEnv: "GIT_PACKED_CONSUMER",
  },
  {
    file: "test/blocks/l7-work/packed.integration.test.ts",
    label: "packed work integration",
    consumerEnv: "WORK_PACKED_CONSUMER",
  },
  {
    file: "test/node-fixtures/memory/packed.integration.test.ts",
    label: "packed memory integration",
    consumerEnv: "MEMORY_PACKED_CONSUMER",
  },
  {
    file: "test/integration/packed.integration.test.ts",
    label: "packed first slice integration",
    consumerEnv: "FORGE_PACKED_CONSUMER",
  },
  {
    file: "test/node-fixtures/state/packed.integration.test.ts",
    label: "packed state integration",
    consumerEnv: "STATE_PACKED_CONSUMER",
  },
  {
    file: "test/core/async-handlers/packed.integration.test.ts",
    label: "packed async integration",
    consumerEnv: "ASYNC_PACKED_CONSUMER",
  },
  {
    file: "test/assembly/providers/packed.integration.test.ts",
    label: "packed providers integration",
    consumerEnv: "PROVIDERS_PACKED_CONSUMER",
  },
] as const;

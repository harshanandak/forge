export const packedSuites = [
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
] as const;

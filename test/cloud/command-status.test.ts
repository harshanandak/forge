import { expect, test } from "bun:test";
import { STATUS } from "../../cloud/src/project.ts";
import { COMMAND_STATUS } from "../../src/adapters/http/index.ts";

test.each(Object.entries(COMMAND_STATUS))(
  "the Worker and CLI agree on the HTTP status for %s",
  (code, status) => {
    expect(STATUS[code]).toBe(status);
  },
  10_000,
);

import { expect } from "bun:test";
import * as fsAdapter from "../../../src/adapters/fs/index.ts";
import {
  journalContract,
  type JournalFactory,
} from "../../contract/journal.contract.ts";

const exportedFactory = (fsAdapter as unknown as Record<string, unknown>)[
  "createLocalJournal"
];

function requireFactory(): JournalFactory {
  expect(typeof exportedFactory).toBe("function");
  if (typeof exportedFactory !== "function")
    throw new Error("createLocalJournal is not exported");
  return exportedFactory as JournalFactory;
}

journalContract("fs adapter", requireFactory);

import { ForgeFailure } from "../../contract/failure.ts";
import { validateStateEvent } from "../../generated/validators.ts";
import type { StateEvent } from "../../generated/types.ts";
import type { SqlDatabase } from "../../ports/store.ts";
import { recordDigest } from "./checkpoint.ts";
import { parseRestoreJson } from "./restore-json.ts";
import { allocationFloorNumber } from "./allocation-floor.ts";

function refuse(): never {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message:
      "Record checkpoint requires contiguous record events without coordination or request witnesses",
    retry: "never",
  });
}

/** Publish each bounded prefix atomically; interrupted work resumes from its last header. */
export function writeRecordCheckpoint(db: SqlDatabase, batch: number): number {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 256) refuse();
  const end = Number(
    db.get("SELECT sequence FROM state_retention WHERE id=1")?.sequence,
  );
  for (;;) {
    const covered = db.transaction(() => {
      const header = db.get("SELECT * FROM state_checkpoint_header WHERE id=1");
      if (header && Number(header.format_version) !== 2) refuse();
      let sequence = Number(header?.covered_sequence ?? 0);
      const rows = db.all(
        "SELECT sequence,namespace,key,body FROM state_events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
        [sequence, end, batch],
      );
      if (!rows.length && sequence !== end) refuse();
      for (const row of rows) {
        const event = parseRestoreJson(String(row.body)) as StateEvent;
        if (
          Number(row.sequence) !== ++sequence ||
          !validateStateEvent(event).ok ||
          event.namespace !== row.namespace ||
          event.key !== row.key ||
          event.requestId !== undefined
        )
          refuse();
        const { namespace, key, revision } = event;
        if (event.type === `${namespace}:record.updated@1`) {
          const record = {
            namespace,
            key,
            revision,
            value: event.data,
            updatedAt: event.at,
            updatedBy: event.actor,
          };
          db.run(
            "INSERT INTO state_checkpoint_live(namespace,key,sequence,revision,digest,body) VALUES (?,?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET sequence=excluded.sequence,revision=excluded.revision,digest=excluded.digest,body=excluded.body",
            [
              namespace,
              key,
              sequence,
              revision,
              recordDigest(record),
              JSON.stringify(record),
            ],
          );
          db.run(
            "DELETE FROM state_checkpoint_deleted WHERE namespace=? AND key=?",
            [namespace, key],
          );
          const prefix = key.slice("allocation:".length);
          const number = key.startsWith("allocation:")
            ? allocationFloorNumber(event.data, prefix)
            : undefined;
          if (number !== undefined)
            db.run(
              "INSERT INTO state_checkpoint_floors VALUES (?,?,?,?) ON CONFLICT(namespace,prefix) DO UPDATE SET sequence=excluded.sequence,highest=MAX(highest,excluded.highest)",
              [namespace, prefix, sequence, number],
            );
        } else if (event.type === `${namespace}:record.deleted@1`) {
          db.run(
            "DELETE FROM state_checkpoint_live WHERE namespace=? AND key=?",
            [namespace, key],
          );
          db.run(
            "INSERT INTO state_checkpoint_deleted VALUES (?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET sequence=excluded.sequence,revision=excluded.revision",
            [namespace, key, sequence, revision],
          );
        } else refuse();
        const numeric = /^(.*?)([1-9][0-9]*)$/.exec(key);
        if (numeric && Number.isSafeInteger(Number(numeric[2])))
          db.run(
            "INSERT INTO state_checkpoint_reservations VALUES (?,?,?,?) ON CONFLICT(namespace,prefix,number) DO UPDATE SET sequence=excluded.sequence",
            [namespace, numeric[1]!, sequence, Number(numeric[2])],
          );
      }
      if (rows.length)
        db.run(
          "INSERT INTO state_checkpoint_header VALUES (1,2,lower(hex(randomblob(16))),1,?,1,0) ON CONFLICT(id) DO UPDATE SET generation=generation+1,covered_sequence=excluded.covered_sequence",
          [sequence],
        );
      return sequence;
    });
    if (covered === end) return covered;
  }
}

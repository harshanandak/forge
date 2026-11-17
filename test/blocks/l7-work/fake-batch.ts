export function fakeBatch<Row extends { value: unknown; revision: number }>(
  records: Map<string, Row>,
  put: (
    key: string,
    value: Row["value"],
    options: { expectRevision: number },
  ) => Row,
): (
  entries: readonly {
    key: string;
    value: Row["value"];
    expectRevision: number;
  }[],
) => Row[] {
  return (entries) => {
    const keys = new Set<string>();
    for (const entry of entries) {
      if (
        keys.has(entry.key) ||
        (records.get(entry.key)?.revision ?? 0) !== entry.expectRevision
      )
        throw new Error("REVISION_CONFLICT");
      keys.add(entry.key);
    }
    const before = new Map(records);
    try {
      return entries.map((entry) =>
        put(entry.key, entry.value, { expectRevision: entry.expectRevision }),
      );
    } catch (error) {
      records.clear();
      for (const [key, row] of before) records.set(key, row);
      throw error;
    }
  };
}

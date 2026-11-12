type Built = {
  value: unknown;
  readSet?: readonly { key: string; expectRevision: number }[];
};
type Fake = {
  maxNumber(prefix: string): number;
  put(
    key: string,
    value: unknown,
    options: {
      expectRevision: number;
      readSet?: readonly { key: string; expectRevision: number }[];
    },
  ): unknown;
};

/** The numbered write for an in-memory fake that never deletes: the highest key plus one. */
export function fakeNext(
  state: Fake,
  prefix: string,
  build: (key: string, number: number) => Built,
): unknown {
  const number = state.maxNumber(prefix) + 1;
  const { value, readSet } = build(`${prefix}${number}`, number);
  return state.put(`${prefix}${number}`, value, {
    expectRevision: 0,
    ...(readSet ? { readSet } : {}),
  });
}

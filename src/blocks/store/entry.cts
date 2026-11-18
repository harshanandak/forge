interface StoreCall {
  readonly input: unknown;
  readonly services: {
    readonly store: { export(input: unknown): unknown };
  };
}

module.exports = {
  "store.export": (call: StoreCall) => call.services.store.export(call.input),
};

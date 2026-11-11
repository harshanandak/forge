interface CloudCall {
  readonly input: unknown;
  readonly services: {
    readonly cloud: { login(input: unknown): Promise<unknown> };
  };
}

// The service checks the input and does the login; the block only declares the operation.
module.exports = {
  "cloud.login": (call: CloudCall) => call.services.cloud.login(call.input),
};

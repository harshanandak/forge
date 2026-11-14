export const read = {
  version: 1,
  kind: "read",
  namespace: "example/state",
  operation: "record.show",
  policyRevision: "policy-1",
  query: { kind: "get", key: "record:1" },
};
export const readVersion = { epoch: "epoch-1", revision: 0 };
export const commit = {
  version: 1,
  kind: "commit",
  namespace: read.namespace,
  operation: "record.create",
  policyRevision: read.policyRevision,
  requestId: "request-1",
  input: { title: "A record" },
  readVersion,
  readSet: [
    {
      namespace: read.namespace,
      key: "record:1",
      expectRevision: 0,
      readVersion,
    },
  ],
  entries: [
    { key: "record:1", value: { title: "A record" }, expectRevision: 0 },
  ],
};

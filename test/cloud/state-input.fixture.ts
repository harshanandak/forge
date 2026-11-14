export const context = {
  actor: { kind: "agent", id: "tester" },
  project: { id: "p" },
  device: { id: "laptop" },
  session: { id: "s1", device: "laptop" },
};
export const read = {
  version: 1,
  kind: "read",
  namespace: "example/state",
  operation: "record.show",
  policyRevision: "policy-1",
  context,
  query: { kind: "get", key: "record:1" },
};
export const readVersion = { epoch: "epoch-1", revision: 0 };
export const commit = {
  version: 1,
  kind: "commit",
  namespace: read.namespace,
  operation: "record.create",
  policyRevision: read.policyRevision,
  context,
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

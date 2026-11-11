# Forge cloud login

Consumer: the owner of a Forge cloud project, logging a second machine or a cloud agent in to it with `forge cloud login`.
Enable the `forge/cloud` built-in block in `.forge/config.yaml` (`blocks: { cloud: { source: { builtin: forge/cloud } } }`).

`forge cloud login --origin <https origin> --project <name>` starts a device login against the Forge cloud Worker,
prints the verification address and a short code on stderr, and polls at the server's pace until the owner approves
it in a browser. It then saves this device's credential in `~/.forge/cloud/credentials.json` and writes the project's
`.forge/cloud.json` binding last. The final result on stdout holds the origin, project, device, token id and expiry;
it never holds the token. Later logins need no flags: the binding supplies the origin and project, and login never
changes an established binding.

The operation is for a person at a terminal (`callers: ["human"]`), so it is not an MCP tool: it prints a code for a
browser and waits for a human. It takes a bounded wait (the code's own lifetime) and holds no lock while waiting.

The block runs no process. It calls the `forge.cloud-login@1` service, which owns the HTTPS client, the private
credential file and the binding file. The device id sent to the server is the local id when the server accepts it,
otherwise `device-` plus the SHA-256 of the local id.

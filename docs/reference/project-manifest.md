# Project manifest

`.forge/project.json` gives a repository one project id that travels with its code. Every clone and every git worktree reads the same id from their checked-out copy of the file.

```json
{
  "schema": 1,
  "id": "5b0f3c1e-2a4d-4e8f-9a6b-7c1d2e3f4a5b",
  "name": "optional-label"
}
```

- `schema` is `1`. `id` is a random lowercase UUID v4. `name` is optional, 1 to 64 letters, digits, dots, hyphens or underscores. Leave it out if the name could reveal a client.
- Any other field is refused, so credentials, paths and account links cannot ride in the file. Project commands refuse a malformed manifest with `INPUT_INVALID`.
- The id is a label, never a password. Knowing it grants no access to anyone's memory.

## Creating it

`forge project init` is the only command that writes the file. It needs the owner's reply, writes a new random id, and refuses with `PROJECT_MANIFEST_EXISTS` when the file exists. It never overwrites, and neither init nor config can change an id. The id is never derived from the git remote, the root commit or the folder name. Commit the file.

If your `.gitignore` ignores all of `.forge/`, allow the manifest:

```gitignore
.forge/*
!.forge/project.json
```

## What reads it

`levels.project()` returns `projectId`, in this order: the id the local store recorded from the manifest, else the manifest's id, else the store's own id (no manifest, as before). The store keeps its own random id, which still keys note ids and the device registry, so existing project memory is untouched. The first write that sees a manifest records its id beside the store id.

If a store recorded one project id and the manifest says another, writes that depend on project identity fail with `PROJECT_ID_CONFLICT` and name both ids. Reads keep the recorded id. Nothing switches silently. An owner-approved adopt or migrate step, and an explicit fork operation, are tracked separately (forge-987).

## Forks

A fork copies the file and so keeps the upstream id. That is fine for contributing upstream. An independent fork or client copy needs its own id: delete the file in the fork and run `forge project init`.

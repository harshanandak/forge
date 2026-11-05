# One-way doors

These actions are one-way doors: publish, force-push, prod-write, migration-apply, delete-branch, delete-worktree, merge-to-autodeploy, global-config.

Authorization requires the owner's reply naming that action. Silence, "continue" or "fix all" never counts as authorization. An unattended recommendation does not grant it either. A merge that deploys, publishes or migrates is a door; deleting a worktree that contains work is a door too.

Describe the specific action and wait for the owner's reply before proceeding. Keep reversible preparation inside the slice's done boundary while that reply is pending.

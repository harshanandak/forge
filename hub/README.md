# Forge Hub

## Windows data directory

Use `%USERPROFILE%\.forge-hub\data` under the Windows account that runs the
hub. Expand `%USERPROFILE%` to the account's profile path before writing the
absolute path into `dataDir` in the hub configuration. The data directory
must have an owner-only DACL, and the hub checks the full path up to the volume
root for reparse points, untrusted owners, and grants that allow replacement.

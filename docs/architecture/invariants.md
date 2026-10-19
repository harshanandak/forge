# Cross-block invariants

1. External tools are resolved to absolute paths by their single owning adapter.
   Blocks consume typed command ports, never generic process resolution for git or gh.
   Enforced for these ports: `test/adapters/account-tools/commands.test.ts`.
   The existing git block generic resolution is a tracked contract gap (legacy tracker `48791f52-b580-4661-9678-827268ebf34e`).
2. Tokens stay within the account adapter invocation and its explicitly allowed children.
   No port returns a token. Credential mode currently refuses before resolution or launch.
   Enforced: `test/adapters/account-tools/commands.test.ts` and the packed provider credential call.
3. The clone-local `forge.githubAccount` config key is the public binding.
   Other blocks must not read account metadata files. Binding is implemented in a later slice.
   Enforced: `test/adapters/account-tools/commands.test.ts` (cross-block ownership).
4. Only the git block installs hooks through `hook.install`; other blocks expose checks.
   Enforced: `test/blocks/l12-git/packed.integration.test.ts` (owned hook installation).
5. Every acquired service lease closes on success, refusal, partial acquisition and abort.
   Cleanup attempts every closer and retains primary and cleanup errors during rollback.
   Enforced: `test/assembly/providers/stateless-files.test.ts` and
   `test/adapters/account-tools/scoped.test.ts` (abort and drain before close settles).

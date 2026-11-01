# Project verification guide

There is no guide by default. Add `.forge/verify.md` when a project has user-visible behaviour worth fixing in place. Pick the scenario relevant to the slice; record its declared check, pass predicate and evidence to save.

Example `.forge/verify.md` (no commands of its own):

```markdown
## CLI help

Check: `verify-cli-help`
Pass: help prints Usage and exits 0.
Evidence: receipt output; save the receipt JSON to evidence/cli-help.json.

## UI page

Check: `verify-ui-page`
Pass: the built app's home page shows Welcome and its primary button works.
Evidence: receipt output and screenshot evidence/home.png (or recording evidence/home.webm).
```

Each declared check must run the built artifact, not the source.

Declare the matching checks in `.forge/config.yaml`:

```yaml
blocks:
  check:
    source: { builtin: forge/check }
    config:
      commands:
        verify-cli-help: node scripts/verify-cli-help.mjs
        verify-ui-page: node scripts/verify-ui-page.mjs
```

Each entry is one executable invocation. Put shell composition in a project-owned script. The project's scripts start/exercise the built app as users get it, assert the pass predicates and save the named files. Run `forge check run --input '{"checks":["verify-cli-help"]}'`; a guide whose command fails reports FAIL, and a missing tool reports INCOMPLETE; neither is a pass. Save receipt output, screenshot or recording paths in a `forge issue comment` on the slice and in the PR's Verification section. Keep the guide and checks current together.

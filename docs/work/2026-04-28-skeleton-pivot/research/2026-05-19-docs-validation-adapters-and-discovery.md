# Research: Docs Validation Adapters And Project Discovery

Date: 2026-05-19
Status: Planning update

## Summary

Forge should not own every documentation checker. The better design is a local docs-validation substage that discovers each project's documentation shape, selects one or more checker adapters, normalizes their output, and lets users toggle the substage on or off per project.

This keeps the user experience simple while avoiding a permanent Forge-maintained clone of established tools.

## Existing Tools To Adapt

### Link Checking

- `lycheeverse/lychee-action` is the strongest default for general link checking. It checks Markdown, HTML, reStructuredText, local files, and websites; supports JSON/Markdown output, cache, job summaries, `fail`, `failIfEmpty`, custom args, working directories, and GitHub token use. Source: <https://github.com/lycheeverse/lychee-action>.
- Lychee supports path exclusions through `--exclude-path` or `exclude_path` in `lychee.toml`; `.lycheeignore` is for URL exclusions, not path exclusions. Source: <https://lychee.cli.rs/recipes/excluding-paths/>.
- `gaurav-nelson/github-action-markdown-link-check` exists but is deprecated as of April 2025. Its Marketplace page points users to the maintained Tcort fork and to Linkspector. It is useful as prior art, not as Forge's default. Source: <https://github.com/marketplace/actions/markdown-link-check>.
- `tcort/markdown-link-check` remains a useful Node CLI/library. It supports recursive folder checks, Docker, config files, ignore/replacement patterns, `projectBaseUrl`, retry behavior, alive status codes, and inline disable comments. Source: <https://www.npmjs.com/package/markdown-link-check>.
- Linkspector is a good PR-review adapter when inline comments matter. Its GitHub Action supports `.linkspector.yml`, reviewdog reporters, `fail_on_error`, `filter_mode`, modified-files-only mode, directory matrices, and token-backed authenticated checks. Source: <https://www.mintlify.com/UmbrellaDocs/linkspector/guides/github-actions>.
- `@umbrelladocs/linkspector` also exists as a CLI. It supports Markdown, AsciiDoc hyperlinks, configuration through `.linkspector.yml`, `dirs`, `files`, `excludedFiles`, `excludedDirs`, and a Puppeteer-backed strategy intended to reduce false positives. Source: <https://www.npmjs.com/package/@umbrelladocs/linkspector>.
- `remark-validate-links` is a better fit for strict local Markdown anchor validation. It reports missing headings in the same file and in referenced Markdown files, and works through `remark-cli`. Source: <https://npm.io/package/remark-validate-links>.

### Docstring And API Documentation Coverage

- ESLint's built-in `require-jsdoc` rule was removed in ESLint v9 and replaced by the `eslint-plugin-jsdoc` equivalent. Source: <https://eslint.org/docs/latest/rules/require-jsdoc>.
- `eslint-plugin-jsdoc` is the right adapter for JavaScript/TypeScript documentation requirements because Forge already uses ESLint, and the plugin provides requirement-oriented JSDoc rules/configs. Source: <https://www.npmjs.com/package/eslint-plugin-jsdoc>.
- Forge can keep a lightweight docstring coverage reporter for summary metrics, but rule enforcement should come from `eslint-plugin-jsdoc` where possible.

### PR Feedback

- reviewdog can normalize linter output into PR checks, annotations, or PR reviews, and has GitHub Action integration plus markdownlint/ESLint actions. Source: <https://github.com/reviewdog/reviewdog>.
- For Forge, reviewdog should be an output adapter, not the core validation engine. The same docs-validation substage should run locally without GitHub and then optionally project results into GitHub PR comments.

## Recommended Forge Model

Do not hardcode a single "docs linker" implementation into core. Add a `docs.validation` substage with these parts:

1. Discovery
2. Adapter selection
3. Config generation
4. Local validation
5. CI projection
6. UI/TUI toggle
7. Baseline and debt tracking

The local Forge command should be stable:

```bash
forge docs detect
forge docs verify
forge docs apply --enable docs.validation
forge docs apply --disable docs.validation
```

The implementation under that command can use Lychee, Linkspector, remark, eslint-plugin-jsdoc, or a custom adapter depending on project shape.

## Project Discovery Process

Forge should discover documentation structure before enabling the substage.

### 1. Explicit Config First

Read Forge config if present:

```yaml
docs:
  validation:
    enabled: true
    roots:
      - README.md
      - docs/
      - packages/*/docs/
    adapters:
      links:
        provider: lychee
      anchors:
        provider: remark-validate-links
      docstrings:
        provider: eslint-plugin-jsdoc
    baseline: .forge/docs/baseline.json
```

Explicit user config always wins over detection.

### 2. Detect Documentation Systems

If config is absent, detect common docs systems:

- generic: `README.md`, `CHANGELOG.md`, `docs/**`
- monorepo: `packages/*/README.md`, `packages/*/docs/**`, `apps/*/docs/**`
- Docusaurus: `docusaurus.config.*`, `sidebars.*`, `docs/**`
- VitePress: `.vitepress/**`, `docs/**`
- MkDocs: `mkdocs.yml`
- Mintlify: `mint.json`, `docs.json`
- TypeDoc: `typedoc.json`
- JSDoc: `jsdoc.json`, `.jsdoc.json`
- package docs: `package.json` `homepage`, `repository`, `exports`, `types`

The output of discovery should be a profile, not immediate file writes:

```json
{
  "roots": ["README.md", "docs/", "packages/*/docs/"],
  "systems": ["generic-markdown", "monorepo"],
  "linkModes": ["relative", "root-relative", "github-blob"],
  "recommendedAdapters": ["lychee", "remark-validate-links", "eslint-plugin-jsdoc"],
  "confidence": 0.86
}
```

### 3. Adapter Selection

Use this default selection logic:

| Need | Default Adapter | Reason |
|---|---|---|
| broad internal/external links | Lychee | Maintained, fast, CI-ready, works beyond Markdown |
| PR inline comments | Linkspector + reviewdog | Native PR-review workflow and modified-files-only mode |
| strict Markdown anchors | remark-validate-links | Better local anchor semantics |
| JavaScript/TypeScript JSDoc rules | eslint-plugin-jsdoc | ESLint-native and current after ESLint v9 |
| summary metrics / baselines | Forge adapter | Normalize output and track project-specific debt |

### 4. Baseline Existing Debt

Large repos often have historical broken links or sparse docstrings. The first enablement should support:

- `mode: report` for current visibility,
- `mode: new-only` to fail only on newly introduced broken links,
- `mode: strict` once the project is cleaned up,
- baseline storage under `.forge/docs/baseline.json` or project-selected path,
- UI controls for "accept baseline", "open cleanup issue", and "enforce strict".

### 5. Configuration Projection

Forge should generate or update tool-specific config only through a plan/apply flow:

- `.lychee.toml` or action args for Lychee,
- `.linkspector.yml` for Linkspector,
- `.remarkrc` or `package.json` `remarkConfig` for remark,
- ESLint flat-config extension for `eslint-plugin-jsdoc`,
- `.github/workflows/docs-validation.yml` when GitHub Actions is enabled,
- Lefthook pre-push entry when local hooks are enabled.

Users should be able to toggle each projection independently:

```yaml
docs:
  validation:
    enabled: true
    localHook: true
    githubAction: true
    prComments: false
    docstringCoverage: report
```

## UI/TUI Fit

In the local Forge UI/TUI, this belongs as a project-level feature page:

- detected docs roots,
- selected adapters,
- current baseline size,
- docstring coverage,
- link-check mode,
- GitHub Action projection status,
- local hook status,
- last run result,
- enable/disable/apply/rollback controls.

The UI must not write tool configs directly. It should call Forge config plan/apply/rollback so all changes are auditable and reversible.

## Release Placement

For current release slicing:

- `0.0.16`: keep the release-plan responsibilities centered on safety, patch, upgrade, rollback, fixtures, protected-write intent records, and the existing migrate dry-run baseline. Track docs-validation through `forge-30k` as the documentation link checking and docs-validation automation slice: the first deliverable is a report/new-only/strict baseline model and a generated GitHub Action/Lefthook projection, with adapter selection documented before broader rollout.
- `0.0.21`: expose docs-validation status through the local UI/TUI only through the same local control-plane APIs used for project runtime graph, stage, substage, hook, extension, and issue views.
- `0.0.24`: generalize docs-validation under extension-contributed components, where third-party adapters can contribute substages, evaluator regions, evidence collectors, hooks, templates, commands, and local UI panels.

## Correction To Current Branch

The current custom `forge docs verify` work is useful as an early Forge-normalized report and baseline model. It should not remain the long-term core checker. The next implementation slice should replace the hardcoded checker behavior with an adapter interface and make Lychee the default external checker, with Linkspector/reviewdog as an opt-in PR-comments projection.

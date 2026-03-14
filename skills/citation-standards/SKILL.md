---
name: citation-standards
description: >
  Citation format rules for research outputs. Enforces consistent source attribution
  in docs/research/ files. ALWAYS use this skill when writing or editing files in
  docs/research/, adding citations to documents, formatting bibliographies, or when
  the user asks about source attribution standards. Also trigger when creating any
  research content that references external sources, URLs, papers, or articles.
  Trigger on phrases like "add citations", "format sources", "research document",
  "reference this source", "bibliography", "cite this", "docs/research".
metadata:
  internal: true
  author: harshanandak
  version: "1.0.0"
---

# Citation Standards

Rules for consistent source attribution in all `docs/research/` documents. Apply these rules whenever writing research findings, documenting decisions, or referencing external sources.

## Required: Sources Section

Every research document MUST end with a `## Sources` section listing all referenced URLs:

```markdown
## Sources

- [Vercel Agent Skills docs](https://vercel.com/docs/agent-resources/skills)
- [GitHub vercel-labs/skills](https://github.com/vercel-labs/skills)
- [anthropics/skills](https://github.com/anthropics/skills)
```

## Inline Citations

When referencing a source in body text, use Markdown link syntax:

```markdown
According to the [Vercel KB guide](https://vercel.com/kb/guide/agent-skills),
the `name` field must match the directory name.
```

Never use bare URLs: `https://example.com/doc` — always wrap in `[Title](URL)`.

## Excerpts

When quoting from a source, use a blockquote and cite inline:

```markdown
> "Skills give agents secure, structured ways to take action across your stack"
> — [Vercel Agent Skills docs](https://vercel.com/docs/agent-resources/skills)
```

## Time-Sensitive Content

Add access date when content may become outdated:

```markdown
- [Bitcoin price](https://coinmarketcap.com/currencies/bitcoin/) — accessed 2026-02-21
```

## Research Document Template

```markdown
## Sources

- [Source Title](URL)
- [Source Title](URL) — accessed YYYY-MM-DD (for time-sensitive data)
```

## Key Rules

1. Every URL must have a descriptive title
2. `## Sources` section is mandatory in every research doc
3. No bare URLs in body text
4. Blockquotes for direct excerpts with inline citation
5. Access dates for time-sensitive sources (prices, stats, current events)
6. List sources in order of relevance (most important first)

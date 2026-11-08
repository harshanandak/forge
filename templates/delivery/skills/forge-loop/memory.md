# Memory and standing rules

At session start, run `forge memory rules` unless a hook supplied it: `result.text.text` is a pointer, never note text. Search memory before starting a task; use its search/show commands.

## Scope and durable facts

Use the lowercase repo name from `gh repo view --json name --jq '.name|ascii_downcase'` as `<name>`.

Save future-session facts: `forge memory add --input '{"text":"...","level":"device","scope":"<name>","tags":["..."]}'`.

Owner tags (`rule`, `preference`, `decision`) are only for directional choices the owner must approve, such as which method to follow; the note waits for the owner. Implementation facts and procedures you settled with evidence use `fact`, `procedure` or `reference` and apply at once; for example "the release job needs a clean tree". A repeat of an owner note returns `exists`. Take back a duplicate or needless proposal with `forge memory withdraw`.

## Propose and adopt

Record an answer or propose a standing rule: `forge decision propose --input '{"title":"...","text":"..."}'`. On `format_missing`, follow the returned `repair`, then propose again. Only after `proposed`, hand it to a human for `decision.adopt`; adoption makes it binding.

Standing rules are adopted decisions. List adopted decision titles only (no decision text): `forge decision list --input '{"status":"adopted"}'`. While `truncated` is true, repeat with `after` set to the returned `next`: `forge decision list --input '{"status":"adopted","after":<next>}'`, even if a page is empty. Request the adopted text from the owner when needed.

# Frame before slicing

- Facts are your job: read the code, and `forge memory search --input '{"query":"...","scope":"<name>"}'` and `forge decision list --input '{}'` for prior choices. Use the lowercase repo name from `gh repo view --json name --jq '.name|ascii_downcase'` as `<name>`.
- Route open decisions to `forge-intake` before framing or slicing.
- Record each answer: `forge decision propose --input '{"title":"...","text":"..."}'`. On `format_missing`, follow the returned `repair`, then propose again. Only after `proposed`, hand it to a human for adoption.
- Plan in depth only for the one or two hard choices.

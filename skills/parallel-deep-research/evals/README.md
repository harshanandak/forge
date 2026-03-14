# Eval Sets

These eval files use a flat JSON array format targeting `scripts/eval_win.py`:

```json
[{"query": "...", "should_trigger": true}]
```

This is **not** compatible with the skill-creator plugin's `run_loop.py` which expects:

```json
{"skill_name": "...", "evals": [{"id": "...", "prompt": "...", "should_trigger": true}]}
```

To use with `run_loop.py`, convert `query` → `prompt` and wrap in the plugin schema.

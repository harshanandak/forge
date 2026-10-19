# Project block

`forge/project` detects project capabilities without writing state or config. Its `project.detect` declaration allows 5000 ms for the synchronous handler. The embedding host can supply a tighter ceiling; an exhausted budget fails with `LIMIT_EXCEEDED`.

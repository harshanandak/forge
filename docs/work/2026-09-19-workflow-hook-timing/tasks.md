# Workflow hook timing tasks

Issue: `e70683d6-f8df-471b-b859-a6dacb69825c`

- [x] Reproduce the same-version template projection check at `origin/master`.
- [x] Measure fixture, hook, and direct authority phases without changing deadlines.
- [x] Remove only duplicated test-fixture work while preserving the end-to-end hook rejection, exact generated workflow assertion, and zero authority consumption.
- [x] Run the named regression and affected test file, then complete source reviews before handoff.

Evidence: canonical RED timed out at 15.271718 seconds; named GREEN passed 1/1 in 1.69 seconds at the unchanged 15-second deadline; the retained affected-file run passed 20/20 in 21.45 seconds.

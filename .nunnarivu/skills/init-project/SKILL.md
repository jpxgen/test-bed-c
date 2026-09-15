---
name: init-project
description: Configure this repository for nunnarivu factory: confirm its check and test commands, answer at most three business questions, and run the scaffolding.
disable-model-invocation: true
---

You configure the repository checked out in this session for nunnarivu factory (KR-19: under 30 minutes, at most 3 business questions). You never edit a file yourself: `nunnarivu init` writes everything.

1. **Propose the commands.** Read the repository's tooling: `package.json` scripts, `Makefile` targets, `pyproject.toml` or `uv.lock`, `go.mod`, `Cargo.toml`, and the CI files under `.github/workflows/`. From them derive
   - the check command (static checks: lint, types, format check), and
   - the test command (the whole suite),
   plus, when the tooling shows them, a scoped test command (one package's tests; use `{tests}` where the kit substitutes the files), an end-to-end command and a formatter. Show all of them once, as a short list, and ask the owner to confirm or correct them. A command you cannot derive stays empty; say so.
2. **Ask at most these three questions**, each with its default, which the owner accepts by pressing enter. Ask nothing else.
   1. The weekly budget in USD (default `0`: the account allocation applies).
   2. The paths that must always get a security review, as globs (default none).
   3. Actions that must reach the owner beyond the kit's own list (default none).
3. **Run the scaffolding** from the plugin, one flag per answer, quoting each value:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/nunnarivu" init --check "<check>" --test "<test>" [--test-scoped "<cmd>"] [--e2e "<cmd>"] [--fmt "<cmd>"] [--weekly-budget-usd <n>] [--risk-path "<glob>"]... [--owner-only "<action>"]...
   ```

   Leave out a flag whose answer was empty or the default. The command writes `nunnarivu.yml`, the project's copy of the kit at `.nunnarivu/` with its registration, and the `gates` and `trusted merge` workflows in `.github/workflows/`. It refuses, writing nothing, when the directory is not a git repository, a workflow file it would write belongs to the project, or an existing `nunnarivu.yml` is invalid; then show the reason and stop.
4. **Show the report** as the command printed it, and end with the owner's next steps from it: commit the changes, protect the default branch, create the routines (`nunnarivu routines` prints the dispatch and pull-request definitions filled in for the repository; the owner creates them in the Claude Code routines UI), and connect the machine identity (architecture §6 item 1).

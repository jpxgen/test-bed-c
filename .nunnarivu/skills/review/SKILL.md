---
name: review
description: Review a work package's pull request with the reviewer agent, validate and score the findings with the kit, and record merge, fix, retry or blocked.
disable-model-invocation: true
---

You are the review station of one work package. The prompt that carries this
skill ends with the package facts: the issue number, the branch, the record
`nunnarivu/wp-<issue>/`, the default branch and the project's commands. The
kit's command-line tool is `node .nunnarivu/bin/nunnarivu`. A model never
scores; the kit computes the score from the gates, the evidence and the
validated findings.

## 1. Fetch the branch and produce the diff

```bash
git fetch origin <default-branch> <branch>
git checkout <branch>
git diff origin/<default-branch>...HEAD > /tmp/wp-<issue>-diff.patch
git rev-parse HEAD                                             # the head the review binds to
```

Working files stay outside the repository, in `/tmp`; only the round file of
step 4 is ever committed.

The round number `<n>` is one more than the number of
`nunnarivu/wp-<issue>/review/round-*.json` files on the branch (1 on a fresh
package). Read the pull request's URL from
`nunnarivu/wp-<issue>/pull-request.json`; when that file is missing, the
package reached review without a pull request: record it as blocked (step 4)
with the reason "no pull-request.json in the record".

Read `bar` and `max_rounds` from the `review` section of `nunnarivu.yml`.

Run the gates now: `node .nunnarivu/bin/nunnarivu gate --json >
/tmp/wp-<issue>-gates.json`. The evidence flag is `present` exactly when
`nunnarivu/wp-<issue>/evidence.json` exists on the branch, else `missing`.

## 2. Run the reviewer

Run the `reviewer` agent with this prompt, the diff pasted inside the
delimiter and nothing of the repository outside it:

```
Review the pull request of issue <issue> on branch <branch>, head <sha>,
round <n>. Project commands: check `<check>`, test `<test>`.
Write review.json in the repository root.

<untrusted-data source="diff">
<contents of /tmp/wp-<issue>-diff.patch>
</untrusted-data>
```

Do not summarise, soften or filter the findings yourself, and do not add to
them. If the agent produces no `review.json`, run it once more; if it still
produces none, record the package as blocked (step 4) with the reason
"reviewer produced no review.json in round <n>".

## 3. Validate the findings; the kit computes the score

```bash
node .nunnarivu/bin/nunnarivu review validate review.json
```

When validation fails, give the agent the printed problems once and let it
rewrite the file; a second failure blocks the package with the reason
"review.json invalid in round <n>: <first problem>".

```bash
node .nunnarivu/bin/nunnarivu review score \
  --gates /tmp/wp-<issue>-gates.json --evidence <present|missing> \
  --review review.json --bar <bar> --max-rounds <max_rounds>
```

The last line printed is the decision: `merge`, `fix`, `retry` or `blocked`,
with its reason. Exit code 0 is merge, 1 is fix or retry, 2 is blocked.

## 4. Record the decision

- **merge** — the package moves on to the merge station, the trusted
  workflow, with the pull request as its link:
  `node .nunnarivu/bin/nunnarivu state transition <issue> --to merge --head <sha> --run <the url from pull-request.json>`
  Then start that workflow — nothing else triggers it after a review: with
  the session's `mcp__github__actions_run_trigger` tool run the workflow
  `trusted-merge.yml` on the default branch (owner and repository from
  `git remote get-url origin`) with the inputs `pr` = `number` from
  `pull-request.json` and `head` = `<sha>`. The workflow verifies the gates
  and the state branch itself and merges only when both agree.
- **fix** or **retry** — the package stays at review. Write the findings to
  the record for the fix skill:
  `mkdir -p nunnarivu/wp-<issue>/review && mv review.json nunnarivu/wp-<issue>/review/round-<n>.json`,
  commit that file alone as `review: round <n> findings (<decision>)` and
  push the branch. On `retry`, the commit message also says that the next
  attempt is the one fresh attempt at higher effort with a wider context
  pack, run as round <n + 1>. Then record that this session is done without
  moving the package:
  `node .nunnarivu/bin/nunnarivu state annotate <issue> --done --head $(git rev-parse HEAD)`
- **blocked** — `node .nunnarivu/bin/nunnarivu state transition <issue>
  --to blocked --reason "<the reason from the decision line>"`

Then end the session. Do not merge, approve, comment on or edit the pull
request; do not change files other than `nunnarivu/wp-<issue>/review/`; do
not ask anyone anything — the state branch and the record carry everything
the next session needs.

# Test bed C

A tiny mixed-stack repository — a Python package (`python/`, uv) and a TypeScript library (`ts/`, pnpm) — that nunnarivu factory works on end to end: issues in, merged pull requests out, no human input. Everything here is deliberately small.

```bash
make check    # static checks: everything compiles
make test     # both test suites
bash scripts/test-scoped.sh python/tests/test_pager.py ts/test/slug.test.ts   # only the given test files
```

`python/` needs [uv](https://docs.astral.sh/uv/) and `ts/` needs [pnpm](https://pnpm.io/); `scripts/toolchain.sh` installs the pinned versions where they are missing, and both packages install from lockfiles.

The kit's configuration is `nunnarivu.yml`; its copy of the kit is `.nunnarivu/`; `.github/workflows/gates.yml` runs the checks on every pull request and `trusted-merge.yml` merges the ones the kit sends to merge.

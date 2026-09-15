#!/usr/bin/env bash
# Runs the given test files, and only those: python/... through the project's
# pytest invocation, ts/... through its tsc + node --test invocation. Every
# path is relative to the repository root. Fails when given no files, when a
# file does not exist or is not a test file of either package, and when any
# run fails; both packages run before the verdict.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
usage() { echo "usage: bash scripts/test-scoped.sh <python/tests/... or ts/test/... file>..." >&2; exit 2; }
[ "$#" -gt 0 ] || usage

python_tests=()
ts_tests=()
for file in "$@"; do
  [ -f "$file" ] || { echo "test-scoped: $file does not exist" >&2; exit 2; }
  case "$file" in
    python/*.py) python_tests+=("${file#python/}") ;;
    ts/*.ts) ts_tests+=("dist/${file#ts/}") ;;
    *) echo "test-scoped: $file is neither a python/ test nor a ts/ test" >&2; exit 2 ;;
  esac
done

bash scripts/toolchain.sh
# The evidence checker runs this twice in one worktree, with and without the
# implementation, often within the same second. A .pyc written by the first run
# is taken as fresh by the second when the restored source has the same size and
# mtime second, so the second run would import the first run's bytecode.
export PYTHONDONTWRITEBYTECODE=1
status=0
if [ "${#python_tests[@]}" -gt 0 ]; then
  (cd python && uv sync --frozen --quiet && uv run --frozen pytest -q "${python_tests[@]}") || status=1
fi
if [ "${#ts_tests[@]}" -gt 0 ]; then
  (cd ts && pnpm install --frozen-lockfile --silent && pnpm exec tsc -p tsconfig.json && node --test "${ts_tests[@]/%.ts/.js}") || status=1
fi
exit "$status"

.PHONY: check test toolchain check-python check-ts test-python test-ts

# Static checks (nunnarivu.yml commands.check): everything compiles.
check: toolchain check-python check-ts

# The whole suite (commands.test).
test: toolchain test-python test-ts

# The pinned toolchain, installed only where it is missing (the gates runner is bare).
toolchain:
	bash scripts/toolchain.sh

check-python:
	cd python && uv sync --frozen --quiet && uv run --frozen python -m compileall -q src tests

check-ts:
	cd ts && pnpm install --frozen-lockfile --silent && pnpm exec tsc -p tsconfig.json --noEmit

test-python:
	cd python && uv sync --frozen --quiet && uv run --frozen pytest -q

test-ts:
	cd ts && pnpm install --frozen-lockfile --silent && pnpm test

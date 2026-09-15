# Work package 3

An invalid page size on the command line reports success

## Acceptance criteria

- [ ] Running `python -m pager --size 0` exits with status 2, prints an error line containing `--size must be a positive integer` on stderr, and prints nothing on stdout.
- [ ] Running `python -m pager --size -3` exits with status 2, prints an error line containing `--size must be a positive integer` on stderr, and prints nothing on stdout.
- [ ] Piping the lines a, b and c through `python -m pager --size 2` exits with status 0 and prints `a`, `b`, an empty line, `c` (stdout is `"a\nb\n\nc\n"`) with nothing on stderr.
- [ ] Piping five lines through `python -m pager --size 2` still exits 0 and prints them as three pages separated by blank lines, as it does today.
- [ ] The rejection happens before stdin is read, so an invalid `--size` produces no output even when input is piped in. (assumption)
- [ ] The existing test `test_cli_rejects_size_below_one` in `python/tests/test_pager.py`, which pins the exit status of `--size 0` at 0 and so encodes the reported bug, is revised to expect status 2; every other existing test in the file keeps passing unchanged. (assumption)
- [ ] The library function `paginate` is untouched: `paginate([1], 0)` still raises `ValueError`. (assumption)
- [ ] `make check` and `make test` pass.

## Write set

python/src/pager/cli.py
python/tests/test_pager.py
nunnarivu/wp-3/

## Evidence

type: logic

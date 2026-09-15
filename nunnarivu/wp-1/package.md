# Work package 1

Paging a list drops the items after the last full page

## Acceptance criteria

- [ ] `paginate([1, 2, 3, 4, 5], 2)` returns `[[1, 2], [3, 4], [5]]`: two full pages, then a last page holding only the fifth item.
- [ ] `paginate([1], 3)` returns `[[1]]`: one page holding that item.
- [ ] `paginate([1, 2, 3, 4], 2)` still returns `[[1, 2], [3, 4]]`: lists that divide evenly are unchanged.
- [ ] `paginate([], 3)` still returns `[]`: an empty list gives no pages.
- [ ] `paginate([1], 0)` still raises `ValueError`: a page size below one is still rejected, as it is today.
- [ ] Piping five lines through `python -m pager --size 2` prints all five lines as three pages separated by blank lines: the fifth line is printed on its own last page.
- [ ] The command-line tool's handling of a page size below one is unchanged: it still prints its error to stderr and returns as it does today. (assumption)
- [ ] The existing tests in `python/tests/test_pager.py` keep passing, and `make check` and `make test` pass.

## Write set

python/src/pager/__init__.py
python/tests/test_pager.py
nunnarivu/wp-1/

## Evidence

type: logic

# Work package 4

Ask how many pages a list needs

## Acceptance criteria

- [ ] The `pager` package exports a function `page_count(items, size)` that returns the number of pages `paginate(items, size)` would produce, as an `int`, without building the pages. (assumption: the name `page_count` and the argument order `(items, size)`, matching `paginate`)
- [ ] `page_count([1, 2, 3, 4, 5], 2)` returns `3`: five items at two per page need three pages.
- [ ] `page_count([1, 2, 3, 4], 2)` returns `2`: four items at two per page need two pages.
- [ ] `page_count([1], 3)` returns `1`: one item at three per page needs one page.
- [ ] `page_count([], 3)` returns `0`: an empty list needs no pages.
- [ ] A shorter final page counts as a page: for every list and page size above, `page_count(items, size)` equals `len(paginate(items, size))`.
- [ ] `page_count([1], 0)` and `page_count([1], -3)` raise `ValueError`, exactly as `paginate` rejects a page size below one; an empty list with a page size below one is rejected too. (assumption: the rejection does not depend on the list being non-empty)
- [ ] `page_count` lives in `python/src/pager/__init__.py` beside `paginate`, and its behaviour is covered by new tests in `python/tests/test_pager.py`.
- [ ] `paginate` and the command-line tool are unchanged: every existing test in `python/tests/test_pager.py` keeps passing, and `make check` and `make test` pass.

## Write set

python/src/pager/__init__.py
python/tests/test_pager.py
nunnarivu/wp-4/

## Evidence

type: logic

import subprocess
import sys

import pytest

from pager import paginate
from pager.cli import main


def test_full_pages():
    assert paginate([1, 2, 3, 4], 2) == [[1, 2], [3, 4]]


def test_empty_input():
    assert paginate([], 3) == []


def test_size_must_be_positive():
    with pytest.raises(ValueError):
        paginate([1], 0)


def test_last_partial_page_is_kept():
    assert paginate([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]


def test_single_item_smaller_than_page_gives_one_page():
    assert paginate([1], 3) == [[1]]


def test_cli_prints_all_five_lines_as_three_pages():
    result = subprocess.run(
        [sys.executable, "-m", "pager", "--size", "2"],
        input="a\nb\nc\nd\ne\n",
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert result.stdout == "a\nb\n\nc\nd\n\ne\n"


def test_cli_prints_three_lines_as_two_pages_with_nothing_on_stderr():
    result = subprocess.run(
        [sys.executable, "-m", "pager", "--size", "2"],
        input="a\nb\nc\n",
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert result.stdout == "a\nb\n\nc\n"
    assert result.stderr == ""


@pytest.mark.parametrize("size", ["0", "-3"])
def test_cli_rejects_non_positive_size_with_status_2(size):
    result = subprocess.run(
        [sys.executable, "-m", "pager", "--size", size],
        input="a\nb\n",
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stdout == ""
    assert "--size must be a positive integer" in result.stderr


def test_cli_invalid_size_is_rejected_before_stdin_is_read(monkeypatch, capsys):
    class UnreadStdin:
        def __iter__(self):
            raise AssertionError("stdin was read before --size was validated")

    monkeypatch.setattr(sys, "stdin", UnreadStdin())
    assert main(["--size", "0"]) == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "--size must be a positive integer" in captured.err


# wp-4: page_count(items, size) reports how many pages paginate would build.
# It is looked up on the module inside each test so a missing function fails
# only these tests, not the import of the whole file.


def _page_count():
    import pager

    return pager.page_count


def test_page_count_is_exported_by_the_pager_package():
    import pager

    assert callable(getattr(pager, "page_count", None))


def test_page_count_five_items_at_two_per_page_needs_three_pages():
    assert _page_count()([1, 2, 3, 4, 5], 2) == 3


def test_page_count_four_items_at_two_per_page_needs_two_pages():
    assert _page_count()([1, 2, 3, 4], 2) == 2


def test_page_count_one_item_at_three_per_page_needs_one_page():
    assert _page_count()([1], 3) == 1


def test_page_count_empty_list_needs_no_pages():
    assert _page_count()([], 3) == 0


def test_page_count_returns_an_int():
    assert type(_page_count()([1, 2, 3], 2)) is int


@pytest.mark.parametrize(
    ("items", "size"),
    [
        ([1, 2, 3, 4, 5], 2),
        ([1, 2, 3, 4], 2),
        ([1], 3),
        ([], 3),
        (list(range(7)), 3),
        (list(range(10)), 1),
    ],
)
def test_page_count_shorter_final_page_counts_matches_paginate(items, size):
    assert _page_count()(items, size) == len(paginate(items, size))


def test_page_count_does_not_build_the_pages():
    class Unsliceable(list):
        def __getitem__(self, key):
            if isinstance(key, slice):
                raise AssertionError("page_count built a page")
            return super().__getitem__(key)

        def __iter__(self):
            raise AssertionError("page_count iterated the items")

    assert _page_count()(Unsliceable([1, 2, 3, 4, 5]), 2) == 3


@pytest.mark.parametrize("size", [0, -3])
def test_page_count_rejects_size_below_one_like_paginate(size):
    with pytest.raises(ValueError):
        _page_count()([1], size)


@pytest.mark.parametrize("size", [0, -3])
def test_page_count_rejects_size_below_one_even_for_an_empty_list(size):
    with pytest.raises(ValueError):
        _page_count()([], size)

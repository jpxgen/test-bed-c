import subprocess
import sys

import pytest

from pager import paginate


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


def test_cli_rejects_size_below_one():
    result = subprocess.run(
        [sys.executable, "-m", "pager", "--size", "0"],
        input="a\nb\n",
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert result.stdout == ""
    assert "--size must be a positive integer" in result.stderr

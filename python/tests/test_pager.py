import pytest

from pager import paginate


def test_full_pages():
    assert paginate([1, 2, 3, 4], 2) == [[1, 2], [3, 4]]


def test_empty_input():
    assert paginate([], 3) == []


def test_size_must_be_positive():
    with pytest.raises(ValueError):
        paginate([1], 0)

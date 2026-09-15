"""Split a sequence into pages."""

from collections.abc import Sequence


def _check_size(size: int) -> None:
    if size < 1:
        raise ValueError("size must be a positive integer")


def paginate(items: Sequence, size: int) -> list[list]:
    """Return ``items`` split into pages of ``size``; the last page may be shorter.

    >>> paginate([1, 2, 3, 4], 2)
    [[1, 2], [3, 4]]
    """
    _check_size(size)
    pages = []
    for start in range(0, len(items), size):
        pages.append(list(items[start : start + size]))
    return pages


def page_count(items: Sequence, size: int) -> int:
    """Return how many pages ``paginate(items, size)`` would build, without building them.

    A shorter final page counts as a page; an empty sequence needs none.

    >>> page_count([1, 2, 3, 4, 5], 2)
    3
    """
    _check_size(size)
    return -(-len(items) // size)

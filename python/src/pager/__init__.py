"""Split a sequence into pages."""

from collections.abc import Sequence


def paginate(items: Sequence, size: int) -> list[list]:
    """Return ``items`` split into pages of ``size``; the last page may be shorter.

    >>> paginate([1, 2, 3, 4], 2)
    [[1, 2], [3, 4]]
    """
    if size < 1:
        raise ValueError("size must be a positive integer")
    pages = []
    for start in range(0, len(items), size):
        pages.append(list(items[start : start + size]))
    return pages

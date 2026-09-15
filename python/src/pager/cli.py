"""``python -m pager --size N``: print stdin's lines in pages separated by blank lines."""

import argparse
import sys
from collections.abc import Sequence

from pager import paginate


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pager", description=__doc__)
    parser.add_argument("--size", type=int, default=10, help="lines per page (default 10)")
    args = parser.parse_args(argv)
    # Rejected before stdin is read, so an invalid size produces no output
    # even when input is piped in, and the caller sees a non-zero status.
    if args.size < 1:
        print("pager: --size must be a positive integer", file=sys.stderr)
        return 2
    lines = [line.rstrip("\n") for line in sys.stdin]
    for index, page in enumerate(paginate(lines, args.size)):
        if index:
            print()
        print("\n".join(page))
    return 0

#!/usr/bin/env python3
"""Replace one template's `collections: [...]` array in the schema-template catalog.

Rewriting a whole vertical by hand means restating the existing array verbatim
just to anchor an edit. This locates the block structurally (brace matching from
`collections: [` inside the template whose `id:` matches) so only the NEW text
has to be supplied.

    python3 scripts/replace-template-collections.py <template-id> <new-body-file>

`<new-body-file>` holds the array ELEMENTS only — no enclosing brackets.
"""

import sys
from pathlib import Path

CATALOG = Path("apps/web/src/server/templates/catalog.ts")


def find_block(src: str, template_id: str) -> tuple[int, int]:
    """Return (start, end) offsets of the collections array body (inside [...])."""
    marker = f'id: "{template_id}",'
    at = src.find(marker)
    if at < 0:
        raise SystemExit(f"template id {template_id!r} not found")
    open_at = src.find("collections: [", at)
    if open_at < 0:
        raise SystemExit(f"no collections array for {template_id!r}")
    i = open_at + len("collections: [")
    depth = 1
    in_str: str | None = None
    escaped = False
    while i < len(src):
        c = src[i]
        if in_str:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == in_str:
                in_str = None
        elif c in "\"'`":
            in_str = c
        elif c in "[{(":
            depth += 1
        elif c in "]})":
            depth -= 1
            if depth == 0:
                return open_at + len("collections: ["), i
        i += 1
    raise SystemExit("unbalanced collections array")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    template_id, body_file = sys.argv[1], Path(sys.argv[2])
    src = CATALOG.read_text()
    start, end = find_block(src, template_id)
    body = body_file.read_text().rstrip("\n")
    CATALOG.write_text(f"{src[:start]}\n{body}\n    {src[end:]}")
    print(f"replaced {template_id}: {end - start} chars -> {len(body)}")


if __name__ == "__main__":
    main()

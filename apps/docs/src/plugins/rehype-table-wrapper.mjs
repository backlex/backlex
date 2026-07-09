/**
 * Wraps every markdown `<table>` in `<div class="table-wrapper">`.
 *
 * A `display: table` box ignores `overflow`, so a table whose min-content width
 * exceeds the prose column has nowhere to scroll and paints over the "On this
 * page" sidebar. The wrapper is the scroll container; the table stays a real
 * table so `width: 100%` still fills the column for narrow tables.
 */
export default function rehypeTableWrapper() {
  return (tree) => {
    const walk = (node) => {
      if (!Array.isArray(node.children)) return;
      for (const child of node.children) walk(child);
      node.children = node.children.map((child) =>
        child.type === "element" && child.tagName === "table"
          ? {
              type: "element",
              tagName: "div",
              // tabindex keeps the scroll region reachable by keyboard.
              properties: { className: ["table-wrapper"], tabindex: 0 },
              children: [child],
            }
          : child,
      );
    };
    walk(tree);
  };
}

/**
 * Kahn topological sort with graceful cycle handling: acyclic nodes come
 * out dependency-first; nodes stuck in a cycle are appended in input order
 * and reported so the caller can warn (a copy loop can still proceed —
 * relation integrity is checked by the final verify, not per row).
 */
export const topoSort = (
  nodes: string[],
  edges: [from: string, to: string][],
): { order: string[]; cyclic: string[] } => {
  const inDegree = new Map<string, number>(nodes.map((n) => [n, 0]));
  const out = new Map<string, string[]>();
  for (const [from, to] of edges) {
    if (!inDegree.has(from) || !inDegree.has(to)) continue;
    out.set(from, [...(out.get(from) ?? []), to]);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => (inDegree.get(n) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const next of out.get(n) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  const placed = new Set(order);
  const cyclic = nodes.filter((n) => !placed.has(n));
  return { order: [...order, ...cyclic], cyclic };
};

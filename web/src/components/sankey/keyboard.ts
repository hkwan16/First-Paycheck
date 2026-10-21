import type { FlowLayout, FlowNode } from './layout';

/*
 * Arrow keys between Sankey nodes. The nodes share one tab stop (a roving
 * tabindex), so the diagram is a single Tab and then:
 *
 *   Up, Down      the node above or below in the same column
 *   Home, End     the first or last node of the column
 *   Right         where the money went: the first band out, else the nearest
 *                 node of the next column
 *   Left          where it came from: the band in, else the nearest node of
 *                 the previous column
 */

const center = (node: FlowNode) => node.y + node.h / 2;

function nearest(column: readonly FlowNode[] | undefined, to: FlowNode): string | null {
  let best: FlowNode | null = null;
  for (const node of column ?? []) {
    if (!best || Math.abs(center(node) - center(to)) < Math.abs(center(best) - center(to))) {
      best = node;
    }
  }
  return best?.id ?? null;
}

/** The node focus moves to for `key`, or null to stay (and let the key do nothing). */
export function nextFocus(layout: FlowLayout, id: string, key: string): string | null {
  const node = layout.nodes.find((n) => n.id === id);
  if (!node) return null;
  const column = layout.columns[node.column];
  const index = column.indexOf(node);

  switch (key) {
    case 'ArrowDown':
      return column[index + 1]?.id ?? null;
    case 'ArrowUp':
      return column[index - 1]?.id ?? null;
    case 'Home':
      return column[0]?.id ?? null;
    case 'End':
      return column.at(-1)?.id ?? null;
    case 'ArrowRight':
      return (
        layout.links.find((l) => l.from === id)?.to ??
        nearest(layout.columns[node.column + 1], node)
      );
    case 'ArrowLeft':
      return (
        layout.links.find((l) => l.to === id)?.from ??
        nearest(layout.columns[node.column - 1], node)
      );
    default:
      return null;
  }
}

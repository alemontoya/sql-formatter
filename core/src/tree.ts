import type { Leaf } from "./trivia.js";

export interface LeafNode {
  kind: "leaf";
  leaf: Leaf;
}

export interface GroupNode {
  kind: "group";
  open: Leaf;
  close: Leaf;
  content: Node[];
}

export type Node = LeafNode | GroupNode;

function isPunct(leaf: Leaf, value: string): boolean {
  return leaf.token.type === "punctuation" && leaf.token.value === value;
}

/** Splits a flat leaf stream into statements at top-level `;` boundaries. */
export function splitStatements(leaves: Leaf[]): { leaves: Leaf[]; hadSemicolon: boolean }[] {
  const statements: { leaves: Leaf[]; hadSemicolon: boolean }[] = [];
  let current: Leaf[] = [];
  let depth = 0;

  for (const leaf of leaves) {
    if (isPunct(leaf, "(")) depth++;
    if (isPunct(leaf, ")")) depth--;

    if (isPunct(leaf, ";") && depth === 0) {
      statements.push({ leaves: current, hadSemicolon: true });
      current = [];
      continue;
    }
    current.push(leaf);
  }
  if (current.length > 0) statements.push({ leaves: current, hadSemicolon: false });

  return statements.filter((s) => s.leaves.length > 0);
}

/** Builds a paren-nesting tree out of a flat leaf stream (one statement's worth). */
export function buildTree(leaves: Leaf[]): Node[] {
  let pos = 0;

  function parseSeq(): Node[] {
    const nodes: Node[] = [];
    while (pos < leaves.length) {
      const leaf = leaves[pos];
      if (isPunct(leaf, "(")) {
        pos++;
        const content = parseSeq();
        const close = leaves[pos]; // ")" — parseSeq returned because it hit one, or ran out
        if (close && isPunct(close, ")")) pos++;
        nodes.push({ kind: "group", open: leaf, close, content });
        continue;
      }
      if (isPunct(leaf, ")")) {
        return nodes; // let the caller consume the ")"
      }
      nodes.push({ kind: "leaf", leaf });
      pos++;
    }
    return nodes;
  }

  return parseSeq();
}

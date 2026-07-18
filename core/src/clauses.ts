import type { Node, LeafNode } from "./tree.js";

export interface Clause {
  keyword: string; // canonical uppercase form, e.g. "GROUP BY", "LEFT JOIN"
  keywordLeaves: LeafNode[];
  body: Node[];
}

// Ordered longest-match-first so e.g. "LEFT OUTER JOIN" is tried before "LEFT JOIN" before "JOIN".
const CLAUSE_STARTERS: string[][] = [
  ["WITH"],
  ["SELECT"],
  ["FROM"],
  ["WHERE"],
  ["GROUP", "BY"],
  ["HAVING"],
  ["ORDER", "BY"],
  ["LIMIT"],
  ["OFFSET"],
  ["LEFT", "OUTER", "JOIN"],
  ["RIGHT", "OUTER", "JOIN"],
  ["FULL", "OUTER", "JOIN"],
  ["LEFT", "JOIN"],
  ["RIGHT", "JOIN"],
  ["FULL", "JOIN"],
  ["INNER", "JOIN"],
  ["CROSS", "JOIN"],
  ["JOIN"],
  ["UNION", "ALL"],
  ["UNION"],
  ["INTERSECT"],
  ["EXCEPT"],
  ["INSERT", "INTO"],
  ["VALUES"],
  ["UPDATE"],
  ["SET"],
  ["DELETE", "FROM"],
  ["DELETE"],
  ["RETURNING"],
].sort((a, b) => b.length - a.length);

function wordAt(nodes: Node[], index: number): string | null {
  const node = nodes[index];
  if (!node || node.kind !== "leaf") return null;
  if (node.leaf.token.type !== "keyword") return null;
  return node.leaf.token.value.toUpperCase();
}

function matchStarterAt(nodes: Node[], index: number): string[] | null {
  for (const starter of CLAUSE_STARTERS) {
    if (starter.every((word, offset) => wordAt(nodes, index + offset) === word)) {
      return starter;
    }
  }
  return null;
}

/**
 * Splits a statement's top-level node sequence into clauses. Anything before
 * the first recognized clause keyword (e.g. `CREATE OR REPLACE TABLE x AS`)
 * becomes its own leading clause, keyed by its first token.
 */
export function splitClauses(nodes: Node[]): Clause[] {
  const clauses: Clause[] = [];
  let i = 0;
  let currentKeyword: string | null = null;
  let currentKeywordLeaves: LeafNode[] = [];
  let currentBody: Node[] = [];

  const flush = () => {
    if (currentKeyword !== null) {
      clauses.push({ keyword: currentKeyword, keywordLeaves: currentKeywordLeaves, body: currentBody });
    } else if (currentBody.length > 0) {
      // No clause keyword ever matched (e.g. bare "CREATE ... AS" prefix) —
      // print as a single header line with no separate keyword/body split.
      clauses.push({ keyword: "", keywordLeaves: [], body: currentBody });
    }
    currentBody = [];
  };

  while (i < nodes.length) {
    const starter = matchStarterAt(nodes, i);
    if (starter) {
      flush();
      currentKeyword = starter.join(" ");
      currentKeywordLeaves = starter.map((_, offset) => nodes[i + offset] as LeafNode);
      i += starter.length;
      continue;
    }
    currentBody.push(nodes[i]);
    i++;
  }
  flush();

  return clauses;
}

import { tokenize } from "./tokenizer.js";
import { attachTrivia, type Leaf } from "./trivia.js";
import { splitStatements, buildTree, type Node, type GroupNode, type LeafNode } from "./tree.js";
import { splitClauses, type Clause } from "./clauses.js";
import { isKeywordLeaf, isSubqueryGroup, splitTopLevelCommas } from "./printer.js";
import { format } from "./format.js";
import type { StyleTemplate } from "./style-template.js";

export interface TableColumnStats {
  distinctCount?: number;
  nullFraction?: number;
  indexed?: boolean;
}

export interface TableStats {
  id: string;
  /** Free-form label for where these stats came from (e.g. "postgres",
   * "redshift", "snowflake-prod"). Purely descriptive — advise() never
   * branches on it — so deliberately not constrained to StyleTemplate's
   * Dialect union, which is a separately locked-in, narrower decision
   * about which dialects the *formatter* targets. */
  dialect: string;
  collectedAt: string;
  tables: Record<string, { rowCount: number; columns?: Record<string, TableColumnStats> }>;
}

export type SuggestionKind = "duplicate-subquery-cte" | "join-order" | "unindexed-column";

export interface Suggestion {
  kind: SuggestionKind;
  statementIndex: number;
  message: string;
  /** A full rewritten statement showing the suggestion applied. Only ever
   * set when the rewrite is mechanically provable as equivalent to the
   * original (see HANDOFF.md) — never a guess, never present for
   * suggestions this module can't prove safe to render. */
  preview?: string;
}

export interface AdviseResult {
  suggestions: Suggestion[];
}

/**
 * Heuristic, structural query advisor — NOT a cost-based optimizer. It never
 * connects to a database; `stats` is a hand-populated snapshot the caller
 * supplies (see schema/table-stats.schema.json). Every suggestion is
 * advisory text; a `preview` is only attached when the rewrite it describes
 * is mechanically guaranteed equivalent to the original, not merely likely
 * faster — see the per-suggestion functions below for exactly which cases
 * qualify and which deliberately don't.
 */
export function advise(sql: string, stats: TableStats | null, template: StyleTemplate): AdviseResult {
  const tokens = tokenize(sql);
  const { leaves } = attachTrivia(tokens);
  const statements = splitStatements(leaves);
  const suggestions: Suggestion[] = [];

  statements.forEach((stmt, i) => {
    if (stmt.leaves.length === 0) return;
    const tree = buildTree(stmt.leaves);
    const clauses = splitClauses(tree);
    const stmtStart = stmt.leaves[0].token.start;
    const stmtEnd = stmt.leaves[stmt.leaves.length - 1].token.end;
    const stmtText = sql.slice(stmtStart, stmtEnd);

    // Real analytical SQL is often CTE-heavy, with the actual FROM/JOIN
    // chains living inside each CTE's own body rather than at the
    // statement's top level — recurse one level into WITH so those are
    // still analyzed. Deliberately not recursing further (a CTE nested
    // inside another CTE, or a scalar/derived-table subquery elsewhere) —
    // one level covers the common case without open-ended recursion.
    const scopes: Clause[][] = [clauses];
    const withClause = clauses.find((c) => c.keyword === "WITH");
    if (withClause) {
      for (const body of extractCteBodies(withClause.body)) {
        scopes.push(splitClauses(body));
      }
    }

    for (const scopeClauses of scopes) {
      suggestions.push(...adviseDuplicateSubqueries(stmtText, stmtStart, scopeClauses, i, template));
      if (stats) suggestions.push(...adviseJoinChain(stmtText, stmtStart, scopeClauses, i, stats, template));
    }
  });

  return { suggestions };
}

// ---------------------------------------------------------------------------
// Shared node helpers (small, deliberately duplicated from printer.ts rather
// than exported further — same precedent as infer.ts's own isSubqueryGroup).

function firstLeaf(node: Node): Leaf {
  return node.kind === "leaf" ? node.leaf : firstLeaf(node.content[0]);
}

function lastLeaf(node: Node): Leaf {
  return node.kind === "leaf" ? node.leaf : lastLeaf(node.content[node.content.length - 1]);
}

function isDot(node: Node | undefined): boolean {
  return !!node && node.kind === "leaf" && node.leaf.token.type === "punctuation" && node.leaf.token.value === ".";
}

function isComma(node: Node | undefined): boolean {
  return !!node && node.kind === "leaf" && node.leaf.token.type === "punctuation" && node.leaf.token.value === ",";
}

interface ResolvedTableRef {
  /** Unqualified table name, or null when this ref is a derived-table subquery. */
  tableName: string | null;
  alias: string;
  subqueryGroup: GroupNode | null;
}

/** Reads a FROM/JOIN clause body's table-ref portion (everything before ON,
 * or the whole body for FROM/CROSS JOIN) into a table name + alias. Handles
 * `schema.table`, `table AS alias`, `table alias`, and `(SELECT ...) alias`. */
function resolveTableRef(tableRef: Node[]): ResolvedTableRef {
  const first = tableRef[0];
  if (first && first.kind === "group" && isSubqueryGroup(first)) {
    const rest = tableRef.slice(1).filter((n) => !isKeywordLeaf(n, "AS"));
    const aliasLeaf = rest[0];
    const alias = aliasLeaf && aliasLeaf.kind === "leaf" ? aliasLeaf.leaf.token.value : "";
    return { tableName: null, alias, subqueryGroup: first };
  }

  // A qualified name is identifier ("." identifier)* — consuming any bare
  // run of identifiers here would swallow a no-AS alias (`orders o`) into
  // the name itself, so a dot must separate each additional segment.
  let i = 0;
  const nameParts: string[] = [];
  if (first && first.kind === "leaf" && (first.leaf.token.type === "identifier" || first.leaf.token.type === "quotedIdentifier")) {
    nameParts.push(first.leaf.token.value);
    i = 1;
    while (isDot(tableRef[i])) {
      const next = tableRef[i + 1];
      if (!next || next.kind !== "leaf" || (next.leaf.token.type !== "identifier" && next.leaf.token.type !== "quotedIdentifier")) break;
      nameParts.push(next.leaf.token.value);
      i += 2;
    }
  }
  const unqualified = nameParts[nameParts.length - 1] ?? "";

  const rest = tableRef.slice(i).filter((n) => !isKeywordLeaf(n, "AS"));
  const aliasLeaf = rest[0];
  const alias = aliasLeaf && aliasLeaf.kind === "leaf" ? aliasLeaf.leaf.token.value : unqualified;
  return { tableName: unqualified || null, alias, subqueryGroup: null };
}

/** Splits a WITH clause's body into each CTE's own inner node sequence
 * (the content of `name [(cols)] AS ( ... )`), skipping a leading
 * RECURSIVE keyword. Mirrors printer.ts's printCtes splitting. */
function extractCteBodies(withClauseBody: Node[]): Node[][] {
  const nodes = withClauseBody[0] && isKeywordLeaf(withClauseBody[0], "RECURSIVE") ? withClauseBody.slice(1) : withClauseBody;
  const bodies: Node[][] = [];
  for (const item of splitTopLevelCommas(nodes)) {
    const group = item.find((n): n is GroupNode => n.kind === "group" && isSubqueryGroup(n));
    if (group) bodies.push(group.content);
  }
  return bodies;
}

function splitJoinBody(body: Node[]): { tableRef: Node[]; onNodes: Node[] | null } {
  const onIdx = body.findIndex((n) => isKeywordLeaf(n, "ON"));
  if (onIdx === -1) return { tableRef: body, onNodes: null };
  return { tableRef: body.slice(0, onIdx), onNodes: body.slice(onIdx + 1) };
}

/** The set of `alias.` qualifiers referenced anywhere in a node sequence,
 * recursing into nested groups (parenthesized sub-expressions). */
function referencedAliases(nodes: Node[]): Set<string> {
  const found = new Set<string>();
  const walk = (ns: Node[]) => {
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      if (n.kind === "leaf" && (n.leaf.token.type === "identifier" || n.leaf.token.type === "quotedIdentifier") && isDot(ns[i + 1])) {
        found.add(n.leaf.token.value);
      }
      if (n.kind === "group") walk(n.content);
    }
  };
  walk(nodes);
  return found;
}

// ---------------------------------------------------------------------------
// Duplicate FROM/JOIN subquery -> CTE extraction

function canonicalize(nodes: Node[]): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.kind === "leaf") {
      const t = n.leaf.token;
      parts.push(t.type + ":" + (t.type === "keyword" ? t.value.toUpperCase() : t.value));
    } else {
      parts.push("(");
      n.content.forEach(walk);
      parts.push(")");
    }
  };
  nodes.forEach(walk);
  return parts.join(" ");
}

interface DerivedTableRef {
  clause: Clause;
  ref: ResolvedTableRef;
  tableRefNodes: Node[];
}

/** Only considers FROM/JOIN-level derived tables (`FROM (SELECT ...) x`) —
 * deliberately not scalar subqueries in SELECT/WHERE, which would need a
 * different, riskier substitution to extract. A single-clause slice at a
 * time keeps every candidate mutually independent and top-level, which is
 * what makes the preview splice below safe to generate mechanically. */
function findDerivedTables(clauses: Clause[]): DerivedTableRef[] {
  const out: DerivedTableRef[] = [];
  for (const clause of clauses) {
    if (clause.keyword !== "FROM" && !clause.keyword.endsWith("JOIN")) continue;
    if (clause.body.some(isComma)) continue; // old-style comma join — not handled in v1
    const { tableRef } = splitJoinBody(clause.body);
    const ref = resolveTableRef(tableRef);
    if (ref.subqueryGroup) out.push({ clause, ref, tableRefNodes: tableRef });
  }
  return out;
}

function adviseDuplicateSubqueries(
  stmtText: string,
  stmtStart: number,
  clauses: Clause[],
  stmtIndex: number,
  template: StyleTemplate,
): Suggestion[] {
  const derived = findDerivedTables(clauses);
  if (derived.length < 2) return [];

  const bySignature = new Map<string, DerivedTableRef[]>();
  for (const d of derived) {
    const sig = canonicalize(d.ref.subqueryGroup!.content);
    if (sig.length < 40) continue; // too trivial to bother extracting
    (bySignature.get(sig) ?? bySignature.set(sig, []).get(sig)!).push(d);
  }

  const hasExistingWith = clauses.some((c) => c.keyword === "WITH");
  const suggestions: Suggestion[] = [];

  for (const [, group] of bySignature) {
    if (group.length < 2) continue;

    const message = `The same subquery appears ${group.length} times in this statement — consider extracting it into a CTE so it's defined once.`;

    if (hasExistingWith) {
      suggestions.push({
        kind: "duplicate-subquery-cte",
        statementIndex: stmtIndex,
        message: message + " (No preview: this statement already has a WITH clause — merging a new CTE into it isn't attempted automatically.)",
      });
      continue;
    }

    const aliases = new Set(group.map((d) => d.ref.alias.toLowerCase()).filter(Boolean));
    const cteName = aliases.size === 1 ? [...aliases][0]! : "extracted_cte";
    // The group's own open/close parens are excluded here since the CTE's
    // `AS (...)` supplies a fresh pair around it below.
    const subqueryText = (g: DerivedTableRef) => {
      const grp = g.ref.subqueryGroup!;
      return stmtText.slice(grp.open.token.end - stmtStart, grp.close.token.start - stmtStart);
    };

    // Replace back-to-front so earlier offsets stay valid across edits.
    const replacements = group
      .map((d) => ({
        start: d.ref.subqueryGroup!.open.token.start - stmtStart,
        end: d.ref.subqueryGroup!.close.token.end - stmtStart,
      }))
      .sort((a, b) => b.start - a.start);

    let rewritten = stmtText;
    for (const r of replacements) {
      rewritten = rewritten.slice(0, r.start) + cteName + rewritten.slice(r.end);
    }
    const previewSql = `WITH ${cteName} AS (\n${subqueryText(group[0]!)}\n)\n${rewritten}`;

    let preview: string | undefined;
    try {
      preview = format(previewSql, template);
    } catch {
      preview = undefined; // if the splice somehow produced unparseable SQL, fall back to text-only
    }

    suggestions.push({ kind: "duplicate-subquery-cte", statementIndex: stmtIndex, message, preview });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Join-order suggestions (INNER JOIN chains only) + unindexed-column flags

interface JoinChainNode {
  alias: string;
  tableName: string;
  rowCount: number;
  joinKeyword: string;
  tableRefText: string;
  onText: string;
  dependsOn: string;
}

function adviseJoinChain(
  stmtText: string,
  stmtStart: number,
  clauses: Clause[],
  stmtIndex: number,
  stats: TableStats,
  template: StyleTemplate,
): Suggestion[] {
  const fromIdx = clauses.findIndex((c) => c.keyword === "FROM");
  if (fromIdx === -1) return [];
  const fromClause = clauses[fromIdx]!;
  if (fromClause.body.some(isComma)) return []; // old-style comma join — not handled in v1

  const base = resolveTableRef(fromClause.body);
  const aliasToTable = new Map<string, string>();
  if (base.tableName) aliasToTable.set(base.alias, base.tableName);

  const joinClauses: Clause[] = [];
  for (let i = fromIdx + 1; i < clauses.length; i++) {
    if (!clauses[i]!.keyword.endsWith("JOIN")) break;
    joinClauses.push(clauses[i]!);
  }

  const chainNodes: JoinChainNode[] = [];
  let chainIsReorderable = joinClauses.length > 0 && !!base.tableName && stats.tables[base.tableName] !== undefined;

  for (const clause of joinClauses) {
    const { tableRef, onNodes } = splitJoinBody(clause.body);
    const ref = resolveTableRef(tableRef);
    if (ref.tableName) aliasToTable.set(ref.alias, ref.tableName);

    if (!chainIsReorderable) continue; // still worth walking, for the alias map used by the unindexed-column pass below
    if (clause.keyword !== "JOIN" && clause.keyword !== "INNER JOIN") {
      chainIsReorderable = false;
      continue;
    }
    if (!onNodes || onNodes.length === 0) {
      chainIsReorderable = false;
      continue;
    }
    if (!ref.tableName || stats.tables[ref.tableName] === undefined) {
      chainIsReorderable = false;
      continue;
    }
    const otherAliases = [...referencedAliases(onNodes)].filter((a) => a !== ref.alias);
    if (otherAliases.length !== 1) {
      chainIsReorderable = false; // ambiguous or multi-table ON condition — not safe to reason about generically
      continue;
    }
    chainNodes.push({
      alias: ref.alias,
      tableName: ref.tableName,
      rowCount: stats.tables[ref.tableName]!.rowCount,
      joinKeyword: clause.keyword,
      tableRefText: stmtText.slice(
        firstLeaf(tableRef[0]!).token.start - stmtStart,
        lastLeaf(tableRef[tableRef.length - 1]!).token.end - stmtStart,
      ),
      onText: stmtText.slice(firstLeaf(onNodes[0]!).token.start - stmtStart, lastLeaf(onNodes[onNodes.length - 1]!).token.end - stmtStart),
      dependsOn: otherAliases[0]!,
    });
  }

  const suggestions: Suggestion[] = [];

  if (chainIsReorderable && chainNodes.length === joinClauses.length) {
    const reordered = greedyTopologicalOrder(base.alias, chainNodes);
    if (reordered && !sameOrder(reordered, chainNodes)) {
      const baseText = stmtText.slice(
        firstLeaf(fromClause.body[0]!).token.start - stmtStart,
        lastLeaf(fromClause.body[fromClause.body.length - 1]!).token.end - stmtStart,
      );
      const chainStart = fromClause.keywordLeaves[0]!.leaf.token.start - stmtStart;
      const lastJoin = joinClauses[joinClauses.length - 1]!;
      const chainEnd = lastLeaf(lastJoin.body[lastJoin.body.length - 1]!).token.end - stmtStart;

      const newChainText =
        `FROM ${baseText}\n` + reordered.map((n) => `${n.joinKeyword} ${n.tableRefText} ON ${n.onText}`).join("\n");
      const previewSql = stmtText.slice(0, chainStart) + newChainText + stmtText.slice(chainEnd);

      let preview: string | undefined;
      try {
        preview = format(previewSql, template);
      } catch {
        preview = undefined;
      }

      const order = [base.tableName, ...reordered.map((n) => n.tableName)].join(" -> ");
      suggestions.push({
        kind: "join-order",
        statementIndex: stmtIndex,
        message: `Based on the row counts in your stats, joining in this order (smallest-first among tables that can validly move) may reduce work: ${order}. This is a naive size heuristic, not a real cost estimate — it ignores selectivity, indexes, and the actual query plan.`,
        preview,
      });
    }
  }

  suggestions.push(...adviseUnindexedColumns(clauses, aliasToTable, stats, stmtIndex));
  return suggestions;
}

/** Repeatedly picks the smallest not-yet-introduced table whose dependency
 * is already satisfied. Only ever produces a valid (dependency-respecting)
 * order — there's no separate "check if this is safe" step needed because
 * an order that violates a dependency is structurally impossible to produce
 * here. Returns null if the join graph is disconnected from the base (a
 * table's dependency never becomes satisfied) rather than reordering only
 * part of the chain. */
function greedyTopologicalOrder(baseAlias: string, nodes: JoinChainNode[]): JoinChainNode[] | null {
  const introduced = new Set([baseAlias]);
  const remaining = [...nodes];
  const order: JoinChainNode[] = [];

  while (remaining.length > 0) {
    const candidates = remaining.filter((n) => introduced.has(n.dependsOn));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.rowCount - b.rowCount);
    const next = candidates[0]!;
    order.push(next);
    introduced.add(next.alias);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return order;
}

function sameOrder(a: JoinChainNode[], b: JoinChainNode[]): boolean {
  return a.length === b.length && a.every((n, i) => n.alias === b[i]!.alias);
}

function adviseUnindexedColumns(
  clauses: Clause[],
  aliasToTable: Map<string, string>,
  stats: TableStats,
  stmtIndex: number,
): Suggestion[] {
  const flagged = new Set<string>();
  const suggestions: Suggestion[] = [];

  const walk = (nodes: Node[]) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (
        n.kind === "leaf" &&
        (n.leaf.token.type === "identifier" || n.leaf.token.type === "quotedIdentifier") &&
        isDot(nodes[i + 1]) &&
        nodes[i + 2]?.kind === "leaf"
      ) {
        const alias = n.leaf.token.value;
        const columnNode = nodes[i + 2] as LeafNode;
        const column = columnNode.leaf.token.value;
        const tableName = aliasToTable.get(alias);
        const colStats = tableName ? stats.tables[tableName]?.columns?.[column] : undefined;
        if (tableName && colStats?.indexed === false) {
          const key = `${tableName}.${column}`;
          if (!flagged.has(key)) {
            flagged.add(key);
            suggestions.push({
              kind: "unindexed-column",
              statementIndex: stmtIndex,
              message: `${tableName}.${column} is used in a JOIN/WHERE condition but your stats mark it as not indexed — this can force a full table scan.`,
            });
          }
        }
      }
      if (n.kind === "group") walk(n.content);
    }
  };

  for (const clause of clauses) {
    if (clause.keyword === "WHERE" || clause.keyword === "HAVING" || clause.keyword.endsWith("JOIN")) walk(clause.body);
  }

  return suggestions;
}

import type { Leaf } from "./trivia.js";
import type { Node, GroupNode, LeafNode } from "./tree.js";
import type { Clause } from "./clauses.js";
import { splitClauses } from "./clauses.js";
import { applyCasing, type StyleTemplate } from "./style-template.js";

/** In "keywordAlign" ("river style") layout, clause keywords within a
 * statement/subquery scope are right-padded so their first word's last
 * character lines up in a shared column (`keywordEndCol`), and everything
 * nested underneath (list items, wrapped conditions, CASE blocks) is rooted
 * at the column right after that (`keywordEndCol + 2`) instead of at
 * `level * indentSize` from zero. `baseLevel` is the `level` at which that
 * rooted column applies; deeper levels add `indentSize` per level on top of
 * it, same as indent mode does from zero. */
interface Ctx {
  style: StyleTemplate["style"];
  align?: { baseLevel: number; keywordEndCol: number };
}

const NO_SPACE_BEFORE = new Set([",", ")", ";", ".", "::", ":", "]"]);
const NO_SPACE_AFTER = new Set(["(", ".", "::", ":", "["]);

function indentUnit(ctx: Ctx): string {
  return ctx.style.indentation.char === "tab" ? "\t" : " ".repeat(ctx.style.indentation.size);
}

function indentStr(ctx: Ctx, level: number): string {
  if (ctx.align) {
    const contentCol = ctx.align.keywordEndCol + 2;
    const col = contentCol + (level - ctx.align.baseLevel) * ctx.style.indentation.size;
    return " ".repeat(Math.max(0, col));
  }
  return indentUnit(ctx).repeat(Math.max(0, level));
}

/** The word a keyword-family alignment column is computed from — e.g.
 * "GROUP" for "GROUP BY", "LEFT" for "LEFT JOIN". Only this first word is
 * right-aligned; a second word (BY, JOIN, ...) just follows with one space,
 * unaligned — this is what the real river-style examples this layout is
 * modeled on actually do (verified against 4 real fixtures). */
export function firstWord(keyword: string): string {
  return keyword.split(" ")[0] ?? keyword;
}

/** The reference word a clause borrows its alignment width from. JOIN
 * variants (LEFT JOIN, CROSS JOIN, ...) and GROUP BY/HAVING/ORDER BY don't
 * right-align their *own* first word — they share FROM's/WHERE's width
 * regardless of their own length (verified: a real fixture aligns
 * "CROSS JOIN" to the same column as "FROM", not to "CROSS"'s own length). */
export function canonicalFamilyWord(keyword: string): string {
  if (keyword.endsWith("JOIN")) return "FROM";
  if (keyword === "GROUP BY" || keyword === "HAVING" || keyword === "ORDER BY") return "WHERE";
  return firstWord(keyword);
}

/** Left-padding so `keyword`'s alignment reference word ends exactly at `keywordEndCol`. */
function familyPad(keywordEndCol: number, keyword: string): string {
  return " ".repeat(Math.max(0, keywordEndCol - canonicalFamilyWord(keyword).length + 1));
}

function firstLeaf(node: Node): Leaf {
  return node.kind === "leaf" ? node.leaf : firstLeaf(node.content[0] ?? { kind: "leaf", leaf: node.open }) ?? node.open;
}

function lastLeaf(node: Node): Leaf {
  if (node.kind === "leaf") return node.leaf;
  return node.close ?? (node.content.length ? lastLeaf(node.content[node.content.length - 1]) : node.open);
}

/** The last leaf of an entire statement's top-level node sequence, or
 * `null` for an empty statement. Exported for `format.ts`, which needs to
 * know whether the statement's last leaf carries a same-line trailing
 * `lineComment` before deciding where a synthesized `;` can safely go —
 * appending it directly after a line comment would put it *inside* that
 * comment's text instead of terminating the statement. */
export function lastLeafOfStatement(nodes: Node[]): Leaf | null {
  const last = nodes[nodes.length - 1];
  return last ? lastLeaf(last) : null;
}

function isKeywordLeaf(node: Node | undefined, word: string): boolean {
  return (
    !!node &&
    node.kind === "leaf" &&
    node.leaf.token.type === "keyword" &&
    node.leaf.token.value.toUpperCase() === word
  );
}

/** A small string builder that tracks spacing/line-start state for inline sequences. */
class Builder {
  out = "";
  private atLineStart = true;
  private lastRaw: string | null = null;
  private forceNoSpaceNext = false;

  text(value: string, noSpace = false) {
    const skip = noSpace || this.forceNoSpaceNext;
    this.forceNoSpaceNext = false;
    if (this.out.length > 0 && !this.atLineStart && !skip) this.out += " ";
    this.out += value;
    this.atLineStart = false;
    this.lastRaw = value;
  }

  spaceAwareText(value: string) {
    const noSpace = this.lastRaw !== null && NO_SPACE_AFTER.has(this.lastRaw);
    this.text(value, noSpace || NO_SPACE_BEFORE.has(value));
  }

  /** Suppresses the space before the very next piece of text (e.g. a unary sign's operand). */
  suppressNextSpace() {
    this.forceNoSpaceNext = true;
  }

  newline(ctx: Ctx, level: number) {
    this.out += "\n" + indentStr(ctx, level);
    this.atLineStart = true;
    this.lastRaw = null;
  }

  raw(value: string) {
    this.out += value;
    this.atLineStart = value.endsWith("\n");
    this.lastRaw = null;
  }
}

function renderLeafText(leaf: Leaf, kind: "keyword" | "function" | "type" | "identifier" | "raw", ctx: Ctx): string {
  const { token } = leaf;
  switch (kind) {
    case "keyword":
      return applyCasing(token.value, ctx.style.casing.keywords);
    case "function":
      return applyCasing(token.value, ctx.style.casing.functions);
    case "type":
      return applyCasing(token.value, ctx.style.casing.types);
    case "identifier":
      return applyCasing(token.value, ctx.style.casing.identifiers);
    default:
      return token.value;
  }
}

/**
 * `nodes` is the leaf/group sequence a single leaf is classified against —
 * usually a clause's body, which has already had its leading keyword(s)
 * (e.g. "INSERT INTO") split off by `splitClauses`. `bodyStartsAtTableRef`
 * tells classifyLeaf that `nodes[0]`, if present, sits in table-ref position
 * (right after a keyword like INTO/TABLE that was split off) so a
 * `name (columns)` at index 0 is a table name + column list, not a function
 * call — the two are indistinguishable from the node sequence alone.
 */
export function classifyLeaf(
  nodes: Node[],
  idx: number,
  bodyStartsAtTableRef = false,
): "keyword" | "function" | "type" | "identifier" | "raw" {
  const node = nodes[idx];
  if (node.kind !== "leaf") return "raw";
  const { token } = node.leaf;
  if (token.type === "keyword") return "keyword";
  if (token.type !== "identifier") return "raw";

  const prev = nodes[idx - 1];
  if (prev && prev.kind === "leaf" && prev.leaf.token.type === "operator" && prev.leaf.token.value === "::") {
    return "type";
  }
  const next = nodes[idx + 1];
  if (next && next.kind === "group" && !isTableRefPosition(nodes, idx, bodyStartsAtTableRef)) return "function";
  return "identifier";
}

/** True when the identifier at `idx` is a table name immediately followed by
 * a parenthesized column list — e.g. `INSERT INTO t (a)` or
 * `CREATE TABLE t (a int)` — which looks identical in the token tree to a
 * function call but must keep `casing.identifiers`, not `casing.functions`.
 * Handles two shapes: the INTO/TABLE keyword still sitting in `nodes` right
 * before `idx` (e.g. bare "CREATE TABLE ..." prefixes, which aren't a
 * recognized clause and keep their keywords inline), and the INTO/TABLE
 * keyword having already been split off by `splitClauses` so `idx === 0` is
 * the clause body's first node (signaled by `bodyStartsAtTableRef`). */
function isTableRefPosition(nodes: Node[], idx: number, bodyStartsAtTableRef: boolean): boolean {
  if (idx === 0 && bodyStartsAtTableRef) return true;
  const prev = nodes[idx - 1];
  if (!prev || prev.kind !== "leaf" || prev.leaf.token.type !== "keyword") return false;
  const keyword = prev.leaf.token.value.toUpperCase();
  return keyword === "INTO" || keyword === "TABLE";
}

const BINARY_TRIGGER_TYPES = new Set(["identifier", "quotedIdentifier", "number", "string"]);

/** A `-`/`+` is a unary sign (no space before its operand) unless it directly
 * follows a value it could be subtracting/adding from (an identifier,
 * number, string, or a parenthesized group). */
function isUnarySign(nodes: Node[], idx: number): boolean {
  const node = nodes[idx];
  if (node.kind !== "leaf") return false;
  const { token } = node.leaf;
  if (token.type !== "operator" || (token.value !== "-" && token.value !== "+")) return false;
  const prev = nodes[idx - 1];
  if (!prev) return true;
  if (prev.kind === "group") return false;
  return !BINARY_TRIGGER_TYPES.has(prev.leaf.token.type);
}

/** A `[` is array-indexing (glued to what came before, e.g. `arr[0]`) when it
 * directly follows a value/group/closing-bracket. Otherwise (after a keyword,
 * comma, or nothing) it's the start of something else — e.g. a SQLite
 * bracket-quoted identifier, `SELECT [col1], [col2]` — and keeps normal
 * spacing. */
function isIndexBracket(nodes: Node[], idx: number): boolean {
  const node = nodes[idx];
  if (node.kind !== "leaf" || node.leaf.token.value !== "[") return false;
  const prev = nodes[idx - 1];
  if (!prev) return false;
  if (prev.kind === "group") return true;
  if (BINARY_TRIGGER_TYPES.has(prev.leaf.token.type)) return true;
  return prev.leaf.token.type === "operator" && prev.leaf.token.value === "]";
}

function printComments(b: Builder, ctx: Ctx, comments: Token_[], level: number) {
  for (const c of comments) {
    if (b.out.length > 0) b.newline(ctx, level);
    b.raw(c.value);
  }
}

type Token_ = Leaf["leadingComments"][number];

/**
 * Prints a flat node sequence inline (no clause-level line breaks), except
 * for CASE/WHEN/END blocks, which always break onto multiple lines since
 * that's the only way they stay readable.
 */
function printSeq(nodes: Node[], level: number, ctx: Ctx, bodyStartsAtTableRef = false): string {
  const b = new Builder();

  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    const leading = firstLeaf(node).leadingComments;
    if (leading.length > 0) {
      for (const c of leading) {
        if (b.out.length > 0) b.newline(ctx, level);
        b.raw(c.value);
      }
      b.newline(ctx, level);
    }

    if (isKeywordLeaf(node, "CASE")) {
      let depth = 1;
      let j = idx + 1;
      while (j < nodes.length && depth > 0) {
        if (isKeywordLeaf(nodes[j], "CASE")) depth++;
        else if (isKeywordLeaf(nodes[j], "END")) depth--;
        if (depth > 0) j++;
      }
      const endIdx = Math.min(j, nodes.length - 1);
      const inner = nodes.slice(idx + 1, endIdx);
      b.text(printCaseBlock(inner, level, ctx));
      idx = endIdx;
      const endLeaf = nodes[idx];
      const trailing = endLeaf ? lastLeaf(endLeaf).trailingComment : null;
      if (trailing) b.text(trailing.value);
      continue;
    }

    if (node.kind === "group") {
      const isCallArgs = idx > 0 && classifyLeaf(nodes, idx - 1, bodyStartsAtTableRef) === "function";
      // keywordAlign mode structurally requires "(" glued to the subquery's
      // first keyword (the family-alignment column is computed from its
      // position) — subqueryOpenParenSameLine is ignored there entirely,
      // same as printGroup's own keywordAlign branch below.
      if (
        isSubqueryGroup(node) &&
        ctx.style.layout.mode !== "keywordAlign" &&
        !ctx.style.parentheses.subqueryOpenParenSameLine
      ) {
        b.newline(ctx, level);
        b.raw(printGroup(node, level, ctx));
      } else {
        b.text(printGroup(node, level, ctx), isCallArgs);
      }
      const trailing = node.close.trailingComment;
      if (trailing) b.text(trailing.value);
      continue;
    }

    const kind = classifyLeaf(nodes, idx, bodyStartsAtTableRef);
    const text = renderLeafText(node.leaf, kind, ctx);
    if (isIndexBracket(nodes, idx)) {
      b.text(text, true);
    } else {
      b.spaceAwareText(text);
    }
    if (isUnarySign(nodes, idx)) b.suppressNextSpace();
    if (node.leaf.trailingComment) b.text(node.leaf.trailingComment.value);
  }

  return b.out;
}

function printCaseBlock(inner: Node[], level: number, ctx: Ctx): string {
  // Split `inner` into WHEN/THEN branches (+ optional ELSE), only at depth 0
  // relative to this CASE (nested CASE...END spans are skipped over).
  type Branch = { keywordLeaf: Leaf; when: Node[]; then: Node[] } | { keywordLeaf: Leaf; elseResult: Node[] };
  const branches: Branch[] = [];
  let depth = 0;
  let i = 0;

  while (i < inner.length) {
    if (isKeywordLeaf(inner[i], "CASE")) depth++;
    if (isKeywordLeaf(inner[i], "END")) depth--;

    if (depth === 0 && isKeywordLeaf(inner[i], "WHEN")) {
      let j = i + 1;
      let d = 0;
      while (j < inner.length && !(d === 0 && isKeywordLeaf(inner[j], "THEN"))) {
        if (isKeywordLeaf(inner[j], "CASE")) d++;
        if (isKeywordLeaf(inner[j], "END")) d--;
        j++;
      }
      const when = inner.slice(i + 1, j);
      let k = j + 1;
      let d2 = 0;
      while (
        k < inner.length &&
        !(d2 === 0 && (isKeywordLeaf(inner[k], "WHEN") || isKeywordLeaf(inner[k], "ELSE")))
      ) {
        if (isKeywordLeaf(inner[k], "CASE")) d2++;
        if (isKeywordLeaf(inner[k], "END")) d2--;
        k++;
      }
      const then = inner.slice(j + 1, k);
      branches.push({ keywordLeaf: (inner[i] as LeafNode).leaf, when, then });
      i = k;
      continue;
    }

    if (depth === 0 && isKeywordLeaf(inner[i], "ELSE")) {
      const keywordLeaf = (inner[i] as LeafNode).leaf;
      let k = i + 1;
      while (k < inner.length) k++;
      branches.push({ keywordLeaf, elseResult: inner.slice(i + 1, k) });
      i = k;
      continue;
    }

    i++;
  }

  const b = new Builder();
  b.raw(applyCasing("CASE", ctx.style.casing.keywords));
  for (const branch of branches) {
    b.newline(ctx, level + 1);
    for (const c of branch.keywordLeaf.leadingComments) {
      b.raw(c.value);
      b.newline(ctx, level + 1);
    }
    if ("elseResult" in branch) {
      b.raw(applyCasing("ELSE", ctx.style.casing.keywords) + " " + printSeq(branch.elseResult, level + 1, ctx));
    } else {
      b.raw(
        applyCasing("WHEN", ctx.style.casing.keywords) +
          " " +
          printSeq(branch.when, level + 1, ctx) +
          " " +
          applyCasing("THEN", ctx.style.casing.keywords) +
          " " +
          printSeq(branch.then, level + 1, ctx)
      );
    }
  }
  b.newline(ctx, level);
  b.raw(applyCasing("END", ctx.style.casing.keywords));
  return b.out;
}

/** Splits a flat node sequence at top-level commas (not inside nested groups). */
export function splitTopLevelCommas(nodes: Node[]): Node[][] {
  const items: Node[][] = [];
  let current: Node[] = [];
  for (const node of nodes) {
    if (node.kind === "leaf" && node.leaf.token.type === "punctuation" && node.leaf.token.value === ",") {
      items.push(current);
      current = [];
      continue;
    }
    current.push(node);
  }
  items.push(current);
  return items.filter((i) => i.length > 0);
}

function printList(items: Node[][], level: number, ctx: Ctx, itemPrinter: (item: Node[]) => string): string {
  const rendered = items.map(itemPrinter);
  const inline = rendered.join(", ");
  const shouldWrap =
    ctx.style.lists.onePerLine ||
    items.length >= ctx.style.lists.wrapThresholdItems ||
    indentStr(ctx, level).length + inline.length > ctx.style.lineWidth ||
    rendered.some((r) => r.includes("\n"));

  if (!shouldWrap) return inline;

  const b = new Builder();
  rendered.forEach((text, i) => {
    // `text` already has its own leading comments baked in by printSeq —
    // don't re-print them here, just place it on a fresh line.
    if (b.out.length > 0) b.newline(ctx, level);

    const isLast = i === rendered.length - 1;
    if (ctx.style.commas.style === "leading") {
      b.raw((i === 0 ? "" : ", ") + text);
    } else {
      b.raw(text + (isLast ? "" : ","));
    }
  });
  return b.out;
}

/** A group is a subquery (as opposed to function-call args, an `IN (...)`
 * list, etc.) when it opens with `SELECT`/`WITH`. Shared by `printGroup`
 * and `printSeq` — the latter needs to know this *before* calling
 * `printGroup`, to decide whether to break the line ahead of `(` for
 * `parentheses.subqueryOpenParenSameLine: false`. */
function isSubqueryGroup(group: GroupNode): boolean {
  const firstInner = group.content[0];
  return !!firstInner && (isKeywordLeaf(firstInner, "SELECT") || isKeywordLeaf(firstInner, "WITH"));
}

/** A window function's `OVER (...)` spec opens with `PARTITION BY` and/or
 * `ORDER BY` — distinguishable from a subquery (`SELECT`/`WITH`) or a plain
 * comma list (function args, `IN (...)`) by starting with one of those two
 * keywords directly. */
function isWindowSpecGroup(group: GroupNode): boolean {
  const firstInner = group.content[0];
  return !!firstInner && (isKeywordLeaf(firstInner, "PARTITION") || isKeywordLeaf(firstInner, "ORDER"));
}

/** Wraps a window spec's comma-separated list (PARTITION BY's or ORDER BY's
 * columns) one-per-line only once the flat rendering overflows lineWidth —
 * same "wrap only when it doesn't fit" philosophy as `printGroupItems`,
 * deliberately ignoring `lists.onePerLine`/`wrapThresholdItems` since this
 * is a clause *inside* a generic paren group, not a clause-level list. */
function printWindowClauseList(items: Node[][], level: number, ctx: Ctx): string {
  const rendered = items.map((item) => printSeq(item, level, ctx));
  const inline = rendered.join(", ");
  const overflows =
    rendered.some((r) => r.includes("\n")) || indentStr(ctx, level).length + inline.length > ctx.style.lineWidth;
  if (!overflows) return inline;

  const b = new Builder();
  rendered.forEach((text, i) => {
    if (i > 0) {
      b.raw(",");
      b.newline(ctx, level);
    }
    b.raw(text);
  });
  return b.out;
}

/** Prints an `OVER (...)` window spec, wrapping `PARTITION BY`/`ORDER BY`
 * (plus any trailing frame clause, e.g. `ROWS BETWEEN ...` — folded into
 * `ORDER BY`'s segment since it has no clause-starter of its own) onto
 * their own lines once the flat rendering overflows `lineWidth`. Applies
 * the same in both layout modes — no shared alignment column is needed
 * inside a window spec, unlike a subquery scope. */
function printWindowSpec(content: Node[], level: number, ctx: Ctx): string {
  const flat = printSeq(content, level, ctx);
  const fits = !flat.includes("\n") && indentStr(ctx, level).length + flat.length + 2 <= ctx.style.lineWidth;
  if (fits) return "(" + flat + ")";

  const clauses = splitClauses(content);
  const b = new Builder();
  b.raw("(");
  clauses.forEach((clause) => {
    b.newline(ctx, level + 1);
    if (clause.keyword === "") {
      b.raw(printSeq(clause.body, level + 1, ctx));
      return;
    }
    const keywordText = printClauseKeyword(clause, ctx);
    const items = splitTopLevelCommas(clause.body);
    b.raw(keywordText + " " + printWindowClauseList(items, level + 1, ctx));
  });
  b.newline(ctx, level);
  b.raw(")");
  return b.out;
}

function printGroup(group: GroupNode, level: number, ctx: Ctx): string {
  const isSubquery = isSubqueryGroup(group);

  if (isSubquery) {
    if (ctx.style.layout.mode === "keywordAlign") {
      // River style glues "(" directly to the subquery's first keyword (no
      // newline in between) — the subquery's own family-alignment column
      // (`baseIndentForInner`) starts right after that "(".
      const baseIndentForInner = indentStr(ctx, level).length + 1;
      const inner = printStatementBody(group.content, level + 1, ctx, baseIndentForInner);
      return "(" + inner + "\n" + indentStr(ctx, level) + ")";
    }
    const inner = printStatementBody(group.content, level + 1, ctx);
    return "(\n" + indentStr(ctx, level + 1) + inner + "\n" + indentStr(ctx, level) + ")";
  }

  if (isWindowSpecGroup(group)) {
    return printWindowSpec(group.content, level, ctx);
  }

  const items = splitTopLevelCommas(group.content);
  if (items.length > 1) {
    return printGroupItems(items, level, ctx);
  }

  return "(" + printSeq(group.content, level, ctx) + ")";
}

/** Prints a parenthesized comma list (function-call args, IN (...), UNPIVOT
 * column lists, ...) inline unless it overflows lineWidth, in which case it
 * wraps one item per line — independent of `lists.onePerLine`, which is only
 * for actual clause-level lists (SELECT, GROUP BY, ...) and would otherwise
 * force every multi-arg function call to explode onto separate lines. */
function printGroupItems(items: Node[][], level: number, ctx: Ctx): string {
  const flatRendered = items.map((item) => printSeq(item, level, ctx));
  const inline = flatRendered.join(", ");
  const overflows =
    flatRendered.some((r) => r.includes("\n")) ||
    indentStr(ctx, level).length + inline.length + 2 > ctx.style.lineWidth;
  if (!overflows) return "(" + inline + ")";

  const wrapped = items.map((item) => printSeq(item, level + 1, ctx));
  const b = new Builder();
  b.raw("(");
  wrapped.forEach((text, i) => {
    b.newline(ctx, level + 1);
    const isLast = i === wrapped.length - 1;
    if (ctx.style.commas.style === "leading") {
      b.raw((i === 0 ? "" : ", ") + text);
    } else {
      b.raw(text + (isLast ? "" : ","));
    }
  });
  b.newline(ctx, level);
  b.raw(")");
  return b.out;
}

/** Splits a flat node sequence into segments at whatever points `isSplitOp` flags. */
function splitChain(
  nodes: Node[],
  isSplitOp: (nodes: Node[], idx: number) => string | null
): { op: string | null; nodes: Node[] }[] {
  const result: { op: string | null; nodes: Node[] }[] = [];
  let current: Node[] = [];
  let op: string | null = null;

  for (let i = 0; i < nodes.length; i++) {
    const opText = isSplitOp(nodes, i);
    if (opText !== null) {
      // A comment trailing the operator itself (same line, e.g. "+ -- note")
      // would otherwise be discarded here — the operator node is dropped
      // once its text is extracted. Fold it onto the next segment's leading
      // comments instead, same trick used for clause keywords.
      const opNode = nodes[i];
      if (opNode.kind === "leaf" && opNode.leaf.trailingComment && nodes[i + 1]) {
        const nextLeaf = firstLeaf(nodes[i + 1]);
        nextLeaf.leadingComments = [opNode.leaf.trailingComment, ...nextLeaf.leadingComments];
        opNode.leaf.trailingComment = null;
      }
      result.push({ op, nodes: current });
      current = [];
      op = opText;
      continue;
    }
    current.push(nodes[i]);
  }
  result.push({ op, nodes: current });
  return result.filter((c) => c.nodes.length > 0);
}

/** Prints a chain of segments (boolean or arithmetic) with one segment per
 * line once there's more than one, using booleanOperators for placement/indent
 * — the one shared "how do we wrap a chain of operators" style knob.
 * `familyAlign`: in keywordAlign mode, WHERE/HAVING/JOIN...ON condition
 * chains right-align each AND/OR to the enclosing scope's shared keyword
 * column (same as SELECT/FROM/...), rather than the generic per-level
 * indent an arithmetic +/- chain inside a list item would use. */
function printChain(
  nodes: Node[],
  level: number,
  ctx: Ctx,
  continuationLevel: number | undefined,
  isSplitOp: (nodes: Node[], idx: number) => string | null,
  renderOp: (op: string) => string,
  familyAlign = false
): string {
  const segments = splitChain(nodes, isSplitOp);
  if (segments.length === 1) return printSeq(segments[0].nodes, level, ctx);

  const useFamilyAlign = familyAlign && !!ctx.align;
  const contLevel = continuationLevel ?? (ctx.style.booleanOperators.indentContinuation ? level + 1 : level);
  const b = new Builder();
  segments.forEach((seg, i) => {
    const text = printSeq(seg.nodes, contLevel, ctx);
    if (i === 0) {
      b.raw(text);
      return;
    }
    const opText = renderOp(seg.op ?? "");
    if (ctx.style.booleanOperators.style === "leading") {
      if (useFamilyAlign) {
        b.raw("\n" + familyPad(ctx.align!.keywordEndCol, opText));
      } else {
        b.newline(ctx, contLevel);
      }
      b.raw(opText + " " + text);
    } else {
      b.raw(" " + opText);
      b.newline(ctx, contLevel);
      b.raw(text);
    }
  });
  return b.out;
}

function isAndOr(nodes: Node[], idx: number): string | null {
  const node = nodes[idx];
  if (isKeywordLeaf(node, "AND")) return "AND";
  if (isKeywordLeaf(node, "OR")) return "OR";
  return null;
}

function printBooleanChain(
  nodes: Node[],
  level: number,
  ctx: Ctx,
  continuationLevel?: number,
  familyAlign = false
): string {
  return printChain(
    nodes,
    level,
    ctx,
    continuationLevel,
    isAndOr,
    (op) => applyCasing(op, ctx.style.casing.keywords),
    familyAlign
  );
}

function isArithmeticOp(nodes: Node[], idx: number): string | null {
  const node = nodes[idx];
  if (node.kind !== "leaf") return null;
  const { token } = node.leaf;
  if (token.type !== "operator" || (token.value !== "+" && token.value !== "-")) return null;
  if (isUnarySign(nodes, idx)) return null;
  return token.value;
}

/** Wraps a long arithmetic (+/-) chain the same way WHERE/HAVING wrap AND/OR,
 * reusing booleanOperators for placement/indent since it's the same shape of
 * "chain of operators too long for one line" problem. */
function printArithmeticChain(nodes: Node[], level: number, ctx: Ctx, continuationLevel?: number): string {
  return printChain(nodes, level, ctx, continuationLevel, isArithmeticOp, (op) => op);
}

function printClauseKeyword(clause: Clause, ctx: Ctx): string {
  return clause.keyword
    .split(" ")
    .map((w) => applyCasing(w, ctx.style.casing.keywords))
    .join(" ");
}

const LIST_CLAUSES = new Set(["SELECT", "FROM", "GROUP BY", "ORDER BY", "RETURNING", "VALUES", "SET"]);
const CONDITION_CLAUSES = new Set(["WHERE", "HAVING"]);

/** In keywordAlign mode, these lead a statement as a one-off preamble line
 * (verified against a real fixture: "INSERT INTO x" stays flush left, and
 * the following WITH/SELECT/SET starts its OWN alignment family — INSERT
 * INTO isn't a peer of SELECT/FROM/WHERE the way JOIN or GROUP BY are).
 * Not part of the shared alignment family: excluded from the column-width
 * computation and never right-padded/left-padded like a family member. */
const PREAMBLE_CLAUSES = new Set(["INSERT INTO", "UPDATE", "DELETE FROM", "DELETE"]);

/** Prints one list item (a SELECT column, GROUP BY key, ...), wrapping a long
 * arithmetic +/- chain onto multiple lines if the flat form overflows lineWidth. */
function printListItem(item: Node[], level: number, ctx: Ctx): string {
  const flat = printSeq(item, level, ctx);
  const indent = indentStr(ctx, level).length;
  const overflows = flat
    .split("\n")
    .some((line, i) => (i === 0 ? indent + line.length : line.length) > ctx.style.lineWidth);
  if (!overflows) return flat;
  return printArithmeticChain(item, level, ctx, level + 1);
}

/** Index of a top-level `AS` keyword leaf in a list item, or -1. Only looks
 * at this item's own top-level nodes — an `AS` nested inside a group (e.g.
 * `CAST(x AS int)`) is invisible here since a group is a single `Node`, not
 * flattened into the item's sequence. */
function topLevelAsIndex(item: Node[]): number {
  return item.findIndex((n) => isKeywordLeaf(n, "AS"));
}

/** Index of a top-level `=` operator leaf in a list item, or -1. Same
 * "only this item's own top-level nodes" scoping as `topLevelAsIndex`. */
function topLevelEqualsIndex(item: Node[]): number {
  return item.findIndex((n) => n.kind === "leaf" && n.leaf.token.type === "operator" && n.leaf.token.value === "=");
}

/** Shared logic for `alignment.aliases`/`alignment.assignments`: renders a
 * list the same way `printList`+`printListItem` would (same wrap-or-not
 * decision, same comma placement), but once wrapped one-per-line, pads each
 * item's text before `splitIndex(item)` out to the widest such prefix in the
 * list, so whatever comes after (an `AS alias`, or `= value`) lines up in a
 * shared column. Only single-line items (no internal newline from the
 * item's own overflow wrapping) with a `splitIndex` match participate in
 * padding — an item with neither prints unchanged, same as without
 * alignment. Alignment is meaningless for an inline (non-wrapped) list — a
 * one-line list has no column to align into — so that case falls back to
 * plain `printListItem` rendering untouched. */
function printAlignedList(items: Node[][], level: number, ctx: Ctx, splitIndex: (item: Node[]) => number): string {
  const rendered = items.map((item) => printListItem(item, level, ctx));
  const inline = rendered.join(", ");
  const shouldWrap =
    ctx.style.lists.onePerLine ||
    items.length >= ctx.style.lists.wrapThresholdItems ||
    indentStr(ctx, level).length + inline.length > ctx.style.lineWidth ||
    rendered.some((r) => r.includes("\n"));

  if (!shouldWrap) return inline;

  const splits = items.map((item, i) => {
    if (rendered[i].includes("\n")) return null;
    const splitIdx = splitIndex(item);
    if (splitIdx === -1) return null;
    return { prefix: printSeq(item.slice(0, splitIdx), level, ctx), suffix: printSeq(item.slice(splitIdx), level, ctx) };
  });
  const widest = Math.max(0, ...splits.filter((s): s is NonNullable<typeof s> => s !== null).map((s) => s.prefix.length));

  const finalRendered = items.map((item, i) => {
    const split = splits[i];
    return split ? split.prefix + " ".repeat(widest - split.prefix.length + 1) + split.suffix : rendered[i];
  });

  const b = new Builder();
  finalRendered.forEach((text, i) => {
    if (b.out.length > 0) b.newline(ctx, level);
    const isLast = i === finalRendered.length - 1;
    if (ctx.style.commas.style === "leading") {
      b.raw((i === 0 ? "" : ", ") + text);
    } else {
      b.raw(text + (isLast ? "" : ","));
    }
  });
  return b.out;
}

function printClauseBody(clause: Clause, level: number, ctx: Ctx): string {
  if (clause.keyword === "VALUES") {
    const tuples = splitTopLevelCommas(clause.body);
    return printList(tuples, level, ctx, (item) => printSeq(item, level, ctx));
  }
  if (LIST_CLAUSES.has(clause.keyword)) {
    const items = splitTopLevelCommas(clause.body);
    if (ctx.style.alignment.aliases && (clause.keyword === "SELECT" || clause.keyword === "RETURNING")) {
      return printAlignedList(items, level, ctx, topLevelAsIndex);
    }
    if (ctx.style.alignment.assignments && clause.keyword === "SET") {
      return printAlignedList(items, level, ctx, topLevelEqualsIndex);
    }
    return printList(items, level, ctx, (item) => printListItem(item, level, ctx));
  }
  if (CONDITION_CLAUSES.has(clause.keyword)) {
    return printBooleanChain(clause.body, level, ctx, undefined, true);
  }
  if (clause.keyword === "WITH") {
    return printCtes(clause.body, level, ctx);
  }
  if (clause.keyword.endsWith("JOIN")) {
    return printJoin(clause.body, level, ctx);
  }
  return printSeq(clause.body, level, ctx, clause.keyword === "INSERT INTO");
}

/** Prints one CTE item ("name AS (subquery)") for keywordAlign mode: the
 * "name AS" prefix stays on the keyword's line, but the subquery group
 * always moves to its own fresh line at this scope's shared column — that's
 * the actual convention in the real river-style examples this is modeled
 * on (verified: CTE bodies never glue "(" inline after "AS", regardless of
 * how long the CTE name is). */
function printCteItem(item: Node[], level: number, ctx: Ctx): string {
  const groupIdx = item.findIndex((n) => n.kind === "group");
  if (groupIdx === -1) return printSeq(item, level, ctx);

  const prefix = item.slice(0, groupIdx);
  const group = item[groupIdx] as GroupNode;
  const rest = item.slice(groupIdx + 1);

  const b = new Builder();
  b.raw(printSeq(prefix, level, ctx));
  b.newline(ctx, level);
  b.raw(printGroup(group, level, ctx));
  if (rest.length > 0) b.raw(" " + printSeq(rest, level, ctx));
  return b.out;
}

function printCtes(body: Node[], level: number, ctx: Ctx): string {
  let nodes = body;
  let prefix = "";
  if (nodes[0] && isKeywordLeaf(nodes[0], "RECURSIVE")) {
    prefix = applyCasing("RECURSIVE", ctx.style.casing.keywords) + " ";
    nodes = nodes.slice(1);
  }

  const items = splitTopLevelCommas(nodes);
  const alignMode = ctx.style.layout.mode === "keywordAlign" && !!ctx.align;
  const printedItems = items.map((item) =>
    alignMode ? printCteItem(item, level, ctx) : printSeq(item, level, ctx)
  );

  if (!alignMode && !ctx.style.ctes.onePerLine && printedItems.length > 1) {
    const inline = printedItems.join(", ");
    const fits = !inline.includes("\n") && indentStr(ctx, level).length + prefix.length + inline.length <= ctx.style.lineWidth;
    if (fits) return prefix + inline;
  }

  const b = new Builder();
  b.raw(prefix);
  printedItems.forEach((text, i) => {
    if (i > 0) {
      b.raw(",");
      b.newline(ctx, level);
      if (ctx.style.ctes.blankLineBetween) b.newline(ctx, level);
    }
    b.raw(text);
  });
  return b.out;
}

function printJoin(body: Node[], level: number, ctx: Ctx): string {
  const onIdx = body.findIndex((n) => isKeywordLeaf(n, "ON"));
  const tableRef = onIdx === -1 ? body : body.slice(0, onIdx);
  const condition = onIdx === -1 ? [] : body.slice(onIdx + 1);

  const b = new Builder();
  b.raw(printSeq(tableRef, level, ctx));
  if (onIdx !== -1) {
    const onKeyword = applyCasing("ON", ctx.style.casing.keywords);
    const alignMode = ctx.style.layout.mode === "keywordAlign" && !!ctx.align;

    if (alignMode) {
      // ON (and a wrapped AND/OR chain under it) reuses the enclosing
      // clause-list's shared column — the same one SELECT/FROM/WHERE/JOIN
      // already right-align to — rather than a separately computed level.
      b.raw("\n" + familyPad(ctx.align!.keywordEndCol, "ON"));
      b.raw(onKeyword + " " + printBooleanChain(condition, level, ctx, level, true));
      return b.out;
    }

    // The ON condition's own line sits at `conditionLevel`; a wrapped
    // multi-condition chain indents `multiConditionIndent` levels past that
    // — a dedicated knob, not stacked with booleanOperators.indentContinuation
    // (which governs WHERE/HAVING, where the chain starts on its own line).
    if (ctx.style.joins.onClausePlacement === "sameLine") {
      const continuationLevel = level + ctx.style.joins.multiConditionIndent;
      b.raw(" " + onKeyword + " " + printBooleanChain(condition, level, ctx, continuationLevel));
    } else {
      const conditionLevel = level + 1;
      const continuationLevel = conditionLevel + ctx.style.joins.multiConditionIndent;
      b.newline(ctx, conditionLevel);
      b.raw(onKeyword + " " + printBooleanChain(condition, conditionLevel, ctx, continuationLevel));
    }
  }
  return b.out;
}

/** Prints one statement's clauses (used both for top-level statements and
 * subqueries). `baseIndentOverride` is only used in `keywordAlign` mode: the
 * column (0-indexed) this scope's family-alignment column is rooted at —
 * passed down by `printGroup` when this is a subquery glued right after a
 * "(" (see there for why it can't just be derived from `level`). */
function printStatementBody(nodes: Node[], level: number, ctx: Ctx, baseIndentOverride?: number): string {
  const clauses = splitClauses(nodes);
  const b = new Builder();
  const alignMode = ctx.style.layout.mode === "keywordAlign";

  // In align mode, every clause keyword in this scope (SELECT/FROM/WHERE/
  // JOIN/GROUP BY/...) right-pads its first word to a shared column,
  // computed fresh per scope from whichever clause keywords actually appear
  // here — the textbook "river style" algorithm. `scopeCtx` carries that
  // column down to every recursive call underneath (list items, CASE
  // blocks, JOIN's ON, nested subqueries), which is what lets all of them
  // align correctly with no further plumbing.
  let scopeCtx = ctx;
  let widestFirstWord = 0;
  let keywordEndCol = 0;
  let scopeBaseIndent = 0;
  if (alignMode) {
    const baseIndent = baseIndentOverride ?? 0;
    scopeBaseIndent = baseIndent;
    const familyKeywords = clauses
      .filter((c) => c.keyword !== "" && !PREAMBLE_CLAUSES.has(c.keyword))
      .map((c) => c.keyword);
    widestFirstWord = Math.max(1, ...familyKeywords.map((k) => canonicalFamilyWord(k).length));
    keywordEndCol = baseIndent + widestFirstWord - 1;
    scopeCtx = { ...ctx, align: { baseLevel: level + 1, keywordEndCol } };
  }

  let familySeen = false;
  clauses.forEach((clause, i) => {
    if (clause.keyword === "" || (alignMode && PREAMBLE_CLAUSES.has(clause.keyword))) {
      // No recognized clause keyword (e.g. a bare "CREATE ... AS" prefix),
      // or a preamble clause in align mode (INSERT INTO/UPDATE/DELETE) —
      // print inline at this level, no family padding, doesn't consume the
      // "family first" slot.
      if (i > 0) b.newline(scopeCtx, level);
      const preambleBody = printClauseBody(clause, level, scopeCtx);
      const keywordPrefix = clause.keyword === "" ? "" : printClauseKeyword(clause, scopeCtx);
      b.raw(keywordPrefix && preambleBody ? keywordPrefix + " " + preambleBody : keywordPrefix + preambleBody);
      return;
    }

    const isFamilyFirst = !familySeen;
    familySeen = true;

    if (i > 0) {
      if (alignMode && !isFamilyFirst) {
        // Right-align this keyword's first word to keywordEndCol, rather
        // than the generic per-level indent.
        b.raw("\n" + familyPad(keywordEndCol, clause.keyword));
      } else if (alignMode) {
        // The family's first member never gets left-padding (it's flush at
        // this scope's own base indent) even if it isn't array index 0 —
        // e.g. WITH following a preamble "INSERT INTO x" line.
        b.raw("\n" + " ".repeat(scopeBaseIndent));
      } else {
        b.newline(scopeCtx, level);
      }
    }

    const firstKeywordLeaf = clause.keywordLeaves[0]?.leaf;
    const lastKeywordLeaf = clause.keywordLeaves[clause.keywordLeaves.length - 1]?.leaf;
    for (const c of firstKeywordLeaf?.leadingComments ?? []) {
      b.raw(c.value);
      if (alignMode) {
        // The comment sits on its own line at whatever column the keyword
        // itself would've used — not the generic content column.
        b.raw("\n" + (isFamilyFirst ? " ".repeat(scopeBaseIndent) : familyPad(keywordEndCol, clause.keyword)));
      } else {
        b.newline(scopeCtx, level);
      }
    }

    // SELECT DISTINCT/ALL: keep the modifier attached to the SELECT keyword
    // itself rather than letting it wrap as if it were the first list item.
    let body = clause.body;
    let selectModifier = "";
    if (clause.keyword === "SELECT" && (isKeywordLeaf(body[0], "DISTINCT") || isKeywordLeaf(body[0], "ALL"))) {
      selectModifier = applyCasing((body[0] as LeafNode).leaf.token.value, scopeCtx.style.casing.keywords);
      body = body.slice(1);
    }

    // A comment trailing the keyword itself (e.g. "SELECT -- note") reads
    // better folded into the body's leading comments than stuck on the
    // keyword line, when the body starts on its own line anyway.
    if (lastKeywordLeaf?.trailingComment && body.length > 0) {
      const target = firstLeaf(body[0]);
      target.leadingComments = [lastKeywordLeaf.trailingComment, ...target.leadingComments];
      lastKeywordLeaf.trailingComment = null;
    }

    let keywordText = printClauseKeyword(clause, scopeCtx);
    if (selectModifier) keywordText += " " + selectModifier;
    if (lastKeywordLeaf?.trailingComment) {
      keywordText += " " + lastKeywordLeaf.trailingComment.value;
    }
    const bodyText = printClauseBody({ ...clause, body }, level + 1, scopeCtx);
    if (bodyText.length === 0) {
      b.raw(keywordText);
    } else if (alignMode) {
      // Always glue the body's first line to the keyword line — bodyText's
      // own internal newlines were already rendered against scopeCtx's
      // aligned column, so straight concatenation lands everything in the
      // right place. The family-first clause (e.g. WITH, or a subquery's
      // own SELECT) right-pads itself out to the shared content column;
      // every other clause already ends exactly at keywordEndCol via
      // familyPad, so one space suffices.
      const pad = isFamilyFirst ? " ".repeat(Math.max(1, widestFirstWord + 1 - keywordText.length)) : " ";
      b.raw(keywordText + pad + bodyText);
    } else if (!bodyText.includes("\n")) {
      // A body that renders on one line (a single item/condition, or a short
      // clause like LIMIT n) stays on the keyword's own line — wrapping to a
      // new line only earns its keep when there's more than one thing to
      // separate.
      b.raw(keywordText + " " + bodyText);
    } else {
      b.raw(keywordText + "\n" + indentStr(ctx, level + 1) + bodyText);
    }
  });

  return b.out;
}

export function printStatement(nodes: Node[], style: StyleTemplate["style"]): string {
  return printStatementBody(nodes, 0, { style });
}

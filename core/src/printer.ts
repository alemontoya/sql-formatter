import type { Leaf } from "./trivia.js";
import type { Node, GroupNode, LeafNode } from "./tree.js";
import type { Clause } from "./clauses.js";
import { splitClauses } from "./clauses.js";
import { applyCasing, type StyleTemplate } from "./style-template.js";

interface Ctx {
  style: StyleTemplate["style"];
}

const NO_SPACE_BEFORE = new Set([",", ")", ";", ".", "::"]);
const NO_SPACE_AFTER = new Set(["(", ".", "::"]);

function indentUnit(ctx: Ctx): string {
  return ctx.style.indentation.char === "tab" ? "\t" : " ".repeat(ctx.style.indentation.size);
}

function indentStr(ctx: Ctx, level: number): string {
  return indentUnit(ctx).repeat(Math.max(0, level));
}

function firstLeaf(node: Node): Leaf {
  return node.kind === "leaf" ? node.leaf : firstLeaf(node.content[0] ?? { kind: "leaf", leaf: node.open }) ?? node.open;
}

function lastLeaf(node: Node): Leaf {
  if (node.kind === "leaf") return node.leaf;
  return node.close ?? (node.content.length ? lastLeaf(node.content[node.content.length - 1]) : node.open);
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

function classifyLeaf(nodes: Node[], idx: number): "keyword" | "function" | "type" | "identifier" | "raw" {
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
  if (next && next.kind === "group") return "function";
  return "identifier";
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
function printSeq(nodes: Node[], level: number, ctx: Ctx): string {
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
      const isCallArgs = idx > 0 && classifyLeaf(nodes, idx - 1) === "function";
      b.text(printGroup(node, level, ctx), isCallArgs);
      const trailing = node.close.trailingComment;
      if (trailing) b.text(trailing.value);
      continue;
    }

    const kind = classifyLeaf(nodes, idx);
    b.spaceAwareText(renderLeafText(node.leaf, kind, ctx));
    if (isUnarySign(nodes, idx)) b.suppressNextSpace();
    if (node.leaf.trailingComment) b.text(node.leaf.trailingComment.value);
  }

  return b.out;
}

function printCaseBlock(inner: Node[], level: number, ctx: Ctx): string {
  // Split `inner` into WHEN/THEN branches (+ optional ELSE), only at depth 0
  // relative to this CASE (nested CASE...END spans are skipped over).
  type Branch = { when: Node[]; then: Node[] } | { elseResult: Node[] };
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
      branches.push({ when, then });
      i = k;
      continue;
    }

    if (depth === 0 && isKeywordLeaf(inner[i], "ELSE")) {
      let k = i + 1;
      while (k < inner.length) k++;
      branches.push({ elseResult: inner.slice(i + 1, k) });
      i = k;
      continue;
    }

    i++;
  }

  const b = new Builder();
  b.raw(applyCasing("CASE", ctx.style.casing.keywords));
  for (const branch of branches) {
    b.newline(ctx, level + 1);
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
function splitTopLevelCommas(nodes: Node[]): Node[][] {
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
    indentStr(ctx, level).length + inline.length > ctx.style.lineWidth;

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

function printGroup(group: GroupNode, level: number, ctx: Ctx): string {
  const firstInner = group.content[0];
  const isSubquery =
    firstInner && isKeywordLeaf(firstInner, "SELECT") || (firstInner && isKeywordLeaf(firstInner, "WITH"));

  if (isSubquery) {
    const inner = printStatementBody(group.content, level + 1, ctx);
    return "(\n" + indentStr(ctx, level + 1) + inner + "\n" + indentStr(ctx, level) + ")";
  }

  const items = splitTopLevelCommas(group.content);
  if (items.length > 1) {
    const inline = items.map((item) => printSeq(item, level, ctx)).join(", ");
    return "(" + inline + ")";
  }

  return "(" + printSeq(group.content, level, ctx) + ")";
}

/** Splits a boolean-chain clause body (WHERE/HAVING/ON) at top-level AND/OR. */
function splitBooleanChain(nodes: Node[]): { op: "AND" | "OR" | null; nodes: Node[] }[] {
  const result: { op: "AND" | "OR" | null; nodes: Node[] }[] = [];
  let current: Node[] = [];
  let op: "AND" | "OR" | null = null;

  for (const node of nodes) {
    if (isKeywordLeaf(node, "AND") || isKeywordLeaf(node, "OR")) {
      result.push({ op, nodes: current });
      current = [];
      op = (node as LeafNode).leaf.token.value.toUpperCase() as "AND" | "OR";
      continue;
    }
    current.push(node);
  }
  result.push({ op, nodes: current });
  return result.filter((c) => c.nodes.length > 0);
}

function printBooleanChain(nodes: Node[], level: number, ctx: Ctx, continuationLevel?: number): string {
  const conditions = splitBooleanChain(nodes);
  if (conditions.length === 1) return printSeq(conditions[0].nodes, level, ctx);

  const contLevel = continuationLevel ?? (ctx.style.booleanOperators.indentContinuation ? level + 1 : level);
  const b = new Builder();
  conditions.forEach((cond, i) => {
    const text = printSeq(cond.nodes, contLevel, ctx);
    if (i === 0) {
      b.raw(text);
      return;
    }
    const opText = applyCasing(cond.op ?? "AND", ctx.style.casing.keywords);
    if (ctx.style.booleanOperators.style === "leading") {
      b.newline(ctx, contLevel);
      b.raw(opText + " " + text);
    } else {
      b.raw(" " + opText);
      b.newline(ctx, contLevel);
      b.raw(text);
    }
  });
  return b.out;
}

function printClauseKeyword(clause: Clause, ctx: Ctx): string {
  return clause.keyword
    .split(" ")
    .map((w) => applyCasing(w, ctx.style.casing.keywords))
    .join(" ");
}

const LIST_CLAUSES = new Set(["SELECT", "FROM", "GROUP BY", "ORDER BY", "RETURNING", "VALUES", "SET"]);
const CONDITION_CLAUSES = new Set(["WHERE", "HAVING"]);

function printClauseBody(clause: Clause, level: number, ctx: Ctx): string {
  if (clause.keyword === "VALUES") {
    const tuples = splitTopLevelCommas(clause.body);
    return printList(tuples, level, ctx, (item) => printSeq(item, level, ctx));
  }
  if (LIST_CLAUSES.has(clause.keyword)) {
    const items = splitTopLevelCommas(clause.body);
    return printList(items, level, ctx, (item) => printSeq(item, level, ctx));
  }
  if (CONDITION_CLAUSES.has(clause.keyword)) {
    return printBooleanChain(clause.body, level, ctx);
  }
  if (clause.keyword === "WITH") {
    return printCtes(clause.body, level, ctx);
  }
  if (clause.keyword.endsWith("JOIN")) {
    return printJoin(clause.body, level, ctx);
  }
  return printSeq(clause.body, level, ctx);
}

function printCtes(body: Node[], level: number, ctx: Ctx): string {
  let nodes = body;
  let prefix = "";
  if (nodes[0] && isKeywordLeaf(nodes[0], "RECURSIVE")) {
    prefix = applyCasing("RECURSIVE", ctx.style.casing.keywords) + " ";
    nodes = nodes.slice(1);
  }

  const items = splitTopLevelCommas(nodes);
  const printedItems = items.map((item) => printSeq(item, level, ctx));

  if (!ctx.style.ctes.onePerLine && printedItems.length > 1) {
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

/** Prints one statement's clauses (used both for top-level statements and subqueries). */
function printStatementBody(nodes: Node[], level: number, ctx: Ctx): string {
  const clauses = splitClauses(nodes);
  const b = new Builder();

  clauses.forEach((clause, i) => {
    if (i > 0) b.newline(ctx, level);

    if (clause.keyword === "") {
      // No recognized clause keyword (e.g. a bare "CREATE ... AS" prefix) —
      // print inline at this level, no separate header/body split.
      b.raw(printClauseBody(clause, level, ctx));
      return;
    }

    const firstKeywordLeaf = clause.keywordLeaves[0]?.leaf;
    const lastKeywordLeaf = clause.keywordLeaves[clause.keywordLeaves.length - 1]?.leaf;
    for (const c of firstKeywordLeaf?.leadingComments ?? []) {
      b.raw(c.value);
      b.newline(ctx, level);
    }

    // SELECT DISTINCT/ALL: keep the modifier attached to the SELECT keyword
    // itself rather than letting it wrap as if it were the first list item.
    let body = clause.body;
    let selectModifier = "";
    if (clause.keyword === "SELECT" && (isKeywordLeaf(body[0], "DISTINCT") || isKeywordLeaf(body[0], "ALL"))) {
      selectModifier = applyCasing((body[0] as LeafNode).leaf.token.value, ctx.style.casing.keywords);
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

    let keywordText = printClauseKeyword(clause, ctx);
    if (selectModifier) keywordText += " " + selectModifier;
    if (lastKeywordLeaf?.trailingComment) {
      keywordText += " " + lastKeywordLeaf.trailingComment.value;
    }
    const bodyText = printClauseBody({ ...clause, body }, level + 1, ctx);
    if (bodyText.length === 0) {
      b.raw(keywordText);
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

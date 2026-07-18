import { isKeyword } from "./keywords.js";
import type { Token } from "./types.js";

const MULTI_CHAR_OPERATORS = [
  "::", "->>", "->", "!=", "<>", "<=", ">=", "||", "~~", "!~", ":=",
].sort((a, b) => b.length - a.length);

const SINGLE_CHAR_PUNCTUATION = new Set(["(", ")", ",", ".", ";"]);

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Tokenizes SQL into a lossless token stream: concatenating every token's
 * `value` in order reproduces the original input exactly. This is what lets
 * the formatter reposition comments/whitespace without ever discarding them.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  const push = (type: Token["type"], start: number, end: number) => {
    tokens.push({ type, value: sql.slice(start, end), start, end });
  };

  while (i < n) {
    const start = i;
    const ch = sql[i];

    // whitespace (spaces, tabs, newlines) — collapsed into one token, exact text kept
    if (isWhitespace(ch)) {
      while (i < n && isWhitespace(sql[i])) i++;
      push("whitespace", start, i);
      continue;
    }

    // line comment
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      push("lineComment", start, i);
      continue;
    }

    // block comment
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      push("blockComment", start, i);
      continue;
    }

    // dollar-quoted string ($$...$$ or $tag$...$tag$) — postgres/snowflake
    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const delimiter = tagMatch[0];
        const closeIndex = sql.indexOf(delimiter, i + delimiter.length);
        i = closeIndex === -1 ? n : closeIndex + delimiter.length;
        push("string", start, i);
        continue;
      }
    }

    // single-quoted string literal, '' is the escaped quote
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      push("string", start, i);
      continue;
    }

    // double-quoted identifier, "" is the escaped quote
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      push("quotedIdentifier", start, i);
      continue;
    }

    // backtick-quoted identifier (sqlite compatibility)
    if (ch === "`") {
      i++;
      while (i < n && sql[i] !== "`") i++;
      i = Math.min(i + 1, n);
      push("quotedIdentifier", start, i);
      continue;
    }

    // number literal
    if (isDigit(ch) || (ch === "." && isDigit(sql[i + 1] ?? ""))) {
      while (i < n && isDigit(sql[i])) i++;
      if (sql[i] === ".") {
        i++;
        while (i < n && isDigit(sql[i])) i++;
      }
      if (sql[i] === "e" || sql[i] === "E") {
        i++;
        if (sql[i] === "+" || sql[i] === "-") i++;
        while (i < n && isDigit(sql[i])) i++;
      }
      push("number", start, i);
      continue;
    }

    // identifier or keyword
    if (isIdentifierStart(ch)) {
      i++;
      while (i < n && isIdentifierPart(sql[i])) i++;
      const word = sql.slice(start, i);
      push(isKeyword(word) ? "keyword" : "identifier", start, i);
      continue;
    }

    // multi-char operators
    const rest = sql.slice(i, i + 3);
    const op = MULTI_CHAR_OPERATORS.find((o) => rest.startsWith(o));
    if (op) {
      i += op.length;
      push("operator", start, i);
      continue;
    }

    // single-char punctuation
    if (SINGLE_CHAR_PUNCTUATION.has(ch)) {
      i++;
      push("punctuation", start, i);
      continue;
    }

    // fallback: any other single character is treated as an operator
    // (=, <, >, +, -, *, /, %, ~, ^, &, |, !, :, etc.)
    i++;
    push("operator", start, i);
  }

  push("eof", n, n);
  return tokens;
}

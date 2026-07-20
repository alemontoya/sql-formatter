export type CasingRule = "upper" | "lower" | "preserve" | "capitalize";

export interface StyleTemplate {
  id: string;
  name: string;
  description?: string;
  version: string;
  schemaVersion: string;
  dialect: "generic" | "postgres" | "snowflake" | "sqlite";
  extends?: string | null;
  source: { type: "manual" | "inferred"; confidence?: Record<string, number> };
  style: {
    layout: { mode: "indent" | "keywordAlign" };
    casing: {
      keywords: CasingRule;
      functions: CasingRule;
      types: CasingRule;
      identifiers: CasingRule;
    };
    indentation: { char: "space" | "tab"; size: number };
    lineWidth: number;
    clauses: { forceNewlinePerClause: boolean; inlineShortStatements: boolean };
    lists: { onePerLine: boolean; wrapThresholdItems: number };
    commas: { style: "leading" | "trailing"; alignAfterComma: boolean };
    joins: { onClausePlacement: "sameLine" | "newLine"; multiConditionIndent: number };
    booleanOperators: { style: "leading" | "trailing"; indentContinuation: boolean };
    ctes: { onePerLine: boolean; blankLineBetween: boolean };
    parentheses: { subqueryOpenParenSameLine: boolean };
    alignment: { aliases: boolean; assignments: boolean };
    quoting: {
      forceQuoteIdentifiers: boolean;
      quoteChar: "double" | "backtick" | "bracket" | "none";
      /** Whether quoting rules (forceQuoteIdentifiers and quote-character
       * conversion) also apply to an identifier directly after AS. false
       * leaves aliases exactly as written — useful for a style that quotes
       * source column/table references but leaves aliases bare. */
      quoteAliases: boolean;
    };
    blankLines: { betweenStatements: "preserve" | "collapseToOne" | "none"; aroundCtes: boolean };
    statementTerminator: { alwaysAppendSemicolon: boolean };
  };
}

export function applyCasing(word: string, rule: CasingRule): string {
  switch (rule) {
    case "upper":
      return word.toUpperCase();
    case "lower":
      return word.toLowerCase();
    case "capitalize":
      return word.length ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word;
    case "preserve":
    default:
      return word;
  }
}

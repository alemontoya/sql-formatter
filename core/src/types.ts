export type TokenType =
  | "keyword"
  | "identifier"
  | "quotedIdentifier"
  | "string"
  | "number"
  | "operator"
  | "punctuation"
  | "lineComment"
  | "blockComment"
  | "whitespace"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

export type Dialect = "generic" | "postgres" | "snowflake" | "sqlite";

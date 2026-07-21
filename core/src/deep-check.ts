import type { PortabilityDialect } from "./lint.js";

/**
 * Builds the Claude API request body for a "deep check" — an LLM-backed
 * portability review, distinct from `lintPortability()`'s deterministic
 * rule catalog. This module never makes a network call itself; it only
 * constructs the request. Each interface (CLI/VS Code/web) is responsible
 * for actually sending it, since each has a different, deliberately
 * explicit way of sourcing an API key — see HANDOFF.md's "Deep Check"
 * section for why this stays an opt-in exception to local-first rather
 * than a default.
 */

export interface DeepCheckFinding {
  /** The exact (or closely paraphrased) source snippet the finding is about. */
  snippet: string;
  /** Why this construct may not port cleanly, and what the target-dialect
   * equivalent typically looks like. */
  message: string;
  /** The model's own confidence in this finding — surfaced as-is, not
   * something this tool verifies. */
  confidence: "high" | "medium" | "low";
}

export interface DeepCheckResponseSchema {
  findings: DeepCheckFinding[];
}

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          snippet: { type: "string", description: "The exact or closely paraphrased source SQL snippet this finding is about." },
          message: {
            type: "string",
            description: "Why this construct may not port cleanly to the target dialect, and what the target-dialect equivalent typically looks like. One or two sentences.",
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["snippet", "message", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are reviewing a SQL script for portability between two SQL dialects. You are NOT rewriting the query and NOT verifying it runs — you are flagging constructs in the source dialect that are likely to fail, behave differently, or need manual translation when the query is ported to the target dialect.

Focus on things a deterministic keyword/pattern scanner would miss: subtle semantic differences (NULL handling, implicit type coercion, date/time arithmetic, window function edge cases), dialect-specific function argument order or defaults, and behavior that changes silently rather than erroring outright. Do not flag generic SQL standard syntax that both dialects support identically.

If you find nothing genuinely likely to cause a problem, return an empty findings array — do not invent low-value findings to pad the response. Each finding's "confidence" should honestly reflect how sure you are; a hunch worth mentioning is still "low" confidence, not "high".`;

/**
 * The request body for `POST /v1/messages` (or the equivalent SDK call).
 * Callers should send this via `client.messages.create(request)` — using
 * structured outputs (`output_config.format`) rather than free-text JSON
 * parsing, since a malformed response here should be a hard error, not a
 * best-effort regex extraction.
 */
export function buildDeepCheckRequest(sql: string, source: PortabilityDialect, target: PortabilityDialect) {
  return {
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: `Source dialect: ${source}\nTarget dialect: ${target}\n\nSQL:\n\`\`\`sql\n${sql}\n\`\`\``,
      },
    ],
    output_config: {
      format: {
        type: "json_schema" as const,
        schema: RESPONSE_JSON_SCHEMA,
      },
    },
  };
}

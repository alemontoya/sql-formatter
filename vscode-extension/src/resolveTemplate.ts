import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { StyleTemplate } from "@sql-formatter/core";
import { BUNDLED_TEMPLATES } from "./templates.js";

/**
 * Resolves the `sqlFormatter.template` setting to an actual StyleTemplate.
 * Kept free of any `vscode` import so it can be unit-tested with vitest
 * directly, without an extension host.
 */
export function resolveTemplate(setting: string, workspaceRoot: string | undefined): StyleTemplate {
  const trimmed = setting.trim() || "default";
  const bundled = BUNDLED_TEMPLATES[trimmed];
  if (bundled) return bundled;

  const path = isAbsolute(trimmed) || !workspaceRoot ? trimmed : resolve(workspaceRoot, trimmed);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`SQL Formatter: couldn't read template "${setting}" (resolved to ${path}): ${errMessage(err)}`);
  }
  try {
    return JSON.parse(text) as StyleTemplate;
  } catch (err) {
    throw new Error(`SQL Formatter: template "${setting}" isn't valid JSON: ${errMessage(err)}`);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

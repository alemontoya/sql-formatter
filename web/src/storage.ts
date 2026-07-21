import type { StyleTemplate } from "@sql-formatter/core";

const TEMPLATES_KEY = "sqlFormatter.customTemplates";
const ACTIVE_KEY = "sqlFormatter.activeTemplate";
const ANTHROPIC_API_KEY_KEY = "sqlFormatter.anthropicApiKey";
const MAX_SAVED = 20;

export interface SavedTemplate {
  label: string;
  template: StyleTemplate;
  savedAt: number;
}

export function loadSavedTemplates(): SavedTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    return raw ? (JSON.parse(raw) as SavedTemplate[]) : [];
  } catch {
    return [];
  }
}

/** Saves (or replaces, by template id) a custom template, most-recent first. */
export function saveCustomTemplate(label: string, template: StyleTemplate): void {
  const list = loadSavedTemplates().filter((t) => t.template.id !== template.id);
  list.unshift({ label, template, savedAt: Date.now() });
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
}

export function deleteCustomTemplate(id: string): void {
  const list = loadSavedTemplates().filter((t) => t.template.id !== id);
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
}

/** The select value ("default" | "compact" | "river" | "custom:<id>") active before the last reload. */
export function getActiveSelection(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveSelection(value: string): void {
  localStorage.setItem(ACTIVE_KEY, value);
}

/**
 * A personal Anthropic API key, stored in this browser's localStorage only
 * — never sent anywhere except directly to the Claude API from Deep Check.
 * This is an explicit, opt-in exception to the rest of this app's
 * never-leaves-your-browser-except-to-Anthropic default; see the Deep Check
 * UI copy for the disclosure shown before first use.
 */
export function getAnthropicApiKey(): string | null {
  return localStorage.getItem(ANTHROPIC_API_KEY_KEY);
}

export function setAnthropicApiKey(key: string): void {
  localStorage.setItem(ANTHROPIC_API_KEY_KEY, key);
}

export function clearAnthropicApiKey(): void {
  localStorage.removeItem(ANTHROPIC_API_KEY_KEY);
}

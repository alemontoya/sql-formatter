import "./style.css";
import { format, inferStyleTemplate, advise } from "@sql-formatter/core";
import type { StyleTemplate, Dialect, InferResult, TableStats, Suggestion } from "@sql-formatter/core";
import { BUNDLED_TEMPLATES } from "./templates";
import { loadSavedTemplates, saveCustomTemplate, deleteCustomTemplate, getActiveSelection, setActiveSelection } from "./storage";

const DIALECTS: Dialect[] = ["generic", "postgres", "snowflake", "sqlite"];

const THEME_KEY = "sqlFormatter.theme";
function currentTheme(): "light" | "dark" {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyStoredTheme(): void {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") document.documentElement.setAttribute("data-theme", stored);
}
applyStoredTheme();

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header>
    <div>
      <h1>SQL Formatter</h1>
      <p>Formats SQL entirely in your browser — nothing is sent anywhere.</p>
    </div>
    <button type="button" id="theme-toggle" aria-label="Toggle light/dark theme"></button>
  </header>

  <div class="tabs">
    <button class="tab active" data-tab="format" type="button">Format</button>
    <button class="tab" data-tab="infer" type="button">Infer style from example</button>
    <button class="tab" data-tab="advise" type="button">Advise</button>
  </div>

  <section class="panel active" id="panel-format">
    <div class="toolbar">
      <label>
        Template
        <select id="template-select">
          <option value="default">Default</option>
          <option value="compact">Compact</option>
          <option value="river">River</option>
          <optgroup label="Saved" id="saved-optgroup"></optgroup>
        </select>
      </label>
      <input type="file" id="template-file" accept="application/json,.json" hidden />
      <button type="button" class="secondary" id="upload-template-btn">Upload template…</button>
      <button type="button" class="secondary" id="delete-template-btn" hidden>Delete saved template</button>
      <button type="button" id="format-btn">Format</button>
      <button type="button" class="secondary" id="copy-btn">Copy output</button>
      <span class="template-info" id="template-info"></span>
    </div>
    <div class="error-banner" id="format-error"></div>
    <div class="editor-grid">
      <div class="editor-col">
        <div class="col-header">Input SQL</div>
        <textarea id="sql-input" spellcheck="false" placeholder="Paste SQL here…"></textarea>
      </div>
      <div class="editor-col">
        <div class="col-header">Formatted</div>
        <pre class="output" id="sql-output"></pre>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-infer">
    <div class="infer-fields">
      <label>Id <input type="text" id="infer-id" placeholder="jane-default" /></label>
      <label>Name <input type="text" id="infer-name" placeholder="Jane's style" /></label>
      <label>
        Dialect
        <select id="infer-dialect">
          ${DIALECTS.map((d) => `<option value="${d}">${d}</option>`).join("")}
        </select>
      </label>
      <label>
        Fallback base
        <select id="infer-base">
          <option value="default">Default</option>
          <option value="compact">Compact</option>
          <option value="river">River</option>
        </select>
      </label>
      <button type="button" id="infer-btn">Infer style</button>
      <button type="button" id="use-template-btn" disabled>Use this template</button>
    </div>
    <div class="error-banner" id="infer-error"></div>
    <div class="infer-grid">
      <div class="editor-col">
        <div class="col-header">Example SQL (already formatted in the style you want)</div>
        <textarea id="infer-input" spellcheck="false" placeholder="Paste an example already formatted the way you like…"></textarea>
      </div>
      <div class="editor-col">
        <div class="col-header">Inferred template</div>
        <pre class="output" id="infer-output"></pre>
      </div>
    </div>
    <div class="warnings" id="infer-warnings"></div>
  </section>

  <section class="panel" id="panel-advise">
    <div class="toolbar">
      <input type="file" id="stats-file" accept="application/json,.json" hidden />
      <button type="button" class="secondary" id="upload-stats-btn">Upload table stats…</button>
      <button type="button" class="secondary" id="clear-stats-btn" hidden>Clear stats</button>
      <button type="button" id="advise-btn">Run advisor</button>
      <span class="template-info" id="stats-info">No stats loaded — structural checks only</span>
    </div>
    <div class="error-banner" id="advise-error"></div>
    <div class="editor-grid">
      <div class="editor-col">
        <div class="col-header">SQL to analyze</div>
        <textarea id="advise-input" spellcheck="false" placeholder="Paste SQL to analyze…"></textarea>
      </div>
      <div class="editor-col">
        <div class="col-header">Suggestions</div>
        <div class="advise-results" id="advise-output"></div>
      </div>
    </div>
  </section>
`;

// ---------------------------------------------------------------------------
// Theme

const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle")!;

function renderThemeToggle(): void {
  themeToggle.textContent = currentTheme() === "dark" ? "🌙" : "☀️";
}

themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
  renderThemeToggle();
});

renderThemeToggle();

// ---------------------------------------------------------------------------
// Tabs

const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const panels = {
  format: document.querySelector<HTMLElement>("#panel-format")!,
  infer: document.querySelector<HTMLElement>("#panel-infer")!,
  advise: document.querySelector<HTMLElement>("#panel-advise")!,
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab as keyof typeof panels;
    Object.entries(panels).forEach(([name, panel]) => panel.classList.toggle("active", name === target));
  });
});

function activateTab(name: keyof typeof panels): void {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  Object.entries(panels).forEach(([n, panel]) => panel.classList.toggle("active", n === name));
}

// ---------------------------------------------------------------------------
// Format panel

const templateSelect = document.querySelector<HTMLSelectElement>("#template-select")!;
const savedOptgroup = document.querySelector<HTMLOptGroupElement>("#saved-optgroup")!;
const templateFileInput = document.querySelector<HTMLInputElement>("#template-file")!;
const uploadTemplateBtn = document.querySelector<HTMLButtonElement>("#upload-template-btn")!;
const deleteTemplateBtn = document.querySelector<HTMLButtonElement>("#delete-template-btn")!;
const templateInfo = document.querySelector<HTMLElement>("#template-info")!;
const formatBtn = document.querySelector<HTMLButtonElement>("#format-btn")!;
const copyBtn = document.querySelector<HTMLButtonElement>("#copy-btn")!;
const formatError = document.querySelector<HTMLElement>("#format-error")!;
const sqlInput = document.querySelector<HTMLTextAreaElement>("#sql-input")!;
const sqlOutput = document.querySelector<HTMLElement>("#sql-output")!;

let activeTemplate: StyleTemplate = BUNDLED_TEMPLATES.default;

function showFormatError(message: string | null): void {
  if (message) {
    formatError.textContent = message;
    formatError.classList.add("visible");
  } else {
    formatError.textContent = "";
    formatError.classList.remove("visible");
  }
}

function renderTemplateInfo(): void {
  const t = activeTemplate;
  templateInfo.textContent = `${t.name} (${t.id}) · ${t.dialect} · ${t.style.layout.mode}`;
}

function renderSavedOptions(selected?: string): void {
  savedOptgroup.innerHTML = loadSavedTemplates()
    .map((s) => `<option value="custom:${escapeHtml(s.template.id)}">${escapeHtml(s.label)}</option>`)
    .join("");
  if (selected) templateSelect.value = selected;
  deleteTemplateBtn.hidden = !templateSelect.value.startsWith("custom:");
}

/** Sets the active template and, unless `persist` is false (used when restoring
 * a selection that's already in storage), saves it under `customLabel`. */
function setActiveTemplate(
  template: StyleTemplate,
  selectValue: string,
  options: { customLabel?: string; persist?: boolean } = {},
): void {
  activeTemplate = template;
  if (options.customLabel && options.persist !== false) {
    saveCustomTemplate(options.customLabel, template);
  }
  renderSavedOptions(selectValue);
  setActiveSelection(selectValue);
  renderTemplateInfo();
  runFormat();
}

function runFormat(): void {
  const sql = sqlInput.value;
  if (!sql.trim()) {
    sqlOutput.textContent = "";
    showFormatError(null);
    return;
  }
  try {
    sqlOutput.textContent = format(sql, activeTemplate);
    showFormatError(null);
  } catch (err) {
    showFormatError(err instanceof Error ? err.message : String(err));
  }
}

templateSelect.addEventListener("change", () => {
  const value = templateSelect.value;
  deleteTemplateBtn.hidden = !value.startsWith("custom:");
  if (value.startsWith("custom:")) {
    const id = value.slice("custom:".length);
    const saved = loadSavedTemplates().find((s) => s.template.id === id);
    if (saved) {
      setActiveTemplate(saved.template, value, { persist: false });
      return;
    }
  }
  setActiveTemplate(BUNDLED_TEMPLATES[value], value);
});

uploadTemplateBtn.addEventListener("click", () => templateFileInput.click());

templateFileInput.addEventListener("change", async () => {
  const file = templateFileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as StyleTemplate;
    if (!parsed?.style?.layout) throw new Error("Not a valid style template (missing `style` fields).");
    setActiveTemplate(parsed, `custom:${parsed.id}`, { customLabel: file.name });
  } catch (err) {
    showFormatError(`Couldn't load template: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    templateFileInput.value = "";
  }
});

deleteTemplateBtn.addEventListener("click", () => {
  if (!templateSelect.value.startsWith("custom:")) return;
  deleteCustomTemplate(templateSelect.value.slice("custom:".length));
  setActiveTemplate(BUNDLED_TEMPLATES.default, "default");
});

formatBtn.addEventListener("click", runFormat);
sqlInput.addEventListener("input", runFormat);

copyBtn.addEventListener("click", async () => {
  if (!sqlOutput.textContent) return;
  await navigator.clipboard.writeText(sqlOutput.textContent);
  const original = copyBtn.textContent;
  copyBtn.textContent = "Copied!";
  setTimeout(() => (copyBtn.textContent = original), 1200);
});

restoreActiveTemplate();

function restoreActiveTemplate(): void {
  const saved = getActiveSelection();
  renderSavedOptions();
  if (!saved) {
    renderTemplateInfo();
    return;
  }
  if (saved.startsWith("custom:")) {
    const id = saved.slice("custom:".length);
    const match = loadSavedTemplates().find((s) => s.template.id === id);
    if (match) {
      setActiveTemplate(match.template, saved, { persist: false });
      return;
    }
  } else if (BUNDLED_TEMPLATES[saved]) {
    setActiveTemplate(BUNDLED_TEMPLATES[saved], saved);
    return;
  }
  renderTemplateInfo();
}

// ---------------------------------------------------------------------------
// Infer panel

const inferIdInput = document.querySelector<HTMLInputElement>("#infer-id")!;
const inferNameInput = document.querySelector<HTMLInputElement>("#infer-name")!;
const inferDialectSelect = document.querySelector<HTMLSelectElement>("#infer-dialect")!;
const inferBaseSelect = document.querySelector<HTMLSelectElement>("#infer-base")!;
const inferBtn = document.querySelector<HTMLButtonElement>("#infer-btn")!;
const useTemplateBtn = document.querySelector<HTMLButtonElement>("#use-template-btn")!;
const inferError = document.querySelector<HTMLElement>("#infer-error")!;
const inferInput = document.querySelector<HTMLTextAreaElement>("#infer-input")!;
const inferOutput = document.querySelector<HTMLElement>("#infer-output")!;
const inferWarnings = document.querySelector<HTMLElement>("#infer-warnings")!;

let lastInferResult: InferResult | null = null;

function showInferError(message: string | null): void {
  if (message) {
    inferError.textContent = message;
    inferError.classList.add("visible");
  } else {
    inferError.textContent = "";
    inferError.classList.remove("visible");
  }
}

inferBtn.addEventListener("click", () => {
  const sql = inferInput.value;
  const id = inferIdInput.value.trim();
  const name = inferNameInput.value.trim();
  if (!sql.trim()) return showInferError("Paste an example SQL script first.");
  if (!id || !name) return showInferError("Id and name are required.");

  try {
    const result = inferStyleTemplate(sql, {
      id,
      name,
      dialect: inferDialectSelect.value as Dialect,
      baseTemplate: BUNDLED_TEMPLATES[inferBaseSelect.value],
    });
    lastInferResult = result;
    inferOutput.textContent = JSON.stringify(result.template, null, 2);
    inferWarnings.innerHTML = result.warnings.length
      ? `<strong>Low-confidence fields — review by hand:</strong><ul>${result.warnings
          .map((w) => `<li class="confidence-low">${escapeHtml(w)}</li>`)
          .join("")}</ul>`
      : "No warnings — every field found a confident signal in the example.";
    useTemplateBtn.disabled = false;
    showInferError(null);
  } catch (err) {
    lastInferResult = null;
    useTemplateBtn.disabled = true;
    showInferError(err instanceof Error ? err.message : String(err));
  }
});

useTemplateBtn.addEventListener("click", () => {
  if (!lastInferResult) return;
  const template = lastInferResult.template;
  setActiveTemplate(template, `custom:${template.id}`, { customLabel: template.name });
  sqlInput.value = inferInput.value;
  activateTab("format");
  runFormat();
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------------------------------------------------------------------------
// Advise panel — heuristic query advisor, not a query optimizer. Runs
// entirely client-side against @sql-formatter/core, same as everything
// else here: no server, no database connection, ever.

const adviseInput = document.querySelector<HTMLTextAreaElement>("#advise-input")!;
const adviseOutput = document.querySelector<HTMLElement>("#advise-output")!;
const adviseError = document.querySelector<HTMLElement>("#advise-error")!;
const adviseBtn = document.querySelector<HTMLButtonElement>("#advise-btn")!;
const uploadStatsBtn = document.querySelector<HTMLButtonElement>("#upload-stats-btn")!;
const statsFileInput = document.querySelector<HTMLInputElement>("#stats-file")!;
const clearStatsBtn = document.querySelector<HTMLButtonElement>("#clear-stats-btn")!;
const statsInfo = document.querySelector<HTMLElement>("#stats-info")!;

let loadedStats: TableStats | null = null;

function showAdviseError(message: string | null): void {
  if (message) {
    adviseError.textContent = message;
    adviseError.classList.add("visible");
  } else {
    adviseError.textContent = "";
    adviseError.classList.remove("visible");
  }
}

function renderStatsInfo(): void {
  if (!loadedStats) {
    statsInfo.textContent = "No stats loaded — structural checks only";
    clearStatsBtn.hidden = true;
    return;
  }
  const tableCount = Object.keys(loadedStats.tables ?? {}).length;
  statsInfo.textContent = `${loadedStats.id} · ${loadedStats.dialect} · ${tableCount} table${tableCount === 1 ? "" : "s"}`;
  clearStatsBtn.hidden = false;
}

function renderSuggestions(suggestions: Suggestion[]): void {
  if (suggestions.length === 0) {
    adviseOutput.innerHTML = `<p class="advise-empty">No suggestions${
      loadedStats ? "" : " — structural checks only. Upload table stats to also check join order and indexing."
    }</p>`;
    return;
  }
  adviseOutput.innerHTML = suggestions
    .map(
      (s) => `
        <div class="suggestion">
          <span class="kind">${escapeHtml(s.kind)}</span>
          <span class="stmt-index">statement ${s.statementIndex + 1}</span>
          <p class="message">${escapeHtml(s.message)}</p>
          ${s.preview ? `<pre>${escapeHtml(s.preview)}</pre>` : ""}
        </div>`,
    )
    .join("");
}

uploadStatsBtn.addEventListener("click", () => statsFileInput.click());

statsFileInput.addEventListener("change", async () => {
  const file = statsFileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as TableStats;
    if (!parsed?.tables) throw new Error("Not a valid table-stats file (missing `tables`).");
    loadedStats = parsed;
    renderStatsInfo();
    showAdviseError(null);
  } catch (err) {
    showAdviseError(`Couldn't load stats: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    statsFileInput.value = "";
  }
});

clearStatsBtn.addEventListener("click", () => {
  loadedStats = null;
  renderStatsInfo();
});

adviseBtn.addEventListener("click", () => {
  const sql = adviseInput.value;
  if (!sql.trim()) return showAdviseError("Paste some SQL to analyze first.");
  try {
    const result = advise(sql, loadedStats, activeTemplate);
    renderSuggestions(result.suggestions);
    showAdviseError(null);
  } catch (err) {
    showAdviseError(err instanceof Error ? err.message : String(err));
  }
});

renderStatsInfo();

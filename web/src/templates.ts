import type { StyleTemplate } from "@sql-formatter/core";

import defaultTemplate from "../../templates/default.json";
import compactTemplate from "../../templates/compact.json";
import riverTemplate from "../../templates/river.json";

export const BUNDLED_TEMPLATES: Record<string, StyleTemplate> = {
  default: defaultTemplate as StyleTemplate,
  compact: compactTemplate as StyleTemplate,
  river: riverTemplate as StyleTemplate,
};

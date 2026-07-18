#!/usr/bin/env node

import { loadModelSelector } from "./model-selector.mjs";

const selectorPath = process.argv[2] || process.env.AGENT_BUS_SELECTOR_PATH;
const selector = await loadModelSelector(selectorPath);
const result = {
  status: selector.status,
  selector_path: selector.selector_path,
  schema_version: selector.schema_version,
  last_verified: selector.last_verified || null,
  next_review: selector.next_review || null,
  summary: selector.summary,
  warnings: selector.warnings,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (selector.status !== "current" || selector.warnings.length > 0) process.exitCode = 1;

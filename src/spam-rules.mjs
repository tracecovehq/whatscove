import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_RULES_PATH = path.join(PACKAGE_ROOT, "config", "spam-rules.json");

function asNonEmptyString(value, fieldName, ruleId = "unknown-rule") {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Spam rule ${ruleId} is missing a valid ${fieldName}.`);
  }

  return value.trim();
}

function normalizeRule(rawRule, index) {
  const fallbackId = `rule-${index + 1}`;
  const id = asNonEmptyString(rawRule?.id ?? fallbackId, "id", fallbackId);
  const label = asNonEmptyString(rawRule?.label ?? id, "label", id);
  const template = asNonEmptyString(rawRule?.template, "template", id);
  const anchorPhrases = Array.isArray(rawRule?.anchorPhrases)
    ? rawRule.anchorPhrases
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];

  return {
    id,
    label,
    template,
    anchorPhrases,
    minScore: Number.isFinite(Number(rawRule?.minScore)) ? Number(rawRule.minScore) : undefined,
    requireInviteLink: rawRule?.requireInviteLink === true,
    tags: Array.isArray(rawRule?.tags)
      ? rawRule.tags.filter((value) => typeof value === "string" && value.trim().length > 0)
      : []
  };
}

export async function loadSpamRules(options = {}) {
  const rulesPath = options.rulesPath || DEFAULT_RULES_PATH;
  const rawText = await readFile(rulesPath, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Failed to parse spam rules at ${rulesPath}: ${error.message}`);
  }

  if (!Array.isArray(parsed?.rules) || parsed.rules.length === 0) {
    throw new Error(`Spam rules at ${rulesPath} must contain a non-empty "rules" array.`);
  }

  const rules = parsed.rules.map(normalizeRule);
  return {
    rulesPath,
    rules
  };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
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

function slugifyRuleId(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
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

async function readRulesDocument(rulesPath) {
  try {
    const rawText = await readFile(rulesPath, "utf8");
    try {
      return JSON.parse(rawText);
    } catch (error) {
      throw new Error(`Failed to parse spam rules at ${rulesPath}: ${error.message}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        version: 1,
        rules: []
      };
    }

    throw error;
  }
}

export async function loadSpamRules(options = {}) {
  const rulesPath = options.rulesPath || DEFAULT_RULES_PATH;
  const parsed = await readRulesDocument(rulesPath);

  if (!Array.isArray(parsed?.rules) || parsed.rules.length === 0) {
    throw new Error(`Spam rules at ${rulesPath} must contain a non-empty "rules" array.`);
  }

  const rules = parsed.rules.map(normalizeRule);
  return {
    rulesPath,
    rules
  };
}

export function buildSpamRule(input) {
  const label = asNonEmptyString(input?.label, "label");
  const template = asNonEmptyString(input?.template, "template", label);
  const id = asNonEmptyString(input?.id ?? slugifyRuleId(label), "id", label);
  const anchorPhrases = Array.isArray(input?.anchorPhrases)
    ? input.anchorPhrases
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];

  return normalizeRule(
    {
      id,
      label,
      template,
      anchorPhrases,
      minScore: input?.minScore,
      requireInviteLink: input?.requireInviteLink,
      tags: input?.tags
    },
    0
  );
}

export async function appendSpamRule(input, options = {}) {
  const rulesPath = options.rulesPath || DEFAULT_RULES_PATH;
  const document = await readRulesDocument(rulesPath);
  const rules = Array.isArray(document?.rules) ? document.rules : [];
  const rule = buildSpamRule(input);

  if (rules.some((existingRule) => existingRule?.id === rule.id)) {
    throw new Error(`Spam rules at ${rulesPath} already contain a rule with id "${rule.id}".`);
  }

  const nextDocument = {
    version: Number.isFinite(Number(document?.version)) ? Number(document.version) : 1,
    rules: [...rules, rule]
  };

  await mkdir(path.dirname(rulesPath), { recursive: true });
  await writeFile(rulesPath, `${JSON.stringify(nextDocument, null, 2)}\n`);

  return {
    rulesPath,
    rule,
    ruleCount: nextDocument.rules.length
  };
}

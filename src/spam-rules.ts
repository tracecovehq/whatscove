import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  AddSpamRuleInput,
  AppendSpamRuleResult,
  LoadSpamRulesResult,
  SpamRule
} from "./types.ts";

interface SpamRulesDocument {
  version: number;
  rules: unknown[];
}

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_RULES_PATH = path.join(PACKAGE_ROOT, "config", "spam-rules.json");

function asNonEmptyString(value: unknown, fieldName: string, ruleId = "unknown-rule"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Spam rule ${ruleId} is missing a valid ${fieldName}.`);
  }

  return value.trim();
}

function slugifyRuleId(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function normalizeRule(rawRule: Partial<SpamRule> & Record<string, unknown>, index: number): SpamRule {
  const fallbackId = `rule-${index + 1}`;
  const id = asNonEmptyString(rawRule.id ?? fallbackId, "id", fallbackId);
  const label = asNonEmptyString(rawRule.label ?? id, "label", id);
  const template = asNonEmptyString(rawRule.template, "template", id);
  const anchorPhrases = Array.isArray(rawRule.anchorPhrases)
    ? rawRule.anchorPhrases
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  const rawMinScore = rawRule.minScore;
  const minScore =
    typeof rawMinScore === "number" && Number.isFinite(rawMinScore)
      ? rawMinScore
      : undefined;

  return {
    id,
    label,
    template,
    anchorPhrases,
    minScore,
    requireInviteLink: rawRule.requireInviteLink === true,
    tags: Array.isArray(rawRule.tags)
      ? rawRule.tags.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : []
  };
}

async function readRulesDocument(rulesPath: string): Promise<SpamRulesDocument> {
  try {
    const rawText = await readFile(rulesPath, "utf8");
    try {
      return JSON.parse(rawText) as SpamRulesDocument;
    } catch (error) {
      throw new Error(`Failed to parse spam rules at ${rulesPath}: ${(error as Error).message}`);
    }
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") {
      return {
        version: 1,
        rules: []
      };
    }

    throw error;
  }
}

export async function loadSpamRules(options: { rulesPath?: string } = {}): Promise<LoadSpamRulesResult> {
  const rulesPath = options.rulesPath || DEFAULT_RULES_PATH;
  const parsed = await readRulesDocument(rulesPath);

  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw new Error(`Spam rules at ${rulesPath} must contain a non-empty "rules" array.`);
  }

  const rules = parsed.rules.map((rule, index) =>
    normalizeRule((rule ?? {}) as Partial<SpamRule> & Record<string, unknown>, index)
  );

  return {
    rulesPath,
    rules
  };
}

export function buildSpamRule(input: AddSpamRuleInput): SpamRule {
  const label = asNonEmptyString(input.label, "label");
  const template = asNonEmptyString(input.template, "template", label);
  const id = asNonEmptyString(input.id ?? slugifyRuleId(label), "id", label);
  const anchorPhrases = Array.isArray(input.anchorPhrases)
    ? input.anchorPhrases
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];

  return normalizeRule(
    {
      id,
      label,
      template,
      anchorPhrases,
      minScore: input.minScore,
      requireInviteLink: input.requireInviteLink,
      tags: input.tags
    },
    0
  );
}

export async function appendSpamRule(
  input: AddSpamRuleInput,
  options: { rulesPath?: string } = {}
): Promise<AppendSpamRuleResult> {
  const rulesPath = options.rulesPath || DEFAULT_RULES_PATH;
  const document = await readRulesDocument(rulesPath);
  const rules = Array.isArray(document.rules) ? document.rules : [];
  const rule = buildSpamRule(input);

  if (rules.some((existingRule) => (existingRule as Partial<SpamRule>)?.id === rule.id)) {
    throw new Error(`Spam rules at ${rulesPath} already contain a rule with id "${rule.id}".`);
  }

  const nextDocument = {
    version: Number.isFinite(document.version) ? document.version : 1,
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

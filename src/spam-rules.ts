import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readStructuredConfig, writeStructuredConfig } from "./config-format.ts";
import type {
  AddSpamRuleInput,
  AppendSpamRuleResult,
  LoadSpamRulesResult,
  SpamSignalBucket,
  SpamRule
} from "./types.ts";

interface SpamRulesDocument {
  version: number;
  rules: unknown[];
}

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_RULES_BASE_PATH = path.join(PACKAGE_ROOT, "config", "spam-rules");

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

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
}

function normalizeSignalBuckets(value: unknown, ruleId: string): SpamSignalBucket[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const rawBucket = entry as Partial<SpamSignalBucket> & Record<string, unknown>;
    const terms = normalizeStringList(rawBucket.terms);
    if (terms.length === 0) {
      return [];
    }

    return [
      {
        name: asNonEmptyString(rawBucket.name ?? `${ruleId}-bucket-${index + 1}`, "signal bucket name", ruleId),
        terms
      }
    ];
  });
}

function normalizeRule(rawRule: Partial<SpamRule> & Record<string, unknown>, index: number): SpamRule {
  const fallbackId = `rule-${index + 1}`;
  const id = asNonEmptyString(rawRule.id ?? fallbackId, "id", fallbackId);
  const label = asNonEmptyString(rawRule.label ?? id, "label", id);
  const template = asNonEmptyString(rawRule.template, "template", id);
  const examples = normalizeStringList(rawRule.examples);
  const anchorPhrases = normalizeStringList(rawRule.anchorPhrases);
  const signalBuckets = normalizeSignalBuckets(rawRule.signalBuckets, id);
  const rawMinScore = rawRule.minScore;
  const minScore =
    typeof rawMinScore === "number" && Number.isFinite(rawMinScore)
      ? rawMinScore
      : undefined;

  return {
    id,
    label,
    template,
    examples,
    anchorPhrases,
    signalBuckets,
    minScore,
    requireInviteLink: rawRule.requireInviteLink === true,
    tags: normalizeStringList(rawRule.tags)
  };
}

async function readRulesDocument(rulesPath: string): Promise<SpamRulesDocument> {
  try {
    const { data } = await readStructuredConfig<SpamRulesDocument>(DEFAULT_RULES_BASE_PATH, rulesPath);
    return data;
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
  const { configPath } = await readStructuredConfig<SpamRulesDocument>(
    DEFAULT_RULES_BASE_PATH,
    options.rulesPath
  );
  const parsed = await readRulesDocument(configPath);

  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw new Error(`Spam rules at ${configPath} must contain a non-empty "rules" array.`);
  }

  const rules = parsed.rules.map((rule, index) =>
    normalizeRule((rule ?? {}) as Partial<SpamRule> & Record<string, unknown>, index)
  );

  return {
    rulesPath: configPath,
    rules
  };
}

export function buildSpamRule(input: AddSpamRuleInput): SpamRule {
  const label = asNonEmptyString(input.label, "label");
  const template = asNonEmptyString(input.template, "template", label);
  const id = asNonEmptyString(input.id ?? slugifyRuleId(label), "id", label);
  const anchorPhrases = normalizeStringList(input.anchorPhrases);

  return normalizeRule(
    {
      id,
      label,
      template,
      examples: input.examples,
      anchorPhrases,
      signalBuckets: input.signalBuckets,
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
  const { configPath } = await readStructuredConfig<SpamRulesDocument>(
    DEFAULT_RULES_BASE_PATH,
    options.rulesPath
  ).catch((error) => {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") {
      return {
        configPath: options.rulesPath || `${DEFAULT_RULES_BASE_PATH}.json`,
        format: "json" as const,
        data: {
          version: 1,
          rules: []
        }
      };
    }
    throw error;
  });
  const document = await readRulesDocument(configPath);
  const rules = Array.isArray(document.rules) ? document.rules : [];
  const rule = buildSpamRule(input);

  if (rules.some((existingRule) => (existingRule as Partial<SpamRule>)?.id === rule.id)) {
    throw new Error(`Spam rules at ${configPath} already contain a rule with id "${rule.id}".`);
  }

  const nextDocument = {
    version: Number.isFinite(document.version) ? document.version : 1,
    rules: [...rules, rule]
  };

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeStructuredConfig(configPath, nextDocument);

  return {
    rulesPath: configPath,
    rule,
    ruleCount: nextDocument.rules.length
  };
}

import { loadSpamRules } from "./spam-rules.ts";
import type { DetectionResult, SpamDetectionOptions, SpamRule } from "./types.ts";

const INVITE_LINK_RE = /\b(?:https?:\/\/)?(?:chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.me\/\S+)\b/i;
const URL_RE =
  /\b(?:https?:\/\/)?(?:chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.me\/\S+|www\.\S+|\S+\.\S{2,})\b/gi;

function stripUrls(text: string): string {
  return text.replace(URL_RE, " ");
}

export function normalizeText(text: string): string {
  return stripUrls(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function toTokenSet(text: string): Set<string> {
  return new Set(normalizeText(text).split(" ").filter(Boolean));
}

function overlapRatio(candidateText: string, templateText: string): number {
  const candidateTokens = toTokenSet(candidateText);
  const templateTokens = toTokenSet(templateText);
  const overlap = [...templateTokens].filter((token) => candidateTokens.has(token)).length;
  return templateTokens.size === 0 ? 0 : overlap / templateTokens.size;
}

function ngramSet(text: string, size = 5): Set<string> {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  if (!normalized) {
    return new Set();
  }

  if (normalized.length <= size) {
    return new Set([normalized]);
  }

  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function jaccardSimilarity(left: string, right: string): number {
  const leftSet = ngramSet(left);
  const rightSet = ngramSet(right);
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const gram of leftSet) {
    if (rightSet.has(gram)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function phraseHits(text: string, anchorPhrases: string[]): string[] {
  const normalized = normalizeText(text);
  return anchorPhrases.filter((phrase) => normalized.includes(normalizeText(phrase)));
}

export function scoreTextAgainstRule(
  text: string,
  rule: SpamRule,
  options: SpamDetectionOptions = {}
): DetectionResult {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return {
      matched: false,
      score: 0,
      reasons: [],
      ruleId: rule.id,
      ruleLabel: rule.label
    };
  }

  const minScore = Number(options.minScore ?? rule.minScore ?? 0.72);
  const hasInviteLink = INVITE_LINK_RE.test(trimmed);
  const tokenCoverage = overlapRatio(trimmed, rule.template);
  const charSimilarity = jaccardSimilarity(trimmed, rule.template);
  const matchedPhrases = phraseHits(trimmed, rule.anchorPhrases ?? []);
  const phraseCoverage =
    matchedPhrases.length === 0 || rule.anchorPhrases.length === 0
      ? 0
      : matchedPhrases.length / rule.anchorPhrases.length;
  const score = Math.min(
    0.99,
    tokenCoverage * 0.55 +
      charSimilarity * 0.25 +
      phraseCoverage * 0.15 +
      (hasInviteLink ? 0.05 : 0)
  );

  const matched =
    (!rule.requireInviteLink || hasInviteLink) &&
    (score >= minScore ||
      tokenCoverage >= 0.8 ||
      (tokenCoverage >= 0.62 && matchedPhrases.length >= 4) ||
      (tokenCoverage >= 0.55 && matchedPhrases.length >= 5 && hasInviteLink) ||
      (tokenCoverage >= 0.5 && matchedPhrases.length >= 4 && hasInviteLink));

  const reasons: string[] = [];
  if (hasInviteLink) {
    reasons.push("contains a WhatsApp invite link");
  }
  if (tokenCoverage >= 0.55) {
    reasons.push(
      `covers ${(tokenCoverage * 100).toFixed(0)}% of the known ${rule.label.toLowerCase()} vocabulary`
    );
  }
  if (matchedPhrases.length > 0) {
    reasons.push(`matches ${matchedPhrases.length} ${rule.label.toLowerCase()} anchor phrase(s)`);
  }
  if (rule.requireInviteLink) {
    reasons.push("rule prefers messages that include an invite link");
  }

  return {
    matched,
    score,
    reasons,
    ruleId: rule.id,
    ruleLabel: rule.label,
    details: {
      hasInviteLink,
      tokenCoverage,
      charSimilarity,
      matchedPhrases,
      ruleId: rule.id,
      ruleLabel: rule.label,
      tags: rule.tags ?? []
    }
  };
}

let cachedDefaultRulesPromise: Promise<SpamRule[]> | undefined;

export async function getDefaultSpamRules(): Promise<SpamRule[]> {
  cachedDefaultRulesPromise ||= loadSpamRules()
    .then((loaded) => loaded.rules)
    .catch((error) => {
      cachedDefaultRulesPromise = undefined;
      throw error;
    });
  return cachedDefaultRulesPromise;
}

export async function detectSpam(
  text: string,
  options: SpamDetectionOptions = {}
): Promise<DetectionResult> {
  const rules = options.rules ?? (await getDefaultSpamRules());
  let bestResult: DetectionResult | null = null;

  for (const rule of rules) {
    const result = scoreTextAgainstRule(text, rule, options);
    if (!bestResult || result.score > bestResult.score) {
      bestResult = result;
    }
  }

  return (
    bestResult ?? {
      matched: false,
      score: 0,
      reasons: []
    }
  );
}

export async function detectStockSpam(
  text: string,
  options: SpamDetectionOptions = {}
): Promise<DetectionResult> {
  const rules = options.rules ?? (await getDefaultSpamRules());
  if (rules.length === 0) {
    return {
      matched: false,
      score: 0,
      reasons: []
    };
  }
  const stockRule = rules.find((rule) => rule.id === "us-stock-group-invite") ?? rules[0];
  return scoreTextAgainstRule(text, stockRule, options);
}

export function createTextCandidates(row: {
  value?: string | null;
  name?: string | null;
  description?: string | null;
}): string[] {
  const values = [row.value, row.name, row.description]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length >= 40);

  return [...new Set(values)];
}

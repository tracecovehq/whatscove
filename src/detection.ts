import { loadSpamRules } from "./spam-rules.ts";
import type { DetectionResult, SpamDetectionOptions, SpamRule } from "./types.ts";

const INVITE_LINK_RE = /\b(?:https?:\/\/)?(?:chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.me\/\S+)\b/i;
const URL_RE =
  /\b(?:https?:\/\/)?(?:chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.me\/\S+|www\.\S+|\S+\.\S{2,})\b/gi;
const MIN_CANDIDATE_LENGTH = 12;

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

function normalizeTokens(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

function toTokenSet(text: string): Set<string> {
  return new Set(normalizeTokens(text));
}

function harmonicMean(left: number, right: number): number {
  if (left <= 0 || right <= 0) {
    return 0;
  }

  return (2 * left * right) / (left + right);
}

function overlapMetrics(candidateText: string, exemplarText: string): {
  recall: number;
  precision: number;
  balanced: number;
} {
  const candidateTokens = toTokenSet(candidateText);
  const exemplarTokens = toTokenSet(exemplarText);
  const overlap = [...exemplarTokens].filter((token) => candidateTokens.has(token)).length;
  const recall = exemplarTokens.size === 0 ? 0 : overlap / exemplarTokens.size;
  const precision = candidateTokens.size === 0 ? 0 : overlap / candidateTokens.size;

  return {
    recall,
    precision,
    balanced: harmonicMean(recall, precision)
  };
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

function getRuleExemplars(rule: SpamRule): string[] {
  return [...new Set([rule.template, ...(rule.examples ?? [])].filter(Boolean))];
}

function getBestExemplarMatch(text: string, rule: SpamRule): {
  exemplar: string;
  recall: number;
  precision: number;
  balanced: number;
  charSimilarity: number;
} {
  const exemplars = getRuleExemplars(rule);
  let best = {
    exemplar: rule.template,
    recall: 0,
    precision: 0,
    balanced: 0,
    charSimilarity: 0
  };
  let bestScore = -1;

  for (const exemplar of exemplars) {
    const overlap = overlapMetrics(text, exemplar);
    const charSimilarity = jaccardSimilarity(text, exemplar);
    const exemplarScore =
      overlap.balanced * 0.45 +
      overlap.recall * 0.25 +
      overlap.precision * 0.2 +
      charSimilarity * 0.1;

    if (exemplarScore > bestScore) {
      bestScore = exemplarScore;
      best = {
        exemplar,
        recall: overlap.recall,
        precision: overlap.precision,
        balanced: overlap.balanced,
        charSimilarity
      };
    }
  }

  return best;
}

function phraseSimilarity(candidateTokens: string[], candidateNormalized: string, phrase: string): number {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) {
    return 0;
  }

  if (candidateNormalized.includes(normalizedPhrase)) {
    return 1;
  }

  const phraseTokens = normalizedPhrase.split(" ").filter(Boolean);
  if (phraseTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }

  const minWindow = Math.max(1, phraseTokens.length - 2);
  const maxWindow = Math.min(candidateTokens.length, phraseTokens.length + 2);
  let best = 0;

  for (let windowSize = minWindow; windowSize <= maxWindow; windowSize += 1) {
    for (let start = 0; start <= candidateTokens.length - windowSize; start += 1) {
      const window = candidateTokens.slice(start, start + windowSize).join(" ");
      const overlap = overlapMetrics(window, normalizedPhrase);
      const charSimilarity = jaccardSimilarity(window, normalizedPhrase);
      const score = overlap.balanced * 0.75 + charSimilarity * 0.25;
      if (score > best) {
        best = score;
      }
    }
  }

  return best;
}

function phraseHitThreshold(phrase: string): number {
  const length = normalizeTokens(phrase).length;
  if (length <= 2) {
    return 0.84;
  }
  if (length <= 4) {
    return 0.8;
  }

  return 0.76;
}

function phraseHits(text: string, anchorPhrases: string[]): string[] {
  const normalized = normalizeText(text);
  const tokens = normalizeTokens(text);
  return anchorPhrases.filter(
    (phrase) => phraseSimilarity(tokens, normalized, phrase) >= phraseHitThreshold(phrase)
  );
}

function matchedSignalBuckets(text: string, rule: SpamRule): string[] {
  const normalized = normalizeText(text);
  const tokens = normalizeTokens(text);

  return (rule.signalBuckets ?? [])
    .filter((bucket) =>
      bucket.terms.some((term) => phraseSimilarity(tokens, normalized, term) >= phraseHitThreshold(term))
    )
    .map((bucket) => bucket.name);
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
  const exemplarMatch = getBestExemplarMatch(trimmed, rule);
  const tokenCoverage = exemplarMatch.recall;
  const tokenPrecision = exemplarMatch.precision;
  const balancedCoverage = exemplarMatch.balanced;
  const charSimilarity = exemplarMatch.charSimilarity;
  const matchedPhrases = phraseHits(trimmed, rule.anchorPhrases ?? []);
  const phraseCoverage =
    matchedPhrases.length === 0 || rule.anchorPhrases.length === 0
      ? 0
      : matchedPhrases.length / rule.anchorPhrases.length;
  const matchedBuckets = matchedSignalBuckets(trimmed, rule);
  const signalCoverage =
    matchedBuckets.length === 0 || rule.signalBuckets.length === 0
      ? 0
      : matchedBuckets.length / rule.signalBuckets.length;
  const candidateTokenCount = normalizeTokens(trimmed).length;
  const isShortMessage = candidateTokenCount <= 18;

  const score = Math.min(
    0.99,
    tokenCoverage * (isShortMessage ? 0.2 : 0.32) +
      tokenPrecision * (isShortMessage ? 0.2 : 0.08) +
      balancedCoverage * (isShortMessage ? 0.26 : 0.18) +
      charSimilarity * 0.1 +
      phraseCoverage * 0.14 +
      signalCoverage * 0.12 +
      (hasInviteLink ? 0.05 : 0)
  );

  const matched =
    (!rule.requireInviteLink || hasInviteLink) &&
    (score >= minScore ||
      tokenCoverage >= 0.8 ||
      balancedCoverage >= 0.78 ||
      (balancedCoverage >= 0.68 && matchedPhrases.length >= 2) ||
      (signalCoverage >= 1 && balancedCoverage >= 0.42) ||
      (signalCoverage >= 2 / 3 && balancedCoverage >= 0.52) ||
      (isShortMessage && tokenPrecision >= 0.72 && (matchedPhrases.length >= 2 || signalCoverage >= 1)) ||
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
  if (isShortMessage && tokenPrecision >= 0.7) {
    reasons.push(
      `looks like a concise paraphrase of the ${rule.label.toLowerCase()} pitch`
    );
  }
  if (matchedPhrases.length > 0) {
    reasons.push(`matches ${matchedPhrases.length} ${rule.label.toLowerCase()} anchor phrase(s)`);
  }
  if (matchedBuckets.length > 0) {
    reasons.push(`matches ${matchedBuckets.length} ${rule.label.toLowerCase()} intent bucket(s)`);
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
      tokenPrecision,
      balancedCoverage,
      charSimilarity,
      matchedPhrases,
      matchedSignalBuckets: matchedBuckets,
      matchedExample: exemplarMatch.exemplar,
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
    .filter((value) => value.length >= MIN_CANDIDATE_LENGTH);

  return [...new Set(values)];
}

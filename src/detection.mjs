const STOCK_SPAM_TEMPLATE = `This is a group for sharing US stock knowledge and information for free. Here, you can view the latest information of various stocks. In order to avoid investment risks and obtain greater returns, you can also learn about the real US stock investment market information here. At the same time, you can also learn more rich investment experience and skills in the group. If you are investing in US stocks, or you are a US stock enthusiast, welcome to join this group`;

const INVITE_LINK_RE = /\b(?:https?:\/\/)?(?:chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.me\/\S+)\b/i;
const URL_RE = /\b(?:https?:\/\/)?(?:chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.me\/\S+|www\.\S+|\S+\.\S{2,})\b/gi;
const ANCHOR_PHRASES = [
  "us stock knowledge",
  "latest information of various stocks",
  "avoid investment risks",
  "greater returns",
  "real us stock investment market information",
  "investment experience and skills",
  "investing in us stocks",
  "us stock enthusiast",
  "welcome to join this group"
];

function stripUrls(text) {
  return text.replace(URL_RE, " ");
}

export function normalizeText(text) {
  return stripUrls(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function toTokenSet(text) {
  return new Set(normalizeText(text).split(" ").filter(Boolean));
}

function overlapRatio(candidateText, templateText) {
  const candidateTokens = toTokenSet(candidateText);
  const templateTokens = toTokenSet(templateText);
  const overlap = [...templateTokens].filter((token) => candidateTokens.has(token)).length;
  return templateTokens.size === 0 ? 0 : overlap / templateTokens.size;
}

function ngramSet(text, size = 5) {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  if (!normalized) {
    return new Set();
  }

  if (normalized.length <= size) {
    return new Set([normalized]);
  }

  const grams = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function jaccardSimilarity(left, right) {
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

function phraseHits(text) {
  const normalized = normalizeText(text);
  return ANCHOR_PHRASES.filter((phrase) => normalized.includes(normalizeText(phrase)));
}

export function detectStockSpam(text, options = {}) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return {
      matched: false,
      score: 0,
      reasons: []
    };
  }

  const minScore = Number(options.minScore ?? 0.72);
  const hasInviteLink = INVITE_LINK_RE.test(trimmed);
  const tokenCoverage = overlapRatio(trimmed, STOCK_SPAM_TEMPLATE);
  const charSimilarity = jaccardSimilarity(trimmed, STOCK_SPAM_TEMPLATE);
  const matchedPhrases = phraseHits(trimmed);
  const phraseCoverage = matchedPhrases.length / ANCHOR_PHRASES.length;
  const score = Math.min(
    0.99,
    tokenCoverage * 0.55 +
      charSimilarity * 0.25 +
      phraseCoverage * 0.15 +
      (hasInviteLink ? 0.05 : 0)
  );

  const matched =
    score >= minScore ||
    tokenCoverage >= 0.8 ||
    (tokenCoverage >= 0.62 && matchedPhrases.length >= 4) ||
    (tokenCoverage >= 0.55 && matchedPhrases.length >= 5 && hasInviteLink) ||
    (tokenCoverage >= 0.5 && matchedPhrases.length >= 4 && hasInviteLink);

  const reasons = [];
  if (hasInviteLink) {
    reasons.push("contains a WhatsApp invite link");
  }
  if (tokenCoverage >= 0.55) {
    reasons.push(`covers ${(tokenCoverage * 100).toFixed(0)}% of the known stock-spam vocabulary`);
  }
  if (matchedPhrases.length > 0) {
    reasons.push(`matches ${matchedPhrases.length} stock-promo anchor phrase(s)`);
  }

  return {
    matched,
    score,
    reasons,
    details: {
      hasInviteLink,
      tokenCoverage,
      charSimilarity,
      matchedPhrases
    }
  };
}

export function createTextCandidates(row) {
  const values = [row?.value, row?.name, row?.description]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length >= 40);

  return [...new Set(values)];
}

export { STOCK_SPAM_TEMPLATE };

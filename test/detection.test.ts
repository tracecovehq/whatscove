import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findSuspiciousEntries,
  formatScanOutput,
  formatWeakScanOutput,
  sortMatchesChronologically
} from "../src/bot.ts";
import {
  createTextCandidates,
  detectSpam,
  detectStockSpam,
  getDefaultSpamRules,
  normalizeText
} from "../src/detection.ts";
import { coerceFixtureSnapshot } from "../src/fixture.ts";
import {
  getActionsForMatch,
  getBundledHookCommand,
  getBundledHookEnvironment,
  planModerationDecisions,
  shouldRetryModerationError
} from "../src/moderation.ts";
import {
  DEFAULT_MODERATION_SCREENSHOT_DIR,
  loadModerationPolicy
} from "../src/moderation-policy.ts";
import { appendSpamRule, buildSpamRule, loadSpamRules } from "../src/spam-rules.ts";
import type {
  MessageSnapshot,
  ModerationDecision,
  ModerationPolicy,
  SpamRule,
  SuspiciousMatch
} from "../src/types.ts";

const STOCK_SPAM_TEMPLATE =
  "This is a group for sharing US stock knowledge and information for free. Here, you can view the latest information of various stocks. In order to avoid investment risks and obtain greater returns, you can also learn about the real US stock investment market information here. At the same time, you can also learn more rich investment experience and skills in the group. If you are investing in US stocks, or you are a US stock enthusiast, welcome to join this group";

const CUSTOM_RULES: SpamRule[] = [
  {
    id: "crypto-signal-promo",
    label: "Crypto signal promo",
    template:
      "Join our free crypto signal team to get the latest bitcoin and altcoin trading signals, market updates, and profit strategies every day.",
    examples: ["Free crypto signal team. Join us for daily bitcoin calls and market updates."],
    anchorPhrases: [
      "free crypto signal team",
      "latest bitcoin and altcoin trading signals",
      "market updates",
      "profit strategies every day"
    ],
    signalBuckets: [
      {
        name: "crypto-topic",
        terms: ["crypto signal", "bitcoin", "altcoin"]
      },
      {
        name: "promo-language",
        terms: ["market updates", "profit strategies", "daily calls"]
      },
      {
        name: "group-invite-cta",
        terms: ["join us", "join our team"]
      }
    ],
    structuralPatterns: [],
    minScore: 0.68,
    requireInviteLink: true,
    tags: ["crypto", "promo"]
  }
];

test("normalizeText strips links and punctuation", () => {
  assert.equal(normalizeText("Hello! https://chat.whatsapp.com/AbCd1234"), "hello");
});

test("detectStockSpam matches the exact stock spam template with a WhatsApp link", async () => {
  const result = await detectStockSpam(
    `${STOCK_SPAM_TEMPLATE} https://chat.whatsapp.com/BDcmXzyI8k17STFbj3ruZ`
  );

  assert.equal(result.matched, true);
  assert.ok(result.score >= 0.9);
});

test("detectStockSpam matches a paraphrased stock spam pitch", async () => {
  const result = await detectStockSpam(
    "Free US stock knowledge group. Learn the latest stock information, avoid investment risks, get greater returns, and pick up more investment experience and skills here. If you invest in US stocks, welcome to join our group: https://chat.whatsapp.com/XYZ"
  );

  assert.equal(result.matched, true);
  assert.ok((result.details?.matchedPhrases.length ?? 0) >= 4);
});

test("detectStockSpam matches broad investment asset-list invite spam", async () => {
  const result = await detectStockSpam(
    "This is a group that shares hot investment information for free every day, including (stocks, options, funds, bonds, foreign exchange, cryptocurrencies, etc.). Here you can get more investment information and knowledge and skills, which can help your investment go more smoothly. Investment enthusiasts are welcome to join.\nhttps://chat.whatsapp.com/EdW3Vs4bZnILXiKNMcBwt0"
  );

  assert.equal(result.matched, true);
  assert.ok(result.score >= 0.9);
  assert.ok(result.reasons.includes("matches financial group invite spam pattern"));
  assert.deepEqual(result.details?.matchedStructuralPatterns, [
    "financial group invite spam pattern"
  ]);
});

test("detectStockSpam matches a short hand-typed stock invite paraphrase", async () => {
  const result = await detectStockSpam(
    "Get US stock knowledge and the latest information on various stocks for free. Join us"
  );

  assert.equal(result.matched, true);
  assert.ok(result.score >= 0.72);
  assert.ok((result.details?.matchedPhrases.length ?? 0) >= 2);
  assert.deepEqual(result.details?.matchedSignalBuckets, [
    "finance-topic",
    "promo-language",
    "group-invite-cta"
  ]);
});

test("detectStockSpam ignores normal community chatter", async () => {
  const result = await detectStockSpam(
    "Hey everyone, tomorrow's East Bay meetup starts at 6:30 PM in Oakland. Bring a jacket because it will be chilly after sunset."
  );

  assert.equal(result.matched, false);
  assert.ok(result.score < 0.5);
});

test("detectStockSpam does not hard-match finance chatter without an invite link", async () => {
  const result = await detectStockSpam(
    "I am comparing stocks, options, funds, bonds, foreign exchange, and crypto for a personal portfolio. Happy to discuss investment information and knowledge if anyone is curious."
  );

  assert.equal(result.matched, false);
});

test("detectSpam uses the best match from a dynamic rule list", async () => {
  const result = await detectSpam(
    "Join our free crypto signal team for the latest bitcoin and altcoin trading signals, market updates, and profit strategies every day: https://chat.whatsapp.com/abc123",
    { rules: CUSTOM_RULES }
  );

  assert.equal(result.matched, true);
  assert.equal(result.ruleId, "crypto-signal-promo");
  assert.equal(result.ruleLabel, "Crypto signal promo");
});

test("detectStockSpam is safe when given an empty rules list", async () => {
  const result = await detectStockSpam("suspicious text", { rules: [] });

  assert.equal(result.matched, false);
  assert.equal(result.score, 0);
});

test("default spam rules load from config", async () => {
  const rules = await getDefaultSpamRules();
  assert.ok(rules.length >= 3);
  assert.equal(rules[0]?.id, "us-stock-group-invite");
  assert.equal(rules[0]?.structuralPatterns[0]?.name, "financial group invite spam pattern");
});

test("default rules detect the short cedar lantern trigger phrase", async () => {
  const result = await detectSpam("Cedar lantern signal: blue harbor seven");

  assert.equal(result.matched, true);
  assert.equal(result.ruleId, "cedar-lantern-signal");
});

test("createTextCandidates keeps short test trigger phrases", () => {
  const candidates = createTextCandidates({
    value: "Cedar lantern signal: blue harbor seven"
  });

  assert.deepEqual(candidates, ["Cedar lantern signal: blue harbor seven"]);
});

test("createTextCandidates keeps bare WhatsApp identifiers for debug logging", () => {
  const candidates = createTextCandidates({
    value: "14159364144@s.whatsapp.net",
    name: "201051747684503@lid",
    description: "120363424971231481@g.us"
  });

  assert.deepEqual(candidates, [
    "14159364144@s.whatsapp.net",
    "201051747684503@lid",
    "120363424971231481@g.us",
    "14159364144@s.whatsapp.net\n201051747684503@lid\n120363424971231481@g.us"
  ]);
});

test("createTextCandidates combines WhatsApp invite card fields", () => {
  const candidates = createTextCandidates({
    value: "https://chat.whatsapp.com/example",
    name: "Indians-US Stock Investors Group",
    description: "Group chat invite\nInvestment enthusiasts are welcome to join."
  });

  assert.ok(
    candidates.includes(
      "https://chat.whatsapp.com/example\nIndians-US Stock Investors Group\nGroup chat invite\nInvestment enthusiasts are welcome to join."
    )
  );
});

test("coerceFixtureSnapshot normalizes a single fixture row with defaults", () => {
  const snapshot = coerceFixtureSnapshot(
    {
      text: "TEST ONLY fixture text"
    },
    "inline-fixture.json",
    new Date("2026-04-24T20:00:00.000Z")
  );

  assert.equal(snapshot.databasePath, "fixture:inline-fixture.json");
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0]?.messagePk, 1);
  assert.equal(snapshot.messages[0]?.chatName, "Fixture Testing");
  assert.equal(snapshot.messages[0]?.senderName, "Fixture Sender");
  assert.equal(snapshot.messages[0]?.text, "TEST ONLY fixture text");
});

test("fixture snapshots can simulate split-field WhatsApp invite spam safely", async () => {
  const snapshot = coerceFixtureSnapshot(
    {
      messages: [
        {
          messagePk: 301,
          messageTimeUtc: "2026-04-24T12:00:00.000Z",
          messageTimeLocal: "2026-04-24 05:00:00",
          chatName: "Fixture Community",
          chatJid: "fixture-community@g.us",
          fromJid: "fixture-spammer@lid",
          senderName: "Fixture Sender",
          messageType: 0,
          text: "TEST ONLY: detector exercise with CTA link.\nhttps://example.test/wa-preview",
          previewTitle: "TEST ONLY - US stock knowledge group",
          previewSummary: "Group chat invite",
          previewContent1:
            "TEST ONLY - latest information of various stocks, information for free, welcome to join",
          previewContent2: "https://example.test/wa-preview"
        }
      ]
    },
    "split-fields.json"
  );

  const result = await findSuspiciousEntries(snapshot, { weakMinScore: 0.1 });

  assert.equal(result.matches.length, 1);
  assert.equal(result.weakMatches.length, 0);
  assert.equal(result.matches[0]?.ruleId, "us-stock-group-invite");
  assert.ok((result.matches[0]?.score ?? 0) >= 0.5);
  assert.match(result.matches[0]?.text ?? "", /TEST ONLY - US stock knowledge group/);
});

test("default rules detect the longer blue harbor spam-like phrase", async () => {
  const result = await detectSpam(
    "Blue Harbor Seven is a private signal group for free market updates. Join now."
  );

  assert.equal(result.matched, true);
  assert.equal(result.ruleId, "blue-harbor-signal-group");
});

test("weak match scanning surfaces low-confidence stock-rule overlaps for testing", async () => {
  const snapshot: MessageSnapshot = {
    databasePath: "/tmp/ChatStorage.sqlite",
    fetchedAt: "2026-04-22T00:00:00.000Z",
    messages: [
      {
        messagePk: 101,
        messageTimeUtc: "2026-04-22T00:00:00.000Z",
        messageTimeLocal: "2026-04-21 17:00:00",
        chatName: "Test Community",
        chatJid: "123@g.us",
        fromJid: "user@s.whatsapp.net",
        senderName: "Test Sender",
        messageType: 0,
        text: "I've had greater returns tailoring my resume to the jd. Welcome to join this group",
        previewTitle: null,
        previewSummary: null,
        previewContent1: null,
        previewContent2: null
      }
    ]
  };

  const result = await findSuspiciousEntries(snapshot, { weakMinScore: 0.1 });

  assert.equal(result.matches.length, 0);
  assert.equal(result.weakMatches.length, 1);
  assert.equal(result.weakMatches[0]?.ruleId, "us-stock-group-invite");
  assert.ok((result.weakMatches[0]?.score ?? 0) >= 0.25);
  assert.ok((result.weakMatches[0]?.score ?? 0) < 0.3);
});

test("weak match scanning is disabled unless a weak threshold is provided", async () => {
  const snapshot: MessageSnapshot = {
    databasePath: "/tmp/ChatStorage.sqlite",
    fetchedAt: "2026-04-22T00:00:00.000Z",
    messages: [
      {
        messagePk: 104,
        messageTimeUtc: "2026-04-22T00:00:00.000Z",
        messageTimeLocal: "2026-04-21 17:00:00",
        chatName: "Test Community",
        chatJid: "123@g.us",
        fromJid: "user@s.whatsapp.net",
        senderName: "Test Sender",
        messageType: 0,
        text: "I've had greater returns tailoring my resume to the jd. Welcome to join this group",
        previewTitle: null,
        previewSummary: null,
        previewContent1: null,
        previewContent2: null
      }
    ]
  };

  const result = await findSuspiciousEntries(snapshot);

  assert.equal(result.matches.length, 0);
  assert.equal(result.weakMatches.length, 0);
});

test("weak match scanning respects the weak threshold floor", async () => {
  const snapshot: MessageSnapshot = {
    databasePath: "/tmp/ChatStorage.sqlite",
    fetchedAt: "2026-04-22T00:00:00.000Z",
    messages: [
      {
        messagePk: 102,
        messageTimeUtc: "2026-04-22T00:00:00.000Z",
        messageTimeLocal: "2026-04-21 17:00:00",
        chatName: "Test Community",
        chatJid: "123@g.us",
        fromJid: "user@s.whatsapp.net",
        senderName: "Test Sender",
        messageType: 0,
        text: "I've had greater returns tailoring my resume to the jd. Welcome to join this group",
        previewTitle: null,
        previewSummary: null,
        previewContent1: null,
        previewContent2: null
      }
    ]
  };

  const result = await findSuspiciousEntries(snapshot, { weakMinScore: 0.3 });

  assert.equal(result.matches.length, 0);
  assert.equal(result.weakMatches.length, 0);
});

test("weak match scanning renders WhatsApp system identifier rows readably", async () => {
  const snapshot: MessageSnapshot = {
    databasePath: "/tmp/ChatStorage.sqlite",
    fetchedAt: "2026-04-23T00:00:00.000Z",
    messages: [
      {
        messagePk: 105,
        messageTimeUtc: "2026-04-23T12:44:14.000Z",
        messageTimeLocal: "2026-04-23 05:44:14",
        chatName: "unPTO: hikes for the unemployed/laid-off",
        chatJid: "120363424971231481@g.us",
        fromJid: "120363424971231481@g.us",
        senderName: "+EAA=",
        messageType: 14,
        groupEventType: 2,
        text: "14159364144@s.whatsapp.net",
        toJid: "120363424971231481@g.us",
        groupMemberJid: "251909109755927@lid",
        groupMemberName: "+EAA=",
        previewTitle: "",
        previewSummary: "",
        previewContent1: "",
        previewContent2: ""
      }
    ]
  };

  const result = await findSuspiciousEntries(snapshot, { weakMinScore: 0 });

  assert.equal(result.matches.length, 0);
  assert.equal(result.weakMatches.length, 1);
  assert.equal(result.weakMatches[0]?.score, 0);
  assert.equal(result.weakMatches[0]?.ruleLabel, "No spam rule signal");
  assert.match(result.weakMatches[0]?.text ?? "", /WhatsApp group membership update/);
  assert.match(result.weakMatches[0]?.text ?? "", /Raw participant id\(s\): 14159364144@s\.whatsapp\.net/);
});

test("weak match scanning suppresses preview fragments when the row has a hard match", async () => {
  const snapshot: MessageSnapshot = {
    databasePath: "/tmp/ChatStorage.sqlite",
    fetchedAt: "2026-04-23T00:00:00.000Z",
    messages: [
      {
        messagePk: 103,
        messageTimeUtc: "2026-04-23T12:42:50.000Z",
        messageTimeLocal: "2026-04-23 05:42:50",
        chatName: "East Bay Chapter",
        chatJid: "123@g.us",
        fromJid: "spammer@s.whatsapp.net",
        senderName: "Spammer",
        messageType: 0,
        groupMemberJid: "spammer-participant@lid",
        text:
          "This is a group that shares hot investment information for free every day, including (stocks, options, funds, bonds, foreign exchange, cryptocurrencies, etc.). Here you can get more investment information and knowledge and skills, which can help your investment go more smoothly. Investment enthusiasts are welcome to join.\nhttps://chat.whatsapp.com/EdW3Vs4bZnILXiKNMcBwt0",
        previewTitle: "Indians-US Stock Investors Group",
        previewSummary: "Group chat invite",
        previewContent1: "https://chat.whatsapp.com/EdW3Vs4bZnILXiKNMcBwt0",
        previewContent2: null
      }
    ]
  };

  const result = await findSuspiciousEntries(snapshot, { weakMinScore: 0.1 });

  assert.equal(result.matches.length, 1);
  assert.equal(result.weakMatches.length, 0);
  assert.equal(result.matches[0]?.fromJid, "spammer-participant@lid");
  assert.ok(result.matches.every((match) => match.score >= 0.72));
});

test("formatScanOutput produces a readable moderation-style summary", () => {
  const output = formatScanOutput({
    matches: [
      {
        fingerprint: "abc123",
        messagePk: 10,
        chatName: "Testing",
        chatJid: "120363425971995875@g.us",
        senderName: "Example Sender",
        fromJid: "15551234567@s.whatsapp.net",
        messageType: 0,
        messageTimeLocal: "2026-04-22 16:00:00",
        ruleId: "blue-harbor-signal-group",
        ruleLabel: "Blue Harbor signal group",
        text: "Blue Harbor Seven is a private signal group for free market updates. Join now.",
        score: 0.95,
        reasons: ["matches 4 blue harbor signal group anchor phrase(s)"],
        details: {
          hasInviteLink: false,
          tokenCoverage: 1,
          tokenPrecision: 1,
          balancedCoverage: 1,
          charSimilarity: 1,
          matchedPhrases: ["blue harbor seven", "private signal group"],
          matchedSignalBuckets: [],
          matchedStructuralPatterns: [],
          matchedExample: "Blue Harbor Seven is a private signal group for free market updates. Join now.",
          ruleId: "blue-harbor-signal-group",
          ruleLabel: "Blue Harbor signal group",
          tags: ["test"]
        }
      }
    ]
  });

  assert.match(output, /Spam match \| Blue Harbor signal group \| 95% confidence \(very high\)/);
  assert.match(output, /Chat: Testing/);
  assert.match(output, /Sender: Example Sender/);
  assert.match(output, /Matched phrases: blue harbor seven, private signal group/);
});

test("formatWeakScanOutput produces a readable low-confidence summary", () => {
  const output = formatWeakScanOutput({
    weakMatches: [
      {
        fingerprint: "weak123",
        messagePk: 11,
        chatName: "Testing",
        chatJid: "120363425971995875@g.us",
        senderName: "Example Sender",
        fromJid: "15551234567@s.whatsapp.net",
        messageType: 0,
        messageTimeLocal: "2026-04-22 16:08:09",
        ruleId: "us-stock-group-invite",
        ruleLabel: "US stock promo invite",
        text: "I've had greater returns tailoring my resume to the jd. Welcome to join this group",
        score: 0.148,
        reasons: ["matches 2 us stock promo invite anchor phrase(s)"],
        details: {
          hasInviteLink: false,
          tokenCoverage: 0.163,
          tokenPrecision: 0.5,
          balancedCoverage: 0.245,
          charSimilarity: 0.099,
          matchedPhrases: ["greater returns", "welcome to join this group"],
          matchedSignalBuckets: [],
          matchedStructuralPatterns: [],
          matchedExample:
            "This is a group for sharing US stock knowledge and information for free. Here, you can view the latest information of various stocks. In order to avoid investment risks and obtain greater returns, you can also learn about the real US stock investment market information here. At the same time, you can also learn more rich investment experience and skills in the group. If you are investing in US stocks, or you are a US stock enthusiast, welcome to join this group",
          ruleId: "us-stock-group-invite",
          ruleLabel: "US stock promo invite",
          tags: ["stocks"]
        }
      }
    ]
  });

  assert.match(output, /Weak testing match \| US stock promo invite \| 15% confidence \(low\)/);
  assert.match(output, /Why: matches 2 us stock promo invite anchor phrase\(s\)/);
  assert.match(output, /Matched phrases: greater returns, welcome to join this group/);
});

test("sortMatchesChronologically orders the console feed oldest to newest", () => {
  const sorted = sortMatchesChronologically([
    {
      fingerprint: "newest",
      messagePk: 30,
      chatName: "Testing",
      chatJid: "group-1@g.us",
      senderName: "Newest Sender",
      fromJid: "newest@s.whatsapp.net",
      messageType: 0,
      messageTimeLocal: "2026-04-22 16:08:09",
      ruleId: "us-stock-group-invite",
      ruleLabel: "US stock promo invite",
      text: "Newest",
      score: 0.2,
      reasons: [],
        details: {
          hasInviteLink: false,
          tokenCoverage: 0,
          tokenPrecision: 0,
          balancedCoverage: 0,
          charSimilarity: 0,
          matchedPhrases: [],
          matchedSignalBuckets: [],
          matchedStructuralPatterns: [],
          ruleId: "us-stock-group-invite",
          ruleLabel: "US stock promo invite",
          tags: []
      }
    },
    {
      fingerprint: "oldest",
      messagePk: 10,
      chatName: "Testing",
      chatJid: "group-1@g.us",
      senderName: "Oldest Sender",
      fromJid: "oldest@s.whatsapp.net",
      messageType: 0,
      messageTimeLocal: "2026-04-22 15:20:44",
      ruleId: "cedar-lantern-signal",
      ruleLabel: "Cedar lantern trigger",
      text: "Oldest",
      score: 0.95,
      reasons: [],
        details: {
          hasInviteLink: false,
          tokenCoverage: 1,
          tokenPrecision: 1,
          balancedCoverage: 1,
          charSimilarity: 1,
          matchedPhrases: [],
          matchedSignalBuckets: [],
          matchedStructuralPatterns: [],
          ruleId: "cedar-lantern-signal",
          ruleLabel: "Cedar lantern trigger",
          tags: []
      }
    },
    {
      fingerprint: "middle",
      messagePk: 20,
      chatName: "Testing",
      chatJid: "group-1@g.us",
      senderName: "Middle Sender",
      fromJid: "middle@s.whatsapp.net",
      messageType: 0,
      messageTimeLocal: "2026-04-22 15:27:46",
      ruleId: "blue-harbor-signal-group",
      ruleLabel: "Blue Harbor signal group",
      text: "Middle",
      score: 0.95,
      reasons: [],
        details: {
          hasInviteLink: false,
          tokenCoverage: 1,
          tokenPrecision: 1,
          balancedCoverage: 1,
          charSimilarity: 1,
          matchedPhrases: [],
          matchedSignalBuckets: [],
          matchedStructuralPatterns: [],
          ruleId: "blue-harbor-signal-group",
          ruleLabel: "Blue Harbor signal group",
          tags: []
      }
    }
  ]);

  assert.deepEqual(
    sorted.map((match) => match.fingerprint),
    ["oldest", "middle", "newest"]
  );
});

test("loadSpamRules reads a custom dynamic rules file", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "whatscove-rules-"));
  const rulesPath = path.join(tempDir, "spam-rules.json");

  await writeFile(
    rulesPath,
    JSON.stringify({
      version: 1,
      rules: CUSTOM_RULES
    })
  );

  const loaded = await loadSpamRules({ rulesPath });
  assert.equal(loaded.rulesPath, rulesPath);
  assert.equal(loaded.rules.length, 1);
  assert.equal(loaded.rules[0]?.id, "crypto-signal-promo");
});

test("loadSpamRules reads a YAML rules file", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "whatscove-rules-yaml-"));
  const rulesPath = path.join(tempDir, "spam-rules.yaml");

  await writeFile(
    rulesPath,
    [
      "version: 1",
      "rules:",
      "  - id: crypto-signal-promo",
      "    label: Crypto signal promo",
      "    template: Join our free crypto signal team for daily calls.",
      "    anchorPhrases:",
      "      - free crypto signal team",
      "      - daily calls",
      "    requireInviteLink: true",
      "    tags:",
      "      - crypto"
    ].join("\n")
  );

  const loaded = await loadSpamRules({ rulesPath });
  assert.equal(loaded.rulesPath, rulesPath);
  assert.equal(loaded.rules.length, 1);
  assert.equal(loaded.rules[0]?.id, "crypto-signal-promo");
});

test("buildSpamRule generates a usable id from the label", () => {
  const rule = buildSpamRule({
    label: "Forex VIP Invite",
    template: "Join our forex VIP room for free market calls."
  });

  assert.equal(rule.id, "forex-vip-invite");
});

test("appendSpamRule appends to a custom rules file", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "whatscove-append-"));
  const rulesPath = path.join(tempDir, "spam-rules.json");

  const result = await appendSpamRule(
    {
      label: "Forex VIP Invite",
      template: "Join our forex VIP room for free market calls.",
      anchorPhrases: ["forex vip room", "free market calls"],
      tags: ["forex"]
    },
    { rulesPath }
  );

  assert.equal(result.ruleCount, 1);

  const loaded = await loadSpamRules({ rulesPath });
  assert.equal(loaded.rules.length, 1);
  assert.equal(loaded.rules[0]?.id, "forex-vip-invite");
  assert.deepEqual(loaded.rules[0]?.tags, ["forex"]);
});

test("appendSpamRule preserves YAML when appending to a YAML rules file", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "whatscove-append-yaml-"));
  const rulesPath = path.join(tempDir, "spam-rules.yaml");

  await writeFile(rulesPath, "version: 1\nrules: []\n");

  const result = await appendSpamRule(
    {
      label: "YAML Forex Invite",
      template: "Join our forex room.",
      tags: ["forex"]
    },
    { rulesPath }
  );

  assert.equal(result.rulesPath, rulesPath);

  const raw = await readFile(rulesPath, "utf8");
  assert.match(raw, /^---/m);
  assert.match(raw, /label: YAML Forex Invite/);
});

test("appendSpamRule rejects duplicate ids", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "whatscove-duplicate-"));
  const rulesPath = path.join(tempDir, "spam-rules.json");

  await appendSpamRule(
    {
      id: "duplicate-rule",
      label: "First label",
      template: "First template"
    },
    { rulesPath }
  );

  await assert.rejects(
    appendSpamRule(
      {
        id: "duplicate-rule",
        label: "Second label",
        template: "Second template"
      },
      { rulesPath }
    ),
    /already contain a rule with id/
  );
});

test("loadModerationPolicy loads the default moderation config", async () => {
  const policy = await loadModerationPolicy();

  assert.equal(policy.enabled, true);
  assert.equal(policy.mode, "queue");
  assert.deepEqual(policy.actions, ["delete_message", "remove_sender"]);
  assert.equal(policy.ignoreLocallyBannedUsers, false);
  assert.equal(policy.captureActionScreenshots, true);
  assert.equal(policy.screenshotDirectory, DEFAULT_MODERATION_SCREENSHOT_DIR);
});

test("loadModerationPolicy reads a YAML moderation config", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "whatscove-mod-yaml-"));
  const policyPath = path.join(tempDir, "moderation-policy.yaml");

  await writeFile(
    policyPath,
    [
      "version: 1",
      "enabled: true",
      "mode: apply",
      "actions:",
      "  - notify",
      "ignoreLocallyBannedUsers: true",
      "captureActionScreenshots: false",
      "screenshotDirectory: /tmp/mod-shots",
      "hookCommand: echo moderation",
      "perRule:",
      "  cedar-lantern-signal:",
      "    actions:",
      "      - notify"
    ].join("\n")
  );

  const policy = await loadModerationPolicy({ policyPath });
  assert.equal(policy.policyPath, policyPath);
  assert.equal(policy.mode, "apply");
  assert.deepEqual(policy.actions, ["notify"]);
  assert.equal(policy.captureActionScreenshots, false);
  assert.equal(policy.screenshotDirectory, "/tmp/mod-shots");
});

test("planModerationDecisions creates queued actions for real spam matches", () => {
  const policy: ModerationPolicy = {
    policyPath: "/tmp/mod.json",
    enabled: true,
    mode: "queue",
    actions: ["delete_message", "remove_sender"],
    ignoreLocallyBannedUsers: false,
    captureActionScreenshots: false,
    screenshotDirectory: "",
    hookCommand: "",
    perRule: {}
  };
  const match: SuspiciousMatch = {
    fingerprint: "abc123",
    messagePk: 99,
    chatName: "General",
    chatJid: "1203634@g.us",
    senderName: "Spammer",
    fromJid: "999@s.whatsapp.net",
    messageType: 0,
    messageTimeLocal: "2026-04-22 15:00:00",
    ruleId: "us-stock-group-invite",
    ruleLabel: "US stock promo invite",
    text: "This is a spam message",
    score: 0.95,
    reasons: ["matches spam rule"]
  };

  const decisions = planModerationDecisions([match], policy, {
    locallyBannedUsers: [],
    processedDecisionIds: []
  });

  assert.equal(decisions.length, 2);
  assert.deepEqual(
    decisions.map((decision) => decision.action),
    ["delete_message", "remove_sender"]
  );
  assert.ok(decisions.every((decision) => decision.messageTimeLocal === "2026-04-22 15:00:00"));
});

test("getActionsForMatch applies per-rule moderation overrides", () => {
  const policy: ModerationPolicy = {
    policyPath: "/tmp/mod.json",
    enabled: true,
    mode: "queue",
    actions: ["delete_message", "remove_sender"],
    ignoreLocallyBannedUsers: true,
    captureActionScreenshots: false,
    screenshotDirectory: "",
    hookCommand: "",
    perRule: {
      "cedar-lantern-signal": {
        actions: ["notify"]
      }
    }
  };
  const match = {
    ruleId: "cedar-lantern-signal"
  } as SuspiciousMatch;

  assert.deepEqual(getActionsForMatch(match, policy), ["notify"]);
});

test("getBundledHookCommand points at the bundled WhatsApp hook", () => {
  const hook = getBundledHookCommand();

  assert.equal(hook.command, "/usr/bin/swift");
  assert.match(hook.args[0] ?? "", /src\/whatsapp-hook\.swift$/);
});

test("getBundledHookEnvironment removes Nix SDK overrides for Apple Swift", () => {
  const env = getBundledHookEnvironment({
    PATH: "/bin",
    SDKROOT: "/nix/store/example-apple-sdk",
    NIX_CFLAGS_COMPILE: "-isysroot /nix/store/example-apple-sdk",
    LIBRARY_PATH: "/nix/store/example-lib",
    DEVELOPER_DIR: "/Applications/Xcode-Renamed.app/Contents/Developer"
  });

  assert.equal(env.PATH, "/bin");
  assert.equal(env.DEVELOPER_DIR, "/Applications/Xcode-Renamed.app/Contents/Developer");
  assert.equal(env.SDKROOT, undefined);
  assert.equal(env.NIX_CFLAGS_COMPILE, undefined);
  assert.equal(env.LIBRARY_PATH, undefined);
});

test("shouldRetryModerationError retries flaky delete-message UI lookup failures", () => {
  const decision = {
    action: "delete_message"
  } as ModerationDecision;

  assert.equal(
    shouldRetryModerationError(
      decision,
      "Could not find a visible message matching 'spam snippet'."
    ),
    true
  );
  assert.equal(
    shouldRetryModerationError(
      decision,
      "Could not open the WhatsApp moderation menu for the matched message."
    ),
    true
  );
  assert.equal(
    shouldRetryModerationError(
      decision,
      "Could not find any moderation menu item matching: Delete."
    ),
    true
  );
});

test("shouldRetryModerationError does not retry unrelated or non-delete failures", () => {
  assert.equal(
    shouldRetryModerationError(
      { action: "remove_sender" } as ModerationDecision,
      "Could not find a visible message matching 'spam snippet'."
    ),
    false
  );
  assert.equal(
    shouldRetryModerationError(
      { action: "delete_message" } as ModerationDecision,
      "Accessibility permission is required for WhatsCove moderation actions."
    ),
    false
  );
});

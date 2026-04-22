import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTextCandidates,
  detectSpam,
  detectStockSpam,
  getDefaultSpamRules,
  normalizeText
} from "../src/detection.ts";
import { appendSpamRule, buildSpamRule, loadSpamRules } from "../src/spam-rules.ts";
import type { SpamRule } from "../src/types.ts";

const STOCK_SPAM_TEMPLATE =
  "This is a group for sharing US stock knowledge and information for free. Here, you can view the latest information of various stocks. In order to avoid investment risks and obtain greater returns, you can also learn about the real US stock investment market information here. At the same time, you can also learn more rich investment experience and skills in the group. If you are investing in US stocks, or you are a US stock enthusiast, welcome to join this group";

const CUSTOM_RULES: SpamRule[] = [
  {
    id: "crypto-signal-promo",
    label: "Crypto signal promo",
    template:
      "Join our free crypto signal team to get the latest bitcoin and altcoin trading signals, market updates, and profit strategies every day.",
    anchorPhrases: [
      "free crypto signal team",
      "latest bitcoin and altcoin trading signals",
      "market updates",
      "profit strategies every day"
    ],
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

test("detectStockSpam ignores normal community chatter", async () => {
  const result = await detectStockSpam(
    "Hey everyone, tomorrow's East Bay meetup starts at 6:30 PM in Oakland. Bring a jacket because it will be chilly after sunset."
  );

  assert.equal(result.matched, false);
  assert.ok(result.score < 0.5);
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

test("default rules detect the longer blue harbor spam-like phrase", async () => {
  const result = await detectSpam(
    "Blue Harbor Seven is a private signal group for free market updates. Join now."
  );

  assert.equal(result.matched, true);
  assert.equal(result.ruleId, "blue-harbor-signal-group");
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

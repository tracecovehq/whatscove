import test from "node:test";
import assert from "node:assert/strict";
import { detectStockSpam, normalizeText, STOCK_SPAM_TEMPLATE } from "../src/detection.mjs";

test("normalizeText strips links and punctuation", () => {
  assert.equal(
    normalizeText("Hello! https://chat.whatsapp.com/AbCd1234"),
    "hello"
  );
});

test("detectStockSpam matches the exact stock spam template with a WhatsApp link", () => {
  const result = detectStockSpam(
    `${STOCK_SPAM_TEMPLATE} https://chat.whatsapp.com/BDcmXzyI8k17STFbj3ruZ`
  );

  assert.equal(result.matched, true);
  assert.ok(result.score >= 0.9);
});

test("detectStockSpam matches a paraphrased stock spam pitch", () => {
  const result = detectStockSpam(
    "Free US stock knowledge group. Learn the latest stock information, avoid investment risks, get greater returns, and pick up more investment experience and skills here. If you invest in US stocks, welcome to join our group: https://chat.whatsapp.com/XYZ"
  );

  assert.equal(result.matched, true);
  assert.ok(result.details.matchedPhrases.length >= 4);
});

test("detectStockSpam ignores normal community chatter", () => {
  const result = detectStockSpam(
    "Hey everyone, tomorrow's East Bay meetup starts at 6:30 PM in Oakland. Bring a jacket because it will be chilly after sunset."
  );

  assert.equal(result.matched, false);
  assert.ok(result.score < 0.5);
});

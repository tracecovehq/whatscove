import { fileURLToPath } from "node:url";
import path from "node:path";
import { readStructuredConfig } from "./config-format.ts";
import type {
  ModerationActionType,
  ModerationPolicy,
  ModerationPolicyOverride
} from "./types.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_MODERATION_POLICY_BASE_PATH = path.join(
  PACKAGE_ROOT,
  "config",
  "moderation-policy"
);

const VALID_ACTIONS: ModerationActionType[] = [
  "delete_message",
  "remove_sender",
  "ban_sender_local",
  "notify"
];

function normalizeActions(input: unknown, fallback: ModerationActionType[]): ModerationActionType[] {
  if (!Array.isArray(input)) {
    return [...fallback];
  }

  const normalized = input.filter(
    (value): value is ModerationActionType =>
      typeof value === "string" && VALID_ACTIONS.includes(value as ModerationActionType)
  );

  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeOverride(input: unknown, fallbackActions: ModerationActionType[]): ModerationPolicyOverride {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return {
    actions: normalizeActions(record.actions, fallbackActions)
  };
}

export async function loadModerationPolicy(
  options: { policyPath?: string } = {}
): Promise<ModerationPolicy> {
  const { configPath, data } = await readStructuredConfig<Record<string, unknown>>(
    DEFAULT_MODERATION_POLICY_BASE_PATH,
    options.policyPath
  );
  const parsed = data;

  const defaultActions = normalizeActions(parsed.actions, [
    "delete_message",
    "remove_sender",
    "ban_sender_local"
  ]);

  const perRuleInput =
    typeof parsed.perRule === "object" && parsed.perRule !== null
      ? (parsed.perRule as Record<string, unknown>)
      : {};

  const perRule = Object.fromEntries(
    Object.entries(perRuleInput).map(([ruleId, value]) => [
      ruleId,
      normalizeOverride(value, defaultActions)
    ])
  );

  return {
    policyPath: configPath,
    enabled: parsed.enabled !== false,
    mode:
      parsed.mode === "apply" || parsed.mode === "detect" || parsed.mode === "queue"
        ? parsed.mode
        : "queue",
    actions: defaultActions,
    ignoreLocallyBannedUsers: parsed.ignoreLocallyBannedUsers !== false,
    hookCommand: typeof parsed.hookCommand === "string" ? parsed.hookCommand.trim() : "",
    perRule
  };
}

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  appendModerationEvents,
  appendModerationQueue,
  loadModerationState,
  saveModerationState
} from "./moderation-state.ts";
import type {
  ModerationActionType,
  ModerationDecision,
  ModerationPolicy,
  ModerationState,
  SuspiciousMatch
} from "./types.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLED_HOOK_PATH = path.join(PACKAGE_ROOT, "src", "whatsapp-hook.swift");
const BUNDLED_HOOK_ENV_OVERRIDES = [
  "SDKROOT",
  "NIX_CFLAGS_COMPILE",
  "NIX_LDFLAGS",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "SWIFT_INCLUDE_PATH",
  "SWIFT_LIBRARY_PATH"
];

function buildDecisionId(match: SuspiciousMatch, action: ModerationActionType): string {
  return createHash("sha1")
    .update(JSON.stringify([match.fingerprint, action]))
    .digest("hex")
    .slice(0, 16);
}

export function getActionsForMatch(
  match: SuspiciousMatch,
  policy: ModerationPolicy
): ModerationActionType[] {
  const override = match.ruleId ? policy.perRule[match.ruleId] : undefined;
  return override?.actions ?? policy.actions;
}

export function planModerationDecisions(
  matches: SuspiciousMatch[],
  policy: ModerationPolicy,
  state: ModerationState
): ModerationDecision[] {
  if (!policy.enabled) {
    return [];
  }

  const processed = new Set(state.processedDecisionIds);
  const locallyBanned = new Set(state.locallyBannedUsers);
  const decisions: ModerationDecision[] = [];

  for (const match of matches) {
    if (
      policy.ignoreLocallyBannedUsers &&
      match.fromJid &&
      locallyBanned.has(match.fromJid)
    ) {
      continue;
    }

    for (const action of getActionsForMatch(match, policy)) {
      const id = buildDecisionId(match, action);
      if (processed.has(id)) {
        continue;
      }

      decisions.push({
        id,
        createdAt: new Date().toISOString(),
        status: policy.mode === "apply" ? "pending_apply" : "queued",
        action,
        matchFingerprint: match.fingerprint,
        chatName: match.chatName,
        chatJid: match.chatJid,
        senderName: match.senderName,
        fromJid: match.fromJid,
        messageTimeLocal: match.messageTimeLocal,
        messagePk: match.messagePk,
        ruleId: match.ruleId,
        ruleLabel: match.ruleLabel,
        text: match.text
      });
    }
  }

  return decisions;
}

export function getBundledHookCommand(): { command: string; args: string[] } {
  return {
    command: "/usr/bin/swift",
    args: [BUNDLED_HOOK_PATH]
  };
}

export function getBundledHookEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of BUNDLED_HOOK_ENV_OVERRIDES) {
    delete env[key];
  }
  return env;
}

async function runProcess(
  command: string,
  args: string[],
  decision: ModerationDecision
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: getBundledHookEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() || `Moderation hook exited with non-zero status ${String(code)}`
        )
      );
    });

    child.stdin.write(JSON.stringify(decision));
    child.stdin.end();
  });
}

export async function preflightBundledModerationHook(policy: ModerationPolicy): Promise<string | null> {
  if (policy.mode !== "apply" || policy.hookCommand) {
    return null;
  }

  const bundled = getBundledHookCommand();
  try {
    await runProcess(
      bundled.command,
      bundled.args,
      {
        id: "preflight-accessibility",
        createdAt: new Date().toISOString(),
        status: "pending_apply",
        action: "preflight_accessibility" as ModerationActionType,
        matchFingerprint: "preflight",
        chatName: "",
        chatJid: "",
        senderName: "",
        fromJid: "",
        messageTimeLocal: "",
        messagePk: 0,
        text: ""
      } as ModerationDecision
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function runHook(policy: ModerationPolicy, decision: ModerationDecision): Promise<void> {
  if (policy.hookCommand) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(policy.hookCommand, {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderr = "";

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            stderr.trim() || `Moderation hook exited with non-zero status ${String(code)}`
          )
        );
      });

      child.stdin.write(JSON.stringify(decision));
      child.stdin.end();
    });
    return;
  }

  const bundled = getBundledHookCommand();
  await runProcess(bundled.command, bundled.args, decision);
}

function applyLocalSideEffects(state: ModerationState, decision: ModerationDecision): void {
  if (
    decision.action === "ban_sender_local" &&
    typeof decision.fromJid === "string" &&
    decision.fromJid.length > 0 &&
    !state.locallyBannedUsers.includes(decision.fromJid)
  ) {
    state.locallyBannedUsers.push(decision.fromJid);
  }
}

export async function handleModeration(
  matches: SuspiciousMatch[],
  policy: ModerationPolicy
): Promise<ModerationDecision[]> {
  const state = await loadModerationState();
  const decisions = planModerationDecisions(matches, policy, state);

  if (decisions.length === 0) {
    return [];
  }

  if (policy.mode === "queue") {
    await appendModerationQueue(decisions);
    state.processedDecisionIds.push(...decisions.map((decision) => decision.id));
    await saveModerationState(state);
    await appendModerationEvents(decisions);
    return decisions;
  }

  if (policy.mode === "apply") {
    const completed: ModerationDecision[] = [];
    for (const decision of decisions) {
      try {
        if (decision.action === "ban_sender_local") {
          applyLocalSideEffects(state, decision);
        } else {
          await runHook(policy, decision);
        }
        decision.status = "applied";
      } catch (error) {
        decision.status = "failed";
        decision.error = error instanceof Error ? error.message : String(error);
      }
      if (decision.status === "applied") {
        state.processedDecisionIds.push(decision.id);
      }
      completed.push(decision);
    }
    await saveModerationState(state);
    await appendModerationEvents(completed);
    return completed;
  }

  state.processedDecisionIds.push(...decisions.map((decision) => decision.id));
  await saveModerationState(state);
  await appendModerationEvents(decisions);
  return decisions;
}

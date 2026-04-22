export interface SpamRule {
  id: string;
  label: string;
  template: string;
  anchorPhrases: string[];
  minScore?: number;
  requireInviteLink: boolean;
  tags: string[];
}

export interface LoadSpamRulesResult {
  rulesPath: string;
  rules: SpamRule[];
}

export interface AddSpamRuleInput {
  id?: string;
  label: string;
  template: string;
  anchorPhrases?: string[];
  minScore?: number;
  requireInviteLink?: boolean;
  tags?: string[];
}

export interface AppendSpamRuleResult {
  rulesPath: string;
  rule: SpamRule;
  ruleCount: number;
}

export interface MessageRow {
  messagePk: number;
  messageTimeUtc: string;
  messageTimeLocal: string;
  chatName: string;
  chatJid: string;
  fromJid: string;
  senderName: string;
  messageType: number;
  text: string | null;
  previewTitle: string | null;
  previewSummary: string | null;
  previewContent1: string | null;
  previewContent2: string | null;
}

export interface MessageSnapshot {
  databasePath: string;
  fetchedAt: string;
  messages: MessageRow[];
}

export interface FetchRecentMessagesOptions {
  afterPk?: number;
  lookbackHours?: number;
  chatFilter?: string;
  limit?: number;
  databasePath?: string;
}

export interface DetectionDetails {
  hasInviteLink: boolean;
  tokenCoverage: number;
  charSimilarity: number;
  matchedPhrases: string[];
  ruleId?: string;
  ruleLabel?: string;
  tags: string[];
}

export interface DetectionResult {
  matched: boolean;
  score: number;
  reasons: string[];
  ruleId?: string;
  ruleLabel?: string;
  details?: DetectionDetails;
}

export interface SuspiciousMatch {
  fingerprint: string;
  messagePk: number;
  chatName: string;
  chatJid: string;
  senderName: string;
  fromJid: string;
  messageType: number;
  messageTimeLocal: string;
  ruleId?: string;
  ruleLabel?: string;
  text: string;
  score: number;
  reasons: string[];
  details?: DetectionDetails;
}

export interface SpamDetectionOptions {
  minScore?: number;
  weakMinScore?: number;
  rules?: SpamRule[];
}

export interface SpamGuardOptions extends SpamDetectionOptions {
  pollMs?: number;
  notify?: boolean;
  limit?: number;
  lookbackHours?: number;
  chatFilter?: string;
  rulesPath?: string;
  moderationPolicy?: ModerationPolicy;
  afterPk?: number;
}

export interface ScanResult {
  snapshot: MessageSnapshot;
  matches: SuspiciousMatch[];
  freshMatches: SuspiciousMatch[];
  weakMatches: SuspiciousMatch[];
  freshWeakMatches: SuspiciousMatch[];
  rulesPath: string;
  ruleCount: number;
  moderationDecisions: ModerationDecision[];
}

export type ModerationMode = "detect" | "queue" | "apply";
export type ModerationActionType =
  | "delete_message"
  | "remove_sender"
  | "ban_sender_local"
  | "notify";

export interface ModerationPolicyOverride {
  actions: ModerationActionType[];
}

export interface ModerationPolicy {
  policyPath: string;
  enabled: boolean;
  mode: ModerationMode;
  actions: ModerationActionType[];
  ignoreLocallyBannedUsers: boolean;
  hookCommand: string;
  perRule: Record<string, ModerationPolicyOverride>;
}

export interface ModerationDecision {
  id: string;
  createdAt: string;
  status: "queued" | "pending_apply" | "applied" | "failed";
  action: ModerationActionType;
  matchFingerprint: string;
  chatName: string;
  chatJid: string;
  senderName: string;
  fromJid: string;
  messagePk: number;
  ruleId?: string;
  ruleLabel?: string;
  text: string;
  error?: string;
}

export interface ModerationState {
  locallyBannedUsers: string[];
  processedDecisionIds: string[];
}

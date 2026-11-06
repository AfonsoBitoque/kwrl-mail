/* ==========================================================================
   CORVO — CONTRATOS DE DADOS REAIS (IPC TAURI <-> RUST, src/types/corvo.ts)
   ==========================================================================
   Zero mocks estáticos: todos os tipos refletem estruturas reais persistidas
   em SQLite (`db.rs`), Keychain (`secure_store.rs`), Gmail API (`gmail_sync.rs`)
   e inferência nativa `llama.cpp` (`llm.rs`).
   ========================================================================== */

export type GmailScopeMode = 'modify-and-labels' | 'read-only';

export type CDLRTier = 'frase' | 'rascunho-curto' | 'rascunho-estruturado';

export interface CustomMailbox {
  id: string;
  name: string;
  accountEmails: string[];
  color?: string | null;
}

export interface AccountView {
  email: string;
  label: string;
  scopeMode: GmailScopeMode;
  historyId: string | null;
  keychainSessionActive: boolean;
  aiEnabled: boolean;
  suggestionTrigger: 'on-open' | 'on-demand';
  autoSummarize: boolean;
  lastSyncedEpoch: number | null;
  provider?: 'gmail' | 'outlook' | 'imap' | string;
}

export interface LocalModelStatus {
  configured: boolean;
  modelPath: string | null;
  sha256: string | null;
  contextSize: number;
  workerLoadedInRam: boolean;
  physicalThreads: number;
  allowOllamaFallback: boolean;
  ollamaModelTag: string;
  bootstrapPhase: 'ready' | 'downloading' | 'verifying' | 'error' | 'idle' | string;
  bootstrapPercent: number | null;
  bootstrapError: string | null;
}

export interface AiBootstrapProgressEvent {
  phase: 'ready' | 'downloading' | 'verifying' | 'error' | 'idle' | string;
  percent: number | null;
  error: string | null;
}

export interface DiscoveredModel {
  id: string;
  displayName: string;
  subtitle: string;
  path: string;
  sizeMb: number;
  expectedSha256: string | null;
  recommended: boolean;
  isGeneralPurpose: boolean;
}

export interface BootstrapState {
  oauthClientId: string | null;
  oauthSecretInKeychain: boolean;
  accounts: AccountView[];
  pollIntervalSecs: number;
  masterAiKillSwitch: boolean;
  userSignatureName: string;
  modelStatus: LocalModelStatus;
  availableModels: DiscoveredModel[];
  customMailboxes: CustomMailbox[];
}

export interface MutationResult {
  succeededIds: string[];
  failedIds: string[];
  error?: string | null;
}

/**
 * Payload leve de listagem IPC (§4.2): sem corpos completos de e-mail.
 */
export interface ThreadListItem {
  id: string;
  accountEmail: string;
  accountLabel: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  displayDate: string;
  internalDateMs: number;
  unread: boolean;
  messageCount: number;
  visualDensity: 'compacta' | 'padrao' | 'densa';
  followupStatus: 'sugerido' | 'agendado' | 'dispensado' | null;
  followupLabel: string | null;
  isInbox?: boolean;
  isStarred?: boolean;
  isTrash?: boolean;
  isSpam?: boolean;
  isDraft?: boolean;
  isSent?: boolean;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  attachmentId?: string | null;
}

export interface KnownContact {
  email: string;
  displayName: string;
}

export interface MessageDetail {
  id: string;
  senderName: string;
  senderEmail: string;
  toHeader: string;
  displayDate: string;
  internalDateMs: number;
  snippet: string;
  bodyPlain: string | null;
  bodyHtml?: string | null;
  attachments?: MessageAttachment[];
  bodyFetched: boolean;
  listUnsubscribe?: string | null;
}

export interface FollowUpInfo {
  detectedQuote: string;
  suggestedWhen: string;
  status: 'sugerido' | 'agendado' | 'dispensado';
}

export interface ThreadDetail {
  id: string;
  accountEmail: string;
  subject: string;
  unread: boolean;
  messages: MessageDetail[];
  followUp: FollowUpInfo | null;
}

export interface InjectionInspection {
  blocked: boolean;
  riskScore: number;
  matchedPatterns: string[];
  userWarning: string | null;
}

export interface ThreadOpenPayload {
  thread: ThreadDetail;
  injectionInspection: InjectionInspection;
}

export interface SyncReport {
  accountEmail: string;
  mode: 'initial' | 'incremental' | 'resync-expired-history' | string;
  addedMessages: number;
  deletedMessages: number;
  newHistoryId: string;
}

export interface AiTokenEvent {
  requestId: string;
  threadId: string;
  tier: string;
  delta: string;
  done: boolean;
  ttftMs: number | null;
  totalMs: number | null;
  engineSource: string;
}

export interface InferenceCompleted {
  requestId: string;
  fullText: string;
  ttftMs: number;
  totalMs: number;
  engineSource: string;
  inspection: InjectionInspection;
}

export interface EmailAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  file?: File;
  dataUrl?: string;
}

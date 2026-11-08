import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  AccountView,
  AiBootstrapProgressEvent,
  AiTokenEvent,
  BootstrapState,
  CustomMailbox,
  DiscoveredModel,
  GmailScopeMode,
  InferenceCompleted,
  KnownContact,
  LocalModelStatus,
  MutationResult,
  SyncReport,
  ThreadListItem,
  ThreadOpenPayload,
} from '../types/kwrl';

export function isRunningInsideTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function getBootstrapState(): Promise<BootstrapState> {
  return invoke<BootstrapState>('get_bootstrap_state');
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isRunningInsideTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  return invoke<void>('open_external_url', { url });
}

export async function saveOAuthClientCredentials(
  clientId: string,
  clientSecret: string
): Promise<void> {
  return invoke<void>('save_oauth_client_credentials', {
    clientId,
    clientSecret,
  });
}

export async function startGmailOAuth(
  scopeMode: GmailScopeMode,
  customLabel?: string
): Promise<AccountView> {
  return invoke<AccountView>('start_gmail_oauth', {
    scopeMode,
    customLabel: customLabel || null,
  });
}

export async function disconnectGmailAccount(email: string): Promise<void> {
  return invoke<void>('disconnect_gmail_account', { email });
}

export async function getCustomMailboxes(): Promise<CustomMailbox[]> {
  return invoke<CustomMailbox[]>('get_custom_mailboxes');
}

export async function saveCustomMailboxes(mailboxes: CustomMailbox[]): Promise<void> {
  return invoke<void>('save_custom_mailboxes', { mailboxes });
}

export async function syncGmailNow(email?: string | null): Promise<SyncReport[]> {
  return invoke<SyncReport[]>('sync_gmail_now', {
    email: email || null,
  });
}

export async function listCachedThreads(params: {
  accountEmail?: string | null;
  searchQuery?: string | null;
  viewFilter?: string | null;
}): Promise<ThreadListItem[]> {
  return invoke<ThreadListItem[]>('list_cached_threads', {
    accountEmail: params.accountEmail || null,
    searchQuery: params.searchQuery || null,
    viewFilter: params.viewFilter || null,
  });
}

export async function openThreadDetail(
  threadId: string
): Promise<ThreadOpenPayload> {
  return invoke<ThreadOpenPayload>('open_thread_detail', { threadId });
}

export async function updateFollowUpStatus(
  threadId: string,
  status: 'sugerido' | 'agendado' | 'dispensado'
): Promise<void> {
  return invoke<void>('update_followup_status', { threadId, status });
}

export async function updateAccountAiPolicy(params: {
  email: string;
  aiEnabled: boolean;
  suggestionTrigger: 'on-open' | 'on-demand';
  autoSummarize: boolean;
}): Promise<void> {
  return invoke<void>('update_account_ai_policy', params);
}

export async function updateRuntimeSettings(params: {
  pollIntervalSecs: number;
  masterAiKillSwitch: boolean;
  contextSize: number;
  allowOllamaFallback: boolean;
  ollamaModelTag: string;
}): Promise<LocalModelStatus> {
  return invoke<LocalModelStatus>('update_runtime_settings', params);
}

export async function updateUserSignatureName(name: string): Promise<string> {
  return invoke<string>('update_user_signature_name', { name });
}

export async function registerLocalGgufModel(
  modelPath: string,
  expectedSha256?: string
): Promise<LocalModelStatus> {
  return invoke<LocalModelStatus>('register_local_gguf_model', {
    modelPath,
    expectedSha256: expectedSha256 || null,
  });
}

export async function downloadVerifiedGgufModel(
  downloadUrl: string,
  fileName: string,
  expectedSha256: string
): Promise<LocalModelStatus> {
  return invoke<LocalModelStatus>('download_verified_gguf_model', {
    downloadUrl,
    fileName,
    expectedSha256,
  });
}

export async function installRecommendedModel(): Promise<LocalModelStatus> {
  return invoke<LocalModelStatus>('install_recommended_model');
}

export function resolveFriendlyModelName(
  modelStatus: LocalModelStatus,
  availableModels: DiscoveredModel[]
): string {
  if (modelStatus.modelPath) {
    const matched = availableModels.find((m) => m.path === modelStatus.modelPath);
    if (matched) {
      return matched.displayName;
    }
    if (modelStatus.modelPath.includes('finetuned')) {
      return 'Motor Kwrl (Fine-Tune)';
    }
    return 'Motor Kwrl';
  }
  return 'Motor Kwrl';
}

export async function subscribeToAiBootstrapProgress(
  handler: (payload: AiBootstrapProgressEvent) => void
): Promise<UnlistenFn> {
  return listen<AiBootstrapProgressEvent>('ai-bootstrap-progress', (evt) =>
    handler(evt.payload)
  );
}

export async function streamCdlrSuggestion(
  requestId: string,
  threadId: string,
  tier: 'frase' | 'rascunho-curto' | 'rascunho-estruturado' | 'resumo-calmo',
  extraContext?: string | null
): Promise<InferenceCompleted> {
  return invoke<InferenceCompleted>('stream_cdlr_suggestion', {
    requestId,
    threadId,
    tier,
    extraContext: extraContext || null,
  });
}

export async function subscribeToAiTokens(
  handler: (payload: AiTokenEvent) => void
): Promise<UnlistenFn> {
  return listen<AiTokenEvent>('ai-token', (evt) => handler(evt.payload));
}

export interface SyncErrorReport {
  error: string;
  isAuthError: boolean;
  isQuotaError: boolean;
}

export async function subscribeToGmailSync(
  handler: (report: SyncReport) => void
): Promise<UnlistenFn> {
  return listen<SyncReport>('gmail-sync-state', (evt) => handler(evt.payload));
}

export async function subscribeToGmailSyncError(
  handler: (report: SyncErrorReport) => void
): Promise<UnlistenFn> {
  return listen<SyncErrorReport>('gmail-sync-error', (evt) => handler(evt.payload));
}

export function mergeSuggestionIntoDraft(
  currentDraft: string,
  incomingSuggestion: string,
  mode: 'append' | 'replace'
): string {
  const cleanCurrent = currentDraft.trim();
  const cleanIncoming = incomingSuggestion.trim();
  if (mode === 'replace' || !cleanCurrent) {
    return cleanIncoming;
  }
  return `${cleanCurrent}\n\n${cleanIncoming}`;
}

export interface AttachmentPayload {
  name: string;
  contentType: string;
  dataBase64: string;
}

export interface SendEmailParams {
  accountEmail: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  attachments: AttachmentPayload[];
}

export interface SendEmailResult {
  messageId: string;
  threadId: string;
  success: boolean;
}

export async function sendGmailMessage(
  params: SendEmailParams
): Promise<SendEmailResult> {
  return invoke<SendEmailResult>('send_gmail_message', { params });
}

export async function markThreadsReadStatus(
  accountEmail: string,
  threadIds: string[],
  read: boolean
): Promise<MutationResult> {
  return invoke<MutationResult>('mark_threads_read_status', {
    accountEmail,
    threadIds,
    read,
  });
}

export async function archiveThreads(
  accountEmail: string,
  threadIds: string[]
): Promise<MutationResult> {
  return invoke<MutationResult>('archive_threads', {
    accountEmail,
    threadIds,
  });
}

export async function unarchiveThreads(
  accountEmail: string,
  threadIds: string[]
): Promise<MutationResult> {
  return invoke<MutationResult>('unarchive_threads', {
    accountEmail,
    threadIds,
  });
}

export async function trashThreads(
  accountEmail: string,
  threadIds: string[]
): Promise<MutationResult> {
  return invoke<MutationResult>('trash_threads', {
    accountEmail,
    threadIds,
  });
}

export async function untrashThreads(
  accountEmail: string,
  threadIds: string[]
): Promise<MutationResult> {
  return invoke<MutationResult>('untrash_threads', {
    accountEmail,
    threadIds,
  });
}

export async function markThreadsSpam(
  accountEmail: string,
  threadIds: string[],
  isSpam: boolean
): Promise<MutationResult> {
  return invoke<MutationResult>('mark_threads_spam', {
    accountEmail,
    threadIds,
    isSpam,
  });
}

export async function starThread(
  accountEmail: string,
  threadId: string,
  starred: boolean
): Promise<MutationResult> {
  return invoke<MutationResult>('star_thread', {
    accountEmail,
    threadId,
    starred,
  });
}

export async function deleteThreadsPermanently(
  accountEmail: string,
  threadIds: string[]
): Promise<MutationResult> {
  return invoke<MutationResult>('delete_threads_permanently', {
    accountEmail,
    threadIds,
  });
}

export async function downloadAttachment(
  accountEmail: string,
  messageId: string,
  attachmentId: string,
  filename: string
): Promise<string> {
  return invoke<string>('download_attachment', {
    accountEmail,
    messageId,
    attachmentId,
    filename,
  });
}

export async function getKnownContacts(): Promise<KnownContact[]> {
  return invoke<KnownContact[]>('get_known_contacts');
}

export interface RewriteTextParams {
  requestId?: string;
  text: string;
  action: 'organize_and_correct' | 'formal' | 'short' | 'translate' | 'custom';
  recipient?: string;
  targetLang?: string;
  customInstruction?: string;
}

export async function rewriteTextWithAi(
  params: RewriteTextParams
): Promise<InferenceCompleted> {
  return invoke<InferenceCompleted>('rewrite_text_with_ai', {
    requestId: params.requestId || `req_txt_${Date.now()}`,
    text: params.text,
    action: params.action,
    recipient: params.recipient || null,
    targetLang: params.targetLang || null,
    customInstruction: params.customInstruction || null,
  });
}

export async function searchMessagesFts(
  query: string,
  accountEmail?: string | null,
  limit?: number
): Promise<ThreadListItem[]> {
  return invoke<ThreadListItem[]>('search_messages_fts', {
    query,
    accountEmail: accountEmail || null,
    limit: limit || 50,
  });
}

export async function exportThreadEml(threadId: string): Promise<string> {
  return invoke<string>('export_thread_eml', { threadId });
}

export async function addCustomAccount(
  email: string,
  label: string,
  provider: string
): Promise<AccountView> {
  return invoke<AccountView>('add_custom_account', {
    email,
    label,
    provider,
  });
}

export async function saveUiLanguage(language: string): Promise<void> {
  if (!isRunningInsideTauri()) {
    return;
  }
  return invoke<void>('save_ui_language', { language });
}

export async function getUiLanguage(): Promise<string> {
  if (!isRunningInsideTauri()) {
    return 'en';
  }
  return invoke<string>('get_ui_language');
}

export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const commaIdx = result.indexOf(',');
      const base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      resolve(base64);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

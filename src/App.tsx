import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalmAIPanel } from './components/CalmAIPanel';
import { ComposeModal } from './components/ComposeModal';
import { CustomMailboxModal } from './components/CustomMailboxModal';
import { EmailList, TintaFilterMode } from './components/EmailList';
import { GmailOnboardingView } from './components/GmailOnboardingView';
import { PrivacySettingsDrawer } from './components/PrivacySettingsDrawer';
import { ReadingPane } from './components/ReadingPane';
import { MAILBOXES, SidebarViews } from './components/SidebarViews';
import { useI18n } from './i18n';
import {
  archiveThreads,
  AttachmentPayload,
  disconnectGmailAccount,
  downloadAttachment,
  fileToBase64,
  getBootstrapState,
  installRecommendedModel,
  isRunningInsideTauri,
  listCachedThreads,
  markThreadsReadStatus,
  markThreadsSpam,
  mergeSuggestionIntoDraft,
  openThreadDetail,
  saveCustomMailboxes,
  saveOAuthClientCredentials,
  searchMessagesFts,
  sendGmailMessage,
  starThread,
  startGmailOAuth,
  streamCdlrSuggestion,
  subscribeToAiBootstrapProgress,
  subscribeToGmailSync,
  subscribeToGmailSyncError,
  syncGmailNow,
  trashThreads,
  unarchiveThreads,
  untrashThreads,
  updateAccountAiPolicy,
  updateRuntimeSettings,
  updateUserSignatureName,
} from './services/tauriBridge';
import {
  AccountView,
  CDLRTier,
  CustomMailbox,
  DiscoveredModel,
  EmailAttachment,
  LocalModelStatus,
  ThreadDetail,
  ThreadListItem,
} from './types/kwrl';

const DEFAULT_MODEL_STATUS: LocalModelStatus = {
  configured: false,
  modelPath: null,
  sha256: null,
  contextSize: 4096,
  workerLoadedInRam: false,
  physicalThreads: 4,
  allowOllamaFallback: false,
  ollamaModelTag: 'qwen2.5:3b',
  bootstrapPhase: 'idle',
  bootstrapPercent: null,
  bootstrapError: null,
};

export const App: React.FC = () => {
  const tauriRuntime = isRunningInsideTauri();
  const { t, setLanguage } = useI18n();

  // Modo inicial segue prefers-color-scheme com persistência local
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('tinta-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });

  const [activeBoxId, setActiveBoxId] = useState<string>('inbox');
  const [filterMode, setFilterMode] = useState<TintaFilterMode>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [ftsResults, setFtsResults] = useState<ThreadListItem[] | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(true);

  // Caixas personalizadas e diálogo de criação/edição
  const [customMailboxes, setCustomMailboxes] = useState<CustomMailbox[]>([]);
  const [customMailboxModalOpen, setCustomMailboxModalOpen] = useState<boolean>(false);
  const [editingMailbox, setEditingMailbox] = useState<CustomMailbox | null>(null);

  // Janela de Composição e Seleção Múltipla
  const [composeOpen, setComposeOpen] = useState<boolean>(false);
  const [composeInitialData, setComposeInitialData] = useState<{
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    attachments?: EmailAttachment[];
    threadId?: string | null;
    inReplyTo?: string | null;
  } | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());

  // Aviso de anulação flutuante (6s)
  const [undoToast, setUndoToast] = useState<{
    text: string;
    onUndo: () => void;
  } | null>(null);
  const undoTimeoutRef = useRef<number | null>(null);

  // Estado vindo do backend Rust (SQLite + Keychain + worker llama.cpp)
  const [oauthClientId, setOauthClientId] = useState<string | null>(null);
  const [oauthSecretInKeychain, setOauthSecretInKeychain] = useState<boolean>(false);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [pollIntervalSecs, setPollIntervalSecs] = useState<number>(30);
  const [masterAiKillSwitch, setMasterAiKillSwitch] = useState<boolean>(false);
  const [userSignatureName, setUserSignatureName] = useState<string>('');
  const [modelStatus, setModelStatus] = useState<LocalModelStatus>(DEFAULT_MODEL_STATUS);
  const [availableModels, setAvailableModels] = useState<DiscoveredModel[]>([]);

  const [threads, setThreads] = useState<ThreadListItem[]>([]);

  // Projeção fiel das conversas com estrela vinda do SQLite/Gmail
  const starredThreadIds = useMemo(() => {
    const set = new Set<string>();
    for (let i = 0; i < threads.length; i++) {
      if (threads[i].isStarred) set.add(threads[i].id);
    }
    return set;
  }, [threads]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [openedThread, setOpenedThread] = useState<ThreadDetail | null>(null);

  const [loadingBody, setLoadingBody] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  // IA: Resumos e Rascunhos por conversa
  const [activeTier, setActiveTier] = useState<CDLRTier>('rascunho-curto');
  const [isGeneratingAi, setIsGeneratingAi] = useState<boolean>(false);
  const [summariesByThread, setSummariesByThread] = useState<Record<string, string>>({});
  const [draftsByThread, setDraftsByThread] = useState<Record<string, string>>({});
  const [userContextByThread, setUserContextByThread] = useState<Record<string, string>>({});
  const [attachmentsByThread, setAttachmentsByThread] = useState<Record<string, EmailAttachment[]>>({});
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const replyInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Aplica tema ao :root com atributo data-theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('tinta-theme', theme);
  }, [theme]);

  // Escuta erros de sincronização e autenticação do Gmail em segundo plano
  useEffect(() => {
    if (!tauriRuntime) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    subscribeToGmailSyncError((errEvt) => {
      if (cancelled) return;
      if (errEvt.isAuthError) {
        setOnboardingError(t('toast.sessionExpired'));
        triggerUndoNotice(t('toast.sessionExpired'), () => setSettingsOpen(true));
      } else if (errEvt.isQuotaError) {
        triggerUndoNotice(t('toast.quotaExceeded'), () => {});
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [tauriRuntime, t]);

  const refreshBootstrap = useCallback(async () => {
    if (!tauriRuntime) return;
    const boot = await getBootstrapState();
    if (boot.uiLanguage && (boot.uiLanguage === 'en' || boot.uiLanguage === 'pt' || boot.uiLanguage === 'fr' || boot.uiLanguage === 'es')) {
      if (!localStorage.getItem('kwrl_language')) {
        setLanguage(boot.uiLanguage as any);
      }
    }
    setOauthClientId(boot.oauthClientId);
    setOauthSecretInKeychain(boot.oauthSecretInKeychain);
    setAccounts(boot.accounts);
    setPollIntervalSecs(boot.pollIntervalSecs);
    setMasterAiKillSwitch(boot.masterAiKillSwitch);
    setUserSignatureName(boot.userSignatureName || '');
    setModelStatus(boot.modelStatus);
    setAvailableModels(boot.availableModels ?? []);
    setCustomMailboxes(boot.customMailboxes ?? []);
    if (boot.accounts.length === 0) {
      setShowOnboarding(true);
    }
  }, [tauriRuntime, setLanguage]);

  const refreshThreadList = useCallback(async () => {
    if (!tauriRuntime) return;
    const list = await listCachedThreads({
      accountEmail: null,
      searchQuery: null,
      viewFilter: 'view-unified',
    });
    setThreads(list);
  }, [tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) {
      setShowOnboarding(true);
      return;
    }
    void refreshBootstrap();
  }, [tauriRuntime, refreshBootstrap]);

  useEffect(() => {
    void refreshThreadList();
  }, [refreshThreadList]);

  // Polling e sync em background
  useEffect(() => {
    if (!tauriRuntime) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    subscribeToGmailSync(() => {
      if (cancelled) return;
      void refreshBootstrap();
      void refreshThreadList();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [tauriRuntime, refreshBootstrap, refreshThreadList]);

  useEffect(() => {
    if (!tauriRuntime) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    subscribeToAiBootstrapProgress((evt) => {
      if (cancelled) return;
      setModelStatus((prev) => ({
        ...prev,
        configured: evt.phase === 'ready' ? true : prev.configured,
        bootstrapPhase: evt.phase,
        bootstrapPercent: evt.percent,
        bootstrapError: evt.error,
      }));
      if (evt.phase === 'ready') {
        void refreshBootstrap();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [tauriRuntime, refreshBootstrap]);

  // Contadores dinâmicos para a Sidebar calculados numa passagem linear única O(N)
  const { boxCounts, accountUnreadCounts, customBoxCounts } = useMemo(() => {
    const counts: Record<string, number> = {
      inbox: 0,
      starred: 0,
      drafts: 0,
      sent: 0,
      archive: 0,
      spam: 0,
      trash: 0,
    };

    const accCounts: Record<string, number> = {};
    for (const acc of accounts) {
      accCounts[acc.email] = 0;
    }

    const cboxCounts: Record<string, number> = {};
    const boxEmailMap = customMailboxes.map((box) => ({
      id: box.id,
      emails: new Set(box.accountEmails.map((e) => e.toLowerCase())),
    }));
    for (const box of customMailboxes) {
      cboxCounts[box.id] = 0;
    }

    const userEmails = new Set(accounts.map((a) => a.email.toLowerCase()));
    const userEmailsArr = Array.from(userEmails);

    for (let i = 0; i < threads.length; i++) {
      const t = threads[i];
      const isArchived = !t.isInbox && !t.isTrash && !t.isSpam;
      const isTrashed = Boolean(t.isTrash);
      const isSpam = Boolean(t.isSpam);
      const isStarred = Boolean(t.isStarred);
      const hasDraft = Boolean(draftsByThread[t.id]?.trim() || t.isDraft);
      const isSent = Boolean(t.isSent) || userEmails.has(t.fromEmail.toLowerCase()) || userEmailsArr.some((em) => t.fromEmail.toLowerCase().includes(em));

      if (isStarred && !isTrashed) counts.starred += 1;
      if (hasDraft && !isTrashed) counts.drafts += 1;
      if (isSent && !isTrashed) counts.sent += 1;
      if (isArchived && !isTrashed) counts.archive += 1;
      if (isSpam && !isTrashed) counts.spam += 1;
      if (isTrashed) counts.trash += 1;

      if (!isArchived && !isTrashed && !isSpam) {
        counts.inbox += 1;
        if (t.unread && t.accountEmail) {
          if (accCounts[t.accountEmail] !== undefined) {
            accCounts[t.accountEmail] += 1;
          }
          const accLower = t.accountEmail.toLowerCase();
          for (let j = 0; j < boxEmailMap.length; j++) {
            if (boxEmailMap[j].emails.has(accLower)) {
              cboxCounts[boxEmailMap[j].id] += 1;
            }
          }
        }
      }
    }

    return { boxCounts: counts, accountUnreadCounts: accCounts, customBoxCounts: cboxCounts };
  }, [threads, draftsByThread, accounts, customMailboxes]);

  // Pesquisa Global Instantânea no SQLite com FTS5 e BM25 com proteção anti-corrida
  const searchSeqRef = useRef(0);
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !tauriRuntime) {
      setFtsResults(null);
      return;
    }

    const timer = setTimeout(() => {
      const seq = ++searchSeqRef.current;
      const targetAcc = activeBoxId.startsWith('account:')
        ? activeBoxId.replace('account:', '')
        : null;
      void searchMessagesFts(q, targetAcc, 50)
        .then((res) => {
          if (seq === searchSeqRef.current) {
            setFtsResults(res || []);
          }
        })
        .catch((err) => {
          if (seq === searchSeqRef.current) {
            console.error('Erro na pesquisa FTS5:', err);
          }
        });
    }, 150);

    return () => clearTimeout(timer);
  }, [searchQuery, activeBoxId, tauriRuntime]);

  // Filtra as mensagens pertencentes à caixa ativa na Sidebar — respeita a caixa mesmo com FTS5
  const mailboxThreads = useMemo(() => {
    const sourceThreads = ftsResults !== null ? ftsResults : threads;
    const userEmails = new Set(accounts.map((a) => a.email.toLowerCase()));

    if (activeBoxId.startsWith('account:')) {
      const targetEmail = activeBoxId.replace('account:', '').toLowerCase();
      return sourceThreads.filter((t) => {
        const matchesAccount = (t.accountEmail || '').toLowerCase() === targetEmail;
        return matchesAccount && t.isInbox && !t.isTrash && !t.isSpam;
      });
    }

    if (activeBoxId.startsWith('custom:')) {
      const customId = activeBoxId.replace('custom:', '');
      const customBox = customMailboxes.find((b) => b.id === customId);
      if (!customBox) return [];
      const targetEmails = new Set(customBox.accountEmails.map((e) => e.toLowerCase()));
      return sourceThreads.filter((t) => {
        const matchesAccount = Boolean(t.accountEmail && targetEmails.has(t.accountEmail.toLowerCase()));
        return matchesAccount && t.isInbox && !t.isTrash && !t.isSpam;
      });
    }

    return sourceThreads.filter((t) => {
      const isArchived = !t.isInbox && !t.isTrash && !t.isSpam;
      const isTrashed = Boolean(t.isTrash);
      const isSpam = Boolean(t.isSpam);
      const isStarred = Boolean(t.isStarred);

      switch (activeBoxId) {
        case 'starred':
          return isStarred && !isTrashed;
        case 'drafts':
          return Boolean(draftsByThread[t.id]?.trim() || t.isDraft) && !isTrashed;
        case 'sent': {
          const fromLower = t.fromEmail.toLowerCase();
          const isSent = Boolean(t.isSent) || userEmails.has(fromLower);
          return isSent && !isTrashed;
        }
        case 'archive':
          return isArchived && !isTrashed;
        case 'spam':
          return isSpam && !isTrashed;
        case 'trash':
          return isTrashed;
        case 'inbox':
        default:
          return Boolean(t.isInbox) && !isTrashed && !isSpam;
      }
    });
  }, [threads, activeBoxId, draftsByThread, accounts, customMailboxes, ftsResults]);

  const activeBoxTitle = useMemo(() => {
    if (activeBoxId.startsWith('account:')) {
      const email = activeBoxId.replace('account:', '');
      const acc = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
      return acc?.label || acc?.email || email;
    }
    if (activeBoxId.startsWith('custom:')) {
      const cid = activeBoxId.replace('custom:', '');
      const cm = customMailboxes.find((m) => m.id === cid);
      return cm ? cm.name : t('sidebar.customMailboxes');
    }
    if (activeBoxId === 'inbox') {
      return accounts.length > 1 ? t('sidebar.allInboxes') : t('sidebar.inbox');
    }
    const def = MAILBOXES.find((b) => b.id === activeBoxId);
    if (def) {
      return t(`sidebar.${def.id}` as any);
    }
    return t('sidebar.inbox');
  }, [activeBoxId, accounts, customMailboxes, t]);

  const selectThreadSeqRef = useRef(0);
  const handleSelectThread = useCallback(
    async (threadId: string) => {
      setSelectedThreadId(threadId);
      // Evita realocação do array de threads e re-render se o item já estiver lido
      setThreads((prev) => {
        const target = prev.find((t) => t.id === threadId);
        if (!target || !target.unread) return prev;
        return prev.map((t) => (t.id === threadId ? { ...t, unread: false } : t));
      });

      if (!tauriRuntime) return;
      const seq = ++selectThreadSeqRef.current;
      setLoadingBody(true);
      try {
        const payload = await openThreadDetail(threadId);
        if (seq === selectThreadSeqRef.current) {
          setOpenedThread(payload.thread);
        }
      } catch (err) {
        if (seq === selectThreadSeqRef.current) {
          console.error('Falha ao abrir detalhe:', err);
        }
      } finally {
        if (seq === selectThreadSeqRef.current) {
          setLoadingBody(false);
        }
      }
    },
    [tauriRuntime]
  );

  // Auto-seleciona a primeira conversa disponível
  useEffect(() => {
    if (showOnboarding) return;
    if (mailboxThreads.length === 0) {
      setSelectedThreadId(null);
      setOpenedThread(null);
      return;
    }
    const stillVisible = mailboxThreads.some((t) => t.id === selectedThreadId);
    if (!stillVisible) {
      void handleSelectThread(mailboxThreads[0].id);
    }
  }, [mailboxThreads, selectedThreadId, showOnboarding, handleSelectThread]);

  const currentThreadIndex = useMemo(() => {
    if (!selectedThreadId) return -1;
    return mailboxThreads.findIndex((t) => t.id === selectedThreadId);
  }, [mailboxThreads, selectedThreadId]);

  // Exibe aviso de anulação com temporizador de 6 segundos
  const triggerUndoNotice = (text: string, onUndoAction: () => void) => {
    if (undoTimeoutRef.current) {
      window.clearTimeout(undoTimeoutRef.current);
    }
    setUndoToast({
      text,
      onUndo: () => {
        onUndoAction();
        setUndoToast(null);
        if (undoTimeoutRef.current) window.clearTimeout(undoTimeoutRef.current);
      },
    });

    undoTimeoutRef.current = window.setTimeout(() => {
      setUndoToast(null);
      undoTimeoutRef.current = null;
    }, 6000);
  };

  const groupThreadIdsByAccount = useCallback(
    (ids: string[]): Map<string, string[]> => {
      const map = new Map<string, string[]>();
      const threadMap = new Map<string, string>();
      for (const t of threads) {
        if (t.accountEmail) {
          threadMap.set(t.id, t.accountEmail);
        }
      }
      const defaultAcc = accounts[0]?.email || '';
      for (const id of ids) {
        const acc = threadMap.get(id) || defaultAcc;
        if (!acc) continue;
        const list = map.get(acc) || [];
        list.push(id);
        map.set(acc, list);
      }
      return map;
    },
    [threads, accounts]
  );

  const handleArchiveThread = async () => {
    if (!selectedThreadId) return;
    const tid = selectedThreadId;
    const currentIdx = currentThreadIndex;
    const current = threads.find((t) => t.id === tid);
    const accountEmail = current?.accountEmail || openedThread?.accountEmail || accounts[0]?.email || '';

    // Atualização otimista no estado projetado
    setThreads((prev) =>
      prev.map((t) => (t.id === tid ? { ...t, isInbox: false } : t))
    );

    // Seleciona a próxima conversa visível
    const nextThreads = mailboxThreads.filter((t) => t.id !== tid);
    if (nextThreads.length > 0) {
      const nextIdx = Math.min(currentIdx, nextThreads.length - 1);
      void handleSelectThread(nextThreads[nextIdx].id);
    }

    if (tauriRuntime && accountEmail) {
      try {
        const res = await archiveThreads(accountEmail, [tid]);
        if (res.failedIds.includes(tid)) {
          // Reverte se a API do Gmail rejeitou
          setThreads((prev) =>
            prev.map((t) => (t.id === tid ? { ...t, isInbox: true } : t))
          );
          triggerUndoNotice(res.error || t('toast.archiveError'), () => {});
          return;
        }
      } catch (err) {
        setThreads((prev) =>
          prev.map((t) => (t.id === tid ? { ...t, isInbox: true } : t))
        );
        triggerUndoNotice(t('toast.connectionError'), () => {});
        return;
      }
    }

    triggerUndoNotice(t('toast.threadArchived'), async () => {
      setThreads((prev) =>
        prev.map((t) => (t.id === tid ? { ...t, isInbox: true } : t))
      );
      if (tauriRuntime && accountEmail) {
        await unarchiveThreads(accountEmail, [tid]);
      }
      void handleSelectThread(tid);
    });
  };

  const handleTrashThread = async () => {
    if (!selectedThreadId) return;
    const tid = selectedThreadId;
    const currentIdx = currentThreadIndex;
    const current = threads.find((t) => t.id === tid);
    const accountEmail = current?.accountEmail || openedThread?.accountEmail || accounts[0]?.email || '';

    setThreads((prev) =>
      prev.map((t) => (t.id === tid ? { ...t, isTrash: true, isInbox: false } : t))
    );

    const nextThreads = mailboxThreads.filter((t) => t.id !== tid);
    if (nextThreads.length > 0) {
      const nextIdx = Math.min(currentIdx, nextThreads.length - 1);
      void handleSelectThread(nextThreads[nextIdx].id);
    }

    if (tauriRuntime && accountEmail) {
      try {
        const res = await trashThreads(accountEmail, [tid]);
        if (res.failedIds.includes(tid)) {
          setThreads((prev) =>
            prev.map((t) => (t.id === tid ? { ...t, isTrash: false, isInbox: true } : t))
          );
          triggerUndoNotice(res.error || t('toast.trashError'), () => {});
          return;
        }
      } catch (err) {
        setThreads((prev) =>
          prev.map((t) => (t.id === tid ? { ...t, isTrash: false, isInbox: true } : t))
        );
        triggerUndoNotice(t('toast.connectionError'), () => {});
        return;
      }
    }

    triggerUndoNotice(t('toast.threadTrashed'), async () => {
      setThreads((prev) =>
        prev.map((t) => (t.id === tid ? { ...t, isTrash: false, isInbox: true } : t))
      );
      if (tauriRuntime && accountEmail) {
        await untrashThreads(accountEmail, [tid]);
      }
      void handleSelectThread(tid);
    });
  };

  const handleSpamThread = async () => {
    if (!selectedThreadId) return;
    const tid = selectedThreadId;
    const currentIdx = currentThreadIndex;
    const current = threads.find((t) => t.id === tid);
    const accountEmail = current?.accountEmail || openedThread?.accountEmail || accounts[0]?.email || '';

    setThreads((prev) =>
      prev.map((t) => (t.id === tid ? { ...t, isSpam: true, isInbox: false } : t))
    );

    const nextThreads = mailboxThreads.filter((t) => t.id !== tid);
    if (nextThreads.length > 0) {
      const nextIdx = Math.min(currentIdx, nextThreads.length - 1);
      void handleSelectThread(nextThreads[nextIdx].id);
    }

    if (tauriRuntime && accountEmail) {
      try {
        const res = await markThreadsSpam(accountEmail, [tid], true);
        if (res.failedIds.includes(tid)) {
          setThreads((prev) =>
            prev.map((t) => (t.id === tid ? { ...t, isSpam: false, isInbox: true } : t))
          );
          triggerUndoNotice(res.error || t('toast.spamError'), () => {});
          return;
        }
      } catch (err) {
        setThreads((prev) =>
          prev.map((t) => (t.id === tid ? { ...t, isSpam: false, isInbox: true } : t))
        );
        triggerUndoNotice(t('toast.connectionError'), () => {});
        return;
      }
    }

    triggerUndoNotice(t('toast.threadSpammed'), async () => {
      setThreads((prev) =>
        prev.map((t) => (t.id === tid ? { ...t, isSpam: false, isInbox: true } : t))
      );
      if (tauriRuntime && accountEmail) {
        await markThreadsSpam(accountEmail, [tid], false);
      }
      void handleSelectThread(tid);
    });
  };

  const handleToggleStar = async () => {
    if (!selectedThreadId) return;
    const tid = selectedThreadId;
    const current = threads.find((t) => t.id === tid);
    const willStar = !current?.isStarred;
    const accountEmail = current?.accountEmail || openedThread?.accountEmail || accounts[0]?.email || '';

    // Atualização otimista
    setThreads((prev) =>
      prev.map((t) => (t.id === tid ? { ...t, isStarred: willStar } : t))
    );

    if (tauriRuntime && accountEmail) {
      try {
        const res = await starThread(accountEmail, tid, willStar);
        if (res.failedIds.includes(tid)) {
          setThreads((prev) =>
            prev.map((t) => (t.id === tid ? { ...t, isStarred: !willStar } : t))
          );
          triggerUndoNotice(res.error || t('toast.connectionError'), () => {});
        }
      } catch (err) {
        setThreads((prev) =>
          prev.map((t) => (t.id === tid ? { ...t, isStarred: !willStar } : t))
        );
        triggerUndoNotice(t('toast.connectionError'), () => {});
      }
    }
  };

  const handleToggleSelectThread = useCallback((tid: string) => {
    setSelectedThreadIds((prev) => {
      const next = new Set(prev);
      if (next.has(tid)) next.delete(tid);
      else next.add(tid);
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedThreadIds(new Set());
  }, []);

  const handleBulkArchive = async () => {
    if (selectedThreadIds.size === 0) return;
    const ids = Array.from(selectedThreadIds);
    setSelectedThreadIds(new Set());

    // Otimista
    setThreads((prev) =>
      prev.map((t) => (ids.includes(t.id) ? { ...t, isInbox: false } : t))
    );

    if (tauriRuntime) {
      const grouped = groupThreadIdsByAccount(ids);
      const failedAll: string[] = [];
      for (const [accEmail, accIds] of grouped.entries()) {
        try {
          const res = await archiveThreads(accEmail, accIds);
          if (res.failedIds.length > 0) {
            failedAll.push(...res.failedIds);
          }
        } catch {
          failedAll.push(...accIds);
        }
      }
      if (failedAll.length > 0) {
        setThreads((prev) =>
          prev.map((t) => (failedAll.includes(t.id) ? { ...t, isInbox: true } : t))
        );
        triggerUndoNotice(t('toast.archiveError'), () => {});
      }
    }

    triggerUndoNotice(t('toast.threadsArchived', { count: ids.length }), async () => {
      setThreads((prev) =>
        prev.map((t) => (ids.includes(t.id) ? { ...t, isInbox: true } : t))
      );
      if (tauriRuntime) {
        const grouped = groupThreadIdsByAccount(ids);
        for (const [accEmail, accIds] of grouped.entries()) {
          await unarchiveThreads(accEmail, accIds);
        }
      }
    });
  };

  const handleBulkTrash = async () => {
    if (selectedThreadIds.size === 0) return;
    const ids = Array.from(selectedThreadIds);
    setSelectedThreadIds(new Set());

    setThreads((prev) =>
      prev.map((t) => (ids.includes(t.id) ? { ...t, isTrash: true, isInbox: false } : t))
    );

    if (tauriRuntime) {
      const grouped = groupThreadIdsByAccount(ids);
      const failedAll: string[] = [];
      for (const [accEmail, accIds] of grouped.entries()) {
        try {
          const res = await trashThreads(accEmail, accIds);
          if (res.failedIds.length > 0) {
            failedAll.push(...res.failedIds);
          }
        } catch {
          failedAll.push(...accIds);
        }
      }
      if (failedAll.length > 0) {
        setThreads((prev) =>
          prev.map((t) => (failedAll.includes(t.id) ? { ...t, isTrash: false, isInbox: true } : t))
        );
        triggerUndoNotice(t('toast.trashError'), () => {});
      }
    }

    triggerUndoNotice(t('toast.threadsTrashed', { count: ids.length }), async () => {
      setThreads((prev) =>
        prev.map((t) => (ids.includes(t.id) ? { ...t, isTrash: false, isInbox: true } : t))
      );
      if (tauriRuntime) {
        const grouped = groupThreadIdsByAccount(ids);
        for (const [accEmail, accIds] of grouped.entries()) {
          await untrashThreads(accEmail, accIds);
        }
      }
    });
  };

  const handleBulkMarkRead = async (read: boolean) => {
    if (selectedThreadIds.size === 0) return;
    const ids = Array.from(selectedThreadIds);
    setSelectedThreadIds(new Set());

    setThreads((prev) =>
      prev.map((t) => (ids.includes(t.id) ? { ...t, unread: !read } : t))
    );

    if (tauriRuntime) {
      const grouped = groupThreadIdsByAccount(ids);
      const failedAll: string[] = [];
      for (const [accEmail, accIds] of grouped.entries()) {
        try {
          const res = await markThreadsReadStatus(accEmail, accIds, read);
          if (res.failedIds.length > 0) {
            failedAll.push(...res.failedIds);
          }
        } catch {
          failedAll.push(...accIds);
        }
      }
      if (failedAll.length > 0) {
        setThreads((prev) =>
          prev.map((t) => (failedAll.includes(t.id) ? { ...t, unread: read } : t))
        );
        triggerUndoNotice(t('toast.connectionError'), () => {});
      }
    }

    triggerUndoNotice(
      read
        ? t('toast.threadsMarkedRead', { count: ids.length })
        : t('toast.threadsMarkedUnread', { count: ids.length }),
      () => {}
    );
  };

  const handleDownloadAttachment = async (messageId: string, attachmentId: string, filename: string) => {
    const accountEmail = openedThread?.accountEmail || accounts[0]?.email || '';
    if (!tauriRuntime || !accountEmail) return;
    try {
      const savedPath = await downloadAttachment(accountEmail, messageId, attachmentId, filename);
      triggerUndoNotice(t('toast.fileDownloaded', { path: savedPath }), () => {});
    } catch (err) {
      console.error('Erro ao descarregar anexo:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      triggerUndoNotice(t('toast.fileDownloadFailed', { error: errMsg }), () => {});
    }
  };

  const handleReplyAll = () => {
    const targetMsg = openedThread?.messages && openedThread.messages[openedThread.messages.length - 1];
    if (!openedThread || !targetMsg) return;

    const userEmail = (openedThread.accountEmail || accounts[0]?.email || '').toLowerCase();
    const allRecipients = [targetMsg.senderEmail];
    if (targetMsg.toHeader) {
      targetMsg.toHeader.split(',').forEach((t) => {
        const clean = t.trim().replace(/^.*</, '').replace(/>.*$/, '').trim();
        if (clean && clean.toLowerCase() !== userEmail && !allRecipients.includes(clean)) {
          allRecipients.push(clean);
        }
      });
    }

    setComposeInitialData({
      to: allRecipients,
      subject: openedThread.subject.toLowerCase().startsWith('re:') ? openedThread.subject : `Re: ${openedThread.subject}`,
      threadId: openedThread.id,
      inReplyTo: targetMsg.id,
    });
    setComposeOpen(true);
  };

  const handleForward = () => {
    const targetMsg = openedThread?.messages && openedThread.messages[openedThread.messages.length - 1];
    if (!openedThread || !targetMsg) return;

    const fwdHeader = `\n\n---------- Mensagem encaminhada ----------\nDe: ${targetMsg.senderName} <${targetMsg.senderEmail}>\nData: ${targetMsg.displayDate}\nAssunto: ${openedThread.subject}\nPara: ${targetMsg.toHeader}\n\n`;
    const fwdBody = fwdHeader + (targetMsg.bodyPlain || targetMsg.snippet);

    setComposeInitialData({
      to: [],
      subject: openedThread.subject.toLowerCase().startsWith('fwd:') ? openedThread.subject : `Fwd: ${openedThread.subject}`,
      body: fwdBody,
    });
    setComposeOpen(true);
  };

  const handlePrevThread = () => {
    if (currentThreadIndex > 0) {
      const prevId = mailboxThreads[currentThreadIndex - 1].id;
      void handleSelectThread(prevId);
    }
  };

  const handleNextThread = () => {
    if (currentThreadIndex < mailboxThreads.length - 1) {
      const nextId = mailboxThreads[currentThreadIndex + 1].id;
      void handleSelectThread(nextId);
    }
  };

  // Atalhos de teclado: J/K navegam, E arquiva, / foca resposta, Esc sai, ⌘J toggle painel IA
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (composeOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setComposeOpen(false);
          setComposeInitialData(null);
        }
        return;
      }

      const target = e.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT';

      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        setAiPanelOpen((prev) => !prev);
        return;
      }

      if (e.key === 'Escape') {
        if (target) target.blur();
        setSettingsOpen(false);
        return;
      }

      if (!isTyping && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        setComposeInitialData(null);
        setComposeOpen(true);
        return;
      }

      if (!isTyping && e.key === '/') {
        e.preventDefault();
        replyInputRef.current?.focus();
        return;
      }

      if (!isTyping && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        handleNextThread();
        return;
      }

      if (!isTyping && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        handlePrevThread();
        return;
      }

      if (!isTyping && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        handleArchiveThread();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mailboxThreads, currentThreadIndex, selectedThreadId, composeOpen]);

  // Geração de Resumo com o Motor Kwrl local
  const handleGenerateSummary = async () => {
    if (!selectedThreadId || isSummarizing) return;
    const tid = selectedThreadId;
    const reqId = `req_sum_${Date.now()}`;
    setIsSummarizing(true);
    setSummariesByThread((prev) => ({ ...prev, [tid]: '' }));

    try {
      const completed = await streamCdlrSuggestion(reqId, tid, 'resumo-calmo');
      setSummariesByThread((prev) => {
        const existing = prev[tid] || '';
        const finalTxt = completed.fullText.trim() ? completed.fullText : existing;
        return { ...prev, [tid]: finalTxt };
      });
    } catch (err) {
      console.error('Falha ao gerar resumo:', err);
    } finally {
      setIsSummarizing(false);
    }
  };

  const currentUserContext = selectedThreadId ? userContextByThread[selectedThreadId] || '' : '';
  const handleUserContextChange = (text: string) => {
    if (selectedThreadId) {
      setUserContextByThread((prev) => ({ ...prev, [selectedThreadId]: text }));
    }
  };

  // Geração de Texto com IA (Frase, Rascunho curto, Estruturado)
  const handleGenerateAiTier = async (tier: CDLRTier, overrideContext?: string) => {
    if (!selectedThreadId || isGeneratingAi) return;
    const tid = selectedThreadId;
    const reqId = `req_tier_${Date.now()}`;
    setActiveTier(tier);
    setIsGeneratingAi(true);

    const ctx = overrideContext !== undefined ? overrideContext : (userContextByThread[tid] || '');
    const extraContext = ctx.trim()
      ? `[Ponto de vista e instruções do utilizador para esta resposta]:\n${ctx.trim()}`
      : null;

    try {
      await streamCdlrSuggestion(reqId, tid, tier, extraContext);
    } catch (err) {
      console.error('Falha ao gerar texto com IA:', err);
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const handleApplyAiToDraft = (text: string, mode: 'append' | 'replace') => {
    if (!selectedThreadId) return;
    setDraftsByThread((prev) => {
      const cur = prev[selectedThreadId] || '';
      const merged = mergeSuggestionIntoDraft(cur, text, mode);
      return { ...prev, [selectedThreadId]: merged };
    });
  };

  const handleQuickChip = (chip: string) => {
    if (!selectedThreadId) return;
    setAiPanelOpen(true);
    let chipContext = userContextByThread[selectedThreadId] || '';

    if (chip === 'Confirmar') {
      chipContext = 'Confirmar disponibilidade e total acordo com a mensagem recebida.';
      setUserContextByThread((prev) => ({ ...prev, [selectedThreadId]: chipContext }));
      setActiveTier('rascunho-curto');
      void handleGenerateAiTier('rascunho-curto', chipContext);
    } else if (chip === 'Pedir mais tempo') {
      chipContext = 'Agradecer a mensagem, explicar com simpatia que preciso de tempo para analisar o assunto e que voltarei ao contacto nos próximos dias com uma resposta.';
      setUserContextByThread((prev) => ({ ...prev, [selectedThreadId]: chipContext }));
      setActiveTier('rascunho-curto');
      void handleGenerateAiTier('rascunho-curto', chipContext);
    } else if (chip === 'Recusar cordialmente') {
      chipContext = 'Agradecer a mensagem mas recusar cordialmente por indisponibilidade neste momento.';
      setUserContextByThread((prev) => ({ ...prev, [selectedThreadId]: chipContext }));
      setActiveTier('rascunho-estruturado');
      void handleGenerateAiTier('rascunho-estruturado', chipContext);
    } else if (chip === 'Frase') {
      setActiveTier('frase');
      void handleGenerateAiTier('frase', chipContext);
    } else if (chip === 'Rascunho curto') {
      setActiveTier('rascunho-curto');
      void handleGenerateAiTier('rascunho-curto', chipContext);
    } else if (chip === 'Estruturado') {
      setActiveTier('rascunho-estruturado');
      void handleGenerateAiTier('rascunho-estruturado', chipContext);
    }
  };

  const handleCustomReplyPrompt = (prompt: string) => {
    if (!selectedThreadId) return;
    setAiPanelOpen(true);
    setUserContextByThread((prev) => ({ ...prev, [selectedThreadId]: prompt }));
    setActiveTier('rascunho-curto');
    void handleGenerateAiTier('rascunho-curto', prompt);
  };

  const handleDiscardDraft = () => {
    if (!selectedThreadId) return;
    setDraftsByThread((prev) => ({ ...prev, [selectedThreadId]: '' }));
    setAttachmentsByThread((prev) => ({ ...prev, [selectedThreadId]: [] }));
  };

  const [isSendingEmail, setIsSendingEmail] = useState(false);

  const handleSendEmail = async (
    mode: 'reply' | 'new',
    customTo?: string,
    customSubject?: string
  ) => {
    if (!selectedThreadId || !openedThread) return;
    const draft = draftsByThread[selectedThreadId]?.trim();
    if (!draft) return;

    const accountEmail = openedThread.accountEmail || selectedAccount?.email;
    if (!accountEmail) {
      triggerUndoNotice(t('toast.noAccountSelected'), () => {});
      return;
    }

    const lastMsg = openedThread.messages[openedThread.messages.length - 1];
    const recipient =
      mode === 'reply' ? lastMsg?.senderEmail || '' : customTo || lastMsg?.senderEmail || '';
    if (!recipient) {
      triggerUndoNotice(t('toast.specifyRecipient'), () => {});
      return;
    }

    let subject =
      mode === 'reply' ? openedThread.subject : customSubject || openedThread.subject;
    if (mode === 'reply' && !subject.toLowerCase().startsWith('re:')) {
      subject = `Re: ${subject}`;
    }

    const atts = attachmentsByThread[selectedThreadId] || [];

    setIsSendingEmail(true);
    try {
      const attachmentPayloads: AttachmentPayload[] = [];
      for (const att of atts) {
        let b64 = '';
        if (att.file) {
          b64 = await fileToBase64(att.file);
        } else if (att.dataUrl) {
          b64 = att.dataUrl.includes(',') ? att.dataUrl.split(',')[1] : att.dataUrl;
        }
        if (b64) {
          const contentType =
            att.file?.type ||
            (att.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
          attachmentPayloads.push({
            name: att.name,
            contentType,
            dataBase64: b64,
          });
        }
      }

      await sendGmailMessage({
        accountEmail,
        to: [recipient],
        subject,
        body: draft,
        threadId: mode === 'reply' ? openedThread.id : null,
        inReplyTo: mode === 'reply' ? lastMsg?.id : null,
        attachments: attachmentPayloads,
      });

      // Limpa rascunho e anexos após envio bem-sucedido
      setDraftsByThread((prev) => ({ ...prev, [selectedThreadId]: '' }));
      setAttachmentsByThread((prev) => ({ ...prev, [selectedThreadId]: [] }));

      triggerUndoNotice(t('toast.emailSentSuccess'), () => {});
    } catch (err: unknown) {
      console.error('Erro ao enviar e-mail:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      triggerUndoNotice(t('toast.emailSendFailed', { error: errMsg }), () => {});
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleSendCompose = async (payload: {
    accountEmail: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    bodyHtml?: string | null;
    threadId?: string | null;
    inReplyTo?: string | null;
    attachments: EmailAttachment[];
  }) => {
    setIsSendingEmail(true);
    try {
      const attachmentPayloads: AttachmentPayload[] = [];
      for (const att of payload.attachments) {
        let b64 = '';
        if (att.file) {
          b64 = await fileToBase64(att.file);
        } else if (att.dataUrl) {
          b64 = att.dataUrl.includes(',') ? att.dataUrl.split(',')[1] : att.dataUrl;
        }
        if (b64) {
          const contentType =
            att.file?.type ||
            (att.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
          attachmentPayloads.push({
            name: att.name,
            contentType,
            dataBase64: b64,
          });
        }
      }

      await sendGmailMessage({
        accountEmail: payload.accountEmail,
        to: payload.to,
        cc: payload.cc.length > 0 ? payload.cc : undefined,
        bcc: payload.bcc.length > 0 ? payload.bcc : undefined,
        subject: payload.subject,
        body: payload.body,
        bodyHtml: payload.bodyHtml || null,
        threadId: payload.threadId || null,
        inReplyTo: payload.inReplyTo || null,
        attachments: attachmentPayloads,
      });

      setComposeOpen(false);
      setComposeInitialData(null);
      triggerUndoNotice(t('toast.emailSentSuccess'), () => {});
      await refreshBootstrap();
      await refreshThreadList();
    } catch (err: unknown) {
      console.error('Erro ao enviar e-mail:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      triggerUndoNotice(t('toast.emailSendFailed', { error: errMsg }), () => {});
    } finally {
      setIsSendingEmail(false);
    }
  };

  const currentDraft = selectedThreadId ? draftsByThread[selectedThreadId] || '' : '';
  const currentSummary = selectedThreadId ? summariesByThread[selectedThreadId] || '' : '';

  const selectedAccount = useMemo(() => {
    const email = openedThread?.accountEmail;
    return accounts.find((a) => a.email === email) || accounts[0];
  }, [accounts, openedThread]);

  const handleCreateOrUpdateCustomMailbox = async (name: string, accountEmails: string[]) => {
    let nextList: CustomMailbox[];
    if (editingMailbox) {
      nextList = customMailboxes.map((m) =>
        m.id === editingMailbox.id ? { ...m, name, accountEmails } : m
      );
    } else {
      const newBox: CustomMailbox = {
        id: `cm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        name,
        accountEmails,
        color: null,
      };
      nextList = [...customMailboxes, newBox];
    }
    setCustomMailboxes(nextList);
    setCustomMailboxModalOpen(false);
    setEditingMailbox(null);
    if (tauriRuntime) {
      try {
        await saveCustomMailboxes(nextList);
      } catch (err) {
        console.error('Erro ao guardar caixas personalizadas:', err);
      }
    }
  };

  const handleDeleteCustomMailbox = async (id: string) => {
    const nextList = customMailboxes.filter((m) => m.id !== id);
    setCustomMailboxes(nextList);
    if (activeBoxId === `custom:${id}`) {
      setActiveBoxId('inbox');
    }
    if (tauriRuntime) {
      try {
        await saveCustomMailboxes(nextList);
      } catch (err) {
        console.error('Erro ao eliminar caixa personalizada:', err);
      }
    }
  };

  const handleAddAccount = async () => {
    if (!tauriRuntime) return;
    setIsAuthenticating(true);
    try {
      await startGmailOAuth('modify-and-labels');
      await refreshBootstrap();
      await refreshThreadList();
      triggerUndoNotice(t('toast.accountAddedSuccess'), () => {});
    } catch (err) {
      console.error('Erro ao adicionar conta:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      triggerUndoNotice(t('toast.accountAddFailed', { error: errMsg }), () => {});
    } finally {
      setIsAuthenticating(false);
    }
  };

  const shouldRenderOnboarding = showOnboarding || accounts.length === 0;

  return (
    <div className="tinta-app-shell">
      {/* Coluna 1: Sidebar (220px) */}
      <SidebarViews
        activeBoxId={activeBoxId}
        boxCounts={boxCounts}
        accountUnreadCounts={accountUnreadCounts}
        customBoxCounts={customBoxCounts}
        accounts={accounts}
        customMailboxes={customMailboxes}
        userName={userSignatureName}
        userEmail={accounts[0]?.email || ''}
        isSyncing={isSyncing}
        onSelectBox={setActiveBoxId}
        onOpenSettings={() => setSettingsOpen(true)}
        onSyncNow={async () => {
          setIsSyncing(true);
          try {
            await syncGmailNow(null);
            await refreshBootstrap();
            await refreshThreadList();
          } finally {
            setIsSyncing(false);
          }
        }}
        onAddAccount={handleAddAccount}
        onCreateCustomMailbox={() => {
          setEditingMailbox(null);
          setCustomMailboxModalOpen(true);
        }}
        onDeleteCustomMailbox={handleDeleteCustomMailbox}
        onCompose={() => {
          setComposeInitialData(null);
          setComposeOpen(true);
        }}
      />

      {/* Coluna 2: Lista (360px) */}
      <EmailList
        boxTitle={activeBoxTitle}
        threads={mailboxThreads}
        selectedThreadId={selectedThreadId}
        searchQuery={searchQuery}
        filterMode={filterMode}
        starredThreadIds={starredThreadIds}
        searchInputRef={searchInputRef}
        showAccountBadge={accounts.length > 1}
        selectedThreadIds={selectedThreadIds}
        onToggleSelectThread={handleToggleSelectThread}
        onClearSelection={handleClearSelection}
        onBulkArchive={handleBulkArchive}
        onBulkTrash={handleBulkTrash}
        onBulkMarkRead={handleBulkMarkRead}
        onSearchChange={setSearchQuery}
        onFilterModeChange={setFilterMode}
        onSelectThread={handleSelectThread}
      />

      {/* Coluna 3: Painel de Leitura (flex-1) */}
      {shouldRenderOnboarding ? (
        <GmailOnboardingView
          savedClientId={oauthClientId}
          secretInKeychain={oauthSecretInKeychain}
          isAuthenticating={isAuthenticating}
          errorMessage={onboardingError}
          onSaveCredentials={async (cid, sec) => {
            setOnboardingError(null);
            try {
              await saveOAuthClientCredentials(cid, sec);
              await refreshBootstrap();
            } catch (err) {
              setOnboardingError(err instanceof Error ? err.message : String(err));
            }
          }}
          onStartOAuth={async (mode, label) => {
            setOnboardingError(null);
            setIsAuthenticating(true);
            try {
              await startGmailOAuth(mode, label);
              await refreshBootstrap();
              await refreshThreadList();
              setShowOnboarding(false);
            } catch (err) {
              setOnboardingError(err instanceof Error ? err.message : String(err));
            } finally {
              setIsAuthenticating(false);
            }
          }}
        />
      ) : (
        <ReadingPane
          thread={openedThread}
          threadIndex={currentThreadIndex}
          totalThreads={mailboxThreads.length}
          isStarred={selectedThreadId ? starredThreadIds.has(selectedThreadId) : false}
          theme={theme}
          loadingBody={loadingBody}
          aiPanelOpen={aiPanelOpen}
          summaryText={currentSummary}
          isSummarizing={isSummarizing}
          draftText={currentDraft}
          attachments={selectedThreadId ? attachmentsByThread[selectedThreadId] || [] : []}
          undoToast={undoToast}
          replyInputRef={replyInputRef}
          onToggleStar={handleToggleStar}
          onArchive={handleArchiveThread}
          onTrash={handleTrashThread}
          onSpam={handleSpamThread}
          onReply={() => replyInputRef.current?.focus()}
          onForward={handleForward}
          onReplyAll={handleReplyAll}
          onDownloadAttachment={handleDownloadAttachment}
          onPrevThread={handlePrevThread}
          onNextThread={handleNextThread}
          onToggleTheme={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
          onToggleAiPanel={() => setAiPanelOpen((prev) => !prev)}
          onDraftChange={(text) => {
            if (selectedThreadId) {
              setDraftsByThread((prev) => ({ ...prev, [selectedThreadId]: text }));
            }
          }}
          onAddAttachment={(att) => {
            if (selectedThreadId) {
              setAttachmentsByThread((prev) => ({
                ...prev,
                [selectedThreadId]: [...(prev[selectedThreadId] || []), att],
              }));
            }
          }}
          onRemoveAttachment={(attId) => {
            if (selectedThreadId) {
              setAttachmentsByThread((prev) => ({
                ...prev,
                [selectedThreadId]: (prev[selectedThreadId] || []).filter((a) => a.id !== attId),
              }));
            }
          }}
          onDiscardDraft={handleDiscardDraft}
          onSendEmail={handleSendEmail}
          isSendingEmail={isSendingEmail}
          onGenerateSummary={handleGenerateSummary}
          onQuickChip={handleQuickChip}
          onSubmitReplyPrompt={handleCustomReplyPrompt}
        />
      )}

      {/* Coluna 4 (Opcional/Toggleable com ⌘J): Painel Lateral de IA */}
      {aiPanelOpen && !shouldRenderOnboarding && openedThread && (
        <CalmAIPanel
          thread={openedThread}
          account={selectedAccount}
          injectionInspection={null}
          masterAiKillSwitch={masterAiKillSwitch}
          modelStatus={modelStatus}
          availableModels={availableModels}
          hasExistingDraft={Boolean(currentDraft.trim())}
          activeTier={activeTier}
          userContextText={currentUserContext}
          onUserContextTextChange={handleUserContextChange}
          onSelectTier={(tier) => setActiveTier(tier)}
          onApplyGeneratedText={(txt, _tier, mode) => handleApplyAiToDraft(txt, mode)}
          onRefreshModelStatus={() => void refreshBootstrap()}
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={() => setAiPanelOpen(false)}
          onAttachFileToDraft={(att) => {
            if (selectedThreadId) {
              setAttachmentsByThread((prev) => ({
                ...prev,
                [selectedThreadId]: [...(prev[selectedThreadId] || []), att],
              }));
              triggerUndoNotice(t('toast.attachmentAdded', { name: att.name }), () => {});
            }
          }}
        />
      )}

      {/* Drawer de Definições e Privacidade */}
      <PrivacySettingsDrawer
        open={settingsOpen}
        accounts={accounts}
        pollIntervalSecs={pollIntervalSecs}
        masterAiKillSwitch={masterAiKillSwitch}
        userSignatureName={userSignatureName}
        modelStatus={modelStatus}
        availableModels={availableModels}
        oauthClientId={oauthClientId}
        oauthSecretInKeychain={oauthSecretInKeychain}
        onClose={() => setSettingsOpen(false)}
        onSaveCredentials={async (cid, sec) => {
          await saveOAuthClientCredentials(cid, sec);
          await refreshBootstrap();
        }}
        onSaveRuntimeSettings={async (params) => {
          const nextStatus = await updateRuntimeSettings(params);
          setPollIntervalSecs(params.pollIntervalSecs);
          setMasterAiKillSwitch(params.masterAiKillSwitch);
          setModelStatus(nextStatus);
        }}
        onUpdateSignatureName={async (name) => {
          const saved = await updateUserSignatureName(name);
          setUserSignatureName(saved);
        }}
        onInstallRecommendedModel={async () => {
          const nextStatus = await installRecommendedModel();
          setModelStatus(nextStatus);
          await refreshBootstrap();
        }}
        onUpdateAccountPolicy={async (params) => {
          await updateAccountAiPolicy(params);
          await refreshBootstrap();
        }}
        onDisconnectAccount={async (email) => {
          await disconnectGmailAccount(email);
          await refreshBootstrap();
          await refreshThreadList();
        }}
        onAddAccount={handleAddAccount}
      />

      {/* Modal para Criar / Editar Caixa de Entrada Personalizada */}
      <CustomMailboxModal
        open={customMailboxModalOpen}
        accounts={accounts}
        initialMailbox={editingMailbox}
        onClose={() => {
          setCustomMailboxModalOpen(false);
          setEditingMailbox(null);
        }}
        onSave={handleCreateOrUpdateCustomMailbox}
      />

      {/* Modal de Compor Novo E-mail */}
      <ComposeModal
        open={composeOpen}
        accounts={accounts}
        defaultAccountEmail={openedThread?.accountEmail || accounts[0]?.email}
        initialTo={composeInitialData?.to}
        initialCc={composeInitialData?.cc}
        initialBcc={composeInitialData?.bcc}
        initialSubject={composeInitialData?.subject}
        initialBody={composeInitialData?.body}
        initialAttachments={composeInitialData?.attachments}
        threadId={composeInitialData?.threadId}
        inReplyTo={composeInitialData?.inReplyTo}
        onClose={() => {
          setComposeOpen(false);
          setComposeInitialData(null);
        }}
        onSend={handleSendCompose}
      />
    </div>
  );
};

import React, { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { formatFileSize } from '../services/documentParser';
import { exportThreadEml, rewriteTextWithAi } from '../services/tauriBridge';
import { EmailAttachment, ThreadDetail } from '../types/kwrl';
import {
  IconArchive,
  IconArrowUp,
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconDownload,
  IconFile,
  IconFlag,
  IconForward,
  IconMarginalia,
  IconMoon,
  IconPaperclip,
  IconPrinter,
  IconReply,
  IconReplyAll,
  IconSpam,
  IconSparkles,
  IconSun,
  IconTrash,
} from './Icons';

interface ReadingPaneProps {
  thread: ThreadDetail | null;
  threadIndex: number;
  totalThreads: number;
  isStarred: boolean;
  theme: 'light' | 'dark';
  loadingBody: boolean;
  aiPanelOpen: boolean;
  summaryText?: string;
  isSummarizing?: boolean;
  draftText: string;
  attachments: EmailAttachment[];
  undoToast: { text: string; onUndo: () => void } | null;
  replyInputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  onToggleStar: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onSpam: () => void;
  onReply: () => void;
  onForward: () => void;
  onReplyAll?: () => void;
  onDownloadAttachment?: (messageId: string, attachmentId: string, filename: string) => void;
  onPrevThread: () => void;
  onNextThread: () => void;
  onToggleTheme: () => void;
  onToggleAiPanel: () => void;
  onDraftChange: (text: string) => void;
  onAddAttachment: (att: EmailAttachment) => void;
  onRemoveAttachment: (attId: string) => void;
  onDiscardDraft: () => void;
  onSendEmail: (mode: 'reply' | 'new', customTo?: string, customSubject?: string) => Promise<void>;
  isSendingEmail: boolean;
  onGenerateSummary?: () => void;
  onQuickChip?: (chipLabel: string) => void;
  onSubmitReplyPrompt?: (prompt: string) => void;
}

function sanitizeHtmlAndCountTrackers(rawHtml: string): { cleanHtml: string; blockedTrackers: number } {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return { cleanHtml: '', blockedTrackers: 0 };
  }

  let count = 0;
  const trackerPatterns = [
    /open\.track/i,
    /mailchimp\.com\/track/i,
    /hubspot\.com\/email-tracking/i,
    /sendgrid\.net\/wf\/open/i,
    /google-analytics\.com\/collect/i,
    /pixel\.gif/i,
    /pixel\.png/i,
    /ci3\.googleusercontent\.com\/proxy\/.*open/i,
  ];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    // 1. Remove tags ativas e perigosas da árvore DOM
    const dangerousTags = ['script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta', 'applet'];
    for (const tag of dangerousTags) {
      const elements = doc.querySelectorAll(tag);
      elements.forEach((el) => el.parentNode?.removeChild(el));
    }

    // 2. Itera todos os elementos restantes para limpar eventos inline e URLs perigosas
    const all = doc.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];

      const attrs = el.getAttributeNames();
      for (const attr of attrs) {
        if (attr.toLowerCase().startsWith('on')) {
          el.removeAttribute(attr);
        }
      }

      if (el.hasAttribute('href')) {
        const href = (el.getAttribute('href') || '').trim().toLowerCase();
        if (href.startsWith('javascript:') || href.startsWith('vbscript:') || href.startsWith('data:text/html')) {
          el.setAttribute('href', '#');
        }
      }

      if (el.hasAttribute('src')) {
        const src = (el.getAttribute('src') || '').trim().toLowerCase();
        if (src.startsWith('javascript:') || src.startsWith('vbscript:')) {
          el.removeAttribute('src');
        }
      }

      // Força abertura de links de forma segura
      if (el.tagName.toLowerCase() === 'a') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }

      // 3. Deteção e neutralização de pixels de rastreio de abertura
      if (el.tagName.toLowerCase() === 'img') {
        const src = (el.getAttribute('src') || '').toLowerCase();
        const width = el.getAttribute('width');
        const height = el.getAttribute('height');
        const style = (el.getAttribute('style') || '').toLowerCase();

        const isKnownTracker = trackerPatterns.some((pattern) => pattern.test(src));
        const isPixel =
          (width === '1' && height === '1') ||
          (width === '0' && height === '0') ||
          style.includes('display: none') ||
          style.includes('display:none');

        if (isKnownTracker || isPixel) {
          count++;
          el.parentNode?.removeChild(el);
        }
      }
    }

    return { cleanHtml: doc.body.innerHTML, blockedTrackers: count };
  } catch {
    return { cleanHtml: rawHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ''), blockedTrackers: 0 };
  }
}

const SandboxedEmailHtml: React.FC<{
  html: string;
  theme: 'light' | 'dark';
}> = ({ html, theme }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState<number>(180);

  const docHtml = useMemo(() => {
    const textColor = theme === 'dark' ? '#ecebf0' : '#1d1929';
    const linkColor = theme === 'dark' ? '#bfa7e8' : '#6b46c1';
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <base target="_blank">
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13.5px;
      line-height: 1.6;
      color: ${textColor};
      background-color: transparent;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    img {
      max-width: 100%;
      height: auto;
    }
    a {
      color: ${linkColor};
      text-decoration: underline;
    }
    table {
      max-width: 100%;
    }
  </style>
</head>
<body>${html}</body>
</html>`;
  }, [html, theme]);

  const updateHeight = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc && doc.body) {
        const height = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 60);
        setFrameHeight(height + 16);
      }
    } catch {
      // Ignora silenciosamente se o motor do browser aplicar restrição de sandbox
    }
  }, []);

  useEffect(() => {
    updateHeight();
  }, [docHtml, updateHeight]);

  return (
    <iframe
      ref={iframeRef}
      title="Corpo do Email Seguro"
      srcDoc={docHtml}
      sandbox="allow-same-origin allow-popups"
      onLoad={updateHeight}
      style={{
        width: '100%',
        height: `${frameHeight}px`,
        minHeight: '60px',
        border: 'none',
        display: 'block',
        backgroundColor: 'transparent',
        overflow: 'hidden',
        transition: 'height 0.12s ease-out',
      }}
    />
  );
};

export const ReadingPane: React.FC<ReadingPaneProps> = ({
  thread,
  threadIndex,
  totalThreads,
  isStarred,
  theme,
  loadingBody,
  aiPanelOpen,
  summaryText,
  draftText,
  attachments,
  undoToast,
  replyInputRef,
  onToggleStar,
  onArchive,
  onTrash,
  onSpam,
  onReply,
  onForward,
  onReplyAll,
  onDownloadAttachment,
  onPrevThread,
  onNextThread,
  onToggleTheme,
  onToggleAiPanel,
  onDraftChange,
  onAddAttachment,
  onRemoveAttachment,
  onDiscardDraft,
  onSendEmail,
  isSendingEmail,
}) => {
  const { t } = useI18n();
  const [sendMode, setSendMode] = useState<'reply' | 'new'>('reply');
  const [customRecipient, setCustomRecipient] = useState('');
  const [customSubject, setCustomSubject] = useState('');
  const draftFileInputRef = useRef<HTMLInputElement | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);

  // Estado local do rascunho com debounce para 120 FPS sem re-renderizar a árvore inteira da app
  const [localDraft, setLocalDraft] = useState(draftText);
  const draftDebounceRef = useRef<number | null>(null);

  useEffect(() => {
    setLocalDraft(draftText);
  }, [draftText, thread?.id]);

  const handleDraftInputChange = useCallback((text: string) => {
    setLocalDraft(text);
    if (draftDebounceRef.current) {
      window.clearTimeout(draftDebounceRef.current);
    }
    draftDebounceRef.current = window.setTimeout(() => {
      onDraftChange(text);
    }, 200);
  }, [onDraftChange]);

  const handleDraftInputBlur = useCallback(() => {
    if (draftDebounceRef.current) {
      window.clearTimeout(draftDebounceRef.current);
    }
    onDraftChange(localDraft);
  }, [localDraft, onDraftChange]);

  const handleExportEml = async () => {
    if (!thread) return;
    try {
      const savedPath = await exportThreadEml(thread.id);
      setLocalNotice(`Conversa exportada com sucesso para ${savedPath}`);
      setTimeout(() => setLocalNotice(null), 5000);
    } catch (err) {
      console.error('Erro ao exportar:', err);
      setLocalNotice(`Falha ao exportar conversa: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setLocalNotice(null), 5000);
    }
  };

  const handleUnsubscribe = (header: string) => {
    const httpMatch = header.match(/<(https?:\/\/[^>]+)>/i);
    if (httpMatch && httpMatch[1]) {
      window.open(httpMatch[1], '_blank');
      setLocalNotice('Ligação de cancelamento de subscrição aberta no navegador.');
      setTimeout(() => setLocalNotice(null), 5000);
      return;
    }
    const mailtoMatch = header.match(/<(mailto:[^>]+)>/i);
    if (mailtoMatch && mailtoMatch[1]) {
      window.location.href = mailtoMatch[1];
      setLocalNotice('Pedido de anulação de subscrição preparado por e-mail.');
      setTimeout(() => setLocalNotice(null), 5000);
      return;
    }
    setLocalNotice(`Instrução de anulação: ${header}`);
    setTimeout(() => setLocalNotice(null), 5000);
  };

  // Cascata de mensagens da conversa: controle de colapsar / expandir
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(() => new Set());
  const [htmlViewMode, setHtmlViewMode] = useState<Record<string, boolean>>({});

  React.useEffect(() => {
    if (thread && thread.messages.length > 0) {
      const lastId = thread.messages[thread.messages.length - 1].id;
      setExpandedMessageIds(new Set([lastId]));
    }
  }, [thread?.id]);

  const toggleMessageExpanded = (msgId: string) => {
    setExpandedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
  };

  const toggleExpandAll = () => {
    if (!thread) return;
    if (expandedMessageIds.size === thread.messages.length) {
      const lastId = thread.messages[thread.messages.length - 1].id;
      setExpandedMessageIds(new Set([lastId]));
    } else {
      setExpandedMessageIds(new Set(thread.messages.map((m) => m.id)));
    }
  };

  React.useEffect(() => {
    if (thread) {
      const lm = thread.messages[thread.messages.length - 1];
      setCustomRecipient(lm?.senderEmail || '');
      setCustomSubject(thread.subject || '');
    }
  }, [thread?.id]);

  const [isAiRevising, setIsAiRevising] = useState(false);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [customPromptOpen, setCustomPromptOpen] = useState(false);
  const [customPromptText, setCustomPromptText] = useState('');
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [previousDraftForUndo, setPreviousDraftForUndo] = useState<string | null>(null);
  const aiMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) {
        setAiMenuOpen(false);
      }
    };
    if (aiMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [aiMenuOpen]);

  const handleAiAction = async (
    action: 'organize_and_correct' | 'formal' | 'short' | 'translate' | 'custom',
    targetLang?: string,
    customInstruction?: string
  ) => {
    if (!localDraft.trim() || isAiRevising) return;
    setAiMenuOpen(false);
    setPreviousDraftForUndo(localDraft);
    setIsAiRevising(true);
    setAiNotice(
      action === 'organize_and_correct'
        ? t('compose.aiNoticeOrganize')
        : action === 'formal'
        ? t('compose.aiNoticeFormal')
        : action === 'short'
        ? t('compose.aiNoticeShort')
        : action === 'custom'
        ? t('compose.aiNoticeCustom')
        : t('compose.aiNoticeTranslate')
    );

    const recipient =
      sendMode === 'reply'
        ? (lastMessage?.senderEmail || lastMessage?.senderName)
        : (customRecipient || undefined);

    try {
      const res = await rewriteTextWithAi({
        text: localDraft,
        action,
        recipient,
        targetLang,
        customInstruction,
      });
      if (res.fullText && res.fullText.trim()) {
        onDraftChange(res.fullText.trim());
        setAiNotice(t('compose.aiNoticeSuccess'));
        setTimeout(() => setAiNotice(null), 3500);
      }
    } catch (err) {
      console.error('Erro na IA:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setAiNotice(t('compose.aiNoticeError', { error: msg }));
      setTimeout(() => setAiNotice(null), 4000);
    } finally {
      setIsAiRevising(false);
    }
  };

  const handleUndoAi = () => {
    if (previousDraftForUndo !== null) {
      onDraftChange(previousDraftForUndo);
      setPreviousDraftForUndo(null);
      setAiNotice(null);
    }
  };

  const handleDraftFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      onAddAttachment({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: f.name,
        size: f.size,
        type: f.name.split('.').pop()?.toLowerCase() || 'bin',
        file: f,
      });
    }

    if (draftFileInputRef.current) {
      draftFileInputRef.current.value = '';
    }
  };

  const lastMessage = useMemo(() => {
    if (!thread || thread.messages.length === 0) return null;
    return thread.messages[thread.messages.length - 1];
  }, [thread]);

  const getInitials = (name: string, email: string) => {
    const raw = (name || email.split('@')[0] || 'U').trim();
    const parts = raw.split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return raw.slice(0, 1).toUpperCase();
  };

  if (!thread) {
    return (
      <main className="tinta-reading-pane">
        <div className="tinta-toolbar">
          <div className="tinta-toolbar-group">
            <button
              type="button"
              className="tinta-toolbar-btn"
              onClick={onToggleTheme}
              title={theme === 'dark' ? t('readingPane.lightMode') : t('readingPane.darkMode')}
              aria-label={t('readingPane.lightMode')}
            >
              {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
            </button>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--mute)',
            fontSize: '13px',
          }}
        >
          {loadingBody
            ? t('readingPane.loadingBody')
            : t('readingPane.emptyDesc')}
        </div>

        {undoToast && (
          <div className="tinta-undo-toast" role="status" aria-live="polite">
            <span>{undoToast.text}</span>
            <button
              type="button"
              className="tinta-undo-link"
              onClick={undoToast.onUndo}
            >
              {t('readingPane.undo')}
            </button>
          </div>
        )}
      </main>
    );
  }

  const senderName =
    lastMessage?.senderName || lastMessage?.senderEmail.split('@')[0] || t('readingPane.from');
  const senderEmail = lastMessage?.senderEmail || '';
  const positionText =
    totalThreads > 0 ? `${threadIndex + 1} / ${totalThreads}` : '';

  return (
    <main className="tinta-reading-pane" aria-label={t('readingPane.emptyTitle')}>
      {/* Barra de Ferramentas (h-12, border-b line) */}
      <header className="tinta-toolbar">
        {/* Esquerda: Arquivar (E), Apagar, Lixo | Responder, Reencaminhar, Marcar */}
        <div className="tinta-toolbar-group">
          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onArchive}
            title={`${t('emailList.archiveAction')} (E)`}
            aria-label={t('emailList.archiveAction')}
          >
            <IconArchive size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onTrash}
            title={`${t('common.delete')} (Backspace)`}
            aria-label={t('common.delete')}
          >
            <IconTrash size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onSpam}
            title={t('sidebar.spam')}
            aria-label={t('sidebar.spam')}
          >
            <IconSpam size={16} />
          </button>

          <span className="tinta-toolbar-separator" />

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onReply}
            title={`${t('readingPane.reply')} (/)`}
            aria-label={t('readingPane.reply')}
          >
            <IconReply size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onReplyAll || onReply}
            title={t('readingPane.replyAll')}
            aria-label={t('readingPane.replyAll')}
          >
            <IconReplyAll size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onForward}
            title={t('readingPane.forward')}
            aria-label={t('readingPane.forward')}
          >
            <IconForward size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={() => window.print()}
            title={t('readingPane.print')}
            aria-label={t('readingPane.print')}
          >
            <IconPrinter size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={handleExportEml}
            title={t('readingPane.exportEml')}
            aria-label={t('readingPane.exportEml')}
          >
            <IconDownload size={16} />
          </button>

          <button
            type="button"
            className={`tinta-toolbar-btn ${isStarred ? 'tinta-toolbar-btn--active' : ''}`}
            onClick={onToggleStar}
            title={isStarred ? t('emailList.unstar') : t('emailList.star')}
            aria-label={isStarred ? t('emailList.unstar') : t('emailList.star')}
          >
            <IconFlag size={16} />
          </button>
        </div>

        {/* Direita: "3 / 8", setas K e J, separador, sol/lua, painel IA */}
        <div className="tinta-toolbar-group">
          {positionText && (
            <span
              className="tinta-time"
              style={{ fontSize: '12px', marginRight: '4px' }}
            >
              {positionText}
            </span>
          )}

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onPrevThread}
            disabled={threadIndex <= 0}
            style={{ opacity: threadIndex <= 0 ? 0.35 : 1 }}
            title={t('readingPane.prevThread')}
            aria-label={t('readingPane.prevThread')}
          >
            <IconChevronUp size={14} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onNextThread}
            disabled={threadIndex >= totalThreads - 1}
            style={{ opacity: threadIndex >= totalThreads - 1 ? 0.35 : 1 }}
            title={t('readingPane.nextThread')}
            aria-label={t('readingPane.nextThread')}
          >
            <IconChevronDown size={14} />
          </button>

          <span className="tinta-toolbar-separator" />

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onToggleTheme}
            title={theme === 'dark' ? t('readingPane.lightMode') : t('readingPane.darkMode')}
            aria-label={t('readingPane.lightMode')}
          >
            {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
          </button>

          <button
            type="button"
            className={`tinta-toolbar-btn ${aiPanelOpen ? 'tinta-toolbar-btn--active' : ''}`}
            onClick={onToggleAiPanel}
            title={aiPanelOpen ? t('readingPane.closeAiPanel') : t('readingPane.openAiPanel')}
            aria-label={t('readingPane.openAiPanel')}
          >
            <IconMarginalia size={15} />
          </button>
        </div>
      </header>

      {/* Conteúdo de Leitura Fluido (preenchimento completo da secção com respiro editorial) */}
      <div className="tinta-reading-scroll-area">
        <div className="tinta-reading-center">
          {/* Título da Conversa e Controlo Expandir/Recolher */}
          <div style={{ marginBottom: '20px' }}>
            <h1 className="tinta-title-reading" style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--ink)' }}>
              {thread.subject || t('emailList.noSubject')}
            </h1>
            {summaryText && (
              <div
                style={{
                  marginTop: '12px',
                  padding: '10px 14px',
                  backgroundColor: 'var(--side)',
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  borderLeft: '3px solid var(--acc)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 600, color: 'var(--acc)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <span>✦</span>
                  <span>{t('readingPane.conversationSummary')}</span>
                </div>
                <div style={{ marginTop: '4px', fontSize: '12.5px', lineHeight: 1.5, color: 'var(--ink)' }}>
                  {summaryText}
                </div>
              </div>
            )}
            {thread.messages.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px' }}>
                <span style={{ fontSize: '12px', color: 'var(--mute)' }}>
                  {thread.messages.length} {t('sidebar.inbox').toLowerCase()}
                </span>
                <button
                  type="button"
                  onClick={toggleExpandAll}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '11px',
                    color: 'var(--color-accent, #a78bfa)',
                    fontWeight: 500,
                  }}
                >
                  {expandedMessageIds.size === thread.messages.length ? t('sidebar.collapseSidebar') : t('sidebar.expandSidebar')}
                </button>
              </div>
            )}
          </div>

          {/* Cascata de Mensagens da Conversa */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '24px' }}>
            {thread.messages.map((msg) => {
              const isExpanded = expandedMessageIds.has(msg.id);
              const msgInitials = getInitials(msg.senderName, msg.senderEmail);
              const showHtml = htmlViewMode[msg.id] ?? false;

              return (
                <div
                  key={msg.id}
                  style={{
                    backgroundColor: 'var(--bg)',
                    border: '1px solid var(--line)',
                    borderRadius: '10px',
                    overflow: 'hidden',
                    transition: 'box-shadow 0.15s ease',
                  }}
                >
                  {/* Cabeçalho da Mensagem */}
                  <div
                    onClick={() => toggleMessageExpanded(msg.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      cursor: 'pointer',
                      backgroundColor: isExpanded ? 'var(--fill)' : 'transparent',
                      borderBottom: isExpanded ? '1px solid var(--line)' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                      <div className="tinta-avatar-reading" style={{ width: '28px', height: '28px', fontSize: '11px', flexShrink: 0 }}>
                        {msgInitials}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>
                            {msg.senderName || msg.senderEmail.split('@')[0]}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--mute)' }}>
                            &lt;{msg.senderEmail}&gt;
                          </span>
                        </div>
                        {!isExpanded && (
                          <div
                            style={{
                              fontSize: '12px',
                              color: 'var(--mute)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              marginTop: '2px',
                            }}
                          >
                            {msg.snippet}
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      <span style={{ fontSize: '11px', color: 'var(--faint)', whiteSpace: 'nowrap' }}>
                        {msg.displayDate}
                      </span>
                      {isExpanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                    </div>
                  </div>

                  {/* Detalhes e Corpo da Mensagem (quando expandida) */}
                  {isExpanded && (
                    <div style={{ padding: '16px 20px' }}>
                      {/* Destinatários e Ações Rápidas */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '16px',
                          paddingBottom: '10px',
                          borderBottom: '1px solid var(--line)',
                          fontSize: '11px',
                          color: 'var(--mute)',
                        }}
                      >
                        <div>
                          <span>{t('readingPane.to')}: {msg.toHeader || senderName}</span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {msg.listUnsubscribe && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUnsubscribe(msg.listUnsubscribe!);
                              }}
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--line)',
                                borderRadius: '4px',
                                padding: '2px 8px',
                                cursor: 'pointer',
                                fontSize: '10px',
                                fontWeight: 500,
                                color: 'var(--acc)',
                              }}
                              title={t('readingPane.unsubscribeNotice')}
                            >
                              {t('readingPane.unsubscribe')}
                            </button>
                          )}
                          {msg.bodyHtml && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setHtmlViewMode((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }));
                              }}
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--line)',
                                borderRadius: '4px',
                                padding: '2px 6px',
                                cursor: 'pointer',
                                fontSize: '10px',
                                color: 'var(--ink)',
                              }}
                            >
                              {showHtml ? 'Plain text' : 'HTML'}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Corpo do E-mail */}
                      <article style={{ margin: '12px 0', fontSize: '13px', lineHeight: '1.6', color: 'var(--ink)' }}>
                        {showHtml && msg.bodyHtml ? (() => {
                          const { cleanHtml, blockedTrackers } = sanitizeHtmlAndCountTrackers(msg.bodyHtml);
                          return (
                            <div>
                              {blockedTrackers > 0 && (
                                <div
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '4px 8px',
                                    borderRadius: '6px',
                                    backgroundColor: 'rgba(56, 161, 105, 0.1)',
                                    border: '1px solid rgba(56, 161, 105, 0.25)',
                                    color: '#2f855a',
                                    fontSize: '11px',
                                    fontWeight: 500,
                                    marginBottom: '10px',
                                  }}
                                >
                                  <span>🛡️</span>
                                  <span>
                                    {t('readingPane.blockedTrackersNotice', { count: blockedTrackers })}
                                  </span>
                                </div>
                              )}
                              <SandboxedEmailHtml html={cleanHtml} theme={theme} />
                            </div>
                          );
                        })() : (
                          <div style={{ whiteSpace: 'pre-wrap' }}>
                            {msg.bodyPlain || msg.snippet}
                          </div>
                        )}
                      </article>

                      {/* Anexos Recebidos */}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--line)' }}>
                          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mute)', marginBottom: '8px' }}>
                            {t('readingPane.attachments')} ({msg.attachments.length})
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {msg.attachments.map((att) => (
                              <div
                                key={att.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '8px',
                                  padding: '6px 12px',
                                  borderRadius: '6px',
                                  border: '1px solid var(--line)',
                                  backgroundColor: 'var(--fill)',
                                  fontSize: '12px',
                                }}
                              >
                                <IconFile size={15} />
                                <div>
                                  <div
                                    style={{
                                      fontWeight: 500,
                                      color: 'var(--ink)',
                                      maxWidth: '180px',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {att.filename}
                                  </div>
                                  <div style={{ fontSize: '10px', color: 'var(--faint)' }}>
                                    {att.sizeBytes > 0 ? `${(att.sizeBytes / 1024).toFixed(0)} KB` : ''}
                                  </div>
                                </div>
                                {att.attachmentId && onDownloadAttachment && (
                                  <button
                                    type="button"
                                    onClick={() => onDownloadAttachment(msg.id, att.attachmentId!, att.filename)}
                                    style={{
                                      background: 'transparent',
                                      border: 'none',
                                      cursor: 'pointer',
                                      color: 'var(--color-accent, #a78bfa)',
                                      padding: '4px',
                                      display: 'flex',
                                      alignItems: 'center',
                                    }}
                                    title={t('readingPane.download')}
                                  >
                                    <IconDownload size={14} />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Rascunho de E-mail (editável com envio como Resposta ou Novo E-mail + Anexos) */}
          <section className="tinta-draft-card">
            <div className="tinta-draft-card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>
                  {sendMode === 'reply' ? t('readingPane.sendInThisThread') : t('compose.newDraft')}
                </span>
                {aiNotice && (
                  <span style={{ fontSize: '11px', color: 'var(--acc, #7567a3)', fontStyle: 'italic' }}>
                    {aiNotice}
                  </span>
                )}

                {/* Controlo de Modo: Responder vs Novo e-mail */}
                <div
                  style={{
                    display: 'inline-flex',
                    backgroundColor: 'var(--fill)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '2px',
                    gap: '2px',
                    border: '1px solid var(--line)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setSendMode('reply')}
                    style={{
                      fontSize: '11px',
                      fontWeight: sendMode === 'reply' ? 600 : 500,
                      padding: '2px 8px',
                      borderRadius: '6px',
                      border: sendMode === 'reply' ? '1px solid var(--line)' : '1px solid transparent',
                      backgroundColor: sendMode === 'reply' ? 'var(--bg)' : 'transparent',
                      color: sendMode === 'reply' ? 'var(--ink)' : 'var(--mute)',
                      cursor: 'pointer',
                    }}
                  >
                    {t('readingPane.reply')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSendMode('new')}
                    style={{
                      fontSize: '11px',
                      fontWeight: sendMode === 'new' ? 600 : 500,
                      padding: '2px 8px',
                      borderRadius: '6px',
                      border: sendMode === 'new' ? '1px solid var(--line)' : '1px solid transparent',
                      backgroundColor: sendMode === 'new' ? 'var(--bg)' : 'transparent',
                      color: sendMode === 'new' ? 'var(--ink)' : 'var(--mute)',
                      cursor: 'pointer',
                    }}
                  >
                    {t('compose.newDraft')}
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  ref={draftFileInputRef}
                  type="file"
                  multiple
                  accept="*"
                  style={{ display: 'none' }}
                  onChange={handleDraftFileSelect}
                />
                <button
                  type="button"
                  className="tinta-btn-secondary"
                  style={{ fontSize: '11px', padding: '3px 8px' }}
                  onClick={() => draftFileInputRef.current?.click()}
                  title={t('readingPane.attachFiles')}
                >
                  <IconPaperclip size={12} />
                  <span>+ {t('compose.attachFiles')}</span>
                </button>

                <div style={{ position: 'relative' }} ref={aiMenuRef}>
                  <button
                    type="button"
                    className="tinta-btn-secondary"
                    style={{
                      fontSize: '11px',
                      padding: '3px 8px',
                      color: !localDraft.trim() ? 'var(--faint)' : 'var(--acc, #7567a3)',
                    }}
                    disabled={!localDraft.trim() || isAiRevising}
                    onClick={() => setAiMenuOpen((prev) => !prev)}
                    title={!localDraft.trim() ? t('compose.bodyPlaceholder') : t('compose.aiAssist')}
                  >
                    <IconSparkles size={12} />
                    <span>{isAiRevising ? t('compose.generating') : t('compose.aiAssist')}</span>
                  </button>

                  {/* Dropdown Menu */}
                  {aiMenuOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        bottom: '100%',
                        right: 0,
                        marginBottom: '6px',
                        backgroundColor: 'var(--bg)',
                        border: '1px solid var(--line)',
                        borderRadius: '8px',
                        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
                        zIndex: 100,
                        width: '260px',
                        padding: '6px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                        maxHeight: 'min(380px, calc(100vh - 220px))',
                        overflowY: 'auto',
                        overscrollBehavior: 'contain',
                        boxSizing: 'border-box',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => handleAiAction('organize_and_correct')}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          padding: '6px 8px',
                          borderRadius: '5px',
                          border: 'none',
                          backgroundColor: 'transparent',
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--ink)' }}>{t('compose.toneOrganize')}</span>
                        <span style={{ fontSize: '10px', color: 'var(--mute)' }}>{t('compose.organizeDesc')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleAiAction('formal')}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          padding: '6px 8px',
                          borderRadius: '5px',
                          border: 'none',
                          backgroundColor: 'transparent',
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--ink)' }}>{t('compose.toneFormal')}</span>
                        <span style={{ fontSize: '10px', color: 'var(--mute)' }}>{t('compose.formalDesc')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleAiAction('short')}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          padding: '6px 8px',
                          borderRadius: '5px',
                          border: 'none',
                          backgroundColor: 'transparent',
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--ink)' }}>{t('compose.toneShort')}</span>
                        <span style={{ fontSize: '10px', color: 'var(--mute)' }}>{t('compose.shortDesc')}</span>
                      </button>

                      <div style={{ height: '1px', backgroundColor: 'var(--line)', margin: '3px 0' }} />

                      <div style={{ padding: '2px 8px', fontSize: '10px', color: 'var(--faint)', fontWeight: 600, textTransform: 'uppercase' }}>
                        {t('compose.toneTranslate')}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px', padding: '0 4px' }}>
                        <button
                          type="button"
                          onClick={() => handleAiAction('translate', 'inglês')}
                          style={{
                            padding: '4px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--line)',
                            backgroundColor: 'var(--bg)',
                            color: 'var(--ink)',
                            fontSize: '10.5px',
                            cursor: 'pointer',
                          }}
                        >
                          {t('compose.langEnglish')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAiAction('translate', 'português')}
                          style={{
                            padding: '4px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--line)',
                            backgroundColor: 'var(--bg)',
                            color: 'var(--ink)',
                            fontSize: '10.5px',
                            cursor: 'pointer',
                          }}
                        >
                          {t('compose.langPortuguese')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAiAction('translate', 'espanhol')}
                          style={{
                            padding: '4px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--line)',
                            backgroundColor: 'var(--bg)',
                            color: 'var(--ink)',
                            fontSize: '10.5px',
                            cursor: 'pointer',
                          }}
                        >
                          {t('compose.langSpanish')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAiAction('translate', 'francês')}
                          style={{
                            padding: '4px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--line)',
                            backgroundColor: 'var(--bg)',
                            color: 'var(--ink)',
                            fontSize: '10.5px',
                            cursor: 'pointer',
                          }}
                        >
                          {t('compose.langFrench')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAiAction('translate', 'alemão')}
                          style={{
                            padding: '4px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--line)',
                            backgroundColor: 'var(--bg)',
                            color: 'var(--ink)',
                            fontSize: '10.5px',
                            cursor: 'pointer',
                            gridColumn: '1 / -1',
                          }}
                        >
                          {t('compose.langGerman')}
                        </button>
                      </div>

                      <div style={{ height: '1px', backgroundColor: 'var(--line)', margin: '3px 0' }} />

                      <button
                        type="button"
                        onClick={() => {
                          setAiMenuOpen(false);
                          setCustomPromptOpen(true);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '6px 8px',
                          borderRadius: '5px',
                          border: 'none',
                          backgroundColor: 'transparent',
                          textAlign: 'left',
                          cursor: 'pointer',
                          fontSize: '11px',
                          color: 'var(--ink)',
                          fontWeight: 500,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <span>✏️</span>
                        <span>{t('compose.instructionCustom')}</span>
                      </button>
                    </div>
                  )}
                </div>

                {previousDraftForUndo !== null && (
                  <button
                    type="button"
                    onClick={handleUndoAi}
                    className="tinta-btn-secondary"
                    style={{ fontSize: '11px', padding: '3px 8px' }}
                    title={t('readingPane.revertAi')}
                  >
                    {t('compose.undo')}
                  </button>
                )}

                {localDraft && (
                  <button
                    type="button"
                    className="tinta-btn-discard"
                    onClick={onDiscardDraft}
                  >
                    {t('compose.discardDraft')}
                  </button>
                )}
              </div>
            </div>

            {/* Campo de Instrução Personalizada de IA */}
            {customPromptOpen && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 10px',
                  backgroundColor: 'var(--side)',
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--line)',
                }}
              >
                <input
                  type="text"
                  value={customPromptText}
                  onChange={(e) => setCustomPromptText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (customPromptText.trim()) {
                        void handleAiAction('custom', undefined, customPromptText.trim());
                        setCustomPromptOpen(false);
                        setCustomPromptText('');
                      }
                    } else if (e.key === 'Escape') {
                      setCustomPromptOpen(false);
                    }
                  }}
                  placeholder={t('compose.instructionPlaceholder')}
                  style={{
                    flex: 1,
                    padding: '4px 8px',
                    borderRadius: '4px',
                    border: '1px solid var(--line)',
                    backgroundColor: 'var(--bg)',
                    color: 'var(--ink)',
                    fontSize: '11.5px',
                    outline: 'none',
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => {
                    if (customPromptText.trim()) {
                      void handleAiAction('custom', undefined, customPromptText.trim());
                      setCustomPromptOpen(false);
                      setCustomPromptText('');
                    }
                  }}
                  disabled={!customPromptText.trim()}
                  className="tinta-btn-primary"
                  style={{ fontSize: '11px', padding: '3px 10px' }}
                >
                  {t('compose.customPromptApply')}
                </button>
                <button
                  type="button"
                  onClick={() => setCustomPromptOpen(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--mute)',
                    fontSize: '11px',
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            )}

            {/* Linha contextual do destinatário / assunto */}
            {sendMode === 'reply' ? (
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--mute)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '2px 0',
                }}
              >
                <span style={{ color: 'var(--faint)' }}>{t('readingPane.reply')}:</span>
                <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{senderName}</span>
                <span style={{ color: 'var(--faint)' }}>({senderEmail})</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '2px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--faint)', width: '56px', flexShrink: 0 }}>
                    {t('compose.to')}:
                  </label>
                  <input
                    type="email"
                    value={customRecipient}
                    onChange={(e) => setCustomRecipient(e.target.value)}
                    placeholder={t('compose.toPlaceholder')}
                    style={{
                      flex: 1,
                      fontSize: '12.5px',
                      padding: '4px 8px',
                      borderRadius: 'var(--radius-lg)',
                      border: '1px solid var(--line)',
                      backgroundColor: 'var(--fill)',
                      color: 'var(--ink)',
                      outline: 'none',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--faint)', width: '56px', flexShrink: 0 }}>
                    {t('compose.subject')}:
                  </label>
                  <input
                    type="text"
                    value={customSubject}
                    onChange={(e) => setCustomSubject(e.target.value)}
                    placeholder={t('compose.subjectPlaceholder')}
                    style={{
                      flex: 1,
                      fontSize: '12.5px',
                      padding: '4px 8px',
                      borderRadius: 'var(--radius-lg)',
                      border: '1px solid var(--line)',
                      backgroundColor: 'var(--fill)',
                      color: 'var(--ink)',
                      outline: 'none',
                    }}
                  />
                </div>
              </div>
            )}

            <textarea
              ref={replyInputRef as any}
              className="tinta-draft-textarea"
              placeholder={t('compose.bodyPlaceholder')}
              value={localDraft}
              onChange={(e) => handleDraftInputChange(e.target.value)}
              onBlur={handleDraftInputBlur}
            />

            {attachments.length > 0 && (
              <div className="tinta-draft-attachments">
                {attachments.map((att) => (
                  <div key={att.id} className="tinta-attachment-pill">
                    <IconPaperclip size={12} />
                    <span className="tinta-attachment-pill-name" title={att.name}>
                      {att.name}
                    </span>
                    <span style={{ fontSize: '10.5px', color: 'var(--faint)' }}>
                      ({formatFileSize(att.size)})
                    </span>
                    <button
                      type="button"
                      className="tinta-attachment-pill-remove"
                      onClick={() => onRemoveAttachment(att.id)}
                      title={t('readingPane.removeAttachment')}
                    >
                      <IconClose size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              className="tinta-draft-card-footer"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
              }}
            >
              <span className="tinta-meta-faint">
                {attachments.length > 0
                  ? `${attachments.length} ${t('readingPane.attachments').toLowerCase()}`
                  : ''}
              </span>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {/* Opção Secundária */}
                {sendMode === 'reply' ? (
                  <button
                    type="button"
                    className="tinta-btn-secondary"
                    disabled={!localDraft.trim() || isSendingEmail}
                    style={{ opacity: localDraft.trim() && !isSendingEmail ? 1 : 0.45 }}
                    onClick={() => {
                      void onSendEmail('new', customRecipient || senderEmail, customSubject || thread.subject);
                    }}
                    title={t('readingPane.sendAsNewThread')}
                  >
                    {t('readingPane.sendAsNewThread')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="tinta-btn-secondary"
                    disabled={!localDraft.trim() || isSendingEmail}
                    style={{ opacity: localDraft.trim() && !isSendingEmail ? 1 : 0.45 }}
                    onClick={() => {
                      void onSendEmail('reply');
                    }}
                    title={t('readingPane.sendInThisThread')}
                  >
                    {t('readingPane.sendInThisThread')}
                  </button>
                )}

                {/* Opção Primária correspondente ao modo ativo */}
                <button
                  type="button"
                  className="tinta-btn-primary"
                  disabled={!localDraft.trim() || isSendingEmail}
                  style={{
                    opacity: localDraft.trim() && !isSendingEmail ? 1 : 0.45,
                    minWidth: '150px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                  }}
                  onClick={() => {
                    if (sendMode === 'reply') {
                      void onSendEmail('reply');
                    } else {
                      void onSendEmail('new', customRecipient || senderEmail, customSubject || thread.subject);
                    }
                  }}
                >
                  {isSendingEmail ? (
                    t('readingPane.sendingAction')
                  ) : sendMode === 'reply' ? (
                    <>
                      <IconReply size={13} />
                      <span>{t('readingPane.sendInThisThread')}</span>
                    </>
                  ) : (
                    <>
                      <IconArrowUp size={13} />
                      <span>{t('readingPane.sendAsNewThread')}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Notificação local do Painel */}
      {localNotice && (
        <div className="tinta-undo-toast" role="status" aria-live="polite">
          <span>{localNotice}</span>
        </div>
      )}

      {/* Aviso de Anular Flutuante (6s) */}
      {undoToast && (
        <div className="tinta-undo-toast" role="status" aria-live="polite">
          <span>{undoToast.text}</span>
          <button
            type="button"
            className="tinta-undo-link"
            onClick={undoToast.onUndo}
          >
            {t('readingPane.undo')}
          </button>
        </div>
      )}
    </main>
  );
};

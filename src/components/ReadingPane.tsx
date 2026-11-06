import React, { RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { formatFileSize } from '../services/documentParser';
import { exportThreadEml, rewriteTextWithAi } from '../services/tauriBridge';
import { EmailAttachment, ThreadDetail } from '../types/corvo';
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
  let count = 0;
  const trackerPatterns = [
    /width=["']?[01]["']?\s+height=["']?[01]["']?/i,
    /height=["']?[01]["']?\s+width=["']?[01]["']?/i,
    /open\.track/i,
    /mailchimp\.com\/track/i,
    /hubspot\.com\/email-tracking/i,
    /sendgrid\.net\/wf\/open/i,
    /google-analytics\.com\/collect/i,
    /pixel\.gif/i,
    /pixel\.png/i,
    /ci3\.googleusercontent\.com\/proxy\/.*open/i,
  ];

  const clean = rawHtml.replace(/<img\s+([^>]*?)>/gi, (match, attrs) => {
    const isTracker = trackerPatterns.some((pattern) => pattern.test(attrs));
    if (isTracker) {
      count++;
      return '<!-- Corvo: rastreador de abertura bloqueado -->';
    }
    return match;
  });

  return { cleanHtml: clean, blockedTrackers: count };
}

export const ReadingPane: React.FC<ReadingPaneProps> = ({
  thread,
  threadIndex,
  totalThreads,
  isStarred,
  theme,
  loadingBody,
  aiPanelOpen,
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
  const [sendMode, setSendMode] = useState<'reply' | 'new'>('reply');
  const [customRecipient, setCustomRecipient] = useState('');
  const [customSubject, setCustomSubject] = useState('');
  const draftFileInputRef = useRef<HTMLInputElement | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);

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
    action: 'organize_and_correct' | 'formal' | 'short' | 'translate',
    targetLang?: string
  ) => {
    if (!draftText.trim() || isAiRevising) return;
    setAiMenuOpen(false);
    setPreviousDraftForUndo(draftText);
    setIsAiRevising(true);
    setAiNotice(
      action === 'organize_and_correct'
        ? 'A organizar parágrafos e tirar erros...'
        : action === 'formal'
        ? 'A reescrever em tom formal...'
        : action === 'short'
        ? 'A condensar o texto...'
        : `A traduzir para ${targetLang || 'inglês'}...`
    );

    const recipient =
      sendMode === 'reply'
        ? (lastMessage?.senderEmail || lastMessage?.senderName)
        : (customRecipient || undefined);

    try {
      const res = await rewriteTextWithAi({
        text: draftText,
        action,
        recipient,
        targetLang,
      });
      if (res.fullText && res.fullText.trim()) {
        onDraftChange(res.fullText.trim());
        setAiNotice('Texto revisto pela IA!');
        setTimeout(() => setAiNotice(null), 3500);
      }
    } catch (err) {
      console.error('Erro na IA:', err);
      setAiNotice('Falha ao processar com a IA.');
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
              title={theme === 'dark' ? 'Modo claro' : 'Modo escuro'}
              aria-label="Alternar tema"
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
            ? 'A carregar mensagem…'
            : 'Seleciona uma mensagem na lista para ler.'}
        </div>

        {undoToast && (
          <div className="tinta-undo-toast" role="status" aria-live="polite">
            <span>{undoToast.text}</span>
            <button
              type="button"
              className="tinta-undo-link"
              onClick={undoToast.onUndo}
            >
              Anular
            </button>
          </div>
        )}
      </main>
    );
  }

  const senderName =
    lastMessage?.senderName || lastMessage?.senderEmail.split('@')[0] || 'Remetente';
  const senderEmail = lastMessage?.senderEmail || '';
  const positionText =
    totalThreads > 0 ? `${threadIndex + 1} de ${totalThreads}` : '';

  return (
    <main className="tinta-reading-pane" aria-label="Painel de leitura">
      {/* Barra de Ferramentas (h-12, border-b line) */}
      <header className="tinta-toolbar">
        {/* Esquerda: Arquivar (E), Apagar, Lixo | Responder, Reencaminhar, Marcar */}
        <div className="tinta-toolbar-group">
          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onArchive}
            title="Arquivar (E)"
            aria-label="Arquivar"
          >
            <IconArchive size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onTrash}
            title="Apagar (Backspace)"
            aria-label="Apagar"
          >
            <IconTrash size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onSpam}
            title="Lixo"
            aria-label="Lixo"
          >
            <IconSpam size={16} />
          </button>

          <span className="tinta-toolbar-separator" />

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onReply}
            title="Responder (/)"
            aria-label="Responder"
          >
            <IconReply size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onReplyAll || onReply}
            title="Responder a todos"
            aria-label="Responder a todos"
          >
            <IconReplyAll size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onForward}
            title="Reencaminhar"
            aria-label="Reencaminhar"
          >
            <IconForward size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={() => window.print()}
            title="Imprimir conversa (⌘P)"
            aria-label="Imprimir"
          >
            <IconPrinter size={16} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={handleExportEml}
            title="Exportar conversa para .eml (Soberania de dados)"
            aria-label="Exportar conversa"
          >
            <IconDownload size={16} />
          </button>

          <button
            type="button"
            className={`tinta-toolbar-btn ${isStarred ? 'tinta-toolbar-btn--active' : ''}`}
            onClick={onToggleStar}
            title={isStarred ? 'Desmarcar' : 'Marcar'}
            aria-label="Marcar mensagem"
          >
            <IconFlag size={16} />
          </button>
        </div>

        {/* Direita: "3 de 8", setas K e J, separador, sol/lua, painel IA */}
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
            title="Anterior (K)"
            aria-label="Mensagem anterior"
          >
            <IconChevronUp size={14} />
          </button>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onNextThread}
            disabled={threadIndex >= totalThreads - 1}
            style={{ opacity: threadIndex >= totalThreads - 1 ? 0.35 : 1 }}
            title="Seguinte (J)"
            aria-label="Mensagem seguinte"
          >
            <IconChevronDown size={14} />
          </button>

          <span className="tinta-toolbar-separator" />

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Modo claro' : 'Modo escuro'}
            aria-label="Alternar tema"
          >
            {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
          </button>

          <button
            type="button"
            className={`tinta-toolbar-btn ${aiPanelOpen ? 'tinta-toolbar-btn--active' : ''}`}
            onClick={onToggleAiPanel}
            title={aiPanelOpen ? 'Fechar assistente lateral' : 'Abrir assistente lateral (⌘J)'}
            aria-label="Assistente de IA lateral"
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
              {thread.subject || '(Sem assunto)'}
            </h1>
            {thread.messages.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px' }}>
                <span style={{ fontSize: '12px', color: 'var(--mute)' }}>
                  {thread.messages.length} mensagens nesta conversa
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
                  {expandedMessageIds.size === thread.messages.length ? 'Recolher anteriores' : 'Expandir todas'}
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
                          <span>Para: {msg.toHeader || 'mim'}</span>
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
                              title="Cancelar subscrição desta lista de distribuição"
                            >
                              Cancelar Subscrição
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
                              {showHtml ? 'Ver texto simples' : 'Ver HTML'}
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
                                    Proteção Ativa: {blockedTrackers} {blockedTrackers === 1 ? 'rastreador' : 'rastreadores'} de abertura bloqueado(s) localmente
                                  </span>
                                </div>
                              )}
                              <div
                                dangerouslySetInnerHTML={{ __html: cleanHtml }}
                                style={{ overflowX: 'auto' }}
                              />
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
                            Anexos recebidos ({msg.attachments.length})
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
                                    title="Descarregar e abrir ficheiro"
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
                  {sendMode === 'reply' ? 'Rascunho de resposta' : 'Novo e-mail'}
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
                    Responder
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
                    Novo e-mail
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
                  title="Anexar PDFs ou outros documentos ao e-mail"
                >
                  <IconPaperclip size={12} />
                  <span>+ Anexar ficheiro</span>
                </button>

                <div style={{ position: 'relative' }} ref={aiMenuRef}>
                  <button
                    type="button"
                    className="tinta-btn-secondary"
                    style={{
                      fontSize: '11px',
                      padding: '3px 8px',
                      color: !draftText.trim() ? 'var(--faint)' : 'var(--acc, #7567a3)',
                    }}
                    disabled={!draftText.trim() || isAiRevising}
                    onClick={() => setAiMenuOpen((prev) => !prev)}
                    title={!draftText.trim() ? 'Escreve algo para usar o Assistente de IA' : 'Organizar texto, tirar erros ou traduzir com o Motor de IA'}
                  >
                    <IconSparkles size={12} />
                    <span>{isAiRevising ? 'A processar...' : 'Rever com IA'}</span>
                  </button>

                  {/* Dropdown Menu */}
                  {aiMenuOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '100%',
                        right: 0,
                        marginTop: '4px',
                        backgroundColor: 'var(--bg)',
                        border: '1px solid var(--line)',
                        borderRadius: '8px',
                        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
                        zIndex: 50,
                        width: '260px',
                        padding: '6px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
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
                        <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--ink)' }}>✨ Organizar e tirar erros</span>
                        <span style={{ fontSize: '10px', color: 'var(--mute)' }}>Corrige ortografia, pontuação e estrutura em pt-PT</span>
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
                        <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--ink)' }}>👔 Tornar mais formal</span>
                        <span style={{ fontSize: '10px', color: 'var(--mute)' }}>Tom executivo e polido</span>
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
                        <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--ink)' }}>⚡ Tornar mais curto</span>
                        <span style={{ fontSize: '10px', color: 'var(--mute)' }}>Conciso e direto ao assunto</span>
                      </button>

                      <div style={{ height: '1px', backgroundColor: 'var(--line)', margin: '3px 0' }} />

                      <div style={{ padding: '2px 8px', fontSize: '10px', color: 'var(--faint)', fontWeight: 600, textTransform: 'uppercase' }}>
                        Tradução
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
                          🇬🇧 Inglês
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
                          🇪🇸 Espanhol
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
                          🇫🇷 Francês
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
                          }}
                        >
                          🇩🇪 Alemão
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {previousDraftForUndo !== null && (
                  <button
                    type="button"
                    onClick={handleUndoAi}
                    className="tinta-btn-secondary"
                    style={{ fontSize: '11px', padding: '3px 8px' }}
                    title="Anular alteração da IA e voltar ao rascunho anterior"
                  >
                    Anular IA
                  </button>
                )}

                {draftText && (
                  <button
                    type="button"
                    className="tinta-btn-discard"
                    onClick={onDiscardDraft}
                  >
                    Limpar
                  </button>
                )}
              </div>
            </div>

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
                <span style={{ color: 'var(--faint)' }}>A responder a:</span>
                <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{senderName}</span>
                <span style={{ color: 'var(--faint)' }}>({senderEmail})</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '2px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--faint)', width: '56px', flexShrink: 0 }}>
                    Para:
                  </label>
                  <input
                    type="email"
                    value={customRecipient}
                    onChange={(e) => setCustomRecipient(e.target.value)}
                    placeholder="destinatario@exemplo.com"
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
                    Assunto:
                  </label>
                  <input
                    type="text"
                    value={customSubject}
                    onChange={(e) => setCustomSubject(e.target.value)}
                    placeholder="Assunto da mensagem"
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
              placeholder={
                sendMode === 'reply'
                  ? `Escreve uma resposta para ${senderName} ou usa o Assistente de IA lateral (⌘J)…`
                  : 'Escreve a tua mensagem ou usa o Assistente de IA lateral (⌘J)…'
              }
              value={draftText}
              onChange={(e) => onDraftChange(e.target.value)}
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
                      title="Remover anexo"
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
                  ? `${attachments.length} ${
                      attachments.length === 1 ? 'ficheiro em anexo' : 'ficheiros em anexo'
                    }`
                  : ''}
              </span>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {/* Opção Secundária */}
                {sendMode === 'reply' ? (
                  <button
                    type="button"
                    className="tinta-btn-secondary"
                    disabled={!draftText.trim() || isSendingEmail}
                    style={{ opacity: draftText.trim() && !isSendingEmail ? 1 : 0.45 }}
                    onClick={() => {
                      void onSendEmail('new', customRecipient || senderEmail, customSubject || thread.subject);
                    }}
                    title="Enviar como um e-mail novo / thread separada"
                  >
                    Enviar como novo e-mail
                  </button>
                ) : (
                  <button
                    type="button"
                    className="tinta-btn-secondary"
                    disabled={!draftText.trim() || isSendingEmail}
                    style={{ opacity: draftText.trim() && !isSendingEmail ? 1 : 0.45 }}
                    onClick={() => {
                      void onSendEmail('reply');
                    }}
                    title="Enviar integrado nesta conversa"
                  >
                    Enviar como resposta
                  </button>
                )}

                {/* Opção Primária correspondente ao modo ativo */}
                <button
                  type="button"
                  className="tinta-btn-primary"
                  disabled={!draftText.trim() || isSendingEmail}
                  style={{
                    opacity: draftText.trim() && !isSendingEmail ? 1 : 0.45,
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
                    'A enviar…'
                  ) : sendMode === 'reply' ? (
                    <>
                      <IconReply size={13} />
                      <span>Enviar como resposta</span>
                    </>
                  ) : (
                    <>
                      <IconArrowUp size={13} />
                      <span>Enviar como novo e-mail</span>
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
            Anular
          </button>
        </div>
      )}
    </main>
  );
};

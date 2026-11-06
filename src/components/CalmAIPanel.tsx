import React, { useEffect, useRef, useState } from 'react';
import {
  ExtractedDocument,
  extractTextFromFile,
  formatFileSize,
} from '../services/documentParser';
import {
  installRecommendedModel,
  resolveFriendlyModelName,
  streamCdlrSuggestion,
  subscribeToAiTokens,
} from '../services/tauriBridge';
import {
  AccountView,
  CDLRTier,
  DiscoveredModel,
  EmailAttachment,
  InjectionInspection,
  LocalModelStatus,
  ThreadDetail,
} from '../types/corvo';
import { IconArrowUp, IconClose, IconFile, IconPaperclip, IconSliders } from './Icons';

interface CalmAIPanelProps {
  thread: ThreadDetail | null;
  account: AccountView | undefined;
  injectionInspection: InjectionInspection | null;
  masterAiKillSwitch: boolean;
  modelStatus: LocalModelStatus;
  availableModels: DiscoveredModel[];
  hasExistingDraft: boolean;
  activeTier?: CDLRTier;
  userContextText?: string;
  onUserContextTextChange?: (text: string) => void;
  onSelectTier?: (tier: CDLRTier) => void;
  onApplyGeneratedText: (
    text: string,
    tier: CDLRTier,
    mode: 'append' | 'replace'
  ) => void;
  onRefreshModelStatus: () => void;
  onOpenSettings: () => void;
  onClose?: () => void;
  onAttachFileToDraft?: (attachment: EmailAttachment) => void;
}

const TIER_TABS: { id: CDLRTier; label: string; subtitle: string }[] = [
  {
    id: 'frase',
    label: 'Frase',
    subtitle: 'Sugere a próxima frase direta para responder.',
  },
  {
    id: 'rascunho-curto',
    label: 'Rascunho curto',
    subtitle: '1 a 3 frases concisas prontas a rever e editar.',
  },
  {
    id: 'rascunho-estruturado',
    label: 'Estruturado',
    subtitle: 'Resposta completa organizada por pontos-chave.',
  },
];

const QUICK_CHIPS: { label: string; context: string; tier: CDLRTier }[] = [
  {
    label: 'Confirmar',
    context: 'Confirmar disponibilidade e total acordo com a mensagem recebida.',
    tier: 'rascunho-curto',
  },
  {
    label: 'Pedir mais tempo',
    context: 'Pedir mais tempo para analisar com calma e propor voltar ao contacto nos próximos dias.',
    tier: 'rascunho-curto',
  },
  {
    label: 'Recusar cordialmente',
    context: 'Agradecer a mensagem mas recusar cordialmente por indisponibilidade neste momento.',
    tier: 'rascunho-estruturado',
  },
  {
    label: 'Agradecer',
    context: 'Agradecer a atenção e desejar uma excelente semana.',
    tier: 'frase',
  },
];

interface GeneratedSlot {
  requestId?: string;
  text: string;
  streaming: boolean;
  ttftMs: number | null;
  totalMs: number | null;
  engineSource: string | null;
  error: string | null;
}

export const CalmAIPanel: React.FC<CalmAIPanelProps> = ({
  thread,
  account,
  injectionInspection,
  masterAiKillSwitch,
  modelStatus,
  availableModels,
  hasExistingDraft,
  activeTier: propActiveTier,
  userContextText: propUserContextText,
  onUserContextTextChange,
  onSelectTier,
  onApplyGeneratedText,
  onRefreshModelStatus,
  onOpenSettings,
  onClose,
  onAttachFileToDraft,
}) => {
  const [internalTier, setInternalTier] = useState<CDLRTier>('rascunho-curto');
  const currentTier = propActiveTier ?? internalTier;
  const [slots, setSlots] = useState<Record<string, GeneratedSlot>>({});

  // Ponto de vista do utilizador por texto (sincronizado com a thread selecionada)
  const [localUserContext, setLocalUserContext] = useState(propUserContextText || '');

  useEffect(() => {
    if (propUserContextText !== undefined) {
      setLocalUserContext(propUserContextText);
    }
  }, [propUserContextText]);

  const activeUserContext = propUserContextText !== undefined ? propUserContextText : localUserContext;

  const handleUserContextChange = (text: string) => {
    setLocalUserContext(text);
    onUserContextTextChange?.(text);
  };

  // Documentos e PDFs de Contexto para a IA
  const [contextDocuments, setContextDocuments] = useState<ExtractedDocument[]>([]);
  const [isParsingDoc, setIsParsingDoc] = useState(false);
  const [previewDocIdx, setPreviewDocIdx] = useState<number | null>(null);
  const contextFileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSelectTier = (tier: CDLRTier) => {
    setInternalTier(tier);
    onSelectTier?.(tier);
  };

  const handleContextFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsParsingDoc(true);
    try {
      const extractedList: ExtractedDocument[] = [];
      for (let i = 0; i < files.length; i++) {
        const doc = await extractTextFromFile(files[i]);
        extractedList.push(doc);
      }
      setContextDocuments((prev) => [...prev, ...extractedList]);
    } catch (err) {
      console.error('Falha ao extrair texto do documento:', err);
    } finally {
      setIsParsingDoc(false);
      if (contextFileInputRef.current) {
        contextFileInputRef.current.value = '';
      }
    }
  };

  const handleRemoveContextDoc = (idx: number) => {
    setContextDocuments((prev) => prev.filter((_, i) => i !== idx));
    if (previewDocIdx === idx) {
      setPreviewDocIdx(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    subscribeToAiTokens((evt) => {
      if (cancelled) return;
      const slotKey = `${evt.threadId}::${evt.tier}`;
      setSlots((prev) => {
        const cur = prev[slotKey];
        // Se este evento pertence a um novo requestId, limpa de imediato qualquer texto de execuções anteriores
        const isNewReq = !cur || (evt.requestId && cur.requestId !== evt.requestId);
        const baseText = isNewReq ? '' : cur.text;
        return {
          ...prev,
          [slotKey]: {
            requestId: evt.requestId,
            text: baseText + evt.delta,
            streaming: !evt.done,
            ttftMs: evt.ttftMs ?? (isNewReq ? null : cur?.ttftMs ?? null),
            totalMs: evt.totalMs ?? (isNewReq ? null : cur?.totalMs ?? null),
            engineSource: evt.engineSource || (isNewReq ? null : cur?.engineSource ?? null),
            error: null,
          },
        };
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const triggerGeneration = async (
    targetThreadId: string,
    tier: CDLRTier | 'resumo-calmo',
    overrideUserContext?: string
  ) => {
    const slotKey = `${targetThreadId}::${tier}`;
    const reqId = `req_${Date.now()}`;

    // Limpa imediatamente o slot para que a nova versão gerada comece do zero
    setSlots((prev) => ({
      ...prev,
      [slotKey]: {
        requestId: reqId,
        text: '',
        streaming: true,
        ttftMs: null,
        totalMs: null,
        engineSource: null,
        error: null,
      },
    }));

    const contextParts: string[] = [];

    const userText = (
      overrideUserContext !== undefined ? overrideUserContext : (activeUserContext || '')
    ).trim();
    if (userText) {
      contextParts.push(
        `[Ponto de vista e instruções do utilizador para esta resposta]:\n${userText}`
      );
    }

    if (contextDocuments.length > 0) {
      contextParts.push(
        contextDocuments
          .map(
            (d) =>
              `[Ficheiro de apoio: ${d.name}${d.pageCount ? ` (${d.pageCount} págs)` : ''}]:\n${d.text}`
          )
          .join('\n\n---\n\n')
      );
    }

    const extraContext = contextParts.length > 0 ? contextParts.join('\n\n---\n\n') : null;

    try {
      const completed = await streamCdlrSuggestion(reqId, targetThreadId, tier, extraContext);
      setSlots((prev) => {
        const existing = prev[slotKey]?.text || '';
        const finalTxt =
          completed.fullText && completed.fullText.trim()
            ? completed.fullText
            : existing;
        return {
          ...prev,
          [slotKey]: {
            requestId: reqId,
            text: finalTxt,
            streaming: false,
            ttftMs: completed.ttftMs,
            totalMs: completed.totalMs,
            engineSource: completed.engineSource,
            error: null,
          },
        };
      });
      onRefreshModelStatus();
    } catch (err) {
      setSlots((prev) => {
        const existing = prev[slotKey]?.text || '';
        return {
          ...prev,
          [slotKey]: {
            requestId: reqId,
            text: existing,
            streaming: false,
            ttftMs: null,
            totalMs: null,
            engineSource: null,
            error: err instanceof Error ? err.message : String(err),
          },
        };
      });
    }
  };

  if (!thread) {
    return <aside className="corvo-ai-margin" aria-label="Assistente de IA" />;
  }

  // Bloqueio 1: Interruptor global ou política da conta
  if (masterAiKillSwitch || (account && !account.aiEnabled)) {
    return (
      <aside className="corvo-ai-margin" aria-label="Assistente de IA">
        <header className="ai-margin-header">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>
              Assistente de IA
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button
                type="button"
                className="tinta-toolbar-btn"
                onClick={onOpenSettings}
                title="Definições e Privacidade"
              >
                <IconSliders size={14} />
              </button>
              {onClose && (
                <button
                  type="button"
                  className="tinta-toolbar-btn"
                  onClick={onClose}
                  title="Fechar painel (⌘J)"
                >
                  <IconClose size={14} />
                </button>
              )}
            </div>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--mute)' }}>DESATIVADO</span>
        </header>
        <div className="ai-margin-section">
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--mute)', lineHeight: 1.5 }}>
            {masterAiKillSwitch
              ? 'As sugestões de escrita e os resumos estão desligados nas preferências.'
              : `As sugestões de IA estão desligadas para a conta ${thread.accountEmail}.`}
          </p>
          <button
            type="button"
            className="tinta-btn-secondary"
            style={{ alignSelf: 'flex-start', marginTop: '8px' }}
            onClick={onOpenSettings}
          >
            Abrir preferências
          </button>
        </div>
      </aside>
    );
  }

  // Bloqueio 2: Injeção de Prompt detetada
  if (injectionInspection?.blocked) {
    return (
      <aside className="corvo-ai-margin" aria-label="Assistente de IA">
        <header className="ai-margin-header">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>
              Proteção de Segurança
            </span>
            {onClose && (
              <button
                type="button"
                className="tinta-toolbar-btn"
                onClick={onClose}
                title="Fechar painel (⌘J)"
              >
                <IconClose size={14} />
              </button>
            )}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--acc)' }}>BLOQUEADO</span>
        </header>
        <div className="ai-margin-section">
          <p style={{ margin: 0, fontSize: '12.5px', lineHeight: 1.55, color: 'var(--ink)' }}>
            {injectionInspection.userWarning ??
              'Este e-mail contém padrões suspeitos de injeção de prompt. O assistente foi suspenso nesta mensagem por salvaguarda.'}
          </p>
        </div>
      </aside>
    );
  }

  const runtimeReady = modelStatus.configured || modelStatus.allowOllamaFallback;
  const isBootstrapping =
    !runtimeReady &&
    (modelStatus.bootstrapPhase === 'downloading' ||
      modelStatus.bootstrapPhase === 'verifying');
  const friendlyModel = resolveFriendlyModelName(modelStatus, availableModels);
  const tierSlot = slots[`${thread.id}::${currentTier}`];
  const activeTabMeta = TIER_TABS.find((t) => t.id === currentTier)!;

  return (
    <aside className="corvo-ai-margin" aria-label="Assistente de Escrita Lateral">
      {/* Cabeçalho do Painel Lateral */}
      <header className="ai-margin-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink)' }}>
            Assistente de Escrita
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <button
              type="button"
              className="tinta-toolbar-btn"
              onClick={onOpenSettings}
              title="Definições e Privacidade"
              aria-label="Definições e Privacidade"
            >
              <IconSliders size={14} />
            </button>
            {onClose && (
              <button
                type="button"
                className="tinta-toolbar-btn"
                onClick={onClose}
                title="Fechar painel (⌘J)"
                aria-label="Fechar painel"
              >
                <IconClose size={14} />
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--faint)' }}>
          <span style={{ color: runtimeReady ? 'var(--acc)' : 'var(--faint)', fontSize: '14px', lineHeight: 1 }}>•</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {runtimeReady
              ? `No teu Mac · ${friendlyModel}`
              : isBootstrapping
                ? `A preparar ${friendlyModel} · ${modelStatus.bootstrapPercent ?? 0}%`
                : 'A preparar assistente local'}
          </span>
        </div>
      </header>

      {!runtimeReady ? (
        <div className="ai-margin-section">
          {isBootstrapping ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--mute)' }}>
                {modelStatus.bootstrapPhase === 'verifying'
                  ? 'A verificar o Motor Corvo local…'
                  : 'Primeira abertura: a preparar o Motor Corvo neste Mac para funcionar sempre offline.'}
              </p>
              <div
                style={{
                  width: '100%',
                  height: '3px',
                  backgroundColor: 'var(--line)',
                  borderRadius: '2px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.max(4, modelStatus.bootstrapPercent ?? 2)}%`,
                    height: '100%',
                    backgroundColor: 'var(--accfill)',
                    transition: 'width 180ms ease-out',
                  }}
                />
              </div>
              <span className="tinta-meta-faint">
                {modelStatus.bootstrapPercent ?? 0}% concluído
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--mute)' }}>
                {modelStatus.bootstrapError ??
                  'Liga-te à internet uma vez para descarregar o motor de IA local.'}
              </p>
              <button
                type="button"
                className="tinta-btn-primary"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  void installRecommendedModel().then(() => onRefreshModelStatus());
                }}
              >
                Tentar novamente
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Sugestões de Resposta com Abas CDLR */}
          <section className="ai-margin-section" style={{ borderBottom: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="tinta-card-label">Sugestão de Resposta</span>
              {tierSlot?.streaming && (
                <span className="tinta-time" style={{ fontSize: '11px' }}>
                  A gerar…
                </span>
              )}
            </div>

            <div className="cdlr-tier-tabs" role="tablist">
              {TIER_TABS.map((tab) => {
                const isActive = currentTier === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`cdlr-tab-btn ${isActive ? 'cdlr-tab-btn--active' : ''}`}
                    onClick={() => handleSelectTier(tab.id)}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <p style={{ margin: 0, fontSize: '12px', color: 'var(--mute)', lineHeight: 1.4 }}>
              {activeTabMeta.subtitle}
            </p>

            {/* Chips de Resposta Rápida */}
            <div style={{ margin: '12px 0 6px 0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mute)' }}>
                Respostas rápidas
              </span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {QUICK_CHIPS.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    className="tinta-chip"
                    style={{ fontSize: '11.5px', padding: '3px 10px' }}
                    onClick={() => {
                      handleUserContextChange(chip.context);
                      handleSelectTier(chip.tier);
                      void triggerGeneration(thread.id, chip.tier, chip.context);
                    }}
                    title={`Gerar: ${chip.label}`}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Campo de Instruções / Ponto de Vista com Botão de Enviar Redondo */}
            <div style={{ margin: '8px 0 6px 0', display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--ink)' }}>
                  Instruir a IA / Ponto de vista
                </span>
                {activeUserContext && (
                  <button
                    type="button"
                    style={{
                      fontSize: '11px',
                      color: 'var(--mute)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                    onClick={() => handleUserContextChange('')}
                    title="Limpar instruções"
                  >
                    Limpar
                  </button>
                )}
              </div>

              <div
                style={{
                  position: 'relative',
                  backgroundColor: 'var(--fill)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-xl)',
                  padding: '7px 34px 7px 9px',
                  transition: 'border-color var(--duration-fast), background-color var(--duration-fast)',
                }}
              >
                <textarea
                  value={activeUserContext}
                  onChange={(e) => handleUserContextChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (!tierSlot?.streaming) {
                        void triggerGeneration(thread.id, currentTier);
                      }
                    }
                  }}
                  placeholder="Instruir a IA ou definir ponto de vista (Enter para gerar)…"
                  rows={2}
                  style={{
                    width: '100%',
                    minHeight: '44px',
                    maxHeight: '120px',
                    resize: 'vertical',
                    fontSize: '12px',
                    lineHeight: 1.45,
                    border: 'none',
                    backgroundColor: 'transparent',
                    color: 'var(--ink)',
                    outline: 'none',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                    padding: 0,
                  }}
                />

                <button
                  type="button"
                  className={`tinta-send-circle-btn ${activeUserContext.trim() ? 'tinta-send-circle-btn--active' : ''}`}
                  disabled={tierSlot?.streaming}
                  onClick={() => {
                    if (!tierSlot?.streaming) {
                      void triggerGeneration(thread.id, currentTier);
                    }
                  }}
                  title="Gerar resposta com estas instruções (Enter)"
                  aria-label="Gerar resposta"
                  style={{
                    position: 'absolute',
                    right: '6px',
                    bottom: '6px',
                  }}
                >
                  <IconArrowUp size={14} />
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--faint)' }}>
                <span>
                  {activeUserContext.trim()
                    ? 'A IA vai adaptar a resposta às tuas instruções.'
                    : 'Opcional. Sem instruções, a IA responde de acordo com o e-mail.'}
                </span>
                <span>Enter para gerar</span>
              </div>
            </div>

            {/* Inserir PDFs ou Documentos de Contexto para a IA */}
            <div style={{ margin: '8px 0 6px 0' }}>
              <input
                ref={contextFileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.txt,.csv,.md,.json,.html"
                style={{ display: 'none' }}
                onChange={handleContextFileChange}
              />

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--faint)' }}>
                  PDF / Documento de contexto
                </span>
                <button
                  type="button"
                  className="tinta-btn-secondary"
                  style={{ fontSize: '11px', padding: '3px 8px' }}
                  onClick={() => contextFileInputRef.current?.click()}
                  disabled={isParsingDoc}
                >
                  <IconPaperclip size={12} />
                  <span>{isParsingDoc ? 'A ler ficheiro…' : '+ Inserir PDF'}</span>
                </button>
              </div>

              {contextDocuments.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
                  {contextDocuments.map((doc, idx) => (
                    <div key={`${doc.name}-${idx}`} className="tinta-context-doc-card">
                      <div className="tinta-context-doc-row">
                        <div className="tinta-context-doc-info">
                          <span style={{ color: 'var(--acc)', display: 'inline-flex' }}>
                            <IconFile size={13} />
                          </span>
                          <span className="tinta-context-doc-name" title={doc.name}>
                            {doc.name}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span className="tinta-context-doc-meta">
                            {doc.pageCount ? `${doc.pageCount} págs · ` : ''}
                            {formatFileSize(doc.size)}
                          </span>
                          <button
                            type="button"
                            className="tinta-attachment-pill-remove"
                            onClick={() => handleRemoveContextDoc(idx)}
                            title="Remover documento de contexto"
                          >
                            <IconClose size={12} />
                          </button>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '2px' }}>
                        <button
                          type="button"
                          style={{ fontSize: '10.5px', color: 'var(--acc)', cursor: 'pointer' }}
                          onClick={() => setPreviewDocIdx(previewDocIdx === idx ? null : idx)}
                        >
                          {previewDocIdx === idx ? 'Ocultar excerto' : 'Ver excerto lido'}
                        </button>
                        {onAttachFileToDraft && doc.originalFile && (
                          <button
                            type="button"
                            style={{ fontSize: '10.5px', color: 'var(--mute)', cursor: 'pointer' }}
                            onClick={() => {
                              onAttachFileToDraft({
                                id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                name: doc.name,
                                size: doc.size,
                                type: doc.type,
                                file: doc.originalFile,
                              });
                            }}
                          >
                            + Anexar ao e-mail
                          </button>
                        )}
                      </div>

                      {previewDocIdx === idx && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--ink)',
                            backgroundColor: 'var(--bg)',
                            border: '1px solid var(--line)',
                            borderRadius: '6px',
                            padding: '6px 8px',
                            maxHeight: '110px',
                            overflowY: 'auto',
                            whiteSpace: 'pre-wrap',
                            lineHeight: 1.4,
                          }}
                        >
                          {doc.text.slice(0, 800)}
                          {doc.text.length > 800 ? '…' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: '8px' }}>
              <button
                type="button"
                className="tinta-btn-primary"
                disabled={tierSlot?.streaming}
                onClick={() => triggerGeneration(thread.id, currentTier)}
              >
                {tierSlot?.streaming
                  ? 'A escrever no teu Mac…'
                  : activeUserContext.trim()
                    ? `Sugerir ${activeTabMeta.label.toLowerCase()} com o teu ponto de vista`
                    : tierSlot?.text
                      ? 'Gerar outra versão'
                      : `Sugerir ${activeTabMeta.label.toLowerCase()}`}
              </button>

              {tierSlot?.error && (
                <p style={{ margin: '8px 0 0 0', fontSize: '12px', color: 'var(--mute)' }}>
                  {tierSlot.error}
                </p>
              )}

              {(tierSlot?.text || tierSlot?.streaming) && (
                <>
                  <p className="cdlr-preview-text" style={{ marginTop: '10px' }}>
                    {tierSlot.text || '…'}
                  </p>

                  {!tierSlot.streaming && tierSlot.text && (
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
                      <button
                        type="button"
                        className="tinta-btn-primary"
                        onClick={() =>
                          onApplyGeneratedText(tierSlot.text, currentTier, 'replace')
                        }
                      >
                        {hasExistingDraft ? 'Substituir no rascunho' : 'Inserir no rascunho'}
                      </button>

                      {hasExistingDraft && (
                        <button
                          type="button"
                          className="tinta-btn-secondary"
                          onClick={() =>
                            onApplyGeneratedText(tierSlot.text, currentTier, 'append')
                          }
                        >
                          + Acrescentar
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        </>
      )}
    </aside>
  );
};

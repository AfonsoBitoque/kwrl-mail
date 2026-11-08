import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getKnownContacts, rewriteTextWithAi } from '../services/tauriBridge';
import { AccountView, EmailAttachment, KnownContact } from '../types/kwrl';
import { IconClose, IconPaperclip, IconSent, IconSparkles } from './Icons';

export interface ComposeModalProps {
  open: boolean;
  accounts: AccountView[];
  defaultAccountEmail?: string;
  initialTo?: string[];
  initialCc?: string[];
  initialBcc?: string[];
  initialSubject?: string;
  initialBody?: string;
  initialAttachments?: EmailAttachment[];
  threadId?: string | null;
  inReplyTo?: string | null;
  onClose: () => void;
  onSend: (payload: {
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
  }) => Promise<void>;
}

export const ComposeModal: React.FC<ComposeModalProps> = ({
  open,
  accounts,
  defaultAccountEmail,
  initialTo,
  initialCc,
  initialBcc,
  initialSubject,
  initialBody,
  initialAttachments,
  threadId = null,
  inReplyTo = null,
  onClose,
  onSend,
}) => {
  const [selectedAccountEmail, setSelectedAccountEmail] = useState<string>('');
  const [toChips, setToChips] = useState<string[]>([]);
  const [toInput, setToInput] = useState('');
  const [ccChips, setCcChips] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState('');
  const [bccChips, setBccChips] = useState<string[]>([]);
  const [bccInput, setBccInput] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [contacts, setContacts] = useState<KnownContact[]>([]);
  const [activeAutocompleteField, setActiveAutocompleteField] = useState<'to' | 'cc' | 'bcc' | null>(null);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState<number>(-1);

  // Estados do Assistente de IA para organização, correção e tradução
  const [isAiProcessing, setIsAiProcessing] = useState(false);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [customPromptOpen, setCustomPromptOpen] = useState(false);
  const [customPromptText, setCustomPromptText] = useState('');
  const [previousBodyForUndo, setPreviousBodyForUndo] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toInputRef = useRef<HTMLInputElement | null>(null);
  const bodyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const aiMenuRef = useRef<HTMLDivElement | null>(null);
  const overlayMouseDownRef = useRef(false);

  const handleOverlayMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    overlayMouseDownRef.current = e.target === e.currentTarget;
  };

  const handleOverlayMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (overlayMouseDownRef.current && e.target === e.currentTarget && !isSending) {
      onClose();
    }
    overlayMouseDownRef.current = false;
  };

  // Carrega contactos conhecidos da base de dados local
  useEffect(() => {
    if (open) {
      void getKnownContacts().then((c) => setContacts(c || [])).catch(() => {});
    }
  }, [open]);

  // Fecha o menu de IA ao clicar fora
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

  // Inicializa campos APENAS UMA VEZ na transição de fecho para abertura (evita reset ao digitar)
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      const initialAcc = defaultAccountEmail || accounts[0]?.email || '';
      setSelectedAccountEmail(initialAcc);
      setToChips(initialTo || []);
      setToInput('');
      setCcChips(initialCc || []);
      setCcInput('');
      setBccChips(initialBcc || []);
      setBccInput('');
      setShowCc((initialCc || []).length > 0);
      setShowBcc((initialBcc || []).length > 0);
      setSubject(initialSubject || '');
      setBody(initialBody || '');
      setAttachments(initialAttachments || []);
      setIsSending(false);
      setIsAiProcessing(false);
      setAiMenuOpen(false);
      setCustomPromptOpen(false);
      setCustomPromptText('');
      setPreviousBodyForUndo(null);
      setAiNotice(null);

      setTimeout(() => {
        if (!initialTo || initialTo.length === 0) {
          toInputRef.current?.focus();
        } else {
          bodyTextareaRef.current?.focus();
        }
      }, 60);
    }
    prevOpenRef.current = open;
  }, [open, defaultAccountEmail, accounts, initialTo, initialCc, initialBcc, initialSubject, initialBody, initialAttachments]);

  // Filtragem de contactos para autocomplete memoizada por campo ativo
  const activeSuggestions = useMemo(() => {
    if (!open || !activeAutocompleteField) return [];
    const query =
      activeAutocompleteField === 'to'
        ? toInput
        : activeAutocompleteField === 'cc'
        ? ccInput
        : bccInput;
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return contacts
      .filter((c) => c.email.toLowerCase().includes(q) || c.displayName.toLowerCase().includes(q))
      .slice(0, 5);
  }, [open, activeAutocompleteField, toInput, ccInput, bccInput, contacts]);

  if (!open) return null;

  const handleAddChip = (field: 'to' | 'cc' | 'bcc', rawValue: string) => {
    const trimmed = rawValue.trim().replace(/[,;]+$/, '');
    if (!trimmed) return;

    if (field === 'to' && !toChips.includes(trimmed)) {
      setToChips((prev) => [...prev, trimmed]);
      setToInput('');
    } else if (field === 'cc' && !ccChips.includes(trimmed)) {
      setCcChips((prev) => [...prev, trimmed]);
      setCcInput('');
    } else if (field === 'bcc' && !bccChips.includes(trimmed)) {
      setBccChips((prev) => [...prev, trimmed]);
      setBccInput('');
    }
    setActiveAutocompleteField(null);
  };

  const handleKeyDownChip = (
    e: React.KeyboardEvent<HTMLInputElement>,
    field: 'to' | 'cc' | 'bcc',
    currentVal: string,
    chips: string[],
    setChips: React.Dispatch<React.SetStateAction<string[]>>
  ) => {
    if (activeSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) => (prev + 1) % activeSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) => (prev <= 0 ? activeSuggestions.length - 1 : prev - 1));
        return;
      }
      if (
        (e.key === 'Enter' || e.key === 'Tab') &&
        selectedSuggestionIndex >= 0 &&
        selectedSuggestionIndex < activeSuggestions.length
      ) {
        e.preventDefault();
        handleAddChip(field, activeSuggestions[selectedSuggestionIndex].email);
        setSelectedSuggestionIndex(-1);
        return;
      }
    }

    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (currentVal.trim()) {
        e.preventDefault();
        handleAddChip(field, currentVal);
        setSelectedSuggestionIndex(-1);
      }
    } else if (e.key === 'Backspace' && !currentVal && chips.length > 0) {
      setChips((prev) => prev.slice(0, prev.length - 1));
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const newAtts: EmailAttachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      newAtts.push({
        id: `att_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        file,
      });
    }
    setAttachments((prev) => [...prev, ...newAtts]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  };

  // Suporte a colar imagens/prints diretamente da área de transferência (Cmd+V)
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const ext = file.type.split('/')[1] || 'png';
          const namedFile = new File([file], `Captura_${timestamp}.${ext}`, { type: file.type });
          pastedFiles.push(namedFile);
        }
      }
    }
    if (pastedFiles.length > 0) {
      const newAtts: EmailAttachment[] = pastedFiles.map((f) => ({
        id: `att_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        name: f.name,
        size: f.size,
        type: f.type,
        file: f,
      }));
      setAttachments((prev) => [...prev, ...newAtts]);
    }
  };

  // Executa uma transformação inteligente com o Motor Kwrl local
  const handleAiAction = async (
    action: 'organize_and_correct' | 'formal' | 'short' | 'translate' | 'custom',
    targetLang?: string,
    customInstruction?: string
  ) => {
    if (!body.trim() || isAiProcessing) return;
    setAiMenuOpen(false);
    setCustomPromptOpen(false);
    setPreviousBodyForUndo(body);
    setIsAiProcessing(true);
    setAiNotice(
      action === 'organize_and_correct'
        ? 'A organizar texto e corrigir erros...'
        : action === 'formal'
        ? 'A reescrever em tom formal e profissional...'
        : action === 'short'
        ? 'A tornar o texto mais conciso...'
        : action === 'translate'
        ? `A traduzir para ${targetLang || 'inglês'}...`
        : 'A aplicar instruções da IA...'
    );

    const firstRecipient = toChips.length > 0 ? toChips[0] : toInput.trim() || undefined;
    try {
      const res = await rewriteTextWithAi({
        text: body,
        action,
        recipient: firstRecipient,
        targetLang,
        customInstruction,
      });
      if (res.fullText && res.fullText.trim()) {
        setBody(res.fullText.trim());
        setAiNotice('Texto revisto com sucesso!');
        setTimeout(() => setAiNotice(null), 3500);
      }
    } catch (err: unknown) {
      console.error('Falha ao processar texto com IA:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setAiNotice(`Erro da IA: ${msg}`);
      setTimeout(() => setAiNotice(null), 4000);
    } finally {
      setIsAiProcessing(false);
    }
  };

  const handleUndoAi = () => {
    if (previousBodyForUndo !== null) {
      setBody(previousBodyForUndo);
      setPreviousBodyForUndo(null);
      setAiNotice(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalTo = [...toChips];
    if (toInput.trim() && !finalTo.includes(toInput.trim())) {
      finalTo.push(toInput.trim());
    }
    const finalCc = [...ccChips];
    if (ccInput.trim() && !finalCc.includes(ccInput.trim())) {
      finalCc.push(ccInput.trim());
    }
    const finalBcc = [...bccChips];
    if (bccInput.trim() && !finalBcc.includes(bccInput.trim())) {
      finalBcc.push(bccInput.trim());
    }

    if (finalTo.length === 0) {
      toInputRef.current?.focus();
      return;
    }

    setIsSending(true);
    try {
      await onSend({
        accountEmail: selectedAccountEmail || accounts[0]?.email || '',
        to: finalTo,
        cc: finalCc,
        bcc: finalBcc,
        subject: subject.trim() || '(Sem assunto)',
        body,
        threadId,
        inReplyTo,
        attachments,
      });
      onClose();
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div
      className="tinta-compose-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onMouseDown={handleOverlayMouseDown}
      onMouseUp={handleOverlayMouseUp}
    >
      <div
        className="tinta-compose-window"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        style={{
          width: '100%',
          maxWidth: '740px',
          height: 'min(720px, 92vh)',
          backgroundColor: 'var(--bg)',
          borderRadius: '12px',
          border: '1px solid var(--line)',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.35)',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        {/* Cabeçalho */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px',
            borderBottom: '1px solid var(--line)',
            backgroundColor: 'var(--side)',
            borderTopLeftRadius: '12px',
            borderTopRightRadius: '12px',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--ink)' }}>
            {threadId ? 'Responder a conversa' : 'Novo E-mail'}
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={isSending}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--mute)',
              padding: '4px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
            }}
            title="Fechar (Esc)"
          >
            <IconClose size={16} />
          </button>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, position: 'relative' }}>
          {/* Seletor de Conta Remetente (De:) */}
          {accounts.length > 1 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 18px',
                borderBottom: '1px solid var(--line)',
                fontSize: '12px',
                gap: '8px',
                backgroundColor: 'var(--bg)',
              }}
            >
              <span style={{ color: 'var(--mute)', width: '45px' }}>De:</span>
              <select
                value={selectedAccountEmail}
                onChange={(e) => setSelectedAccountEmail(e.target.value)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--ink)',
                  fontSize: '12px',
                  fontWeight: 500,
                  outline: 'none',
                  cursor: 'pointer',
                  flex: 1,
                }}
              >
                {accounts.map((acc) => (
                  <option key={acc.email} value={acc.email} style={{ backgroundColor: 'var(--bg)', color: 'var(--ink)' }}>
                    {acc.label ? `${acc.label} (${acc.email})` : acc.email}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Campo "Para:" */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: '8px 18px',
              borderBottom: '1px solid var(--line)',
              fontSize: '12px',
              gap: '6px',
              position: 'relative',
              backgroundColor: 'var(--bg)',
              zIndex: activeAutocompleteField === 'to' ? 60 : 10,
            }}
          >
            <span style={{ color: 'var(--mute)', width: '45px' }}>Para:</span>
            {toChips.map((chip) => (
              <span
                key={chip}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 8px',
                  backgroundColor: 'var(--fill)',
                  border: '1px solid var(--line)',
                  borderRadius: '12px',
                  fontSize: '11px',
                  color: 'var(--ink)',
                }}
              >
                {chip}
                <button
                  type="button"
                  onClick={() => setToChips((prev) => prev.filter((c) => c !== chip))}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    color: 'var(--mute)',
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              ref={toInputRef}
              type="text"
              value={toInput}
              onChange={(e) => {
                setToInput(e.target.value);
                setActiveAutocompleteField('to');
              }}
              onFocus={() => setActiveAutocompleteField('to')}
              onBlur={() => setTimeout(() => setActiveAutocompleteField(null), 200)}
              onKeyDown={(e) => handleKeyDownChip(e, 'to', toInput, toChips, setToChips)}
              placeholder={toChips.length === 0 ? 'destinatario@exemplo.pt (escreve e prime Enter ou vírgula)' : ''}
              style={{
                flex: 1,
                minWidth: '160px',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: 'var(--ink)',
                fontSize: '12.5px',
              }}
            />

            {/* Ações Cc e Bcc */}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--mute)',
                    fontSize: '11px',
                    fontWeight: 500,
                  }}
                >
                  Cc
                </button>
              )}
              {!showBcc && (
                <button
                  type="button"
                  onClick={() => setShowBcc(true)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--mute)',
                    fontSize: '11px',
                    fontWeight: 500,
                  }}
                >
                  Bcc
                </button>
              )}
            </div>

            {/* Autocomplete dropdown para Para */}
            {activeAutocompleteField === 'to' && toInput.trim() && (
              <div
                role="listbox"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: '60px',
                  right: '18px',
                  backgroundColor: 'var(--bg)',
                  border: '1px solid var(--line)',
                  borderRadius: '6px',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                  zIndex: 100,
                  maxHeight: '180px',
                  overflowY: 'auto',
                }}
              >
                {activeSuggestions.map((s, idx) => (
                  <div
                    key={s.email}
                    role="option"
                    aria-selected={idx === selectedSuggestionIndex}
                    tabIndex={0}
                    onClick={() => handleAddChip('to', s.email)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleAddChip('to', s.email);
                      }
                    }}
                    style={{
                      padding: '6px 12px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      borderBottom: '1px solid var(--line)',
                      backgroundColor: idx === selectedSuggestionIndex ? 'var(--hov)' : 'transparent',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = idx === selectedSuggestionIndex ? 'var(--hov)' : 'transparent')}
                  >
                    <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{s.displayName}</span>
                    <span style={{ color: 'var(--mute)' }}>{s.email}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Campo "Cc:" */}
          {showCc && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                padding: '8px 18px',
                borderBottom: '1px solid var(--line)',
                fontSize: '12px',
                gap: '6px',
                position: 'relative',
                backgroundColor: 'var(--bg)',
                zIndex: activeAutocompleteField === 'cc' ? 60 : 9,
              }}
            >
              <span style={{ color: 'var(--mute)', width: '45px' }}>Cc:</span>
              {ccChips.map((chip) => (
                <span
                  key={chip}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    backgroundColor: 'var(--fill)',
                    border: '1px solid var(--line)',
                    borderRadius: '12px',
                    fontSize: '11px',
                    color: 'var(--ink)',
                  }}
                >
                  {chip}
                  <button
                    type="button"
                    onClick={() => setCcChips((prev) => prev.filter((c) => c !== chip))}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      color: 'var(--mute)',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={ccInput}
                onChange={(e) => {
                  setCcInput(e.target.value);
                  setActiveAutocompleteField('cc');
                }}
                onFocus={() => setActiveAutocompleteField('cc')}
                onBlur={() => setTimeout(() => setActiveAutocompleteField(null), 200)}
                onKeyDown={(e) => handleKeyDownChip(e, 'cc', ccInput, ccChips, setCcChips)}
                placeholder={ccChips.length === 0 ? 'copia@exemplo.pt' : ''}
                style={{
                  flex: 1,
                  minWidth: '140px',
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  color: 'var(--ink)',
                  fontSize: '12.5px',
                }}
              />

              {activeAutocompleteField === 'cc' && ccInput.trim() && (
                <div
                  role="listbox"
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: '60px',
                    right: '18px',
                    backgroundColor: 'var(--bg)',
                    border: '1px solid var(--line)',
                    borderRadius: '6px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                    zIndex: 100,
                    maxHeight: '180px',
                    overflowY: 'auto',
                  }}
                >
                  {activeSuggestions.map((s, idx) => (
                    <div
                      key={s.email}
                      role="option"
                      aria-selected={idx === selectedSuggestionIndex}
                      tabIndex={0}
                      onClick={() => handleAddChip('cc', s.email)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleAddChip('cc', s.email);
                        }
                      }}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        borderBottom: '1px solid var(--line)',
                        backgroundColor: idx === selectedSuggestionIndex ? 'var(--hov)' : 'transparent',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = idx === selectedSuggestionIndex ? 'var(--hov)' : 'transparent')}
                    >
                      <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{s.displayName}</span>
                      <span style={{ color: 'var(--mute)' }}>{s.email}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Campo "Bcc:" */}
          {showBcc && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                padding: '8px 18px',
                borderBottom: '1px solid var(--line)',
                fontSize: '12px',
                gap: '6px',
                position: 'relative',
                backgroundColor: 'var(--bg)',
                zIndex: activeAutocompleteField === 'bcc' ? 60 : 8,
              }}
            >
              <span style={{ color: 'var(--mute)', width: '45px' }}>Bcc:</span>
              {bccChips.map((chip) => (
                <span
                  key={chip}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    backgroundColor: 'var(--fill)',
                    border: '1px solid var(--line)',
                    borderRadius: '12px',
                    fontSize: '11px',
                    color: 'var(--ink)',
                  }}
                >
                  {chip}
                  <button
                    type="button"
                    onClick={() => setBccChips((prev) => prev.filter((c) => c !== chip))}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      color: 'var(--mute)',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={bccInput}
                onChange={(e) => {
                  setBccInput(e.target.value);
                  setActiveAutocompleteField('bcc');
                }}
                onFocus={() => setActiveAutocompleteField('bcc')}
                onBlur={() => setTimeout(() => setActiveAutocompleteField(null), 200)}
                onKeyDown={(e) => handleKeyDownChip(e, 'bcc', bccInput, bccChips, setBccChips)}
                placeholder={bccChips.length === 0 ? 'copia.oculta@exemplo.pt' : ''}
                style={{
                  flex: 1,
                  minWidth: '140px',
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  color: 'var(--ink)',
                  fontSize: '12.5px',
                }}
              />

              {activeAutocompleteField === 'bcc' && bccInput.trim() && (
                <div
                  role="listbox"
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: '60px',
                    right: '18px',
                    backgroundColor: 'var(--bg)',
                    border: '1px solid var(--line)',
                    borderRadius: '6px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                    zIndex: 100,
                    maxHeight: '180px',
                    overflowY: 'auto',
                  }}
                >
                  {activeSuggestions.map((s, idx) => (
                    <div
                      key={s.email}
                      role="option"
                      aria-selected={idx === selectedSuggestionIndex}
                      tabIndex={0}
                      onClick={() => handleAddChip('bcc', s.email)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleAddChip('bcc', s.email);
                        }
                      }}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        borderBottom: '1px solid var(--line)',
                        backgroundColor: idx === selectedSuggestionIndex ? 'var(--hov)' : 'transparent',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = idx === selectedSuggestionIndex ? 'var(--hov)' : 'transparent')}
                    >
                      <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{s.displayName}</span>
                      <span style={{ color: 'var(--mute)' }}>{s.email}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Campo "Assunto:" */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '8px 18px',
              borderBottom: '1px solid var(--line)',
              fontSize: '12px',
              backgroundColor: 'var(--bg)',
            }}
          >
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Assunto"
              style={{
                width: '100%',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: 'var(--ink)',
                fontSize: '13px',
                fontWeight: 500,
              }}
            />
          </div>

          {/* Barra de Ferramentas do Assistente de IA acima do Corpo */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 18px',
              backgroundColor: 'var(--fill)',
              borderBottom: '1px solid var(--line)',
              position: 'relative',
              zIndex: aiMenuOpen ? 50 : 5,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' }} ref={aiMenuRef}>
              <button
                type="button"
                onClick={() => setAiMenuOpen((prev) => !prev)}
                disabled={isAiProcessing || !body.trim()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  backgroundColor: aiMenuOpen ? 'var(--hov)' : 'var(--bg)',
                  color: !body.trim() ? 'var(--faint)' : 'var(--acc, #7567a3)',
                  fontSize: '11.5px',
                  fontWeight: 600,
                  cursor: !body.trim() || isAiProcessing ? 'not-allowed' : 'pointer',
                  opacity: !body.trim() ? 0.6 : 1,
                  transition: 'background-color 0.15s ease',
                }}
                title={!body.trim() ? 'Escreve algo no corpo para usar a IA' : 'Melhora, organiza ou traduz o teu texto com o Motor IA'}
              >
                <IconSparkles size={13} />
                <span>Assistente de IA</span>
              </button>

              {/* Botão de Anular alteração da IA */}
              {previousBodyForUndo !== null && (
                <button
                  type="button"
                  onClick={handleUndoAi}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '11px',
                    color: 'var(--mute)',
                    textDecoration: 'underline',
                    padding: '2px 4px',
                  }}
                  title="Reverter texto para o original antes da IA"
                >
                  Anular alteração
                </button>
              )}

              {/* Menu Dropdown de Ações de IA */}
              {aiMenuOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: '4px',
                    backgroundColor: 'var(--bg)',
                    border: '1px solid var(--line)',
                    borderRadius: '8px',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
                    zIndex: 100,
                    width: '280px',
                    padding: '6px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                    maxHeight: 'min(380px, calc(90vh - 220px))',
                    overflowY: 'auto',
                    overscrollBehavior: 'contain',
                    boxSizing: 'border-box',
                  }}
                >
                  <div style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--faint)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Revisão & Estrutura
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAiAction('organize_and_correct')}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '2px',
                      padding: '7px 8px',
                      borderRadius: '5px',
                      border: 'none',
                      backgroundColor: 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)' }}>✨ Organizar e tirar erros</span>
                    <span style={{ fontSize: '10.5px', color: 'var(--mute)' }}>Corrige ortografia, pontuação e cria parágrafos limpos em pt-PT</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleAiAction('formal')}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '2px',
                      padding: '7px 8px',
                      borderRadius: '5px',
                      border: 'none',
                      backgroundColor: 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)' }}>👔 Tornar mais formal</span>
                    <span style={{ fontSize: '10.5px', color: 'var(--mute)' }}>Tom executivo, polido e profissional</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleAiAction('short')}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '2px',
                      padding: '7px 8px',
                      borderRadius: '5px',
                      border: 'none',
                      backgroundColor: 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)' }}>⚡ Tornar mais curto e direto</span>
                    <span style={{ fontSize: '10.5px', color: 'var(--mute)' }}>Remove redundâncias e foca o essencial</span>
                  </button>

                  <div style={{ height: '1px', backgroundColor: 'var(--line)', margin: '4px 0' }} />

                  <div style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--faint)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Tradução
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', padding: '0 4px' }}>
                    <button
                      type="button"
                      onClick={() => handleAiAction('translate', 'inglês')}
                      style={{
                        padding: '6px 8px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                        backgroundColor: 'var(--bg)',
                        color: 'var(--ink)',
                        fontSize: '11px',
                        cursor: 'pointer',
                        textAlign: 'center',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg)')}
                    >
                      🇬🇧 Inglês
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAiAction('translate', 'espanhol')}
                      style={{
                        padding: '6px 8px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                        backgroundColor: 'var(--bg)',
                        color: 'var(--ink)',
                        fontSize: '11px',
                        cursor: 'pointer',
                        textAlign: 'center',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg)')}
                    >
                      🇪🇸 Espanhol
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAiAction('translate', 'francês')}
                      style={{
                        padding: '6px 8px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                        backgroundColor: 'var(--bg)',
                        color: 'var(--ink)',
                        fontSize: '11px',
                        cursor: 'pointer',
                        textAlign: 'center',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg)')}
                    >
                      🇫🇷 Francês
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAiAction('translate', 'alemão')}
                      style={{
                        padding: '6px 8px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                        backgroundColor: 'var(--bg)',
                        color: 'var(--ink)',
                        fontSize: '11px',
                        cursor: 'pointer',
                        textAlign: 'center',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg)')}
                    >
                      🇩🇪 Alemão
                    </button>
                  </div>

                  <div style={{ height: '1px', backgroundColor: 'var(--line)', margin: '4px 0' }} />

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
                      padding: '7px 8px',
                      borderRadius: '5px',
                      border: 'none',
                      backgroundColor: 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '11.5px',
                      color: 'var(--ink)',
                      fontWeight: 500,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--hov)')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <span>✏️</span>
                    <span>Pedir outra alteração personalizada...</span>
                  </button>
                </div>
              )}
            </div>

            {/* Aviso de Estado da IA */}
            {aiNotice && (
              <span
                style={{
                  fontSize: '11px',
                  color: isAiProcessing ? 'var(--acc, #7567a3)' : 'var(--mute)',
                  fontStyle: 'italic',
                }}
              >
                {aiNotice}
              </span>
            )}
          </div>

          {/* Campo de Instrução Personalizada de IA */}
          {customPromptOpen && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 18px',
                backgroundColor: 'var(--side)',
                borderBottom: '1px solid var(--line)',
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
                    }
                  } else if (e.key === 'Escape') {
                    setCustomPromptOpen(false);
                  }
                }}
                placeholder="Ex: 'Muda o tom para mais amigável e diz que só posso reunir quinta-feira à tarde' (Enter para aplicar)"
                style={{
                  flex: 1,
                  padding: '5px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  backgroundColor: 'var(--bg)',
                  color: 'var(--ink)',
                  fontSize: '12px',
                  outline: 'none',
                }}
                autoFocus
              />
              <button
                type="button"
                onClick={() => {
                  if (customPromptText.trim()) {
                    void handleAiAction('custom', undefined, customPromptText.trim());
                  }
                }}
                disabled={!customPromptText.trim()}
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: 'var(--acc, #7567a3)',
                  color: '#fff',
                  fontSize: '11.5px',
                  fontWeight: 600,
                  cursor: !customPromptText.trim() ? 'not-allowed' : 'pointer',
                  opacity: !customPromptText.trim() ? 0.6 : 1,
                }}
              >
                Aplicar
              </button>
              <button
                type="button"
                onClick={() => setCustomPromptOpen(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--mute)',
                  fontSize: '11.5px',
                }}
              >
                Cancelar
              </button>
            </div>
          )}

          {/* Corpo do E-mail */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minHeight: '260px', backgroundColor: 'var(--bg)' }}>
            <textarea
              ref={bodyTextareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onPaste={handlePaste}
              placeholder="Escreve a tua mensagem aqui... Podes escrever tópicos soltos ou ideias e usar o Assistente de IA acima para organizar o texto e tirar erros."
              disabled={isAiProcessing}
              style={{
                flex: 1,
                width: '100%',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                resize: 'none',
                padding: '16px 18px',
                color: 'var(--ink)',
                fontFamily: 'inherit',
                fontSize: '13.5px',
                lineHeight: '1.6',
                opacity: isAiProcessing ? 0.6 : 1,
              }}
            />

            {/* Aviso de Arrastar e Largar */}
            {isDragging && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundColor: 'rgba(117, 103, 163, 0.15)',
                  border: '2px dashed var(--acc, #7567a3)',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--ink)',
                  fontSize: '14px',
                  fontWeight: 500,
                  zIndex: 30,
                }}
              >
                Larga os ficheiros aqui para anexar
              </div>
            )}
          </div>

          {/* Lista de Anexos Adicionados */}
          {attachments.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                padding: '8px 18px',
                borderTop: '1px solid var(--line)',
                backgroundColor: 'var(--side)',
              }}
            >
              {attachments.map((att) => (
                <div
                  key={att.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '3px 8px',
                    backgroundColor: 'var(--bg)',
                    border: '1px solid var(--line)',
                    borderRadius: '6px',
                    fontSize: '11px',
                    color: 'var(--ink)',
                  }}
                >
                  <IconPaperclip size={12} />
                  <span style={{ maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {att.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '0 2px',
                      color: 'var(--mute)',
                      fontWeight: 'bold',
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Rodapé: Ações e Enviar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 18px',
              borderTop: '1px solid var(--line)',
              backgroundColor: 'var(--side)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => handleFiles(e.target.files)}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--bg)',
                  color: 'var(--ink)',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
                title="Anexar ficheiros"
              >
                <IconPaperclip size={14} />
                <span>Anexar</span>
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={isSending || isAiProcessing}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'transparent',
                  color: 'var(--mute)',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                Descartar
              </button>
              <button
                type="submit"
                disabled={isSending || isAiProcessing}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 18px',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: 'var(--acc, #7567a3)',
                  color: '#ffffff',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: isSending || isAiProcessing ? 'not-allowed' : 'pointer',
                  opacity: isSending || isAiProcessing ? 0.7 : 1,
                }}
              >
                <IconSent size={13} />
                <span>{isSending ? 'A enviar...' : 'Enviar'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

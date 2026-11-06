import React, { useEffect, useState } from 'react';
import { resolveFriendlyModelName } from '../services/tauriBridge';
import { AccountView, DiscoveredModel, LocalModelStatus } from '../types/corvo';
import { IconCheck, IconClose, IconPlus } from './Icons';

interface PrivacySettingsDrawerProps {
  open: boolean;
  accounts: AccountView[];
  pollIntervalSecs: number;
  masterAiKillSwitch: boolean;
  userSignatureName?: string;
  modelStatus: LocalModelStatus;
  availableModels: DiscoveredModel[];
  onClose: () => void;
  onSaveRuntimeSettings: (params: {
    pollIntervalSecs: number;
    masterAiKillSwitch: boolean;
    contextSize: number;
    allowOllamaFallback: boolean;
    ollamaModelTag: string;
  }) => Promise<void>;
  onUpdateSignatureName?: (name: string) => Promise<void>;
  onInstallRecommendedModel: () => Promise<void>;
  onUpdateAccountPolicy: (params: {
    email: string;
    aiEnabled: boolean;
    suggestionTrigger: 'on-open' | 'on-demand';
    autoSummarize: boolean;
  }) => Promise<void>;
  onDisconnectAccount: (email: string) => Promise<void>;
  onAddAccount?: () => void;
  onAddCustomAccount?: (email: string, label: string, provider: string) => Promise<void>;
}

export const PrivacySettingsDrawer: React.FC<PrivacySettingsDrawerProps> = ({
  open,
  accounts,
  pollIntervalSecs,
  masterAiKillSwitch,
  userSignatureName = 'Afonso',
  modelStatus,
  availableModels,
  onClose,
  onSaveRuntimeSettings,
  onUpdateSignatureName,
  onInstallRecommendedModel,
  onUpdateAccountPolicy,
  onDisconnectAccount,
  onAddAccount,
  onAddCustomAccount,
}) => {
  const [addingProvider, setAddingProvider] = useState<'outlook' | 'imap' | null>(null);
  const [newAccountEmail, setNewAccountEmail] = useState('');
  const [newAccountLabel, setNewAccountLabel] = useState('');
  const [isSubmittingAccount, setIsSubmittingAccount] = useState(false);
  const [pollSecs, setPollSecs] = useState(pollIntervalSecs);
  const [aiActive, setAiActive] = useState(!masterAiKillSwitch);
  const [sigName, setSigName] = useState(userSignatureName);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  useEffect(() => {
    setPollSecs(pollIntervalSecs);
    setAiActive(!masterAiKillSwitch);
    setSigName(userSignatureName);
  }, [pollIntervalSecs, masterAiKillSwitch, userSignatureName, open]);

  if (!open) return null;

  const friendlyEngine = resolveFriendlyModelName(modelStatus, availableModels);
  const isBootstrapping =
    !modelStatus.configured &&
    (modelStatus.bootstrapPhase === 'downloading' ||
      modelStatus.bootstrapPhase === 'verifying');

  const flashSaved = (msg: string) => {
    setSavedNotice(msg);
    window.setTimeout(() => {
      setSavedNotice((cur) => (cur === msg ? null : cur));
    }, 2400);
  };

  const handleToggleAiActive = async (nextActive: boolean) => {
    setAiActive(nextActive);
    setFeedbackError(null);
    try {
      await onSaveRuntimeSettings({
        pollIntervalSecs: pollSecs,
        masterAiKillSwitch: !nextActive,
        contextSize: modelStatus.contextSize,
        allowOllamaFallback: modelStatus.allowOllamaFallback,
        ollamaModelTag: modelStatus.ollamaModelTag,
      });
      flashSaved(
        nextActive ? 'Assistente de escrita ativado.' : 'Assistente de escrita desligado.'
      );
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleChangePollSecs = async (nextSecs: number) => {
    setPollSecs(nextSecs);
    setFeedbackError(null);
    try {
      await onSaveRuntimeSettings({
        pollIntervalSecs: nextSecs,
        masterAiKillSwitch: !aiActive,
        contextSize: modelStatus.contextSize,
        allowOllamaFallback: modelStatus.allowOllamaFallback,
        ollamaModelTag: modelStatus.ollamaModelTag,
      });
      flashSaved('Frequência de atualização guardada.');
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveSignatureName = async () => {
    const trimmed = sigName.trim();
    if (!trimmed || trimmed === userSignatureName) return;
    setFeedbackError(null);
    try {
      if (onUpdateSignatureName) {
        await onUpdateSignatureName(trimmed);
        flashSaved(`Nome de assinatura atualizado para "${trimmed}".`);
      }
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="IA Privada e Contas"
      onClick={onClose}
    >
      <div className="settings-sheet" onClick={(e) => e.stopPropagation()}>
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--hairline)',
            paddingBottom: 'var(--space-4)',
          }}
        >
          <div>
            <span className="type-kicker">Privacidade & Preferências</span>
            <h2 className="type-view-title" style={{ marginTop: '4px' }}>
              IA Privada & Contas
            </h2>
            <p
              style={{
                margin: '6px 0 0 0',
                fontSize: '0.8125rem',
                color: 'var(--ink-secondary)',
                lineHeight: 1.45,
              }}
            >
              O Corvo inclui o seu próprio motor privado de escrita em português. Tudo
              corre localmente no teu computador, sem enviar e-mails para terceiros.
            </p>
          </div>
          <button
            type="button"
            className="quiet-btn"
            onClick={onClose}
            aria-label="Fechar definições"
          >
            <IconClose size={14} />
          </button>
        </header>

        {feedbackError && (
          <div
            style={{
              padding: 'var(--space-3)',
              border: '1px solid var(--tone-warning-line)',
              backgroundColor: 'var(--tone-warning-wash)',
              color: 'var(--tone-warning-ink)',
              fontSize: '0.78rem',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {feedbackError}
          </div>
        )}

        {savedNotice && (
          <div className="type-mono-meta" style={{ color: 'var(--accent-solid)' }}>
            {savedNotice}
          </div>
        )}

        {/* Secção 1: Motor Único Oficial do Corvo (Zero configuração manual) */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <span className="type-kicker">1. Motor de IA Integrado</span>

          <div
            style={{
              padding: '12px 14px',
              border: modelStatus.configured
                ? '1px solid var(--accent-solid)'
                : '1px solid var(--hairline-strong)',
              backgroundColor: modelStatus.configured
                ? 'var(--accent-wash)'
                : 'transparent',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                  {friendlyEngine}
                </div>
                <div
                  style={{
                    fontSize: '0.76rem',
                    color: 'var(--ink-secondary)',
                    marginTop: '2px',
                  }}
                >
                  {modelStatus.configured
                    ? 'Instalado neste computador · rápido e 100% offline'
                    : isBootstrapping
                      ? `A preparar automaticamente no primeiro arranque (${modelStatus.bootstrapPercent ?? 0}%)…`
                      : modelStatus.bootstrapError ??
                        'A aguardar ligação à internet para concluir a instalação única.'}
                </div>
              </div>

              {modelStatus.configured ? (
                <span className="ai-badge-transparent" style={{ flexShrink: 0 }}>
                  <IconCheck size={12} />
                  <span>Ativo</span>
                </span>
              ) : !isBootstrapping ? (
                <button
                  type="button"
                  className="quiet-btn quiet-btn--active"
                  onClick={() => void onInstallRecommendedModel()}
                >
                  Tentar novamente
                </button>
              ) : null}
            </div>

            {isBootstrapping && (
              <div
                style={{
                  width: '100%',
                  height: '3px',
                  backgroundColor: 'var(--hairline-strong)',
                  borderRadius: '2px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.max(4, modelStatus.bootstrapPercent ?? 2)}%`,
                    height: '100%',
                    backgroundColor: 'var(--accent-solid)',
                    transition: 'width 180ms ease-out',
                  }}
                />
              </div>
            )}
          </div>
        </section>

        {/* Secção 2: Preferências Gerais */}
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            borderTop: '1px solid var(--hairline)',
            paddingTop: 'var(--space-4)',
          }}
        >
          <span className="type-kicker">2. Preferências Gerais</span>

          <label className="setting-row" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <span>Ativar sugestões de escrita e resumos de conversa</span>
            <input
              type="checkbox"
              checked={aiActive}
              onChange={(e) => void handleToggleAiActive(e.target.checked)}
            />
          </label>

          <div className="setting-row" style={{ alignItems: 'center' }}>
            <span>Procurar novos e-mails automaticamente</span>
            <select
              className="form-field-select"
              style={{ width: 'auto' }}
              value={pollSecs}
              onChange={(e) => void handleChangePollSecs(Number(e.target.value))}
            >
              <option value={30}>A cada 30 segundos</option>
              <option value={60}>A cada minuto</option>
              <option value={90}>A cada minuto e meio</option>
            </select>
          </div>

          <div
            className="setting-row"
            style={{
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
            }}
          >
            <div>
              <div style={{ fontSize: '0.8125rem' }}>O teu nome para saudações e assinaturas</div>
              <div
                className="type-mono-meta"
                style={{ marginTop: '2px', color: 'var(--ink-secondary)' }}
              >
                Usado pela IA para saudações calorosas e assinaturas (ex: "Um abraço,\n{sigName}").
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="text"
                className="form-field-input"
                style={{
                  width: '120px',
                  padding: '4px 8px',
                  fontSize: '0.8125rem',
                  fontFamily: 'inherit',
                }}
                value={sigName}
                onChange={(e) => setSigName(e.target.value)}
                onBlur={() => void handleSaveSignatureName()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveSignatureName();
                }}
                placeholder="Afonso"
              />
              <button
                type="button"
                className="quiet-btn"
                style={{ fontSize: '0.75rem', padding: '3px 8px' }}
                onClick={() => void handleSaveSignatureName()}
              >
                Guardar
              </button>
            </div>
          </div>
        </section>

        {/* Secção 3: Contas Gmail Ligadas */}
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            borderTop: '1px solid var(--hairline)',
            paddingTop: 'var(--space-4)',
          }}
        >
          <span className="type-kicker">3. Contas Gmail Ligadas</span>

          {accounts.length === 0 ? (
            <span className="type-mono-meta">Nenhuma conta Gmail ligada ainda.</span>
          ) : (
            accounts.map((acc) => (
              <div
                key={acc.email}
                style={{
                  padding: 'var(--space-3)',
                  border: '1px solid var(--hairline-strong)',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.8125rem' }}>
                      {acc.email}
                    </div>
                    <div className="type-mono-meta">
                      {acc.keychainSessionActive
                        ? 'Sessão protegida no Porta-chaves do macOS'
                        : 'Sessão expirada — volta a iniciar sessão'}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="quiet-btn"
                    onClick={() => void onDisconnectAccount(acc.email)}
                  >
                    Desligar conta
                  </button>
                </div>

                <label
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                  }}
                >
                  <span>Permitir resumos e rascunhos nesta conta</span>
                  <input
                    type="checkbox"
                    checked={acc.aiEnabled}
                    onChange={(e) =>
                      void onUpdateAccountPolicy({
                        email: acc.email,
                        aiEnabled: e.target.checked,
                        suggestionTrigger: acc.suggestionTrigger,
                        autoSummarize: acc.autoSummarize,
                      })
                    }
                  />
                </label>
              </div>
            ))
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '6px' }}>
            {onAddAccount && (
              <button
                type="button"
                className="tinta-btn-secondary"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12px',
                  padding: '6px 12px',
                }}
                onClick={onAddAccount}
              >
                <IconPlus size={13} />
                <span>Google / Gmail</span>
              </button>
            )}

            {onAddCustomAccount && (
              <>
                <button
                  type="button"
                  className="tinta-btn-secondary"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12px',
                    padding: '6px 12px',
                  }}
                  onClick={() => {
                    setAddingProvider(addingProvider === 'outlook' ? null : 'outlook');
                    setNewAccountEmail('');
                    setNewAccountLabel('');
                  }}
                >
                  <IconPlus size={13} />
                  <span>Microsoft 365 / Outlook</span>
                </button>

                <button
                  type="button"
                  className="tinta-btn-secondary"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12px',
                    padding: '6px 12px',
                  }}
                  onClick={() => {
                    setAddingProvider(addingProvider === 'imap' ? null : 'imap');
                    setNewAccountEmail('');
                    setNewAccountLabel('');
                  }}
                >
                  <IconPlus size={13} />
                  <span>Conta IMAP / Personalizada</span>
                </button>
              </>
            )}
          </div>

          {addingProvider && onAddCustomAccount && (
            <div
              style={{
                marginTop: '12px',
                padding: '12px',
                borderRadius: '8px',
                backgroundColor: 'var(--fill)',
                border: '1px solid var(--line)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)' }}>
                {addingProvider === 'outlook'
                  ? 'Associar Conta Microsoft 365 / Outlook'
                  : 'Associar Conta IMAP / Servidor Próprio'}
              </div>
              <input
                type="email"
                placeholder="exemplo@empresa.com"
                value={newAccountEmail}
                onChange={(e) => setNewAccountEmail(e.target.value)}
                style={{
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  backgroundColor: 'var(--bg)',
                  color: 'var(--ink)',
                  fontSize: '12px',
                  outline: 'none',
                }}
              />
              <input
                type="text"
                placeholder="Etiqueta da conta (ex: Trabalho, Corporativo)"
                value={newAccountLabel}
                onChange={(e) => setNewAccountLabel(e.target.value)}
                style={{
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  backgroundColor: 'var(--bg)',
                  color: 'var(--ink)',
                  fontSize: '12px',
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
                <button
                  type="button"
                  onClick={() => setAddingProvider(null)}
                  style={{
                    padding: '4px 10px',
                    background: 'transparent',
                    border: 'none',
                    fontSize: '11.5px',
                    color: 'var(--mute)',
                    cursor: 'pointer',
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={!newAccountEmail.trim() || isSubmittingAccount}
                  onClick={async () => {
                    if (!newAccountEmail.trim()) return;
                    setIsSubmittingAccount(true);
                    try {
                      await onAddCustomAccount(
                        newAccountEmail.trim(),
                        newAccountLabel.trim(),
                        addingProvider
                      );
                      setAddingProvider(null);
                    } catch (err) {
                      console.error('Erro ao adicionar conta:', err);
                    } finally {
                      setIsSubmittingAccount(false);
                    }
                  }}
                  style={{
                    padding: '5px 12px',
                    borderRadius: '6px',
                    backgroundColor: 'var(--acc)',
                    color: '#fff',
                    border: 'none',
                    fontSize: '11.5px',
                    fontWeight: 600,
                    cursor: !newAccountEmail.trim() || isSubmittingAccount ? 'not-allowed' : 'pointer',
                    opacity: !newAccountEmail.trim() || isSubmittingAccount ? 0.6 : 1,
                  }}
                >
                  {isSubmittingAccount ? 'A associar…' : 'Ligar Conta'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

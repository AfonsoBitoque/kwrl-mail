import React, { useEffect, useState } from 'react';
import { openExternalUrl, resolveFriendlyModelName } from '../services/tauriBridge';
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
  oauthClientId?: string | null;
  oauthSecretInKeychain?: boolean;
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
  onSaveCredentials?: (clientId: string, clientSecret: string) => Promise<void>;
}

export const PrivacySettingsDrawer: React.FC<PrivacySettingsDrawerProps> = ({
  open,
  accounts,
  pollIntervalSecs,
  masterAiKillSwitch,
  userSignatureName = '',
  modelStatus,
  availableModels,
  oauthClientId,
  oauthSecretInKeychain,
  onClose,
  onSaveRuntimeSettings,
  onUpdateSignatureName,
  onInstallRecommendedModel,
  onUpdateAccountPolicy,
  onDisconnectAccount,
  onAddAccount,
  onSaveCredentials,
}) => {
  const [pollSecs, setPollSecs] = useState(pollIntervalSecs);
  const [aiActive, setAiActive] = useState(!masterAiKillSwitch);
  const [sigName, setSigName] = useState(userSignatureName);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  // Gestão de Credenciais Google Cloud BYOK
  const [showOauthForm, setShowOauthForm] = useState(false);
  const [rawOauthInput, setRawOauthInput] = useState('');
  const [oauthSecretInput, setOauthSecretInput] = useState('');
  const [isSavingOauth, setIsSavingOauth] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

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

  const handleSaveOauthCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSaveCredentials) return;
    const trimmedInput = rawOauthInput.trim();
    const isJson = trimmedInput.startsWith('{');
    if (!trimmedInput || (!isJson && !oauthSecretInput.trim())) return;

    setIsSavingOauth(true);
    setOauthError(null);
    try {
      await onSaveCredentials(
        trimmedInput,
        isJson ? 'from_json' : oauthSecretInput.trim()
      );
      setRawOauthInput('');
      setOauthSecretInput('');
      setShowOauthForm(false);
      flashSaved('Chaves Google Cloud atualizadas com sucesso no Keychain!');
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSavingOauth(false);
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
                  padding: '6px 14px',
                }}
                onClick={onAddAccount}
              >
                <IconPlus size={13} />
                <span>Associar Nova Conta Google / Gmail</span>
              </button>
            )}
          </div>

          {/* Informação sobre suporte a Microsoft 365, Outlook e IMAP */}
          <div
            style={{
              marginTop: '14px',
              padding: '12px 14px',
              borderRadius: '8px',
              backgroundColor: 'var(--fill)',
              border: '1px solid var(--line)',
              fontSize: '11.5px',
              color: 'var(--mute)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              lineHeight: '1.5',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--ink)' }}>
              <span>ℹ️</span>
              <span>Microsoft 365, Outlook e IMAP</span>
            </div>
            <div>
              O Corvo opera atualmente em exclusivo com contas <strong>Google / Gmail</strong> através do fluxo oficial <strong>OAuth 2.0 PKCE S256</strong> (RFC 8252) com permissões mínimas e sincronização local direta.
            </div>
            <div style={{ fontSize: '11px', color: 'var(--faint)' }}>
              O suporte nativo a <strong>Microsoft 365 / Outlook</strong> (via Microsoft Graph API) e servidores <strong>IMAP</strong> está previsto para uma versão futura.
            </div>
          </div>
        </section>

        {/* Secção 4: Credenciais Google Cloud (Modelo Open Source / BYOK) */}
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            borderTop: '1px solid var(--hairline)',
            paddingTop: 'var(--space-4)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="type-kicker">4. Chaves Google Cloud (OAuth 2.0 / BYOK)</span>
            {oauthClientId && oauthSecretInKeychain && (
              <span className="ai-badge-transparent">
                <IconCheck size={12} />
                <span>Ativo no Keychain</span>
              </span>
            )}
          </div>

          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
            O Corvo adota o modelo <em>Bring Your Own Keys</em> (BYOK): cada utilizador utiliza a sua própria credencial gratuita do Google Cloud, eliminando intermediários, quotas partilhadas e custos de auditoria comercial.
          </p>

          <div
            style={{
              padding: '12px 14px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--hairline-strong)',
              backgroundColor: 'var(--surface-sunken)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                  {oauthClientId ? 'ID de Cliente Configurado' : 'Nenhuma chave configurada'}
                </div>
                <div className="type-mono-meta" style={{ marginTop: '2px' }}>
                  {oauthClientId
                    ? `${oauthClientId.slice(0, 18)}…`
                    : 'Configura uma chave para ligar contas Gmail'}
                </div>
              </div>

              {onSaveCredentials && (
                <button
                  type="button"
                  className="quiet-btn"
                  onClick={() => setShowOauthForm(!showOauthForm)}
                >
                  {showOauthForm ? 'Fechar' : oauthClientId ? 'Substituir Chave' : 'Configurar Chave'}
                </button>
              )}
            </div>

            {showOauthForm && onSaveCredentials && (
              <form
                onSubmit={(e) => void handleSaveOauthCredentials(e)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  borderTop: '1px solid var(--hairline)',
                  paddingTop: '10px',
                  marginTop: '4px',
                }}
              >
                <div style={{ display: 'flex', gap: '10px', fontSize: '0.75rem', marginBottom: '4px' }}>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ padding: 0, fontSize: '0.75rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/library/gmail.googleapis.com')}
                  >
                    1. Ativar Gmail API ↗
                  </button>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ padding: 0, fontSize: '0.75rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/credentials')}
                  >
                    2. Criar Credencial OAuth (Desktop app) ↗
                  </button>
                </div>

                <textarea
                  className="form-field-input"
                  rows={3}
                  style={{
                    resize: 'vertical',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.75rem',
                  }}
                  placeholder='Cola aqui o conteúdo do ficheiro JSON descarregado da Google (ou apenas o Client ID)…'
                  value={rawOauthInput}
                  onChange={(e) => setRawOauthInput(e.target.value)}
                />

                {!rawOauthInput.trim().startsWith('{') && rawOauthInput.trim().length > 0 && (
                  <input
                    type="password"
                    className="form-field-input"
                    placeholder="Client Secret (ex: GOCSPX-...)"
                    value={oauthSecretInput}
                    onChange={(e) => setOauthSecretInput(e.target.value)}
                  />
                )}

                {oauthError && (
                  <div style={{ color: 'var(--tone-warning-ink)', fontSize: '0.75rem' }}>
                    {oauthError}
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    type="submit"
                    className="primary-solid-btn"
                    disabled={
                      isSavingOauth ||
                      !rawOauthInput.trim() ||
                      (!rawOauthInput.trim().startsWith('{') && !oauthSecretInput.trim())
                    }
                    style={{ padding: '6px 14px', fontSize: '0.78rem' }}
                  >
                    {isSavingOauth ? 'A guardar no Keychain…' : 'Guardar no Keychain'}
                  </button>

                  <button
                    type="button"
                    className="quiet-btn"
                    onClick={() => setShowOauthForm(false)}
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

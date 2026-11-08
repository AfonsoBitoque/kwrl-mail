import React, { useEffect, useState } from 'react';
import { openExternalUrl, resolveFriendlyModelName } from '../services/tauriBridge';
import { AccountView, DiscoveredModel, LocalModelStatus } from '../types/kwrl';
import { IconCheck, IconClose, IconPlus } from './Icons';
import { SUPPORTED_LANGUAGES, useI18n } from '../i18n';

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
  const { language, setLanguage, t } = useI18n();
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
        nextActive
          ? t('settings.aiKillSwitch') + ': ' + t('common.active')
          : t('settings.aiKillSwitch') + ': ' + t('common.inactive')
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
      flashSaved(t('common.saved'));
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
        flashSaved(t('common.saved') + `: "${trimmed}"`);
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
      flashSaved(t('common.saved'));
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
      aria-label={t('settings.title')}
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
            <span className="type-kicker">Kwrl Mail</span>
            <h2 className="type-view-title" style={{ marginTop: '4px' }}>
              {t('settings.title')}
            </h2>
            <p
              style={{
                margin: '6px 0 0 0',
                fontSize: '0.8125rem',
                color: 'var(--ink-secondary)',
                lineHeight: 1.45,
              }}
            >
              {t('settings.desc')}
            </p>
          </div>
          <button
            type="button"
            className="quiet-btn"
            onClick={onClose}
            aria-label={t('common.close')}
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

        {/* Secção 0: Idioma da Interface */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span className="type-kicker">{t('settings.languageSection')}</span>
          <p
            style={{
              margin: '0 0 6px 0',
              fontSize: '0.8rem',
              color: 'var(--ink-secondary)',
              lineHeight: 1.4,
            }}
          >
            {t('settings.languageDesc')}
          </p>
          <div
            style={{
              display: 'flex',
              gap: '6px',
              flexWrap: 'wrap',
            }}
          >
            {SUPPORTED_LANGUAGES.map((lang) => {
              const isCurrent = language === lang.code;
              return (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => setLanguage(lang.code)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontSize: '0.8rem',
                    fontWeight: isCurrent ? 600 : 400,
                    cursor: 'pointer',
                    border: isCurrent
                      ? '1px solid var(--color-accent, #a78bfa)'
                      : '1px solid var(--line)',
                    backgroundColor: isCurrent
                      ? 'rgba(167, 139, 250, 0.16)'
                      : 'var(--fill)',
                    color: isCurrent ? 'var(--ink)' : 'var(--mute)',
                    transition: 'all 120ms ease-out',
                  }}
                >
                  <span style={{ fontSize: '14px' }}>{lang.flag}</span>
                  <span>{lang.nativeName}</span>
                  {lang.code === 'en' && (
                    <span
                      style={{
                        fontSize: '9.5px',
                        padding: '1px 4px',
                        borderRadius: '3px',
                        backgroundColor: 'var(--line)',
                        color: 'var(--faint)',
                        marginLeft: '2px',
                      }}
                    >
                      Default
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* Secção 1: Motor Único Oficial do Kwrl (Zero configuração manual) */}
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            borderTop: '1px solid var(--hairline)',
            paddingTop: 'var(--space-4)',
          }}
        >
          <span className="type-kicker">{t('settings.aiSection')}</span>

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
                    ? t('aiPanel.modelReady')
                    : isBootstrapping
                      ? t('aiPanel.firstLaunchPrep') + ` (${modelStatus.bootstrapPercent ?? 0}%)…`
                      : modelStatus.bootstrapError ?? t('aiPanel.connectInternetNotice')}
                </div>
              </div>

              {modelStatus.configured ? (
                <span className="ai-badge-transparent" style={{ flexShrink: 0 }}>
                  <IconCheck size={12} />
                  <span>{t('common.active')}</span>
                </span>
              ) : !isBootstrapping ? (
                <button
                  type="button"
                  className="quiet-btn quiet-btn--active"
                  onClick={() => void onInstallRecommendedModel()}
                >
                  {t('aiPanel.retry')}
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
          <span className="type-kicker">{t('settings.syncSection')}</span>

          <label className="setting-row" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <span>{t('settings.aiKillSwitch')}</span>
            <input
              type="checkbox"
              checked={aiActive}
              onChange={(e) => void handleToggleAiActive(e.target.checked)}
            />
          </label>

          <div className="setting-row" style={{ alignItems: 'center' }}>
            <span>{t('settings.pollInterval')}</span>
            <select
              className="form-field-select"
              style={{ width: 'auto' }}
              value={pollSecs}
              onChange={(e) => void handleChangePollSecs(Number(e.target.value))}
            >
              <option value={30}>{t('settings.poll30')}</option>
              <option value={60}>{t('settings.poll60')}</option>
              <option value={90}>{t('settings.poll90')}</option>
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
              <div style={{ fontSize: '0.8125rem' }}>{t('settings.userSignature')}</div>
              <div
                className="type-mono-meta"
                style={{ marginTop: '2px', color: 'var(--ink-secondary)' }}
              >
                {t('settings.sigNameHint', { name: sigName || '...' })}
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
                placeholder={t('settings.userSignaturePlaceholder')}
              />
              <button
                type="button"
                className="quiet-btn"
                style={{ fontSize: '0.75rem', padding: '3px 8px' }}
                onClick={() => void handleSaveSignatureName()}
              >
                {t('common.save')}
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
          <span className="type-kicker">{t('settings.accountsSection')}</span>

          {accounts.length === 0 ? (
            <span className="type-mono-meta">{t('settings.noAccounts')}</span>
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
                        ? t('settings.keychainActiveLabel')
                        : t('settings.sessionExpiredLabel')}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="quiet-btn"
                    onClick={() => void onDisconnectAccount(acc.email)}
                  >
                    {t('settings.disconnectBtn')}
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
                  <span>{t('settings.allowAiAccount')}</span>
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
                <span>{t('settings.addAccountBtn')}</span>
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
              <span>{t('settings.outlookNoticeTitle')}</span>
            </div>
            <div>
              {t('settings.outlookNoticeDesc')}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--faint)' }}>
              {t('settings.outlookNoticeFuture')}
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
            <span className="type-kicker">{t('settings.oauthSection')}</span>
            {oauthClientId && oauthSecretInKeychain && (
              <span className="ai-badge-transparent">
                <IconCheck size={12} />
                <span>{t('settings.keychainActive')}</span>
              </span>
            )}
          </div>

          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
            {t('settings.byokExplainer')}
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
                  {oauthClientId ? t('settings.oauthConfigured') : t('settings.oauthNoneConfigured')}
                </div>
                <div className="type-mono-meta" style={{ marginTop: '2px' }}>
                  {oauthClientId
                    ? `${oauthClientId.slice(0, 18)}…`
                    : t('settings.oauthNoneConfigured')}
                </div>
              </div>

              {onSaveCredentials && (
                <button
                  type="button"
                  className="quiet-btn"
                  onClick={() => setShowOauthForm(!showOauthForm)}
                >
                  {showOauthForm ? t('common.close') : oauthClientId ? t('settings.replaceKey') : t('settings.setupKey')}
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '0.75rem', marginBottom: '4px' }}>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ padding: 0, fontSize: '0.75rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/library/gmail.googleapis.com')}
                  >
                    {t('settings.step1GmailApi')}
                  </button>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ padding: 0, fontSize: '0.75rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/credentials/consent')}
                  >
                    {t('settings.step2Audience')}
                  </button>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ padding: 0, fontSize: '0.75rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/credentials')}
                  >
                    {t('settings.step3DesktopApp')}
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
                  placeholder={t('settings.oauthInputPlaceholder')}
                  value={rawOauthInput}
                  onChange={(e) => setRawOauthInput(e.target.value)}
                />

                {!rawOauthInput.trim().startsWith('{') && rawOauthInput.trim().length > 0 && (
                  <input
                    type="password"
                    className="form-field-input"
                    placeholder={t('settings.oauthSecretPlaceholder')}
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
                    {isSavingOauth ? t('settings.savingKeychain') : t('settings.saveKeychainBtn')}
                  </button>

                  <button
                    type="button"
                    className="quiet-btn"
                    onClick={() => setShowOauthForm(false)}
                  >
                    {t('common.cancel')}
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

import React, { useState } from 'react';
import { GmailScopeMode } from '../types/kwrl';
import { IconCheck, IconGoogleMark, KwrlMark } from './Icons';
import { openExternalUrl } from '../services/tauriBridge';
import { SUPPORTED_LANGUAGES, useI18n } from '../i18n';

interface GmailOnboardingViewProps {
  savedClientId: string | null;
  secretInKeychain: boolean;
  isAuthenticating: boolean;
  errorMessage: string | null;
  onSaveCredentials: (clientId: string, clientSecret: string) => Promise<void>;
  onStartOAuth: (scopeMode: GmailScopeMode, label: string) => Promise<void>;
}

export const GmailOnboardingView: React.FC<GmailOnboardingViewProps> = ({
  savedClientId,
  secretInKeychain,
  isAuthenticating,
  errorMessage,
  onSaveCredentials,
  onStartOAuth,
}) => {
  const { language, setLanguage, t } = useI18n();
  const [accountLabel, setAccountLabel] = useState('');
  const [scopeMode, setScopeMode] = useState<GmailScopeMode>('modify-and-labels');
  const [manualSetupOpen, setManualSetupOpen] = useState(false);

  // Permite colar o ficheiro JSON inteiro da Google, ou Client ID + Secret
  const [rawJsonOrId, setRawJsonOrId] = useState(savedClientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [savingAndStarting, setSavingAndStarting] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<string | null>(null);

  const credentialsReady = Boolean(savedClientId) && secretInKeychain;
  const showSetup = !credentialsReady || manualSetupOpen;

  const handleContinueWithGoogle = async () => {
    if (!credentialsReady) {
      setManualSetupOpen(true);
      return;
    }
    await onStartOAuth(scopeMode, accountLabel);
  };

  const handleSaveCredentialsAndContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedInput = rawJsonOrId.trim();
    const isJsonPaste = trimmedInput.startsWith('{');
    if (!trimmedInput || (!isJsonPaste && !clientSecret.trim())) return;

    setSavingAndStarting(true);
    setLocalFeedback(null);
    try {
      await onSaveCredentials(
        trimmedInput,
        isJsonPaste ? 'from_json' : clientSecret.trim()
      );
      setClientSecret('');
      setManualSetupOpen(false);
      await onStartOAuth(scopeMode, accountLabel);
    } catch (err) {
      setLocalFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAndStarting(false);
    }
  };

  const isPastingJson = rawJsonOrId.trim().startsWith('{');

  return (
    <main className="corvo-reading-pane" aria-label={t('onboarding.title')}>
      <article className="reading-article" style={{ maxWidth: '580px' }}>
        <header className="reading-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '4px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <KwrlMark size={20} />
              <span className="type-kicker">{t('onboarding.kicker')}</span>
            </div>

            {/* Seletor rápido de idiomas */}
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '2px',
                padding: '2px',
                borderRadius: '6px',
                backgroundColor: 'var(--surface-sunken)',
                border: '1px solid var(--hairline)',
              }}
              role="group"
              aria-label={t('common.language')}
            >
              {SUPPORTED_LANGUAGES.map((lang) => {
                const isSelected = language === lang.code;
                return (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => setLanguage(lang.code)}
                    style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      border: 'none',
                      backgroundColor: isSelected ? 'var(--surface-primary)' : 'transparent',
                      color: isSelected ? 'var(--ink-primary)' : 'var(--ink-tertiary)',
                      fontSize: '11px',
                      fontWeight: isSelected ? 600 : 400,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '3px',
                      boxShadow: isSelected ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
                    }}
                    title={lang.nativeName}
                  >
                    <span>{lang.flag}</span>
                    <span style={{ textTransform: 'uppercase' }}>{lang.code}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <h1 className="type-thread-subject" style={{ marginTop: '10px' }}>
            {showSetup ? t('onboarding.titleSetup') : t('onboarding.title')}
          </h1>

          <p
            style={{
              margin: '8px 0 0 0',
              fontSize: '0.9rem',
              lineHeight: 1.6,
              color: 'var(--ink-secondary)',
            }}
          >
            {showSetup ? t('onboarding.descSetup') : t('onboarding.descDirect')}
          </p>
        </header>

        {/* MODO 1: Chaves Prontas -> Ecrã de Login Direto */}
        {!showSetup && (
          <section
            style={{
              marginTop: 'var(--space-6)',
              paddingTop: 'var(--space-5)',
              borderTop: '1px solid var(--hairline)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            {/* Indicador de chaves ativas */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--surface-sunken)',
                fontSize: '0.8rem',
                color: 'var(--ink-secondary)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="ai-badge-transparent">
                  <IconCheck size={12} />
                  <span>{t('onboarding.credentialsReady')}</span>
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>
                  {savedClientId ? `${savedClientId.slice(0, 12)}…` : ''}
                </span>
              </div>
              <button
                type="button"
                className="quiet-btn"
                style={{ fontSize: '0.75rem', padding: '2px 6px' }}
                onClick={() => setManualSetupOpen(true)}
              >
                {t('onboarding.changeCredentials')}
              </button>
            </div>

            <div>
              <button
                type="button"
                className="primary-solid-btn"
                style={{
                  padding: '10px 18px',
                  fontSize: '0.875rem',
                  gap: '10px',
                }}
                disabled={isAuthenticating || savingAndStarting}
                onClick={() => void handleContinueWithGoogle()}
              >
                <IconGoogleMark size={15} />
                <span>
                  {isAuthenticating
                    ? t('onboarding.waitingBrowser')
                    : t('onboarding.continueGoogle')}
                </span>
              </button>
            </div>

            {/* Opções opcionais (nome da conta / modo só leitura) */}
            <details style={{ marginTop: '4px' }}>
              <summary
                style={{
                  fontSize: '0.78rem',
                  color: 'var(--ink-tertiary)',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                {t('onboarding.optionalOptions')}
              </summary>

              <div
                style={{
                  marginTop: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  maxWidth: '400px',
                }}
              >
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.75rem',
                      color: 'var(--ink-secondary)',
                      marginBottom: '4px',
                    }}
                  >
                    {t('onboarding.accountLabelHint')}
                  </label>
                  <input
                    type="text"
                    className="form-field-input"
                    placeholder={t('onboarding.accountLabelPlaceholder')}
                    value={accountLabel}
                    onChange={(e) => setAccountLabel(e.target.value)}
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.75rem',
                      color: 'var(--ink-secondary)',
                      marginBottom: '4px',
                    }}
                  >
                    {t('onboarding.accessLevel')}
                  </label>
                  <select
                    className="form-field-select"
                    value={scopeMode}
                    onChange={(e) => setScopeMode(e.target.value as GmailScopeMode)}
                  >
                    <option value="modify-and-labels">
                      {t('onboarding.accessDefault')}
                    </option>
                    <option value="read-only">
                      {t('onboarding.accessReadOnly')}
                    </option>
                  </select>
                </div>
              </div>
            </details>
          </section>
        )}

        {/* MODO 2: Assistente Guiado de Configuração BYOK (4 Passos Claros) */}
        {showSetup && (
          <section
            style={{
              marginTop: 'var(--space-6)',
              paddingTop: 'var(--space-5)',
              borderTop: '1px solid var(--hairline)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            {/* Passo 1 */}
            <div
              style={{
                display: 'flex',
                gap: '12px',
                padding: '12px 14px',
                border: '1px solid var(--hairline)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--surface-sunken)',
              }}
            >
              <div
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--ink-primary)',
                  color: 'var(--surface-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                1
              </div>
              <div style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem', display: 'block', marginBottom: '4px' }}>
                  {t('onboarding.step1Title')}
                </strong>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
                  {t('onboarding.step1Desc')}
                </p>
                <div style={{ marginTop: '8px' }}>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ fontSize: '0.78rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/library/gmail.googleapis.com')}
                  >
                    {t('onboarding.step1Button')}
                  </button>
                </div>
              </div>
            </div>

            {/* Passo 2: Público-alvo / Utilizadores de Teste (OBRIGATÓRIO) */}
            <div
              style={{
                display: 'flex',
                gap: '12px',
                padding: '12px 14px',
                border: '1px solid var(--hairline-strong)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--surface-sunken)',
              }}
            >
              <div
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--ink-primary)',
                  color: 'var(--surface-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                2
              </div>
              <div style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem', display: 'block', marginBottom: '4px' }}>
                  {t('onboarding.step2Title')}
                </strong>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
                  {t('onboarding.step2Desc')}
                </p>
                <div style={{ marginTop: '8px' }}>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ fontSize: '0.78rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/credentials/consent')}
                  >
                    {t('onboarding.step2Button')}
                  </button>
                </div>
              </div>
            </div>

            {/* Passo 3 */}
            <div
              style={{
                display: 'flex',
                gap: '12px',
                padding: '12px 14px',
                border: '1px solid var(--hairline)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--surface-sunken)',
              }}
            >
              <div
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--ink-primary)',
                  color: 'var(--surface-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                3
              </div>
              <div style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem', display: 'block', marginBottom: '4px' }}>
                  {t('onboarding.step3Title')}
                </strong>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
                  {t('onboarding.step3Desc')}
                </p>
                <div style={{ marginTop: '8px' }}>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ fontSize: '0.78rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/credentials')}
                  >
                    {t('onboarding.step3Button')}
                  </button>
                </div>
              </div>
            </div>

            {/* Passo 4 */}
            <div
              style={{
                display: 'flex',
                gap: '12px',
                padding: '12px 14px',
                border: '1px solid var(--hairline)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--surface-sunken)',
              }}
            >
              <div
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--ink-primary)',
                  color: 'var(--surface-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                4
              </div>
              <div style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem', display: 'block', marginBottom: '4px' }}>
                  {t('onboarding.step4Title')}
                </strong>
                <p style={{ margin: '0 0 8px 0', fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
                  {t('onboarding.step4Desc')}
                </p>

                <form
                  onSubmit={(e) => void handleSaveCredentialsAndContinue(e)}
                  style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
                >
                  <textarea
                    className="form-field-input"
                    rows={4}
                    style={{
                      resize: 'vertical',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.75rem',
                      lineHeight: 1.4,
                    }}
                    placeholder={t('onboarding.jsonPlaceholder')}
                    value={rawJsonOrId}
                    onChange={(e) => setRawJsonOrId(e.target.value)}
                  />

                  {!isPastingJson && rawJsonOrId.trim().length > 0 && (
                    <input
                      type="password"
                      className="form-field-input"
                      placeholder={t('settings.oauthSecretPlaceholder')}
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                    />
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                    <button
                      type="submit"
                      className="primary-solid-btn"
                      disabled={
                        savingAndStarting ||
                        !rawJsonOrId.trim() ||
                        (!isPastingJson && !clientSecret.trim())
                      }
                      style={{ padding: '8px 16px', fontSize: '0.8125rem' }}
                    >
                      <IconCheck size={14} />
                      <span>
                        {savingAndStarting
                          ? t('onboarding.savingAndConnecting')
                          : t('onboarding.saveAndContinue')}
                      </span>
                    </button>

                    {credentialsReady && (
                      <button
                        type="button"
                        className="quiet-btn"
                        onClick={() => setManualSetupOpen(false)}
                      >
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>
                </form>
              </div>
            </div>
          </section>
        )}

        {/* Mensagens de erro */}
        {(errorMessage || localFeedback) && (
          <div
            style={{
              marginTop: 'var(--space-5)',
              padding: 'var(--space-3) var(--space-4)',
              border: '1px solid var(--tone-warning-line)',
              backgroundColor: 'var(--tone-warning-wash)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem',
              color: 'var(--tone-warning-ink)',
            }}
          >
            {localFeedback || errorMessage}
          </div>
        )}
      </article>
    </main>
  );
};

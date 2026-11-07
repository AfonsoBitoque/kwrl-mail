import React, { useState } from 'react';
import { GmailScopeMode } from '../types/corvo';
import { CorvoMark, IconCheck, IconGoogleMark } from './Icons';
import { openExternalUrl } from '../services/tauriBridge';

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
    <main className="corvo-reading-pane" aria-label="Iniciar sessão com Google">
      <article className="reading-article" style={{ maxWidth: '580px' }}>
        <header className="reading-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CorvoMark size={20} />
            <span className="type-kicker">Corvo · Correio Local & Código Aberto</span>
          </div>

          <h1 className="type-thread-subject" style={{ marginTop: '10px' }}>
            {showSetup
              ? 'Configurar Credenciais do Gmail'
              : 'Entra na tua conta Gmail'}
          </h1>

          <p
            style={{
              margin: '8px 0 0 0',
              fontSize: '0.9rem',
              lineHeight: 1.6,
              color: 'var(--ink-secondary)',
            }}
          >
            {showSetup
              ? 'O Corvo é 100% privado, local e sem servidores intermédios. Para ligares o Gmail com total soberania e sem custos de auditoria comercial, utiliza a tua própria chave gratuita da Google Cloud.'
              : 'Abre o início de sessão oficial da Google no teu browser habitual. Os teus e-mails ficam guardados localmente neste computador e a sessão protegida no Keychain do sistema.'}
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
                  <span>Chave Própria Configurada</span>
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
                Alterar
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
                    ? 'A aguardar confirmação no browser…'
                    : 'Continuar com Google'}
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
                Opções opcionais (etiqueta da conta e permissões)
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
                    Nome na barra lateral (opcional)
                  </label>
                  <input
                    type="text"
                    className="form-field-input"
                    placeholder="Ex: Pessoal, Trabalho"
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
                    Nível de acesso
                  </label>
                  <select
                    className="form-field-select"
                    value={scopeMode}
                    onChange={(e) => setScopeMode(e.target.value as GmailScopeMode)}
                  >
                    <option value="modify-and-labels">
                      Padrão (ler e marcar como lido)
                    </option>
                    <option value="read-only">
                      Apenas leitura
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
                  Ativar a Gmail API na Google Cloud
                </strong>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
                  Acede à Google Cloud Console, cria um projeto gratuito (ex: <em>Corvo Mail</em>) e clica em <strong>Ativar</strong> (Enable).
                </p>
                <div style={{ marginTop: '8px' }}>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ fontSize: '0.78rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/library/gmail.googleapis.com')}
                  >
                    1. Abrir Google Cloud Console ↗
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
                  Ecrã de Consentimento & Público-Alvo / Utilizadores de Teste (Obrigatório)
                </strong>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
                  No menu <strong>Ecrã de consentimento OAuth</strong> (*OAuth consent screen*), seleciona tipo <strong>Externo</strong> (*External*).<br />
                  ⚠️ <strong>Passo Crítico:</strong> Na secção <strong>Público-alvo</strong> (*Audience*) ou <strong>Utilizadores de Teste</strong> (*Test users*), clica obrigatoriamente em <strong>&ldquo;+ Adicionar utilizadores&rdquo;</strong> e introduz todos os e-mails Gmail que vais usar no Corvo. Se não adicionares o teu e-mail aqui, a Google bloqueará o acesso com <em>Erro 403 (access_denied)</em>.
                </p>
                <div style={{ marginTop: '8px' }}>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ fontSize: '0.78rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/credentials/consent')}
                  >
                    2. Configurar Ecrã de Consentimento & Utilizadores de Teste ↗
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
                  Criar Credencial &ldquo;Desktop app&rdquo; e Descarregar JSON
                </strong>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
                  Em <strong>Credenciais</strong> → <strong>+ Criar Credenciais</strong> → <strong>ID do cliente OAuth</strong>, escolhe o tipo <strong>Aplicação de Computador</strong> (Desktop app). Clica em <em>Criar</em> e depois no botão/ícone de <strong>Descarregar ficheiro JSON</strong>.
                </p>
                <div style={{ marginTop: '8px' }}>
                  <button
                    type="button"
                    className="quiet-btn"
                    style={{ fontSize: '0.78rem', textDecoration: 'underline' }}
                    onClick={() => void openExternalUrl('https://console.cloud.google.com/apis/credentials')}
                  >
                    3. Abrir Ecrã de Credenciais ↗
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
                  Colar o ficheiro JSON descarregado
                </strong>
                <p style={{ margin: '0 0 8px 0', fontSize: '0.8rem', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
                  Abre o ficheiro JSON descarregado num editor de texto (começa por <code>&#123;&quot;installed&quot;: ...&#125;</code>), copia todo o conteúdo e cola aqui:
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
                    placeholder='Cola aqui o JSON da Google (começa por { "installed": ... }) ou o Client ID…'
                    value={rawJsonOrId}
                    onChange={(e) => setRawJsonOrId(e.target.value)}
                  />

                  {!isPastingJson && rawJsonOrId.trim().length > 0 && (
                    <input
                      type="password"
                      className="form-field-input"
                      placeholder="Client Secret (ex: GOCSPX-...)"
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
                          ? 'A guardar e a ligar…'
                          : 'Guardar e Continuar com Google'}
                      </span>
                    </button>

                    {credentialsReady && (
                      <button
                        type="button"
                        className="quiet-btn"
                        onClick={() => setManualSetupOpen(false)}
                      >
                        Cancelar
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

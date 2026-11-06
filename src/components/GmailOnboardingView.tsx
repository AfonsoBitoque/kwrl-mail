import React, { useState } from 'react';
import { GmailScopeMode } from '../types/corvo';
import { CorvoMark, IconCheck, IconGoogleMark } from './Icons';

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
  const [showCreatorSetup, setShowCreatorSetup] = useState(false);

  // Permite ou colar o ficheiro JSON inteiro da Google, ou Client ID + Secret
  const [rawJsonOrId, setRawJsonOrId] = useState(savedClientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [savingAndStarting, setSavingAndStarting] = useState(false);

  const credentialsReady = Boolean(savedClientId) && secretInKeychain;

  const handleContinueWithGoogle = async () => {
    if (!credentialsReady) {
      // Tenta primeiro iniciar (caso o utilizador tenha acabado de guardar o .env ou o JSON na pasta)
      // Se ainda faltar a chave da app, abre suavemente o passo único do criador.
      setShowCreatorSetup(true);
      await onStartOAuth(scopeMode, accountLabel);
      return;
    }
    await onStartOAuth(scopeMode, accountLabel);
  };

  const handleSaveCreatorKeyAndContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedInput = rawJsonOrId.trim();
    const isJsonPaste = trimmedInput.startsWith('{');
    if (!trimmedInput || (!isJsonPaste && !clientSecret.trim())) return;

    setSavingAndStarting(true);
    try {
      await onSaveCredentials(
        trimmedInput,
        isJsonPaste ? 'from_json' : clientSecret.trim()
      );
      setClientSecret('');
      setShowCreatorSetup(false);
      await onStartOAuth(scopeMode, accountLabel);
    } finally {
      setSavingAndStarting(false);
    }
  };

  const isPastingJson = rawJsonOrId.trim().startsWith('{');

  return (
    <main className="corvo-reading-pane" aria-label="Iniciar sessão com Google">
      <article className="reading-article" style={{ maxWidth: '540px' }}>
        <header className="reading-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CorvoMark size={20} />
            <span className="type-kicker">Corvo · Correio Local</span>
          </div>

          <h1 className="type-thread-subject" style={{ marginTop: '10px' }}>
            Entra na tua conta Gmail.
          </h1>

          <p
            style={{
              margin: '8px 0 0 0',
              fontSize: '0.9rem',
              lineHeight: 1.6,
              color: 'var(--ink-secondary)',
            }}
          >
            Abre o início de sessão oficial da Google no teu browser habitual. Os teus e-mails ficam
            guardados localmente neste computador e a sessão protegida no Keychain do macOS.
          </p>
        </header>

        {/* Botão Direto "Continuar com Google" */}
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

          {/* Opções opcionais discretas (nome da conta / modo só leitura) */}
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

        {errorMessage && !showCreatorSetup && (
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
            {errorMessage}
          </div>
        )}

        {/* Gaveta de configuração única do criador da app — só abre se ainda não existir .env / JSON */}
        {showCreatorSetup && (
          <section
            style={{
              marginTop: 'var(--space-6)',
              paddingTop: 'var(--space-5)',
              borderTop: '1px solid var(--hairline)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="type-kicker">Configuração única do criador da app (2 min)</span>
              {credentialsReady && (
                <span className="ai-badge-transparent">
                  <IconCheck size={12} />
                  <span>Ativo</span>
                </span>
              )}
            </div>

            <p
              style={{
                margin: 0,
                fontSize: '0.8125rem',
                lineHeight: 1.55,
                color: 'var(--ink-secondary)',
              }}
            >
              Para a Google reconhecer a tua app <strong>Corvo</strong>, descarrega 1 única vez o
              ficheiro JSON gratuito (tipo <em>Desktop app</em>) na Google Cloud e larga-o na pasta
              do projeto <strong>ou</strong> cola o conteúdo do JSON diretamente aqui:
            </p>

            <form
              onSubmit={(e) => void handleSaveCreatorKeyAndContinue(e)}
              style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              <textarea
                className="form-field-input"
                rows={3}
                style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}
                placeholder='Cola aqui o conteúdo do ficheiro JSON descarregado da Google (ou apenas o Client ID)…'
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

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <button
                  type="submit"
                  className="primary-solid-btn"
                  disabled={
                    savingAndStarting ||
                    !rawJsonOrId.trim() ||
                    (!isPastingJson && !clientSecret.trim())
                  }
                >
                  <span>
                    {savingAndStarting
                      ? 'A guardar e a abrir Google…'
                      : 'Guardar uma vez e Continuar com Google'}
                  </span>
                </button>

                <button
                  type="button"
                  className="quiet-btn"
                  onClick={() => setShowCreatorSetup(false)}
                >
                  Fechar
                </button>
              </div>
            </form>
          </section>
        )}

        {!showCreatorSetup && (
          <div style={{ marginTop: 'var(--space-6)' }}>
            <button
              type="button"
              className="quiet-btn"
              style={{ padding: 0, fontSize: '0.75rem', color: 'var(--ink-tertiary)' }}
              onClick={() => setShowCreatorSetup(true)}
            >
              {credentialsReady
                ? 'Chave da app configurada · alterar'
                : 'Primeira vez como criador da app? Configurar chave Google'}
            </button>
          </div>
        )}
      </article>
    </main>
  );
};

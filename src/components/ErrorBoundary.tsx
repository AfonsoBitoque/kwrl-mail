import { Component, ErrorInfo, ReactNode } from 'react';
import { en } from '../i18n/translations/en';
import { pt } from '../i18n/translations/pt';
import { fr } from '../i18n/translations/fr';
import { es } from '../i18n/translations/es';
import { SupportedLanguage } from '../i18n/types';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

const ERROR_STRINGS: Record<SupportedLanguage, { title: string; desc: string; recover: string; reload: string }> = {
  en: {
    title: en.errorBoundary.title,
    desc: en.errorBoundary.desc,
    recover: en.errorBoundary.recoverButton,
    reload: en.errorBoundary.reloadApp,
  },
  pt: {
    title: pt.errorBoundary.title,
    desc: pt.errorBoundary.desc,
    recover: pt.errorBoundary.recoverButton,
    reload: pt.errorBoundary.reloadApp,
  },
  fr: {
    title: fr.errorBoundary.title,
    desc: fr.errorBoundary.desc,
    recover: fr.errorBoundary.recoverButton,
    reload: fr.errorBoundary.reloadApp,
  },
  es: {
    title: es.errorBoundary.title,
    desc: es.errorBoundary.desc,
    recover: es.errorBoundary.recoverButton,
    reload: es.errorBoundary.reloadApp,
  },
};

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary capturou uma exceção:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      const stored = (typeof window !== 'undefined' ? localStorage.getItem('kwrl_language') : null) as SupportedLanguage | null;
      const lang: SupportedLanguage = stored && ['en', 'pt', 'fr', 'es'].includes(stored) ? stored : 'en';
      const strings = ERROR_STRINGS[lang] || ERROR_STRINGS.en;

      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--bg, #1a1a1a)',
            color: 'var(--ink, #ffffff)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            padding: '24px',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              maxWidth: '560px',
              width: '100%',
              backgroundColor: 'var(--surface, #242424)',
              border: '1px solid var(--line, #333333)',
              borderRadius: '12px',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '24px' }}>⚠️</span>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
                {strings.title}
              </h2>
            </div>

            <p style={{ margin: 0, fontSize: '13px', color: 'var(--mute, #888888)', lineHeight: 1.5 }}>
              {strings.desc}
            </p>

            {this.state.error && (
              <div
                style={{
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  borderRadius: '8px',
                  padding: '12px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  color: '#f87171',
                  overflowX: 'auto',
                  maxHeight: '180px',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {this.state.error.toString()}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
              <button
                type="button"
                onClick={this.handleReset}
                style={{
                  flex: 1,
                  padding: '8px 14px',
                  borderRadius: '6px',
                  border: '1px solid var(--line, #444)',
                  backgroundColor: 'transparent',
                  color: 'var(--ink, #fff)',
                  fontSize: '13px',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                {strings.recover}
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                style={{
                  flex: 1,
                  padding: '8px 14px',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: 'var(--acc, #7567a3)',
                  color: '#ffffff',
                  fontSize: '13px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                {strings.reload}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

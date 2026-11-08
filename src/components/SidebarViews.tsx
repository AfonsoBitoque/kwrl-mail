import React, { useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { AccountView, CustomMailbox } from '../types/kwrl';
import {
  IconArchive,
  IconClose,
  IconDrafts,
  IconEdit,
  IconFlag,
  IconFolder,
  IconInbox,
  IconMail,
  IconPlus,
  IconProps,
  IconSent,
  IconSliders,
  IconSpam,
  IconTrash,
} from './Icons';

export type StandardBoxId =
  | 'inbox'
  | 'starred'
  | 'drafts'
  | 'sent'
  | 'archive'
  | 'spam'
  | 'trash';

export type TintaBoxId = StandardBoxId;

export interface MailboxItem {
  id: StandardBoxId;
  label: string;
  icon: React.FC<IconProps>;
}

export const MAILBOXES: MailboxItem[] = [
  { id: 'inbox', label: 'Entrada', icon: IconInbox },
  { id: 'starred', label: 'Marcadas', icon: IconFlag },
  { id: 'drafts', label: 'Rascunhos', icon: IconDrafts },
  { id: 'sent', label: 'Enviadas', icon: IconSent },
  { id: 'archive', label: 'Arquivo', icon: IconArchive },
  { id: 'spam', label: 'Lixo', icon: IconSpam },
  { id: 'trash', label: 'Reciclagem', icon: IconTrash },
];

export interface SidebarViewsProps {
  activeBoxId: string;
  boxCounts: Record<string, number>;
  accountUnreadCounts?: Record<string, number>;
  customBoxCounts?: Record<string, number>;
  accounts: AccountView[];
  customMailboxes: CustomMailbox[];
  userName: string;
  userEmail: string;
  isSyncing: boolean;
  onSelectBox: (boxId: string) => void;
  onOpenSettings: () => void;
  onSyncNow: () => Promise<void> | void;
  onAddAccount: () => void;
  onCreateCustomMailbox: () => void;
  onDeleteCustomMailbox: (id: string) => void;
  onCompose?: () => void;
}

const getInitials = (name: string, email: string) => {
  const target = (name.trim() || email.split('@')[0] || 'U').trim();
  const parts = target.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return target.slice(0, 2).toUpperCase();
};

export const SidebarViews: React.FC<SidebarViewsProps> = ({
  activeBoxId,
  boxCounts,
  accountUnreadCounts = {},
  customBoxCounts = {},
  accounts,
  customMailboxes,
  userName,
  userEmail,
  isSyncing,
  onSelectBox,
  onOpenSettings,
  onSyncNow,
  onAddAccount,
  onCreateCustomMailbox,
  onDeleteCustomMailbox,
  onCompose,
}) => {
  const { t, language, setLanguage } = useI18n();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const initials = getInitials(userName, userEmail);
  const isMultiAccount = accounts.length > 1;

  const getBoxLabel = (id: StandardBoxId) => {
    switch (id) {
      case 'inbox':
        return isMultiAccount ? `${t('sidebar.inbox')} (All)` : t('sidebar.inbox');
      case 'starred':
        return t('sidebar.starred');
      case 'drafts':
        return t('sidebar.drafts');
      case 'sent':
        return t('sidebar.sent');
      case 'archive':
        return t('sidebar.archive');
      case 'spam':
        return t('sidebar.spam');
      case 'trash':
        return t('sidebar.trash');
      default:
        return id;
    }
  };

  return (
    <aside className="tinta-sidebar" aria-label={t('sidebar.inbox')}>
      {/* Topo: Nome da App Kwrl + Seletor de Idioma Rápido */}
      <div className="tinta-sidebar-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button
          type="button"
          className="tinta-brand-btn"
          onClick={() => void onSyncNow()}
          title={isSyncing ? t('common.syncing') : `${t('common.syncNow')} (Kwrl)`}
        >
          <span className="tinta-sidebar-brand">Kwrl</span>
          {isSyncing && (
            <span className="tinta-syncing-indicator" title={t('common.syncing')}>
              •
            </span>
          )}
        </button>

        {/* Quick Language Toggle Pill */}
        <button
          type="button"
          onClick={() => {
            const nextMap: Record<string, 'en' | 'pt' | 'fr' | 'es'> = {
              en: 'pt',
              pt: 'fr',
              fr: 'es',
              es: 'en',
            };
            setLanguage(nextMap[language] || 'en');
          }}
          title={`${t('common.language')}: ${language.toUpperCase()} (Click to change)`}
          style={{
            background: 'var(--fill)',
            border: '1px solid var(--line)',
            borderRadius: '4px',
            padding: '2px 6px',
            fontSize: '10px',
            fontWeight: 600,
            color: 'var(--ink-secondary)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          {language.toUpperCase()}
        </button>
      </div>

      {/* Botão de Compor Novo E-mail */}
      <div style={{ padding: '0 12px 10px 12px' }}>
        <button
          type="button"
          onClick={onCompose}
          className="tinta-compose-trigger-btn"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            backgroundColor: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            color: 'var(--color-text)',
            fontSize: '12px',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'background-color 0.15s ease, border-color 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-accent, #a78bfa)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border)';
          }}
          title={`${t('sidebar.compose')} (C)`}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconEdit size={14} />
            <span>{t('sidebar.compose')}</span>
          </div>
          <span
            style={{
              fontSize: '10px',
              color: 'var(--color-muted)',
              border: '1px solid var(--color-border)',
              borderRadius: '4px',
              padding: '1px 5px',
            }}
          >
            C
          </span>
        </button>
      </div>

      {/* Secção 1: Caixas Padrão e Entrada Unificada */}
      <div className="tinta-sidebar-section">
        <div className="tinta-sidebar-label">{t('sidebar.inbox')}</div>
        <nav className="tinta-sidebar-nav" aria-label="Lista de caixas principais">
          {/* Caixa de Entrada Principal (Todas as Caixas se > 1 conta) */}
          <button
            type="button"
            className={`tinta-nav-item ${activeBoxId === 'inbox' ? 'tinta-nav-item--active' : ''}`}
            onClick={() => onSelectBox('inbox')}
          >
            <span
              className="tinta-nav-icon"
              style={{ color: activeBoxId === 'inbox' ? 'var(--acc)' : 'var(--mute)' }}
            >
              <IconInbox size={16} />
            </span>
            <span className="tinta-nav-label">
              {getBoxLabel('inbox')}
            </span>
            {(boxCounts['inbox'] ?? 0) > 0 && (
              <span className="tinta-nav-count">{boxCounts['inbox']}</span>
            )}
          </button>

          {/* Sub-itens para cada conta individual quando há múltiplos e-mails */}
          {isMultiAccount &&
            accounts.map((acc) => {
              const boxKey = `account:${acc.email}`;
              const isActive = activeBoxId === boxKey;
              const unread = accountUnreadCounts[acc.email.toLowerCase()] ?? 0;
              const label = acc.label || acc.email.split('@')[0];

              return (
                <button
                  key={acc.email}
                  type="button"
                  className={`tinta-nav-item ${isActive ? 'tinta-nav-item--active' : ''}`}
                  style={{ paddingLeft: '28px', fontSize: '12px' }}
                  onClick={() => onSelectBox(boxKey)}
                  title={`Entrada de: ${acc.email}`}
                >
                  <span
                    className="tinta-nav-icon"
                    style={{ color: isActive ? 'var(--acc)' : 'var(--mute)' }}
                  >
                    <IconMail size={13} />
                  </span>
                  <span
                    className="tinta-nav-label"
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </span>
                  {unread > 0 && <span className="tinta-nav-count">{unread}</span>}
                </button>
              );
            })}

          {/* Restantes caixas padrão */}
          {MAILBOXES.filter((b) => b.id !== 'inbox').map((box) => {
            const isActive = box.id === activeBoxId;
            const count = boxCounts[box.id] ?? 0;
            const Icon = box.icon;

            return (
              <button
                key={box.id}
                type="button"
                className={`tinta-nav-item ${isActive ? 'tinta-nav-item--active' : ''}`}
                onClick={() => onSelectBox(box.id)}
              >
                <span
                  className="tinta-nav-icon"
                  style={{ color: isActive ? 'var(--acc)' : 'var(--mute)' }}
                >
                  <Icon size={16} />
                </span>
                <span className="tinta-nav-label">{getBoxLabel(box.id)}</span>
                {count > 0 && <span className="tinta-nav-count">{count}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Secção 2: As Minhas Caixas (Caixas Personalizadas com Contas Selecionadas) */}
      <div className="tinta-sidebar-section" style={{ marginTop: '16px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingRight: '6px',
          }}
        >
          <div className="tinta-sidebar-label">{t('sidebar.customViews')}</div>
          <button
            type="button"
            onClick={onCreateCustomMailbox}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--mute)',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: 'var(--radius-sm, 4px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--ink)';
              e.currentTarget.style.backgroundColor = 'var(--hov)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--mute)';
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title={t('sidebar.newCustomView')}
            aria-label={t('sidebar.newCustomView')}
          >
            <IconPlus size={12} />
          </button>
        </div>

        <nav className="tinta-sidebar-nav" aria-label="Caixas personalizadas">
          {customMailboxes.map((box) => {
            const boxKey = `custom:${box.id}`;
            const isActive = activeBoxId === boxKey;
            const count = customBoxCounts[box.id] ?? 0;

            return (
              <div
                key={box.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  position: 'relative',
                }}
                className="tinta-custom-box-row"
              >
                <button
                  type="button"
                  className={`tinta-nav-item ${isActive ? 'tinta-nav-item--active' : ''}`}
                  style={{ flex: 1, paddingRight: '28px' }}
                  onClick={() => onSelectBox(boxKey)}
                  title={`${box.name} (${box.accountEmails.join(', ')})`}
                >
                  <span
                    className="tinta-nav-icon"
                    style={{ color: isActive ? 'var(--acc)' : 'var(--mute)' }}
                  >
                    <IconFolder size={15} />
                  </span>
                  <span className="tinta-nav-label">{box.name}</span>
                  {count > 0 && <span className="tinta-nav-count">{count}</span>}
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Eliminar a caixa "${box.name}"?`)) {
                      onDeleteCustomMailbox(box.id);
                    }
                  }}
                  className="tinta-custom-box-delete-btn"
                  title={`Eliminar caixa ${box.name}`}
                  style={{
                    position: 'absolute',
                    right: '6px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: 'var(--mute)',
                    cursor: 'pointer',
                    padding: '2px',
                    borderRadius: '4px',
                    opacity: 0.6,
                  }}
                >
                  <IconClose size={11} />
                </button>
              </div>
            );
          })}
        </nav>
      </div>

      <div className="tinta-sidebar-spacer" />

      {/* Popover / Menu de Contas (quando aberto) */}
      {accountMenuOpen && (
        <div
          ref={accountMenuRef}
          style={{
            margin: '0 10px 8px 10px',
            backgroundColor: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-lg)',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            zIndex: 100,
          }}
        >
          <div
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--faint)',
              padding: '2px 6px',
            }}
          >
            {t('sidebar.accounts').toUpperCase()} ({accounts.length})
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {accounts.map((acc) => (
              <div
                key={acc.email}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '4px 6px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  backgroundColor: 'var(--fill)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                  <span style={{ color: 'var(--acc)', fontSize: '12px' }}>•</span>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--ink)',
                      fontWeight: 500,
                    }}
                    title={acc.email}
                  >
                    {acc.email}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div style={{ height: '1px', backgroundColor: 'var(--line)', margin: '4px 0' }} />

          <button
            type="button"
            className="tinta-btn-secondary"
            style={{
              fontSize: '11.5px',
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              width: '100%',
            }}
            onClick={() => {
              setAccountMenuOpen(false);
              onAddAccount();
            }}
          >
            <IconPlus size={12} />
            <span>+ {t('sidebar.addAccount')}</span>
          </button>
        </div>
      )}

      {/* Rodapé da Sidebar: Bloco de Utilizador e Contas */}
      <footer className="tinta-sidebar-footer">
        <div
          className="tinta-sidebar-user-block"
          style={{ cursor: 'pointer' }}
          onClick={() => setAccountMenuOpen(!accountMenuOpen)}
          title={t('sidebar.accounts')}
        >
          <div className="tinta-avatar-sidebar">{initials}</div>
          <div className="tinta-sidebar-user-info">
            <span className="tinta-sidebar-user-name" title={userName || userEmail}>
              {isMultiAccount ? `${accounts.length} ${t('sidebar.accounts').toLowerCase()}` : (userName || userEmail.split('@')[0])}
            </span>
            <span className="tinta-sidebar-user-email" title={userEmail}>
              {userEmail}
            </span>
          </div>
        </div>

        <button
          type="button"
          className="tinta-sidebar-settings-btn"
          onClick={onOpenSettings}
          title={t('sidebar.settings')}
          aria-label={t('sidebar.settings')}
        >
          <IconSliders size={15} />
        </button>
      </footer>
    </aside>
  );
};

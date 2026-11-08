import React, { useEffect, useRef, useState } from 'react';
import { AccountView, CustomMailbox } from '../types/kwrl';
import { IconClose, IconFolder, IconMail } from './Icons';
import { useI18n } from '../i18n';

interface CustomMailboxModalProps {
  open: boolean;
  accounts: AccountView[];
  initialMailbox?: CustomMailbox | null;
  onClose: () => void;
  onSave: (name: string, accountEmails: string[]) => void;
}

export const CustomMailboxModal: React.FC<CustomMailboxModalProps> = ({
  open,
  accounts,
  initialMailbox,
  onClose,
  onSave,
}) => {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const overlayMouseDownRef = useRef(false);

  useEffect(() => {
    if (initialMailbox) {
      setName(initialMailbox.name);
      setSelectedEmails(initialMailbox.accountEmails);
    } else {
      setName('');
      // Por omissão, seleciona a primeira conta se houver
      setSelectedEmails(accounts.length > 0 ? [accounts[0].email] : []);
    }
    setError(null);
  }, [initialMailbox, accounts, open]);

  if (!open) return null;

  const toggleAccount = (email: string) => {
    setSelectedEmails((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]
    );
  };

  const handleSelectAll = () => {
    if (selectedEmails.length === accounts.length) {
      setSelectedEmails([]);
    } else {
      setSelectedEmails(accounts.map((a) => a.email));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setError(t('customMailbox.errorNameRequired'));
      return;
    }
    if (selectedEmails.length === 0) {
      setError(t('customMailbox.errorAccountRequired'));
      return;
    }
    onSave(cleanName, selectedEmails);
    onClose();
  };

  const handleOverlayMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    overlayMouseDownRef.current = e.target === e.currentTarget;
  };

  const handleOverlayMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (overlayMouseDownRef.current && e.target === e.currentTarget) {
      onClose();
    }
    overlayMouseDownRef.current = false;
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '16px',
      }}
      onMouseDown={handleOverlayMouseDown}
      onMouseUp={handleOverlayMouseUp}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '460px',
          backgroundColor: 'var(--bg)',
          borderRadius: 'var(--radius-xl)',
          border: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabeçalho */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--acc)' }}>
              <IconFolder size={18} />
            </span>
            <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--ink)' }}>
              {initialMailbox ? t('customMailbox.titleEdit') : t('customMailbox.titleNew')}
            </span>
          </div>

          <button
            type="button"
            className="tinta-toolbar-btn"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <IconClose size={14} />
          </button>
        </header>

        {/* Formulário */}
        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Nome da Caixa */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)' }}>
              {t('customMailbox.nameLabel')}
            </label>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder={t('customMailbox.namePlaceholder')}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: '13px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--line)',
                backgroundColor: 'var(--fill)',
                color: 'var(--ink)',
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
              }}
            />
          </div>

          {/* Seleção de Contas */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)' }}>
                {t('customMailbox.accountsLabel')} ({selectedEmails.length}/{accounts.length})
              </label>
              {accounts.length > 1 && (
                <button
                  type="button"
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '11px',
                    color: 'var(--acc)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                  onClick={handleSelectAll}
                >
                  {selectedEmails.length === accounts.length ? t('emailList.deselectAll') : t('customMailbox.selectAllAccounts')}
                </button>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                maxHeight: '180px',
                overflowY: 'auto',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-lg)',
                padding: '6px',
                backgroundColor: 'var(--fill)',
              }}
            >
              {accounts.length === 0 ? (
                <span style={{ fontSize: '12px', color: 'var(--mute)', padding: '8px' }}>
                  {t('settings.noAccounts')}
                </span>
              ) : (
                accounts.map((acc) => {
                  const isChecked = selectedEmails.includes(acc.email);
                  return (
                    <label
                      key={acc.email}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 8px',
                        borderRadius: 'var(--radius-md, 6px)',
                        backgroundColor: isChecked ? 'var(--bg)' : 'transparent',
                        border: isChecked ? '1px solid var(--line)' : '1px solid transparent',
                        cursor: 'pointer',
                        transition: 'background-color var(--duration-fast)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleAccount(acc.email)}
                          style={{
                            accentColor: 'var(--acc)',
                            cursor: 'pointer',
                            width: '15px',
                            height: '15px',
                          }}
                        />
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: '12.5px', fontWeight: isChecked ? 600 : 500, color: 'var(--ink)' }}>
                            {acc.email}
                          </span>
                          {acc.label && acc.label !== acc.email.split('@')[0] && (
                            <span style={{ fontSize: '11px', color: 'var(--mute)' }}>
                              {acc.label}
                            </span>
                          )}
                        </div>
                      </div>

                      <span style={{ color: 'var(--mute)' }}>
                        <IconMail size={14} />
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {error && (
            <div style={{ fontSize: '12px', color: '#dc2626' }}>
              {error}
            </div>
          )}

          {/* Rodapé com Botões */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '8px',
              paddingTop: '8px',
              borderTop: '1px solid var(--line)',
            }}
          >
            <button
              type="button"
              className="tinta-btn-secondary"
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="tinta-btn-primary"
              disabled={!name.trim() || selectedEmails.length === 0}
              style={{
                opacity: !name.trim() || selectedEmails.length === 0 ? 0.5 : 1,
              }}
            >
              {t('customMailbox.saveButton')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

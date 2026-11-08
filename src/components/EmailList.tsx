import React, { RefObject, useMemo } from 'react';
import { ThreadListItem } from '../types/kwrl';
import { IconFlag, IconSearch } from './Icons';
import { useI18n } from '../i18n';

export type TintaFilterMode = 'all' | 'unread' | 'starred' | 'attachments';

export interface EmailListProps {
  boxTitle: string;
  threads: ThreadListItem[];
  selectedThreadId: string | null;
  searchQuery: string;
  filterMode: TintaFilterMode;
  starredThreadIds: Set<string>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  showAccountBadge?: boolean;
  selectedThreadIds?: Set<string>;
  onToggleSelectThread?: (threadId: string) => void;
  onClearSelection?: () => void;
  onBulkArchive?: () => void;
  onBulkTrash?: () => void;
  onBulkMarkRead?: (read: boolean) => void;
  onSearchChange: (query: string) => void;
  onFilterModeChange: (mode: TintaFilterMode) => void;
  onSelectThread: (threadId: string) => void;
}

function getInitials(name: string, email: string): string {
  const target = (name.trim() || email.split('@')[0] || 'U').trim();
  const parts = target.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return target.slice(0, 2).toUpperCase();
}

interface ThreadCardProps {
  thread: ThreadListItem;
  isSelected: boolean;
  isStarred: boolean;
  isChecked: boolean;
  showAccountBadge: boolean;
  hasSelectionHandler: boolean;
  onSelectThread: (threadId: string) => void;
  onToggleSelectThread?: (threadId: string) => void;
}

const ThreadCard = React.memo<ThreadCardProps>(({
  thread,
  isSelected,
  isStarred,
  isChecked,
  showAccountBadge,
  hasSelectionHandler,
  onSelectThread,
  onToggleSelectThread,
}) => {
  const { t } = useI18n();
  const initials = useMemo(
    () => getInitials(thread.fromName, thread.fromEmail),
    [thread.fromName, thread.fromEmail]
  );

  return (
    <div className="tinta-thread-item-wrapper">
      <button
        type="button"
        className={`tinta-thread-card ${
          isSelected ? 'tinta-thread-card--selected' : ''
        }`}
        onClick={() => onSelectThread(thread.id)}
      >
        {/* Ponto de não lido (7px) */}
        <div className="tinta-unread-slot">
          {thread.unread && (
            <span
              className={`tinta-unread-dot ${
                isSelected ? 'tinta-unread-dot--selected' : ''
              }`}
            />
          )}
        </div>

        {/* Checkbox de Seleção Múltipla */}
        {hasSelectionHandler && onToggleSelectThread && (
          <div
            onClick={(e) => {
              e.stopPropagation();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: '6px',
            }}
          >
            <input
              type="checkbox"
              checked={isChecked}
              onChange={(e) => {
                e.stopPropagation();
                onToggleSelectThread(thread.id);
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
              aria-label={`${t('emailList.selectAll')} ${thread.fromName || thread.fromEmail}`}
              style={{
                cursor: 'pointer',
                accentColor: 'var(--color-accent, #a78bfa)',
              }}
            />
          </div>
        )}

        {/* Avatar (34px) */}
        <div
          className={`tinta-avatar-list ${
            isSelected ? 'tinta-avatar-list--selected' : ''
          }`}
        >
          {initials}
        </div>

        {/* 3 linhas de conteúdo */}
        <div className="tinta-thread-lines">
          {/* Linha 1: Remetente + Conta + Hora */}
          <div className="tinta-thread-line-1">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
              <span
                className={
                  isSelected
                    ? 'tinta-sender-selected'
                    : thread.unread
                    ? 'tinta-sender-unread'
                    : 'tinta-sender-read'
                }
              >
                {thread.fromName || thread.fromEmail.split('@')[0]}
              </span>
              {showAccountBadge && thread.accountEmail && (
                <span
                  style={{
                    fontSize: '9.5px',
                    fontWeight: 500,
                    padding: '0 4px',
                    borderRadius: '3px',
                    backgroundColor: isSelected ? 'rgba(255,255,255,0.22)' : 'var(--fill)',
                    color: isSelected ? '#ffffff' : 'var(--faint)',
                    border: isSelected ? 'none' : '1px solid var(--line)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: '85px',
                    lineHeight: '14px',
                  }}
                  title={thread.accountEmail}
                >
                  {thread.accountLabel || thread.accountEmail.split('@')[0]}
                </span>
              )}
            </div>
            <span
              className={`tinta-time ${isSelected ? 'tinta-time--selected' : ''}`}
            >
              {thread.displayDate}
            </span>
          </div>

          {/* Linha 2: Assunto + Anexo / Bandeira */}
          <div className="tinta-thread-line-2">
            <span
              className={`tinta-subject-list ${
                isSelected ? 'tinta-subject-list--selected' : ''
              }`}
            >
              {thread.subject || t('emailList.noSubject')}
            </span>
            <span className="tinta-thread-badges">
              {isStarred && (
                <span
                  className={`tinta-flag-badge ${
                    isSelected ? 'tinta-flag-badge--selected' : ''
                  }`}
                  title={t('emailList.star')}
                >
                  <IconFlag size={12} />
                </span>
              )}
            </span>
          </div>

          {/* Linha 3: Pré-visualização de 1 linha */}
          <div className="tinta-thread-line-3">
            <span
              className={`tinta-preview-list ${
                isSelected ? 'tinta-preview-list--selected' : ''
              }`}
            >
              {thread.snippet || t('emailList.noSnippet')}
            </span>
          </div>
        </div>
      </button>
    </div>
  );
});
ThreadCard.displayName = 'ThreadCard';

export const EmailList: React.FC<EmailListProps> = ({
  boxTitle,
  threads,
  selectedThreadId,
  searchQuery,
  filterMode,
  starredThreadIds,
  searchInputRef,
  showAccountBadge = false,
  selectedThreadIds,
  onToggleSelectThread,
  onClearSelection,
  onBulkArchive,
  onBulkTrash,
  onBulkMarkRead,
  onSearchChange,
  onFilterModeChange,
  onSelectThread,
}) => {
  const { t } = useI18n();

  const unreadCount = useMemo(() => {
    let count = 0;
    for (let i = 0; i < threads.length; i++) {
      if (threads[i].unread) count++;
    }
    return count;
  }, [threads]);

  const filteredThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return threads.filter((t) => {
      if (filterMode === 'unread' && !t.unread) return false;
      if (filterMode === 'starred' && !starredThreadIds.has(t.id)) return false;
      if (filterMode === 'attachments') {
        const text = (t.snippet + ' ' + t.subject).toLowerCase();
        const hasAtt =
          text.includes('.pdf') ||
          text.includes('.png') ||
          text.includes('.jpg') ||
          text.includes('anexo') ||
          text.includes('ficheiro') ||
          text.includes('attachment') ||
          text.includes('pièce') ||
          text.includes('adjunto');
        if (!hasAtt) return false;
      }
      if (q) {
        const matchSubject = t.subject.toLowerCase().includes(q);
        const matchSender =
          t.fromName.toLowerCase().includes(q) || t.fromEmail.toLowerCase().includes(q);
        const matchSnippet = t.snippet.toLowerCase().includes(q);
        if (!matchSubject && !matchSender && !matchSnippet) return false;
      }
      return true;
    });
  }, [threads, filterMode, starredThreadIds, searchQuery]);

  // Agrupamento temporal calculado num único ciclo linear O(N) sem recriar Date() por item
  const grouped = useMemo(() => {
    if (filteredThreads.length === 0) return [];

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86400000;
    const startOfWeek = startOfToday - ((now.getDay() + 6) % 7) * 86400000;

    const hoje: ThreadListItem[] = [];
    const ontem: ThreadListItem[] = [];
    const estaSemana: ThreadListItem[] = [];
    const maisAntigos: ThreadListItem[] = [];

    for (let i = 0; i < filteredThreads.length; i++) {
      const item = filteredThreads[i];
      const time = item.internalDateMs || 0;
      if (time >= startOfToday) {
        hoje.push(item);
      } else if (time >= startOfYesterday) {
        ontem.push(item);
      } else if (time >= startOfWeek) {
        estaSemana.push(item);
      } else {
        maisAntigos.push(item);
      }
    }

    const groups: { group: string; items: ThreadListItem[] }[] = [];
    if (hoje.length > 0) groups.push({ group: t('emailList.groupToday'), items: hoje });
    if (ontem.length > 0) groups.push({ group: t('emailList.groupYesterday'), items: ontem });
    if (estaSemana.length > 0) groups.push({ group: t('emailList.groupThisWeek'), items: estaSemana });
    if (maisAntigos.length > 0) groups.push({ group: t('emailList.groupOlder'), items: maisAntigos });
    return groups;
  }, [filteredThreads, t]);

  const hasSelection = Boolean(selectedThreadIds && selectedThreadIds.size > 0);

  return (
    <section className="tinta-list-pane" aria-label={t('sidebar.inbox')}>
      {/* Cabeçalho da Lista */}
      <div className="tinta-list-header">
        <div className="tinta-list-title-row">
          <h1 className="tinta-title-list">{boxTitle}</h1>
          <span className="tinta-meta-mute">
            {unreadCount} {t('emailList.unreadCountBadge')}
          </span>
        </div>

        {/* Campo de pesquisa */}
        <div className="tinta-search-wrapper">
          <span className="tinta-search-icon">
            <IconSearch size={14} />
          </span>
          <input
            ref={searchInputRef}
            type="search"
            className="tinta-search-input"
            placeholder={t('common.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label={t('common.searchPlaceholder')}
          />
        </div>

        {/* Controlo segmentado */}
        <div className="tinta-segmented-filter" role="tablist">
          <button
            type="button"
            className={`tinta-filter-btn ${filterMode === 'all' ? 'tinta-filter-btn--active' : ''}`}
            onClick={() => onFilterModeChange('all')}
          >
            {t('emailList.filterAll')}
          </button>
          <button
            type="button"
            className={`tinta-filter-btn ${filterMode === 'unread' ? 'tinta-filter-btn--active' : ''}`}
            onClick={() => onFilterModeChange('unread')}
          >
            {t('emailList.filterUnread')}
          </button>
          <button
            type="button"
            className={`tinta-filter-btn ${filterMode === 'starred' ? 'tinta-filter-btn--active' : ''}`}
            onClick={() => onFilterModeChange('starred')}
          >
            {t('emailList.filterStarred')}
          </button>
          <button
            type="button"
            className={`tinta-filter-btn ${filterMode === 'attachments' ? 'tinta-filter-btn--active' : ''}`}
            onClick={() => onFilterModeChange('attachments')}
          >
            {t('emailList.filterAttachments')}
          </button>
        </div>
      </div>

      {/* Barra de Ações em Massa (quando há seleção) */}
      {hasSelection && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 14px',
            backgroundColor: 'var(--color-surface)',
            borderBottom: '1px solid var(--color-border)',
            fontSize: '11px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>
              {t('emailList.selectedCount', { count: selectedThreadIds!.size })}
            </span>
            {onClearSelection && (
              <button
                type="button"
                onClick={onClearSelection}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-muted)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                {t('emailList.clearSelection')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {onBulkMarkRead && (
              <button
                type="button"
                onClick={() => onBulkMarkRead(true)}
                style={{
                  padding: '3px 8px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-border)',
                  background: 'transparent',
                  color: 'var(--color-text)',
                  cursor: 'pointer',
                  fontSize: '11px',
                }}
                title={t('emailList.markRead')}
              >
                {t('emailList.markRead')}
              </button>
            )}
            {onBulkArchive && (
              <button
                type="button"
                onClick={onBulkArchive}
                style={{
                  padding: '3px 8px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-border)',
                  background: 'transparent',
                  color: 'var(--color-text)',
                  cursor: 'pointer',
                  fontSize: '11px',
                }}
                title={t('emailList.archiveAction')}
              >
                {t('emailList.archiveAction')}
              </button>
            )}
            {onBulkTrash && (
              <button
                type="button"
                onClick={onBulkTrash}
                style={{
                  padding: '3px 8px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-border)',
                  background: 'transparent',
                  color: 'var(--color-text)',
                  cursor: 'pointer',
                  fontSize: '11px',
                }}
                title={t('emailList.moveToTrash')}
              >
                {t('emailList.moveToTrash')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Lista com scroll e agrupamento temporal */}
      <div className="tinta-list-scroll-area">
        {grouped.length === 0 ? (
          <div className="tinta-list-empty">
            <span className="tinta-meta-mute">{t('emailList.noMessages')}</span>
          </div>
        ) : (
          grouped.map(({ group, items }) => (
            <div key={group} className="tinta-group-wrapper">
              <div className="tinta-group-header-row">
                <span className="tinta-group-header">{group}</span>
              </div>
              <div className="tinta-group-items">
                {items.map((thread) => {
                  const isSelected = thread.id === selectedThreadId;
                  const isStarred = starredThreadIds.has(thread.id);
                  const isChecked = selectedThreadIds?.has(thread.id) ?? false;

                  return (
                    <ThreadCard
                      key={thread.id}
                      thread={thread}
                      isSelected={isSelected}
                      isStarred={isStarred}
                      isChecked={isChecked}
                      showAccountBadge={showAccountBadge}
                      hasSelectionHandler={Boolean(onToggleSelectThread)}
                      onSelectThread={onSelectThread}
                      onToggleSelectThread={onToggleSelectThread}
                    />
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
};

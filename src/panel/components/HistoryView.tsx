import { Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AssistantMessage } from '../../shared/conversation';
import { PROVIDERS, modelLabel } from '../../providers/registry';
import { deleteAllConversations, deleteConversation, openConversation } from '../actions';
import { originOf, relativeTime } from '../format';
import { useStore } from '../store';
import { ProviderAvatar } from './ui';

export function HistoryView() {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeId);
  const busyIds = useStore((s) => {
    const ids: string[] = [];
    for (const [id, list] of Object.entries(s.messages)) {
      const last = list.findLast((m) => m.role === 'assistant') as AssistantMessage | undefined;
      if (last && (last.status === 'pending' || last.status === 'streaming')) ids.push(id);
    }
    return ids.join(',');
  });
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      [c.title, c.pageTitle, c.pageUrl, c.targetLabel].some((field) => field?.toLowerCase().includes(q)),
    );
  }, [conversations, query]);

  return (
    <section className="view history" aria-label="대화 기록">
      <div className="view-head">
        <h2>기록</h2>
        <span className="muted">{conversations.length}개</span>
      </div>
      <label className="search">
        <Search size={14} aria-hidden="true" />
        <input type="search" placeholder="질문·페이지·요소로 찾기" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {filtered.length === 0 ? (
        <p className="muted empty-history">{conversations.length === 0 ? '아직 저장된 분석이 없습니다.' : '찾는 대화가 없습니다.'}</p>
      ) : (
        <ul className="history-list">
          {filtered.map((conversation) => (
            <li key={conversation.id} className={conversation.id === activeId ? 'is-active' : ''}>
              <button type="button" className="history-item" onClick={() => void openConversation(conversation.id)}>
                <span className="history-title">{conversation.title}</span>
                <span className="history-meta">
                  <ProviderAvatar provider={conversation.provider} />
                  {PROVIDERS[conversation.provider].shortLabel} · {modelLabel(conversation.provider, conversation.model)}
                  {conversation.pageUrl && ` · ${originOf(conversation.pageUrl)}`}
                </span>
                <span className="history-meta">
                  {conversation.targetLabel && <code>{conversation.targetLabel}</code>}
                  <span>{relativeTime(conversation.updatedAt)}</span>
                  {busyIds.split(',').includes(conversation.id) && <span className="badge">생성 중</span>}
                </span>
              </button>
              <button
                type="button"
                className="icon-btn history-delete"
                aria-label={`"${conversation.title}" 삭제`}
                title="삭제"
                onClick={() => {
                  if (window.confirm('이 대화와 함께 저장된 수집 자료(스냅샷)도 삭제합니다. 계속할까요?')) {
                    void deleteConversation(conversation.id);
                  }
                }}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {conversations.length > 0 && (
        <div className="view-foot">
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => {
              if (window.confirm(`대화 ${conversations.length}개와 수집 자료를 모두 삭제합니다. 되돌릴 수 없습니다.`)) {
                void deleteAllConversations();
              }
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            <span className="btn-label">모든 기록 삭제</span>
          </button>
        </div>
      )}
    </section>
  );
}

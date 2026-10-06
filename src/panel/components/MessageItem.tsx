import { Check, Copy, FileSearch, KeyRound, Paperclip, RotateCcw, TriangleAlert } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { validateCitations } from '../../shared/citations';
import type { AssistantMessage, UserMessage } from '../../shared/conversation';
import { getTarget, type StoredSnapshot } from '../../shared/snapshot';
import { modelLabel } from '../../providers/registry';
import { cancel, openPreview, retry, setView } from '../actions';
import { STATUS_LABEL, interruptText, timingText, usageText } from '../format';
import { useStore } from '../store';
import { FindingsCard } from './Findings';
import { Markdown, type CitationTarget } from './Markdown';

export const UserMessageView = memo(function UserMessageView({ message }: { message: UserMessage }) {
  const snapshot = useStore((s) => (message.snapshotId ? s.snapshots[message.snapshotId] : undefined));
  const target = snapshot ? getTarget(snapshot) : null;
  return (
    <div className="msg msg-user">
      <div className="bubble">{message.text}</div>
      {snapshot && target && (
        <div className="msg-attachment">
          <button type="button" className="attach-chip" onClick={() => openPreview(snapshot.id)} title="보낸 자료 보기">
            <Paperclip size={12} aria-hidden="true" />
            <code>{target.label}</code>
            <span className="attach-chip-meta">요소 {snapshot.elements.length - snapshot.exclusions.elementIds.length}개</span>
          </button>
          <FindingsCard snapshot={snapshot} title="이 질문에 첨부한 기본 검사" />
        </div>
      )}
    </div>
  );
});

function useCitationMap(conversationId: string, replyTo: string): Map<string, CitationTarget> {
  const messages = useStore((s) => s.messages[conversationId]);
  const snapshots = useStore((s) => s.snapshots);
  return useMemo(() => {
    const map = new Map<string, CitationTarget>();
    for (const message of messages ?? []) {
      if (message.role === 'user' && message.snapshotId) {
        const snapshot: StoredSnapshot | undefined = snapshots[message.snapshotId];
        if (snapshot) {
          const excluded = new Set(snapshot.exclusions.elementIds);
          for (const el of snapshot.elements) {
            if (!excluded.has(el.id)) map.set(el.id, { snapshotId: snapshot.id, label: el.label });
          }
        }
      }
      if (message.id === replyTo) break;
    }
    return map;
  }, [messages, snapshots, replyTo]);
}

function ErrorBox({ message, isLast }: { message: AssistantMessage; isLast: boolean }) {
  const error = message.error;
  const needsSettings = error?.kind === 'auth' || error?.kind === 'missing_key' || error?.kind === 'permission';
  return (
    <div className={`msg-notice notice-${message.status}`} role={message.status === 'error' ? 'alert' : undefined}>
      <TriangleAlert size={14} aria-hidden="true" />
      <div className="msg-notice-body">
        {message.status === 'cancelled' && <p>사용자가 응답 생성을 중단했습니다. {message.text ? '받은 부분까지 저장했습니다.' : ''}</p>}
        {message.status === 'interrupted' && <p>{interruptText(message)}</p>}
        {message.status === 'error' && <p>{error?.message ?? '오류가 발생했습니다.'}</p>}
        {error?.retryAfterSec !== undefined && <p className="muted">약 {error.retryAfterSec}초 뒤에 다시 시도하세요.</p>}
        <div className="msg-notice-actions">
          {needsSettings && (
            <button type="button" className="chip-btn" onClick={() => setView('settings')}>
              <KeyRound size={13} aria-hidden="true" /> 설정 열기
            </button>
          )}
          {isLast && error?.kind !== 'consent_required' && (
            <button type="button" className="chip-btn" onClick={() => void retry(message.conversationId, message.id)}>
              <RotateCcw size={13} aria-hidden="true" /> 다시 시도
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="msg-action"
      onClick={() => void navigator.clipboard.writeText(text).then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      })}
      aria-label="답변 복사"
      title="답변 복사"
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

export const AssistantMessageView = memo(function AssistantMessageView({
  message,
  isLast,
  superseded,
}: {
  message: AssistantMessage;
  isLast: boolean;
  superseded: boolean;
}) {
  const phase = useStore((s) => s.phases[message.id]);
  const citations = useCitationMap(message.conversationId, message.replyTo);
  const check = useMemo(() => validateCitations(message.text, new Set(citations.keys())), [message.text, citations]);
  // 새 시도가 생기면 이전 시도는 접는다. 사용자가 펼친 경우만 그대로 둔다.
  const [expanded, setExpanded] = useState(false);
  const active = message.status === 'pending' || message.status === 'streaming';

  if (superseded && !expanded) {
    return (
      <div className="msg msg-assistant is-superseded">
        <button type="button" className="superseded-toggle" onClick={() => setExpanded(true)}>
          이전 시도 · {STATUS_LABEL[message.status]} · {modelLabel(message.provider, message.model)} — 펼치기
        </button>
      </div>
    );
  }

  const usage = usageText(message);
  const timing = timingText(message);

  return (
    <article className={`msg msg-assistant status-${message.status}`} aria-busy={active}>
      <header className="msg-head">
        <span className={`provider-dot provider-${message.provider}`} aria-hidden="true" />
        <span className="msg-model">{modelLabel(message.provider, message.model)}</span>
        {message.mock && <span className="badge badge-warn">모의 응답 · 실제 모델 아님</span>}
        {message.status !== 'complete' && <span className={`status-tag status-tag-${message.status}`}>{STATUS_LABEL[message.status]}</span>}
        {message.stopReason === 'max_tokens' && <span className="status-tag status-tag-cancelled">출력 한도로 잘림</span>}
      </header>
      {message.text ? (
        <Markdown text={message.text} citations={citations} />
      ) : (
        active && (
          <p className="msg-waiting">
            <span className="dots" aria-hidden="true" />
            {phase === 'thinking' ? '모델이 추론하는 중' : phase === 'connected' || phase === 'writing' ? '응답을 받는 중' : '연결하는 중'}
          </p>
        )
      )}
      {message.status === 'streaming' && message.text && <span className="cursor" aria-hidden="true" />}
      {(message.status === 'cancelled' || message.status === 'interrupted' || message.status === 'error') && (
        <ErrorBox message={message} isLast={isLast} />
      )}
      {!active && (
        <footer className="msg-foot">
          {check.cited.length > 0 && (
            <span className={`cite-check ${check.unknown.length ? 'has-unknown' : ''}`}>
              <FileSearch size={12} aria-hidden="true" /> 근거 {check.valid.length}개 확인
              {check.unknown.length > 0 && ` · 수집 자료에 없는 식별자 ${check.unknown.length}개(${check.unknown.join(', ')})`}
            </span>
          )}
          {usage && <span>{usage}</span>}
          {timing && <span>{timing}</span>}
          {message.text && <CopyAnswer text={message.text} />}
        </footer>
      )}
      {active && (
        <div className="msg-stop-row">
          <button type="button" className="chip-btn" onClick={() => cancel(message.conversationId)}>
            중단
          </button>
        </div>
      )}
    </article>
  );
});

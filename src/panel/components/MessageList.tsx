/**
 * 대화 본문. 사용자가 맨 아래 근처에 있을 때만 새 내용에 맞춰 내려가고,
 * 위쪽을 읽는 중이면 위치를 그대로 두고 '최신 답변으로' 버튼만 보여 준다.
 */
import { ArrowDown, Crosshair } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AssistantMessage } from '../../shared/conversation';
import { providerReady, setView, startPicking } from '../actions';
import { draftKey, useStore } from '../store';
import { FindingsCard } from './Findings';
import { AssistantMessageView, UserMessageView } from './MessageItem';

const STICK_THRESHOLD = 56;

function EmptyGuide() {
  const access = useStore((s) => s.tab.access);
  const hasKey = useStore((s) => providerReady(s, s.activeId ? s.conversations.find((c) => c.id === s.activeId)?.provider ?? s.newChat.provider : s.newChat.provider));
  const picking = useStore((s) => s.picker.status !== 'idle');
  return (
    <div className="empty-guide">
      <h2>궁금한 요소를 골라 질문하세요</h2>
      <ol>
        <li>
          아래 <strong>요소 선택</strong>을 누릅니다.
        </li>
        <li>
          페이지에서 문제가 보이는 요소를 클릭합니다. <kbd>↑</kbd>로 부모 요소, <kbd>Esc</kbd>로 취소.
        </li>
        <li>무엇이 이상한지 질문합니다. 선택한 요소의 실제 스타일과 크기를 근거로 답합니다.</li>
      </ol>
      <p className="empty-examples">예: “이 텍스트가 왜 말줄임되지 않을까?”, “이 요소 때문에 가로 스크롤이 생길까?”</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-primary btn-md" onClick={() => void startPicking()} disabled={picking || access === 'restricted'}>
          <Crosshair size={15} aria-hidden="true" />
          <span className="btn-label">요소 선택</span>
        </button>
      </div>
      {access === 'unknown' && (
        <p className="empty-note">이 탭은 아직 접근 권한이 없습니다. 툴바의 NoodleLens 아이콘을 누르면 이 탭에서 선택할 수 있습니다.</p>
      )}
      {!hasKey && (
        <p className="empty-note">
          모델에 질문하려면 API 키가 필요합니다.{' '}
          <button type="button" className="link-btn" onClick={() => setView('settings')}>
            설정에서 키 입력
          </button>
          {' '}— 키가 없어도 요소 선택과 기본 검사는 쓸 수 있습니다.
        </p>
      )}
    </div>
  );
}

export function MessageList() {
  const activeId = useStore((s) => s.activeId);
  const messages = useStore((s) => (s.activeId ? s.messages[s.activeId] : undefined));
  const draftAttachment = useStore((s) => s.drafts[draftKey(s)]?.attachment ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setShowJump(false);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    stick.current = atBottom;
    setShowJump(!atBottom);
  };

  // 대화를 바꾸면 맨 아래에서 시작한다.
  useLayoutEffect(() => {
    scrollToBottom();
  }, [activeId, scrollToBottom]);

  // 내용 높이가 바뀌면(스트리밍·펼침) 붙어 있을 때만 따라 내려간다.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      } else {
        setShowJump(true);
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // 사용자가 새 질문을 보내면 맨 아래로 간다.
  const lastUserId = messages?.findLast((m) => m.role === 'user')?.id;
  useEffect(() => {
    if (lastUserId) scrollToBottom();
  }, [lastUserId, scrollToBottom]);

  const list = messages ?? [];
  const lastAssistantId = list.findLast((m) => m.role === 'assistant')?.id;

  return (
    <div className="messages-wrap">
      <main className="messages" ref={scrollRef} onScroll={onScroll} aria-label="대화">
        <div ref={contentRef} className="messages-inner">
          {list.length === 0 && !draftAttachment && <EmptyGuide />}
          {list.map((message, index) => {
            if (message.role === 'user') return <UserMessageView key={message.id} message={message} />;
            const next = list[index + 1] as AssistantMessage | undefined;
            const superseded = next?.role === 'assistant' && next.replyTo === message.replyTo;
            return (
              <AssistantMessageView
                key={message.id}
                message={message}
                isLast={message.id === lastAssistantId && index === list.length - 1}
                superseded={superseded}
              />
            );
          })}
          {draftAttachment && (
            <div className="draft-findings">
              <FindingsCard snapshot={draftAttachment} title="선택한 요소의 기본 검사" defaultOpen />
            </div>
          )}
        </div>
      </main>
      {showJump && (
        <button type="button" className="jump-latest" onClick={scrollToBottom}>
          <ArrowDown size={14} aria-hidden="true" /> 최신 답변으로
        </button>
      )}
    </div>
  );
}

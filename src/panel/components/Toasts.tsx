import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { dismissNotice, useStore } from '../store';

/**
 * 알림. 채팅 화면에서는 입력창 위 흐름 안(inline)에 두어 버튼을 덮지 않고,
 * 기록·설정 화면에서는 아래쪽에 띄운다(floating).
 */
export function Toasts({ placement }: { placement: 'inline' | 'floating' }) {
  const notices = useStore((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className={`toasts toasts-${placement}`} role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`toast toast-${notice.tone}`}>
          {notice.tone === 'error' ? (
            <CircleAlert size={15} className="toast-icon" aria-hidden="true" />
          ) : notice.tone === 'success' ? (
            <CircleCheck size={15} className="toast-icon" aria-hidden="true" />
          ) : (
            <Info size={15} className="toast-icon" aria-hidden="true" />
          )}
          <span className="toast-text">{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                notice.action?.run();
                dismissNotice(notice.id);
              }}
            >
              {notice.action.label}
            </button>
          )}
          <button type="button" className="toast-close" aria-label="알림 닫기" onClick={() => dismissNotice(notice.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

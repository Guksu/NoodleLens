import { X } from 'lucide-react';
import { dismissNotice, useStore } from '../store';

export function Toasts() {
  const notices = useStore((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`toast toast-${notice.tone}`}>
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

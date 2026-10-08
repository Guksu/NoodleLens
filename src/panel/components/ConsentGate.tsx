import { acceptConsent } from '../actions';
import { Logo } from './ui';

/** 첫 실행 안내. 수집·전송하는 자료를 알리고 사용자가 직접 동의해야 쓸 수 있다. 동의 버튼은 하단에 고정한다. */
export function ConsentGate() {
  return (
    <div className="app consent">
      <div className="consent-scroll">
        <div className="consent-inner">
          <div className="consent-brand">
            <Logo size={28} />
            <h1>NoodleLens</h1>
          </div>
          <p className="consent-lead">페이지 요소를 골라 레이아웃 문제를 AI에게 묻는 도구입니다. 시작하기 전에 어떤 자료를 다루는지 확인해 주세요.</p>
          <dl className="consent-list">
            <dt>요소를 선택하면</dt>
            <dd>
              그 요소와 주변 요소의 태그·클래스·일부 속성, 글 앞부분, 실제 적용된 스타일과 크기, 페이지 제목과 주소(쿼리 값 제외)를 수집해
              이 브라우저에 저장합니다.
            </dd>
            <dt>질문을 보내면</dt>
            <dd>
              질문과 위 자료를 사용자가 고른 AI 제공자(OpenAI 또는 Anthropic)에 본인 API 키로 보냅니다. 보내기 전에 ‘수집 내용’에서 확인하고
              뺄 수 있습니다. NoodleLens 개발자 서버는 없습니다.
            </dd>
            <dt>수집하지 않는 것</dt>
            <dd>입력창 값, 비밀번호, 쿠키, 편집 중인 글.</dd>
            <dt>보관과 삭제</dt>
            <dd>API 키는 이 기기에 암호화해 두거나 브라우저를 닫을 때까지만 둡니다. 대화와 수집 자료는 기록·설정에서 언제든 지울 수 있습니다.</dd>
          </dl>
        </div>
      </div>
      <div className="consent-actions">
        <button type="button" className="btn btn-primary consent-accept" onClick={() => void acceptConsent()}>
          <span className="btn-label">이해했고 동의합니다</span>
        </button>
      </div>
    </div>
  );
}

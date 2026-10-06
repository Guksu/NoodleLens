/**
 * NoodleLens service worker.
 *
 * 툴바 아이콘 클릭을 직접 받아 사이드 패널을 연다.
 * openPanelOnActionClick을 쓰면 클릭해도 activeTab이 부여되지 않기 때문에,
 * action.onClicked에서 sidePanel.open()을 await 없이 바로 호출한다(사용자 제스처 유지).
 * 이렇게 하면 클릭한 탭에 activeTab 권한이 생겨 패널이 그 탭에 요소 선택 스크립트를 주입할 수 있다.
 *
 * 모델 요청은 여기서 하지 않는다. 스트리밍은 사이드 패널 페이지가 소유한다(docs/DESIGN.md).
 */

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId === undefined) return;
  // await 없이 먼저 호출해야 사용자 제스처로 인정된다.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
    // 이미 열려 있거나 열 수 없는 창
  });
  if (tab.id !== undefined) {
    // 이미 열린 패널에 '이 탭 접근이 허용됨'을 알린다. 패널이 없으면 받는 쪽이 없어 실패한다.
    chrome.runtime
      .sendMessage({ type: 'noodlelens/action-clicked', tabId: tab.id, windowId: tab.windowId })
      .catch(() => {});
  }
});

// 세션 보관 API 키와 설정은 확장 프로그램 페이지·service worker에서만 읽을 수 있게 둔다.
// session은 기본값을 명시하는 것이고, local은 기본적으로 content script에도 열려 있어 막는다(Chrome 140+).
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

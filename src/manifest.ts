/**
 * manifest.json 생성. 권한별 용도는 docs/PRIVACY.md에 정리한다.
 *
 * - sidePanel: 사이드 패널 UI
 * - storage: 설정·세션 동안만 보관하는 API 키(chrome.storage.session)
 * - scripting + activeTab: 사용자가 툴바 아이콘을 누른 탭에만 요소 선택 스크립트를 주입
 * - optional_host_permissions: 사용자가 원할 때만 '모든 사이트에서 바로 선택'을 허용
 * - host_permissions(API 두 곳): OpenAI는 잘못된 키 등 오류 응답에 CORS 헤더를 붙이지 않아(2026-10-06 실측)
 *   CORS만으로는 오류 내용을 읽지 못하고 네트워크 오류로 보인다. 제공자 오류를 구분해 안내하려고 이 두 호스트만 요청한다.
 */
export interface ManifestOptions {
  version: string;
  mode: string;
}

const CSP = [
  "script-src 'self'",
  "object-src 'self'",
  "connect-src 'self' https://api.openai.com https://api.anthropic.com",
  "img-src 'self' data:",
  "style-src 'self'",
  "font-src 'self'",
  "media-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function buildManifest({ version, mode }: ManifestOptions) {
  const dev = mode !== 'production';
  return {
    manifest_version: 3,
    name: dev ? 'NoodleLens (dev)' : 'NoodleLens',
    short_name: 'NoodleLens',
    description: '페이지 요소를 골라 레이아웃·스타일 문제를 GPT·Claude에게 묻는 사이드 패널. 본인 API 키를 사용합니다.',
    version,
    minimum_chrome_version: '141',
    icons: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
    action: {
      default_title: 'NoodleLens 열기',
      default_icon: {
        '16': 'icons/icon-16.png',
        '32': 'icons/icon-32.png',
      },
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab'],
    host_permissions: ['https://api.openai.com/*', 'https://api.anthropic.com/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    commands: {
      _execute_action: {
        description: 'NoodleLens 열기(현재 탭 접근 허용)',
      },
    },
    content_security_policy: {
      extension_pages: CSP,
    },
  };
}

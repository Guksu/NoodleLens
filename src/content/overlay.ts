/**
 * 페이지 위에 그리는 강조 오버레이.
 *
 * - closed shadow root 안에 그려서 페이지 CSS·스크립트와 섞이지 않는다.
 * - host는 position:fixed라 문서 흐름(레이아웃)을 바꾸지 않는다.
 * - 스타일은 constructable stylesheet와 CSSOM으로만 넣는다(엄격한 페이지 CSP 대응).
 * - innerHTML을 쓰지 않는다(Trusted Types 페이지 대응).
 */

const HOST_TAG = 'noodlelens-overlay';

const SHEET = `
:host { all: initial; }
.catcher {
  position: fixed; inset: 0; pointer-events: none; background: transparent;
}
.catcher[data-active="true"] { pointer-events: auto; cursor: crosshair; }
.box {
  position: fixed; box-sizing: border-box; pointer-events: none; display: none;
  border: 2px solid #f2b544; background: rgba(242, 181, 68, 0.14); border-radius: 2px;
}
.box[data-variant="selected"] { border-color: #f08a24; background: rgba(240, 138, 36, 0.18); }
.box[data-variant="evidence"] { border-color: #3b82f6; background: rgba(59, 130, 246, 0.16); border-style: solid; }
.box[data-variant="missing"] { border-color: #ef4444; border-style: dashed; background: transparent; }
.label {
  position: fixed; display: none; pointer-events: none; max-width: calc(100vw - 16px);
  box-sizing: border-box; padding: 3px 7px; border-radius: 5px;
  background: #16181f; color: #fff4dc; box-shadow: 0 2px 8px rgba(0,0,0,.25);
  font: 500 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.label .dim { color: #b9b4a8; }
.banner {
  position: fixed; left: 50%; top: 12px; transform: translateX(-50%); display: none; pointer-events: none;
  max-width: calc(100vw - 24px); box-sizing: border-box; padding: 7px 12px; border-radius: 999px;
  background: #16181f; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.28);
  font: 500 13px/1.4 system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.banner[data-edge="bottom"] { top: auto; bottom: 12px; }
.banner kbd {
  font: inherit; padding: 0 5px; border-radius: 4px; background: rgba(255,255,255,.16);
}
`;

export type BoxVariant = 'hover' | 'selected' | 'evidence' | 'missing';

export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function important(el: HTMLElement, styles: Record<string, string>) {
  for (const [prop, value] of Object.entries(styles)) el.style.setProperty(prop, value, 'important');
}

export class Overlay {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  readonly catcher: HTMLDivElement;
  private readonly box: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly banner: HTMLDivElement;

  constructor() {
    this.host = document.createElement(HOST_TAG);
    important(this.host, {
      all: 'initial',
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      overflow: 'visible',
      'z-index': '2147483647',
      display: 'block',
      'pointer-events': 'none',
    });
    this.root = this.host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SHEET);
    this.root.adoptedStyleSheets = [sheet];
    this.catcher = this.make('catcher');
    this.box = this.make('box');
    this.label = this.make('label');
    this.banner = this.make('banner');
  }

  private make(className: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = className;
    this.root.appendChild(el);
    return el;
  }

  attach() {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
  }

  get catching(): boolean {
    return this.catcher.dataset.active === 'true';
  }

  /** 선택 모드도 강조도 없으면 host를 문서에서 뺀다 */
  detachIfIdle() {
    if (this.catching || this.box.style.display === 'block' || this.banner.style.display === 'block') return;
    this.host.remove();
  }

  isOwn(node: Node | null): boolean {
    if (!node) return false;
    if (node === this.host) return true;
    const root = node.getRootNode();
    return root === this.root;
  }

  setCatching(active: boolean) {
    this.catcher.dataset.active = String(active);
  }

  /**
   * fixed 요소의 기준점. 보통 (0,0)이지만 html에 transform 등이 있으면
   * fixed가 뷰포트가 아닌 html 기준이 되므로 그만큼 보정한다.
   */
  private origin(): { x: number; y: number } {
    const r = this.catcher.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  showBox(viewportRect: BoxRect, variant: BoxVariant, labelParts: { main: string; dim?: string } | null) {
    const origin = this.origin();
    const rect = {
      left: viewportRect.left - origin.x,
      top: viewportRect.top - origin.y,
      width: viewportRect.width,
      height: viewportRect.height,
    };
    this.box.dataset.variant = variant;
    Object.assign(this.box.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${Math.max(rect.width, 2)}px`,
      height: `${Math.max(rect.height, 2)}px`,
    });
    if (!labelParts) {
      this.label.style.display = 'none';
      return;
    }
    this.label.replaceChildren(document.createTextNode(labelParts.main));
    if (labelParts.dim) {
      const dim = document.createElement('span');
      dim.className = 'dim';
      dim.textContent = `  ${labelParts.dim}`;
      this.label.appendChild(dim);
    }
    this.label.style.display = 'block';
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const labelHeight = this.label.offsetHeight || 22;
    const labelWidth = this.label.offsetWidth || 120;
    let top = rect.top - labelHeight - 4;
    if (top < 4) top = Math.min(rect.top + rect.height + 4, viewportHeight - labelHeight - 4);
    if (top < 4) top = 4;
    const left = Math.min(Math.max(rect.left, 4), Math.max(4, viewportWidth - labelWidth - 4));
    Object.assign(this.label.style, { left: `${left}px`, top: `${top}px` });
  }

  hideBox() {
    this.box.style.display = 'none';
    this.label.style.display = 'none';
  }

  showBanner(parts: Array<string | { kbd: string }>) {
    this.banner.replaceChildren(
      ...parts.map((part) => {
        if (typeof part === 'string') return document.createTextNode(part);
        const kbd = document.createElement('kbd');
        kbd.textContent = part.kbd;
        return kbd;
      }),
    );
    this.banner.style.display = 'block';
  }

  /** 포인터가 배너 근처로 가면 배너를 반대쪽 끝으로 옮긴다 */
  moveBannerAwayFrom(y: number) {
    const height = document.documentElement.clientHeight || window.innerHeight;
    const edge = this.banner.dataset.edge === 'bottom' ? 'bottom' : 'top';
    if (edge === 'top' && y < 64) this.banner.dataset.edge = 'bottom';
    else if (edge === 'bottom' && y > height - 64) this.banner.dataset.edge = 'top';
  }

  hideBanner() {
    this.banner.style.display = 'none';
  }

  destroy() {
    this.host.remove();
  }
}

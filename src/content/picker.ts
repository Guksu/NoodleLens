import type { Overlay } from './overlay';
import type { Tracker } from './tracker';
import { composedParent } from './collect';
import type { PickCancelReason } from '../shared/protocol';

export interface PickerCallbacks {
  onPick: (el: Element) => void;
  onCancel: (reason: PickCancelReason) => void;
}

/** 클릭을 페이지에 넘기지 않기 위해 가로채는 포인터 이벤트 */
const BLOCKED_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
  'touchend',
] as const;

const LINE_HEIGHT_PX = 16;

/**
 * 요소 선택 모드.
 *
 * 화면 전체를 덮는 투명 catcher가 포인터 이벤트를 받으므로 페이지의 링크·버튼은 반응하지 않는다.
 * 아래 요소는 elementsFromPoint로 찾고, open shadow root는 안쪽까지 내려간다.
 * catcher가 휠을 받으면 포인터 아래의 스크롤 영역을 대신 스크롤한다.
 * stop()은 붙인 리스너를 모두 떼고 강조를 지운다.
 */
export class Picker {
  private active = false;
  private pointer: { x: number; y: number } | null = null;
  private hovered: Element | null = null;
  /** ↑로 부모로 올라갔을 때 ↓로 돌아오기 위한 경로 */
  private trail: Element[] = [];
  private hitTestPending = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly overlay: Overlay,
    private readonly tracker: Tracker,
    private readonly callbacks: PickerCallbacks,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.overlay.attach();
    this.overlay.setCatching(true);
    this.overlay.showBanner(['요소를 클릭해 선택 · ', { kbd: '↑' }, ' 부모 · ', { kbd: 'Esc' }, ' 취소']);

    const catcher = this.overlay.catcher;
    const listen = <K extends keyof WindowEventMap>(
      target: EventTarget,
      type: K | string,
      handler: (event: Event) => void,
      options: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler, options);
      this.cleanups.push(() => target.removeEventListener(type, handler, options));
    };

    listen(catcher, 'pointermove', (event) => this.onPointerMove(event as PointerEvent), { passive: true });
    for (const type of BLOCKED_EVENTS) {
      listen(catcher, type, (event) => this.onBlocked(event), { capture: true, passive: false });
    }
    listen(catcher, 'wheel', (event) => this.onWheel(event as WheelEvent), { passive: false });
    listen(window, 'keydown', (event) => this.onKeyDown(event as KeyboardEvent), { capture: true });
    listen(window, 'scroll', () => this.scheduleHitTest(), { capture: true, passive: true });
    listen(window, 'resize', () => this.scheduleHitTest(), { passive: true });
    listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.cancel('tab-hidden');
    }, {});
    listen(window, 'pagehide', () => this.cancel('pagehide'), {});
  }

  /** 리스너와 오버레이를 정리한다. 콜백은 부르지 않는다. */
  stop() {
    if (!this.active) return;
    this.active = false;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.overlay.setCatching(false);
    this.overlay.hideBanner();
    // 강조를 지우면서 쓰지 않는 오버레이 host도 문서에서 뺀다.
    this.tracker.stop();
    this.hovered = null;
    this.trail = [];
    this.pointer = null;
  }

  cancel(reason: PickCancelReason) {
    if (!this.active) return;
    this.stop();
    this.callbacks.onCancel(reason);
  }

  private elementAt(x: number, y: number): Element | null {
    for (const el of document.elementsFromPoint(x, y)) {
      if (this.overlay.isOwn(el)) continue;
      return this.drillShadow(el, x, y);
    }
    return null;
  }

  private drillShadow(el: Element, x: number, y: number): Element {
    let current = el;
    for (let depth = 0; depth < 20 && current.shadowRoot; depth += 1) {
      const root: ShadowRoot = current.shadowRoot;
      const inner = root.elementsFromPoint(x, y).find((candidate) => candidate !== current && root.contains(candidate));
      if (!inner) break;
      current = inner;
    }
    return current;
  }

  private setHovered(el: Element | null, resetTrail: boolean) {
    if (resetTrail) this.trail = [];
    this.hovered = el;
    if (el) this.tracker.follow(el, 'hover');
    else this.tracker.stop();
  }

  private onPointerMove(event: PointerEvent) {
    this.pointer = { x: event.clientX, y: event.clientY };
    this.overlay.moveBannerAwayFrom(event.clientY);
    const el = this.elementAt(event.clientX, event.clientY);
    if (el !== this.hovered && !this.trail.includes(el as Element)) this.setHovered(el, true);
  }

  private scheduleHitTest() {
    if (this.hitTestPending || !this.pointer) return;
    this.hitTestPending = true;
    requestAnimationFrame(() => {
      this.hitTestPending = false;
      if (!this.active || !this.pointer) return;
      const el = this.elementAt(this.pointer.x, this.pointer.y);
      if (el !== this.hovered) this.setHovered(el, true);
    });
  }

  private onBlocked(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type !== 'click') return;
    const mouse = event as MouseEvent;
    if (mouse.button !== 0) return;
    const el = this.hovered ?? this.elementAt(mouse.clientX, mouse.clientY);
    if (el) this.pick(el);
  }

  private pick(el: Element) {
    this.stop();
    this.callbacks.onPick(el);
  }

  private onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.cancel('escape');
      return;
    }
    if (event.key === 'ArrowUp' && this.hovered) {
      const parent = composedParent(this.hovered);
      if (parent && parent !== document.documentElement) {
        this.trail.push(this.hovered);
        this.setHovered(parent, false);
      }
    } else if (event.key === 'ArrowDown' && this.trail.length > 0) {
      this.setHovered(this.trail.pop() ?? null, false);
    } else if (event.key === 'Enter' && this.hovered) {
      this.pick(this.hovered);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  private onWheel(event: WheelEvent) {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? window.innerHeight : 1;
    const dx = (event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX) * scale;
    const dy = (event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY) * scale;
    const under = this.elementAt(event.clientX, event.clientY);
    const scroller = scrollableAncestor(under, dx, dy);
    if (scroller) scroller.scrollBy({ left: dx, top: dy });
    else window.scrollBy({ left: dx, top: dy });
    this.scheduleHitTest();
  }
}

function canScroll(el: Element, overflow: string, delta: number, pos: number, client: number, size: number) {
  if (delta === 0 || !/(auto|scroll|overlay)/.test(overflow) || size <= client + 1) return false;
  return delta > 0 ? pos + client < size - 1 : pos > 0;
}

function scrollableAncestor(start: Element | null, dx: number, dy: number): Element | null {
  for (let el = start; el; el = composedParent(el)) {
    if (el === document.documentElement || el === document.body) return null;
    const cs = getComputedStyle(el);
    if (
      canScroll(el, cs.overflowY, dy, el.scrollTop, el.clientHeight, el.scrollHeight) ||
      canScroll(el, cs.overflowX, dx, el.scrollLeft, el.clientWidth, el.scrollWidth)
    ) {
      return el;
    }
  }
  return null;
}

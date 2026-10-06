/**
 * 수집하는 computed style 속성 목록.
 * 패널의 메시지 검증도 이 목록을 허용 목록으로 쓴다.
 */

/** 네 방향 값을 합쳐 축약형으로 저장하는 속성 */
export const BOX_SHORTHANDS = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
} as const;

export const ALWAYS_PROPS = [
  'display',
  'position',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'overflow-x',
  'overflow-y',
] as const;

export const TEXT_PROPS = [
  'white-space',
  'text-wrap-mode',
  'text-overflow',
  'word-break',
  'overflow-wrap',
  'font-size',
  'line-height',
  'text-align',
] as const;

export const LINE_CLAMP_PROPS = ['-webkit-line-clamp', '-webkit-box-orient'] as const;

export const FLEX_CONTAINER_PROPS = [
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-content',
  'row-gap',
  'column-gap',
] as const;

export const GRID_CONTAINER_PROPS = [
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'justify-items',
  'align-items',
  'justify-content',
  'align-content',
  'row-gap',
  'column-gap',
] as const;

export const FLEX_ITEM_PROPS = ['flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'order'] as const;

export const GRID_ITEM_PROPS = [
  'grid-column-start',
  'grid-column-end',
  'grid-row-start',
  'grid-row-end',
  'justify-self',
  'align-self',
] as const;

export const POSITIONED_PROPS = ['top', 'right', 'bottom', 'left', 'z-index'] as const;

/** 기본값이 아닐 때만 넣는 속성과 그 기본값 */
export const NON_DEFAULT_PROPS: Record<string, readonly string[]> = {
  float: ['none'],
  transform: ['none'],
  contain: ['none'],
  'container-type': ['normal'],
  visibility: ['visible'],
  'writing-mode': ['horizontal-tb'],
  direction: ['ltr'],
  'aspect-ratio': ['auto'],
  'object-fit': ['fill'],
  'vertical-align': ['baseline'],
  'text-overflow': ['clip'],
  'white-space': ['normal'],
};

export const PSEUDO_PROPS = ['content', 'display', 'position', 'width', 'height', 'top', 'right', 'bottom', 'left', 'transform'] as const;

export const ALLOWED_STYLE_KEYS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(BOX_SHORTHANDS),
  ...ALWAYS_PROPS,
  ...TEXT_PROPS,
  ...LINE_CLAMP_PROPS,
  ...FLEX_CONTAINER_PROPS,
  ...GRID_CONTAINER_PROPS,
  ...FLEX_ITEM_PROPS,
  ...GRID_ITEM_PROPS,
  ...POSITIONED_PROPS,
  ...Object.keys(NON_DEFAULT_PROPS),
]);

export const ALLOWED_PSEUDO_KEYS: ReadonlySet<string> = new Set<string>(PSEUDO_PROPS);

/** 수집하는 HTML 속성 허용 목록. data-*, value, name 등은 수집하지 않는다. */
export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'class',
  'role',
  'type',
  'href',
  'src',
  'alt',
  'title',
  'placeholder',
  'aria-label',
  'aria-hidden',
  'hidden',
  'dir',
  'lang',
  'width',
  'height',
  'colspan',
  'rowspan',
  'loading',
  'style',
  'disabled',
  'open',
  'slot',
]);

export function isFlexDisplay(display: string | undefined): boolean {
  return display === 'flex' || display === 'inline-flex';
}

export function isGridDisplay(display: string | undefined): boolean {
  return display === 'grid' || display === 'inline-grid';
}

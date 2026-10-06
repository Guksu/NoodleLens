/**
 * 모델 답변 렌더링.
 * - 원시 HTML은 렌더링하지 않는다(react-markdown 기본).
 * - 이미지는 불러오지 않고 글자로만 보여 준다(페이지 내용이 섞인 답변으로 외부 주소를 부르는 것을 막음).
 * - [E3] 형태의 근거 식별자는 버튼으로 바꾸고, 수집 자료에 없으면 경고로 표시한다.
 */
import { Check, Copy } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import { splitCitations } from '../../shared/citations';
import { highlight } from '../actions';

export interface CitationTarget {
  snapshotId: string;
  label: string;
}

const CITE_PREFIX = '#nl-cite-';

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

function remarkCitations() {
  return (tree: MdNode) => {
    visit(tree as never, 'text', (node: MdNode, index: number | undefined, parent: MdNode | undefined) => {
      if (!parent || index === undefined || parent.type === 'link' || !node.value) return;
      const parts = splitCitations(node.value);
      if (parts.length === 1 && typeof parts[0] === 'string') return;
      const replacement: MdNode[] = parts.flatMap((part): MdNode[] =>
        typeof part === 'string'
          ? [{ type: 'text', value: part }]
          : part.ids.map((id) => ({ type: 'link', url: `${CITE_PREFIX}${id}`, children: [{ type: 'text', value: id }] })),
      );
      parent.children?.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="code-copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      aria-label="코드 복사"
      title="코드 복사"
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

function urlTransform(url: string): string {
  if (url.startsWith(CITE_PREFIX)) return url;
  return /^(https?:|mailto:)/i.test(url) ? url : '';
}

export const Markdown = memo(function Markdown({
  text,
  citations,
}: {
  text: string;
  citations: ReadonlyMap<string, CitationTarget>;
}) {
  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith(CITE_PREFIX)) {
        const id = href.slice(CITE_PREFIX.length);
        const target = citations.get(id);
        if (!target) {
          return (
            <span className="cite is-unknown" title="수집 자료에 없는 식별자입니다. 모델이 잘못 인용했을 수 있습니다.">
              {id}?
            </span>
          );
        }
        return (
          <button type="button" className="cite" title={`${target.label} — 페이지에서 보기`} onClick={() => void highlight(target.snapshotId, id)}>
            {id}
          </button>
        );
      }
      if (!href) return <span>{children}</span>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    img({ alt, src }) {
      return <span className="md-image-placeholder">[이미지: {alt || src || '설명 없음'}]</span>;
    },
    pre({ children }) {
      return (
        <div className="code-block">
          <CopyButton text={textOf(children).replace(/\n$/, '')} />
          <pre>{children}</pre>
        </div>
      );
    },
    table({ children }) {
      return (
        <div className="table-scroll">
          <table>{children}</table>
        </div>
      );
    },
  };
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitations]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

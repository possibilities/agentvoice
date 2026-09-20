import { common, createLowlight } from "lowlight";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  Children,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  cloneElement,
  isValidElement,
  memo,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  activateDocumentLink,
  useDocumentViewerLink,
} from "../../transcript/document-viewer-context";

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textFromNode(node.props.children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child = Children.toArray(children)[0];
  const className = isValidElement<{ className?: string }>(child)
    ? child.props.className
    : undefined;
  const language = className?.match(/language-([\w-]+)/)?.[1] ?? "code";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textFromNode(children).trimEnd());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <div className="code-block__header">
        <span>{language}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={copied ? "Copied" : "Copy code"}
                onClick={copy}
              />
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </TooltipTrigger>
          <TooltipContent portalClassName="agentchats-transcript">
            {copied ? "Copied" : "Copy code"}
          </TooltipContent>
        </Tooltip>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

type MarkdownNode = {
  type: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  children?: MarkdownNode[];
};

type HtmlNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
};

const metadataAssignment = /(?:^|\s)[\w.-]+=(?:"[^"]*"|'[^']*'|\S+)/;
const sentencePunctuation = /[.!?](?:\s|$)/;
const commonLanguageRegistry = createLowlight(common);

/** Recover prose accidentally placed on an otherwise empty opening fence. */
function remarkRecoverEmptyFenceInfo() {
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return;
      parent.children = parent.children.map((node) => {
        const meta = node.meta?.trim();
        if (
          node.type === "code" &&
          node.value === "" &&
          node.lang &&
          meta &&
          !commonLanguageRegistry.registered(node.lang) &&
          sentencePunctuation.test(meta) &&
          !metadataAssignment.test(meta)
        ) {
          return {
            ...node,
            lang: null,
            meta: null,
            value: `${node.lang} ${meta}`,
          };
        }
        visit(node);
        return node;
      });
    };
    visit(tree);
  };
}

const remarkPlugins = [remarkGfm, remarkRecoverEmptyFenceInfo];

function textFromHtmlNode(node: HtmlNode): string {
  if (node.type === "text") return node.value ?? "";
  return node.children?.map(textFromHtmlNode).join("") ?? "";
}

function headingSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** Give rendered documents stable in-panel heading anchors without raw HTML. */
function rehypeDocumentHeadingIds() {
  return (tree: HtmlNode) => {
    const seen = new Map<string, number>();
    const visit = (node: HtmlNode) => {
      if (/^h[1-6]$/.test(node.tagName ?? "")) {
        const base = headingSlug(textFromHtmlNode(node)) || "section";
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        node.properties = {
          ...node.properties,
          id: count === 0 ? base : `${base}-${count + 1}`,
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const transcriptRehypePlugins = [rehypeHighlight];
const documentRehypePlugins = [rehypeHighlight, rehypeDocumentHeadingIds];

function MarkdownLink({
  children,
  node: _node,
  href,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const viewer = useDocumentViewerLink();
  const local = Boolean(href && viewer?.canOpen({ href, base: viewer.base }));
  const sameDocument = Boolean(viewer?.base && href?.startsWith("#"));
  return (
    <a
      {...props}
      href={href}
      target={local || sameDocument ? undefined : "_blank"}
      rel={local || sameDocument ? undefined : "noreferrer"}
      aria-haspopup={local ? "dialog" : undefined}
      onClick={(event) => {
        if (sameDocument && href?.startsWith("#")) {
          const popup = event.currentTarget.closest('[data-slot="document-viewer"]');
          const id = (() => {
            try {
              return decodeURIComponent(href.slice(1));
            } catch {
              return href.slice(1);
            }
          })();
          const target = popup?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
          if (target) {
            event.preventDefault();
            target.scrollIntoView({ block: "start" });
          }
          return;
        }
        if (href && viewer && local) activateDocumentLink(event, href, viewer);
      }}
    >
      {children}
    </a>
  );
}

type NumberedItemProps = ComponentPropsWithoutRef<"li"> & { "data-ordered-marker"?: string };

/** Keep decimal markers at the prose edge while every text line hangs together. */
function OrderedList({
  children,
  start,
  reversed,
  style,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"ol"> & { node?: unknown }) {
  const items = Children.toArray(children);
  const count = items.filter((child) => isValidElement(child) && child.type === "li").length;
  let ordinal = start ?? (reversed ? count : 1);
  let markerWidth = 2;
  const numbered = items.map((child) => {
    if (!isValidElement<NumberedItemProps>(child) || child.type !== "li") return child;
    const value = child.props.value;
    if ((typeof value === "number" || typeof value === "string") && Number.isInteger(Number(value)))
      ordinal = Number(value);
    const marker = `${ordinal}.`;
    ordinal += reversed ? -1 : 1;
    markerWidth = Math.max(markerWidth, marker.length);
    return cloneElement(child, { "data-ordered-marker": marker });
  });
  return (
    <ol
      {...props}
      start={start}
      reversed={reversed}
      // biome-ignore lint/a11y/noRedundantRoles: Preserve Safari list semantics when native marker styling is removed.
      role="list"
      style={{ ...style, "--ordered-marker-width": `${markerWidth}ch` } as CSSProperties}
    >
      {numbered}
    </ol>
  );
}

const markdownComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  ol: OrderedList,
  a: MarkdownLink,
};

export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const viewer = useDocumentViewerLink();
  const urlTransform = useCallback(
    (value: string) =>
      viewer?.canOpen({ href: value, base: viewer.base }) ? value : defaultUrlTransform(value),
    [viewer],
  );
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={viewer?.base ? documentRehypePlugins : transcriptRehypePlugins}
        components={markdownComponents}
        urlTransform={urlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

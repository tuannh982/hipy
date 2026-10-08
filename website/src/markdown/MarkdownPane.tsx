import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Components } from "react-markdown";
import { MermaidBlock } from "../lessons/MermaidBlock";

export function MarkdownPane({
  source,
  assets = {},
}: {
  source: string;
  assets?: Record<string, string>;
}) {
  const overrides = useMemo<Components>(() => makeOverrides(assets), [assets]);

  return (
    <div className="lesson-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={overrides}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

export function makeOverrides(assets: Record<string, string>): Components {
  return {
                                code({ className, children, node: _node, ...rest }) {
      const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "";
      const text = String(children ?? "").replace(/\n$/, "");
      if (language === "mermaid") return <MermaidBlock chart={text} />;
      return <code className={className} {...rest}>{children}</code>;
    },
                                            img({ src, alt }) {
      const resolved = src !== undefined && Object.hasOwn(assets, src) ? assets[src] : undefined;
      if (resolved === undefined) {
        return <span className="lesson-image-missing">{src ?? "image"}</span>;
      }
      return <img className="lesson-image" src={resolved} alt={alt ?? ""} />;
    },
                        a({ href, title, children }) {
      const external = href !== undefined && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href);
      return (
        <a
          className="lesson-link"
          href={href}
          title={title}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {children}
        </a>
      );
    },
  };
}

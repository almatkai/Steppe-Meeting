import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

interface MarkdownViewerProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
}

interface PreBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  children?: React.ReactNode;
}

const CodeBlock: React.FC<PreBlockProps> = ({ children, ...props }) => {
  const [copied, setCopied] = useState(false);

  // Extract raw text from children for copying
  let codeText = "";
  if (React.isValidElement(children)) {
    const codeChildren = (children.props as any)?.children;
    if (typeof codeChildren === "string") {
      codeText = codeChildren;
    } else if (Array.isArray(codeChildren)) {
      codeText = codeChildren.map((c) => (typeof c === "string" ? c : "")).join("");
    }
  }

  // Extract language if specified in code className
  let language = "";
  if (React.isValidElement(children)) {
    const className = (children.props as any)?.className || "";
    const match = /language-(\w+)/.exec(className);
    if (match) {
      language = match[1];
    }
  }

  const handleCopy = () => {
    if (!codeText) return;
    navigator.clipboard.writeText(codeText.replace(/\n$/, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-3 rounded-xl overflow-hidden border border-slate-800 bg-slate-950/90 shadow-sm">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-slate-900/90 border-b border-slate-800 text-[11px] text-slate-400 select-none">
        <span className="font-mono text-indigo-400 font-medium lowercase">
          {language || "код"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-slate-200 transition-colors cursor-pointer py-0.5 px-1.5 rounded hover:bg-slate-800"
          title="Скопировать код"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400 text-[10px]">Скопировано</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3 text-slate-400" />
              <span className="text-[10px]">Копировать</span>
            </>
          )}
        </button>
      </div>
      <pre
        className="p-3.5 overflow-x-auto text-xs font-mono text-slate-200 leading-relaxed"
        {...props}
      >
        {children}
      </pre>
    </div>
  );
};

export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({
  content,
  className = "",
  isStreaming = false,
}) => {
  return (
    <div className={`markdown-content select-text text-sm leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node, ...props }) => (
            <h1
              className="text-base font-bold text-white mt-3 mb-1.5 first:mt-0 tracking-tight"
              {...props}
            />
          ),
          h2: ({ node, ...props }) => (
            <h2
              className="text-sm font-semibold text-slate-100 mt-3 mb-1.5 first:mt-0 tracking-tight"
              {...props}
            />
          ),
          h3: ({ node, ...props }) => (
            <h3
              className="text-xs font-semibold text-indigo-300 mt-2.5 mb-1 first:mt-0"
              {...props}
            />
          ),
          h4: ({ node, ...props }) => (
            <h4
              className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider mt-2 mb-1 first:mt-0"
              {...props}
            />
          ),
          p: ({ node, ...props }) => (
            <p className="mb-2 last:mb-0 leading-relaxed text-slate-200" {...props} />
          ),
          ul: ({ node, ...props }) => (
            <ul className="list-disc pl-5 space-y-1 my-2 text-slate-200" {...props} />
          ),
          ol: ({ node, ...props }) => (
            <ol className="list-decimal pl-5 space-y-1 my-2 text-slate-200" {...props} />
          ),
          li: ({ node, ...props }) => <li className="leading-relaxed pl-0.5" {...props} />,
          strong: ({ node, ...props }) => (
            <strong className="font-semibold text-white" {...props} />
          ),
          em: ({ node, ...props }) => <em className="italic text-slate-300" {...props} />,
          blockquote: ({ node, ...props }) => (
            <blockquote
              className="border-l-2 border-indigo-500/70 pl-3 py-1 my-2 text-slate-300 italic bg-slate-900/40 rounded-r"
              {...props}
            />
          ),
          pre: ({ node, ...props }) => <CodeBlock {...props} />,
          code: ({ node, className: codeClassName, children, ...props }) => {
            // If code is inside pre (fenced code block), render without inline styling
            const isInline = !codeClassName && typeof children === "string" && !children.includes("\n");
            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 mx-0.5 rounded-md bg-slate-800/80 text-indigo-300 font-mono text-[11px] border border-slate-700/50"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={codeClassName} {...props}>
                {children}
              </code>
            );
          },
          table: ({ node, ...props }) => (
            <div className="overflow-x-auto my-3 rounded-xl border border-slate-800 bg-slate-950/40 shadow-sm">
              <table className="min-w-full divide-y divide-slate-800 text-xs" {...props} />
            </div>
          ),
          thead: ({ node, ...props }) => <thead className="bg-slate-900/80" {...props} />,
          th: ({ node, ...props }) => (
            <th
              className="px-3.5 py-2.5 text-left font-semibold text-slate-300 uppercase tracking-wider text-[11px]"
              {...props}
            />
          ),
          tbody: ({ node, ...props }) => (
            <tbody className="divide-y divide-slate-800/50 text-slate-200" {...props} />
          ),
          tr: ({ node, ...props }) => (
            <tr className="hover:bg-slate-800/30 transition-colors" {...props} />
          ),
          td: ({ node, ...props }) => (
            <td className="px-3.5 py-2 text-slate-300 leading-relaxed" {...props} />
          ),
          a: ({ node, ...props }) => (
            <a
              className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2 transition-colors cursor-pointer"
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            />
          ),
          hr: ({ node, ...props }) => <hr className="my-3 border-slate-800/80" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
      {isStreaming && (
        <span className="inline-block w-1.5 h-4 ml-1 bg-indigo-400 animate-pulse align-middle" />
      )}
    </div>
  );
};

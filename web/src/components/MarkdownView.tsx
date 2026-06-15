import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownViewProps {
  markdown: string
  className?: string
}

export function MarkdownView({ markdown, className = '' }: MarkdownViewProps) {
  return (
    <div className={`prose-mirror-display max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          h1: ({ children }) => <h1 className="mt-1 mb-3 text-xl font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-5 mb-2 border-b border-border pb-1 text-lg font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-4 mb-2 text-base font-semibold">{children}</h3>,
          h4: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold uppercase tracking-normal text-muted-foreground">{children}</h4>,
          p: ({ children }) => <p className="my-2 leading-6" style={{ whiteSpace: 'pre-wrap' }}>{children}</p>,
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>,
          li: ({ children }) => <li style={{ whiteSpace: 'pre-wrap' }}>{children}</li>,
          blockquote: ({ children }) => <blockquote className="my-3 border-l-4 border-border pl-4 text-muted-foreground">{children}</blockquote>,
          pre: ({ children }) => <pre className="my-3 overflow-auto rounded-md bg-muted p-3">{children}</pre>,
          code: ({ className, children }) => {
            const block = (typeof className === 'string' && className.startsWith('language-')) || String(children).includes('\n')
            return block
              ? <code className={className}>{children}</code>
              : <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{children}</code>
          },
          table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-sm">{children}</table></div>,
          th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
          hr: () => <hr className="my-4 border-border" />,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {children}
            </a>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

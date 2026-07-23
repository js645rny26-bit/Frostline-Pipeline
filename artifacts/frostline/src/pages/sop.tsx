import { Fragment, type ReactNode } from "react";
import { Layout } from "@/components/layout";
import sopRaw from "../../../../docs/DAILY_SOP.md?raw";

/** Render **bold** and `code` spans inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

type Block =
  | { kind: "h1" | "h2" | "h3" | "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

function parse(md: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "" || line.trim() === "---") continue;
    const li = /^- (.*)$/.exec(line);
    const oli = /^\d+\. (.*)$/.exec(line);
    if (li || oli) {
      const kind = li ? "ul" : "ol";
      const item = (li ?? oli)![1];
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) {
        last.items.push(item);
      } else {
        blocks.push({ kind, items: [item] });
      }
      continue;
    }
    if (line.startsWith("### ")) blocks.push({ kind: "h3", text: line.slice(4) });
    else if (line.startsWith("## ")) blocks.push({ kind: "h2", text: line.slice(3) });
    else if (line.startsWith("# ")) blocks.push({ kind: "h1", text: line.slice(2) });
    else blocks.push({ kind: "p", text: line });
  }
  return blocks;
}

export default function SopPage() {
  const blocks = parse(sopRaw);
  return (
    <Layout>
      <div className="mx-auto max-w-3xl px-6 py-8" data-testid="page-sop">
        {blocks.map((b, i) => {
          switch (b.kind) {
            case "h1":
              return (
                <h1 key={i} className="mb-4 text-2xl font-bold tracking-tight text-foreground">
                  {inline(b.text)}
                </h1>
              );
            case "h2":
              return (
                <h2 key={i} className="mb-3 mt-8 border-b border-border pb-2 text-lg font-semibold text-foreground">
                  {inline(b.text)}
                </h2>
              );
            case "h3":
              return (
                <h3 key={i} className="mb-2 mt-5 text-base font-semibold text-foreground">
                  {inline(b.text)}
                </h3>
              );
            case "ul":
              return (
                <ul key={i} className="mb-4 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
                  {b.items.map((item, j) => (
                    <li key={j}>{inline(item)}</li>
                  ))}
                </ul>
              );
            case "ol":
              return (
                <ol key={i} className="mb-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
                  {b.items.map((item, j) => (
                    <li key={j}>{inline(item)}</li>
                  ))}
                </ol>
              );
            default:
              return (
                <p key={i} className="mb-4 text-sm leading-relaxed text-muted-foreground">
                  {inline(b.text)}
                </p>
              );
          }
        })}
      </div>
    </Layout>
  );
}

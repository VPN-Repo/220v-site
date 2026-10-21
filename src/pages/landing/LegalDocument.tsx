import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Renders an owner-supplied legal text (src/content/legal/*.txt) verbatim.
 * The .txt file is the single source of truth: this module only adds semantic
 * markup (h1/h2/h3/p/ul/li, bold labels) and turns URLs and emails into links.
 * It never adds, removes or reorders words; see src/test/legal-docs.test.tsx.
 */

export type LegalBlock =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "operator"; operator: string; address: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] };

const BULLET = /^\s*•\s*/;
const SECTION = /^\d+\.\s/;
const SUBSECTION_TITLE = /^\d+\.\d+\.\s.*:$/;
const OPERATOR = /^(Оператор:\s.*?)\s(Адрес:\s.*)$/;

export function parseLegalText(source: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let first = true;

  for (const raw of lines) {
    if (raw.trim() === "") continue;

    if (BULLET.test(raw)) {
      const item = raw.replace(BULLET, "").trim();
      const last = blocks[blocks.length - 1];
      if (last?.kind === "ul") last.items.push(item);
      else blocks.push({ kind: "ul", items: [item] });
      continue;
    }

    const line = raw.trim();
    if (first) {
      blocks.push({ kind: "h1", text: line });
      first = false;
      continue;
    }

    const operator = OPERATOR.exec(line);
    if (operator) blocks.push({ kind: "operator", operator: operator[1], address: operator[2] });
    else if (SECTION.test(line)) blocks.push({ kind: "h2", text: line });
    else if (SUBSECTION_TITLE.test(line)) blocks.push({ kind: "h3", text: line });
    else blocks.push({ kind: "p", text: line });
  }

  return blocks;
}

const LINKABLE = /(https?:\/\/[^\s]+?|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)(?=[.,;:!?)»]*(?:\s|$))/g;
const SITE_ORIGINS = ["https://220v.shop", "https://220v.tech"];

/** Turns URLs and emails into links; the visible text stays exactly the same. */
export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LINKABLE)) {
    const value = match[0];
    const start = match.index ?? 0;
    if (start > cursor) out.push(text.slice(cursor, start));
    if (value.includes("@") && !value.startsWith("http")) {
      out.push(
        <a key={start} href={`mailto:${value}`}>
          {value}
        </a>,
      );
    } else if (SITE_ORIGINS.some((origin) => value.startsWith(`${origin}/`))) {
      const origin = SITE_ORIGINS.find((o) => value.startsWith(`${o}/`)) ?? "";
      out.push(
        <Link key={start} to={value.slice(origin.length)}>
          {value}
        </Link>,
      );
    } else {
      out.push(
        <a key={start} href={value} target="_blank" rel="noopener noreferrer">
          {value}
        </a>,
      );
    }
    cursor = start + value.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

/** Bold lead-in: "1.1.", "2.1. Доступ:", "ВНИМАНИЕ:". */
const PARAGRAPH_LEAD = /^(\d+\.\d+\.(?: [А-ЯЁ][а-яё]+:)?|ВНИМАНИЕ:)(\s)/;
/** Bold lead-in for list items: a defined term before " — " or a short label ending in ":". */
const ITEM_LEAD = /^([^—:]{1,60}?)(\s—\s)|^([А-ЯЁ][а-яё]+(?: [а-яё]+)?:)(\s)/;

function withLead(text: string, lead: RegExp): ReactNode {
  const match = lead.exec(text);
  if (!match) return linkify(text);
  const head = match[1] ?? match[3];
  const sep = match[2] ?? match[4];
  return (
    <>
      <strong>{head}</strong>
      {sep}
      {linkify(text.slice(head.length + sep.length))}
    </>
  );
}

function renderBlock(block: LegalBlock, index: number): ReactNode {
  switch (block.kind) {
    case "h1":
      return <h1 key={index}>{block.text}</h1>;
    case "h2":
      return <h2 key={index}>{block.text}</h2>;
    case "h3":
      return <h3 key={index}>{block.text}</h3>;
    case "operator":
      return (
        <p key={index}>
          {withLead(block.operator, /^(Оператор:)(\s)/)} <br />
          {withLead(block.address, /^(Адрес:)(\s)/)}
        </p>
      );
    case "p":
      return <p key={index}>{withLead(block.text, PARAGRAPH_LEAD)}</p>;
    case "ul":
      return (
        <ul key={index}>
          {block.items.map((item, i) => (
            <li key={i}>{withLead(item, ITEM_LEAD)}</li>
          ))}
        </ul>
      );
  }
}

export const LegalDocument = ({ source }: { source: string }) => (
  <article className="doc__content">
    {parseLegalText(source).map((block, index) => (
      <Fragment key={index}>{renderBlock(block, index)}</Fragment>
    ))}
  </article>
);

export default LegalDocument;

import { extractText, getDocumentProxy } from "unpdf";

export const MAX_TEXT_CHARS = 60_000;

export async function pdfToText(bytes: ArrayBuffer): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text: tidy(text), pages: totalPages };
}

export function tidy(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function truncate(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Truncated: showing the first ${max.toLocaleString()} of ${text.length.toLocaleString()} characters.]`;
}

export function isPdf(bytes: ArrayBuffer, contentType: string): boolean {
  if (contentType.includes("pdf")) return true;
  const head = new Uint8Array(bytes.slice(0, 5));
  return String.fromCharCode(...head) === "%PDF-";
}

export function isTextLike(contentType: string, filename = ""): boolean {
  return (
    /^text\/|json|xml|javascript|csv/.test(contentType) ||
    /\.(txt|md|java|c|h|py|js|ts|csv|json|xml|html|hdl|tst|cmp|asm|vm|jack|sql)$/i.test(filename)
  );
}

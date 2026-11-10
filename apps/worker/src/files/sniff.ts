// The content check of a file (m2-attachments design D3): its type is read
// from its first bytes, never from its name or the browser's claim, and must
// agree with the declared type. Pure. Spec platform/attachments "Only allowed
// files of bounded size".
import { AttachmentMediaTypeSchema, type AttachmentMediaType } from "@a2h/protocol";

/** How much of a file is read to identify it: the first 8 KB (ranged GET). */
export const SNIFF_BYTES = 8192;

export type SniffOutcome = { ok: true; media_type: AttachmentMediaType } | { ok: false };

const REFUSED: SniffOutcome = Object.freeze({ ok: false });

const TEXT_TYPES: ReadonlySet<AttachmentMediaType> = new Set(["text/plain", "text/csv", "text/markdown"]);

function startsWith(head: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (head.length < at + signature.length) return false;
  return signature.every((b, i) => head[at + i] === b);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The binary type the bytes carry, by signature; null when none matches. */
function binaryType(head: Uint8Array): AttachmentMediaType | null {
  if (startsWith(head, ascii("%PDF-"))) return "application/pdf";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/**
 * Markup a browser would sniff as HTML or XML (the WHATWG MIME sniffing
 * patterns, after leading whitespace): such a file is not accepted as text,
 * whatever it is declared as.
 */
const MARKUP = /^[\t\n\f\r ]*(<!DOCTYPE HTML|<HTML|<HEAD|<SCRIPT|<IFRAME|<H1|<DIV|<FONT|<TABLE|<A|<STYLE|<TITLE|<B|<BODY|<BR|<P|<SVG)[\t\n\f\r >/]|^[\t\n\f\r ]*(<!--|<\?XML)/i;

/** Decoded text when the bytes are UTF-8 without NUL or control bytes (tab, LF, FF, CR allowed). */
function asText(head: Uint8Array, truncated: boolean): string | null {
  let body = head;
  if (startsWith(body, [0xef, 0xbb, 0xbf])) body = body.subarray(3);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string | null = null;
  // A multibyte character may be cut by the end of the head: drop up to 3 bytes, only then.
  for (let cut = 0; cut <= (truncated ? 3 : 0) && text === null; cut += 1) {
    try {
      text = decoder.decode(body.subarray(0, body.length - cut));
    } catch {
      text = null;
    }
  }
  if (text === null) return null;
  // C0 controls other than tab (9), LF (10), FF (12) and CR (13), and DEL (127).
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13) || c === 127) return null;
  }
  return text;
}

/**
 * The type of a file from its first bytes (`head`, at most SNIFF_BYTES),
 * checked against its declared type. `truncated`: the file is longer than
 * `head`. Text types (plain, CSV, Markdown) cannot be told apart by bytes:
 * valid text keeps the declared text type.
 */
export function sniffFile(head: Uint8Array, declared: string, { truncated = false }: { truncated?: boolean } = {}): SniffOutcome {
  const parsed = AttachmentMediaTypeSchema.safeParse(declared);
  if (!parsed.success || head.length === 0) return REFUSED;
  const declaredType = parsed.data;
  const binary = binaryType(head);
  if (binary !== null) return binary === declaredType ? { ok: true, media_type: binary } : REFUSED;
  if (!TEXT_TYPES.has(declaredType)) return REFUSED;
  const text = asText(head, truncated);
  if (text === null || MARKUP.test(text)) return REFUSED;
  return { ok: true, media_type: declaredType };
}

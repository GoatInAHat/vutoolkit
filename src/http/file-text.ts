/**
 * The text of a downloaded file. PDFs are read with Mozilla's PDF.js (`pdfjs-dist`), the parser
 * Firefox uses; text formats are decoded as they are. Nothing here parses a format by hand.
 */

export interface FileText {
  /** The kind of file it was read as. */
  kind: "pdf" | "text";
  text: string;
  /** Page count, for a PDF. */
  pages?: number;
}

/** A content type, or a file name, that is plain text to decode as is. */
const TEXTUAL = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|x-javascript|ld\+json|rtf|x-tex|csv|x-sh|x-python|sql)\b|[^;]*\+(?:json|xml)\b)/i;
const TEXT_EXT = /\.(?:txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|py|java|c|h|cpp|hpp|s|asm|v|sv|vhd|tex|rtf|sql|sh|yaml|yml|log)$/i;

/** True when the bytes start with the PDF header. */
export const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;

/** Whether a response with this content type or file name holds text to show as is. */
export function isTextual(contentType: string, name = ""): boolean {
  return TEXTUAL.test(contentType.trim()) || TEXT_EXT.test(name);
}

/** The text of every page of a PDF, pages separated by a form feed line. */
export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    // PDF.js takes ownership of the buffer it is given.
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join("\n").replace(/[ \t]+$/gm, ""));
      page.cleanup();
    }
    return { text: pages.join("\n\f\n"), pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}

/**
 * The text of a file: a PDF through PDF.js, a text format decoded as UTF-8. Anything else throws
 * an error naming its type, so a caller is never handed decoded binary.
 */
export async function fileText(bytes: Uint8Array, contentType: string, name = ""): Promise<FileText> {
  if (isPdf(bytes) || /^application\/pdf\b/i.test(contentType) || /\.pdf$/i.test(name)) {
    const { text, pages } = await pdfText(bytes);
    return { kind: "pdf", text, pages };
  }
  if (isTextual(contentType, name)) return { kind: "text", text: new TextDecoder().decode(bytes) };
  throw Object.assign(new Error(`${name || "the file"} is ${contentType || "an unknown type"}, which has no text reader here (PDF and text files only)`), {
    code: "UNSUPPORTED_FILE_TYPE",
  });
}

const BINARY_TYPE = /^(?:application\/(?:pdf|octet-stream|zip|gzip|x-7z-compressed|x-rar|msword|vnd\.ms-|vnd\.openxmlformats|vnd\.oasis)|image\/(?!svg)|audio\/|video\/|font\/)/i;

/** Whether a response body is a file rather than text: a binary content type, or NUL bytes. */
export function looksBinary(contentType: string, bytes: Uint8Array): boolean {
  if (BINARY_TYPE.test(contentType.trim()) || isPdf(bytes)) return true;
  return bytes.subarray(0, 8192).includes(0);
}

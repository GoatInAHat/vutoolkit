import { describe, expect, it } from "vitest";
import { fileText, isTextual, looksBinary } from "./file-text.js";

/** A small valid PDF: one page per entry, each line drawn as its own text line (synthetic). */
function makePdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const font = 3 + pages.length * 2;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  for (const [i, lines] of pages.entries()) {
    const ops = lines.map((line, j) => `BT /F1 12 Tf 72 ${720 - j * 18} Td (${line}) Tj ET`).join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("fileText", () => {
  it("reads a PDF's pages with PDF.js", async () => {
    const pdf = makePdf([["CS 9999 Syllabus", "Grading: exams 50%"], ["Office hours Monday"]]);
    const result = await fileText(pdf, "application/pdf", "syllabus.pdf");
    expect(result.kind).toBe("pdf");
    expect(result.pages).toBe(2);
    expect(result.text).toContain("CS 9999 Syllabus");
    expect(result.text).toContain("Grading: exams 50%");
    expect(result.text.split("\f")[1]).toContain("Office hours Monday");
  });

  it("reads a PDF served as octet-stream by its header", async () => {
    const result = await fileText(makePdf([["Week 1 notes"]]), "application/octet-stream", "");
    expect(result).toMatchObject({ kind: "pdf", pages: 1 });
    expect(result.text).toContain("Week 1 notes");
  });

  it("decodes text formats as they are", async () => {
    const result = await fileText(new TextEncoder().encode("a,b\n1,2\n"), "text/csv; charset=utf-8", "grades.csv");
    expect(result).toEqual({ kind: "text", text: "a,b\n1,2\n" });
    expect(isTextual("application/octet-stream", "main.c")).toBe(true);
  });

  it("refuses a type it has no reader for, naming it", async () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    await expect(fileText(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
  });
});

describe("looksBinary", () => {
  it("tells files from text", () => {
    expect(looksBinary("application/pdf", new Uint8Array())).toBe(true);
    expect(looksBinary("image/png", new Uint8Array([1]))).toBe(true);
    expect(looksBinary("image/svg+xml", new TextEncoder().encode("<svg/>"))).toBe(false);
    expect(looksBinary("application/json", new TextEncoder().encode('{"a":1}'))).toBe(false);
    expect(looksBinary("", new Uint8Array([0x41, 0, 0x42]))).toBe(true);
  });
});

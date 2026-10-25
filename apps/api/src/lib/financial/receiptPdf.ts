// Owner t180u(2): a dependency-free, text-only PDF (PDF 1.4, Helvetica) for
// AE service-fee receipts. Only ASCII is emitted; anything else is replaced.
export interface ReceiptPdfInput {
  title: string;
  lines: Array<[label: string, value: string]>;
  history: string[];
  footer: string;
}

function esc(s: string): string {
  return s
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function renderReceiptPdf(input: ReceiptPdfInput): Buffer {
  const ops: string[] = ["BT", "/F2 16 Tf", "50 790 Td", `(${esc(input.title)}) Tj`, "/F1 10 Tf", "0 -28 Td"];
  for (const [label, value] of input.lines) {
    ops.push(`(${esc(`${label}: ${value}`).slice(0, 180)}) Tj`, "0 -15 Td");
  }
  if (input.history.length) {
    ops.push("0 -10 Td", "/F2 11 Tf", "(History) Tj", "/F1 9 Tf", "0 -14 Td");
    for (const h of input.history.slice(0, 25)) ops.push(`(${esc(h).slice(0, 200)}) Tj`, "0 -12 Td");
  }
  ops.push("0 -14 Td", "/F1 8 Tf", `(${esc(input.footer).slice(0, 200)}) Tj`, "ET");
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * Generates the committed PDF test fixture (test/e2e/fixtures/sample.pdf) used by
 * both the file-service unit test and the pdf-viewer e2e. Hand-built (no pdf
 * library) so the fixture is reproducible and dependency-free.
 *
 * The document is intentionally minimal but real: 2 pages, each with selectable
 * Helvetica text (so the text layer and find have content), and a 2-entry outline
 * (so the sidebar outline assertion has data). Re-run with `node tools/make-pdf-fixture.mjs`
 * if the fixture ever needs regenerating; the output is otherwise static.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'test', 'e2e', 'fixtures', 'sample.pdf');

// Each page's visible text. "Conduit" appears on page 1 — the find/highlight target.
const PAGE1_TEXT = 'Conduit PDF fixture page one selectable text';
const PAGE2_TEXT = 'Second page of the fixture with more words';

const objects = [];
function add(body) {
  objects.push(body);
  return objects.length; // 1-based object number
}

function contentStream(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
}

// Object layout (numbers must stay stable for the /Kids + /Outlines refs below):
//   1 Catalog, 2 Pages, 3 Page1, 4 Page1 content, 5 Page2, 6 Page2 content,
//   7 Font, 8 Outlines, 9 Outline item A, 10 Outline item B
add('<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>'); // 1
add('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'); // 2
add(
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
); // 3
add(contentStream(PAGE1_TEXT)); // 4
add(
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
); // 5
add(contentStream(PAGE2_TEXT)); // 6
add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 7
add('<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 2 >>'); // 8
add('<< /Title (First Section) /Parent 8 0 R /Next 10 0 R /Dest [3 0 R /Fit] >>'); // 9
add('<< /Title (Second Section) /Parent 8 0 R /Prev 9 0 R /Dest [5 0 R /Fit] >>'); // 10

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefStart = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += '0000000000 65535 f \n';
for (const off of offsets) {
  pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

writeFileSync(out, pdf, 'latin1');
console.log(`Wrote ${out} (${pdf.length} bytes, ${objects.length} objects, 2 pages)`);

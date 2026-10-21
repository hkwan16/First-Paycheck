// Writes e2e/fixtures/acme-paystub.pdf: a synthetic one-page text PDF of the
// mockup's pay stub (Acme Corp, J. Rivera), for confirm.spec.ts. Invented
// data only, never a real document: the SSN is the well-known example
// 123-45-6789, and the deposit account is printed masked, as stubs do.
// The lines follow api/tests/fixtures/llm/extract_pay_stub.json, so the
// API's FakeGateway answer links to them. Run: node e2e/fixtures/make-acme-paystub.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LINES = [
  'ACME CORP EARNINGS STATEMENT',
  'Employee Rivera, J',
  'SSN 123-45-6789',
  'Direct Deposit Acct ****4821',
  'Pay Frequency Semi-monthly',
  'Pay Date 10/15/2026',
  'Period 10/01/2026 - 10/15/2026',
  'Gross Pay 2,708.33',
  'Federal Income Tax 297.76',
  'Social Security 167.92',
  'Medicare 39.27',
  'CA State Tax 98.14',
  'CA SDI 32.50',
  '401(k) -',
  'Medical Pretax 62.50',
  'Dental/Vision 14.20',
  'Net Pay 1,996.04',
  'YTD Gross 5,416.66',
];

const pdfString = (text) => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

function textPdf(lines, fontSize = 11) {
  const ops = [`BT /F1 ${fontSize} Tf ${fontSize + 4} TL 72 720 Td`];
  for (const line of lines) ops.push(`${pdfString(line)} Tj T*`);
  ops.push('ET');
  const stream = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const target = fileURLToPath(new URL('./acme-paystub.pdf', import.meta.url));
writeFileSync(target, textPdf(LINES));

# 004: Upload, ingest and redaction

Status: Implemented, M2.

## Goal

Take a document the user uploads (a pay stub, an offer letter or a benefits summary as PDF, PNG or JPEG), keep its bytes in `document_blobs` under row-level security until the user confirms what was read from it, and turn it into pages that are safe to show a language model: text-layer PDF pages redacted as text, every other page rasterized, OCR'd and redacted in the image itself, and pages whose OCR is too unreliable to redact withheld entirely. Code: `api/ingest/` (`store.py`, `reader.py`, `ocr.py`, `redact.py`, `chunk.py`, `pipeline.py`), the upload and listing routes in `api/app/routers/docs.py`, the rate limiter in `api/app/ratelimit.py`, retention in `api/jobs/scheduler.py`, migration `0003_documents`. What the model does with the pages is spec 005.

## Inputs

| Input | Type | Valid range |
|---|---|---|
| `POST /docs` `file` | multipart file part | 1 byte to 10 MB (10,485,760 bytes); a PDF, PNG or JPEG by its leading bytes |
| `POST /docs` `type` | form field or query | `pay_stub`, `offer_letter`, `benefits` |
| Stored bytes | `document_blobs.bytes` | As uploaded |
| OCR settings | constants in `ingest/ocr.py` | Tesseract `--psm 6`, English |

## Outputs

- `POST /docs` (201): `{document_id}`. The `documents` row starts `uploaded`.
- `GET /docs`: the user's documents, newest first: `{id, type, status, status_reason, redaction_count, page_count, uploaded_at, confirmed_at, deleted_at}`.
- `prepare_document(bytes, content_type) -> PreparedDocument` (worker only): `page_count`, per page its number, `source` (`text` or `ocr`), redacted lines, redaction count, OCR mean confidence, and either the model input (`TextPage` with redacted text, or `ImagePage` with a redacted PNG) or a withheld reason.
- `chunk_words(text) -> list[str]`: retrieval chunks for `benefits_chunks`.

## Rules

### Upload and storage

1. `POST /docs` reads the file part and decides its type from its leading bytes, not the client's `Content-Type`: `%PDF-` is `application/pdf`, `\x89PNG\r\n\x1a\n` is `image/png`, `\xff\xd8\xff` is `image/jpeg`. Anything else is 415 `unsupported_media_type`.
2. An empty file is 422. More than 10,485,760 bytes is 413 `file_too_large`; a `Content-Length` header already above the limit plus 64 KB of multipart overhead is refused before the body is read.
3. The route stores the bytes with `ingest/store.py:put` and inserts the `documents` row (`status = uploaded`, `content_type`, `size_bytes`) in the request's one transaction. Nothing is parsed, OCR'd or sent anywhere in the API process.
4. `ingest/store.py` is the only module that reads or writes `document_blobs` (`put`, `get`, `delete`, `expire_unconfirmed`). `tests/unit/test_boundaries.py` enforces it.
5. **Rate limit.** A user may store 10 uploads per clock hour (UTC). The counter is a row in `rate_limit_counters (user_id, bucket, window_start, count)`, incremented with one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` in the request's transaction, so concurrent uploads cannot both slip under the limit. The 11th upload in a window is 429 `rate_limited` with a `Retry-After` header (seconds to the next window), and its increment rolls back with the request, so refused and failed uploads do not count.

### Reading (worker only)

6. A PDF is opened with pdfplumber. A page has a text layer when its extracted words hold at least 20 non-space characters. Its words come with boxes (`x0, top, x1, bottom`, PDF points).
7. A PDF page without a text layer is rasterized with pypdfium2 at 200 dpi and OCR'd. A PNG or JPEG upload is one page: EXIF orientation is applied, it is converted to RGB, and an image whose long edge exceeds 3,300 px is scaled down to 3,300 px before OCR.
8. At most the first 30 pages are read. `page_count` is the document's real page count; pages past 30 are reported as withheld with reason `page_limit`.
9. A file pdfplumber, pypdfium2 or Pillow cannot open, or a PDF with no pages, raises `UnreadableDocument`; the extract job then marks the document `failed` (spec 005).

### OCR

10. `pytesseract.image_to_data` with `--psm 6` returns words with boxes (pixels) and a confidence 0-100; entries with an empty text or a confidence of -1 are dropped. Words are grouped into lines by Tesseract's `(block, paragraph, line)` numbers, in reading order.
11. A page's mean confidence is the arithmetic mean of its words' confidences; a page with no words has mean 0.
12. **A page whose mean confidence is below 60 is withheld**: it is not sent to the model and its lines are not shown, because an SSN that OCR misread cannot be found to redact. The user types that page's fields by hand.

### Lines

13. Words are grouped into lines: text-layer words by vertical overlap (a word joins a line when its vertical center lies within the line's top and bottom), OCR words by rule 10. A line's text is its words joined by single spaces, left to right; a page's text is its lines joined by `\n`.

### Redaction

14. `find_sensitive(text)` returns non-overlapping spans, scanning in this order; a later pattern never matches inside an earlier span:

    | Kind | Pattern | Context needed |
    |---|---|---|
    | `ssn` | `\d{3}-\d{2}-\d{4}` | None |
    | `ein` | `\d{2}-\d{7}` | None |
    | `ssn` | `\d{3}[ -]?\d{2}[ -]?\d{4}` (nine digits, optionally grouped) | `SSN`, `SS#`, `Social`, `Soc Sec` or `Taxpayer ID` within the 60 characters before it |
    | `account` | eight to seventeen digits, optionally separated by single dashes | `Acct`, `Account`, `Routing`, `ABA`, `Transit` or `Direct deposit` within the 60 characters before it |

    Context words match case-insensitively on word boundaries. Every pattern must stand alone: no digit, letter, `.`, `,` or `-` immediately before it, and no digit or letter immediately after it, nor `.`/`,`/`-` followed by a digit. So `1,234.56`, `2026-10-15` and `x123-45-6789` never match.
15. `redact_text(text) -> (text, count)` replaces each span with `[REDACTED]` and returns how many spans it replaced. Line breaks are never inside a span, so the redacted text keeps its lines.
16. `redact_image(image, lines) -> (image, count)` finds the spans in the page text built from `lines` (rule 13), and draws a filled black rectangle over every word box that overlaps a span, padded by 4 px on each side and clipped to the image. `count` is the number of spans. The input image is not modified.
17. A text-layer page is sent as its redacted text. An OCR page is sent as its redacted image, re-encoded as PNG and scaled so its long edge is at most 2,576 px. The document's `redaction_count` is the sum over pages that were read (withheld pages count none).
18. Masked numbers (`XXX-XX-1234`, `****4821`) are already safe and are left as printed.

### Chunking

19. `chunk_words(text, size=400, overlap=50)` splits on whitespace and returns chunks of up to 400 words joined by single spaces; chunk `k` starts at word `350 * k`; the last chunk is the first one that reaches the final word. Empty text gives no chunks.

### Retention

20. Confirming a document deletes its blob and sets `deleted_at` in the confirm transaction (spec 005).
21. Every scheduler tick (spec 002 rule 36) runs `store.expire_unconfirmed(now)` on the privileged connection: every document not `confirmed`, not yet deleted, and created more than 7 days before `now` loses its blob and becomes `failed` with `status_reason = 'expired'` and `deleted_at = now`. The tick reports the count as `expired`. The same tick deletes `rate_limit_counters` rows whose window ended more than a day earlier.

### Documents table and statuses

22. `documents.status` is one of `uploaded`, `extracting`, `proposed`, `confirmed`, `manual_entry_required`, `failed`. `status_reason` is set exactly when the status is `manual_entry_required` or `failed` (`refused`, `no_readable_page`, `budget`, `extraction_failed`, `unreadable_file`, `expired`). `confirmed_at` is set exactly when the status is `confirmed`.
23. `page_count` is null until a document has been read, then the real page count.

## Hand-worked examples

### Redaction (`tests/unit/ingest/test_redact.py::test_redaction_table`)

| # | Text | Redacted | Count |
|---|---|---|---|
| 1 | `SSN 123-45-6789` | `SSN [REDACTED]` | 1 |
| 2 | `Employee ID 123-45-6789` | `Employee ID [REDACTED]` | 1 |
| 3 | `Social Security Number: 900123456` | `Social Security Number: [REDACTED]` | 1 |
| 4 | `SSN\n900 12 3456` | `SSN\n[REDACTED]` | 1 |
| 5 | `Badge 900123456` | unchanged | 0 |
| 6 | `Direct Deposit Acct 000123456789` | `Direct Deposit Acct [REDACTED]` | 1 |
| 7 | `Routing 021000021 Account 4411-2233-9988` | `Routing [REDACTED] Account [REDACTED]` | 2 |
| 8 | `Employer EIN 12-3456789` | `Employer EIN [REDACTED]` | 1 |
| 9 | `Account ****4821 Amount 1,996.04` | unchanged | 0 |
| 10 | `Social Security 167.92 1,343.36` | unchanged | 0 |
| 11 | `XXX-XX-6789` | unchanged | 0 |
| 12 | `Pay date 2026-10-15 Check 12345678` | unchanged | 0 |
| 13 | `Acct 12345678901234567890` | unchanged | 0 |

Row 4: the label is on the line above, inside the 60-character window, and the digits are grouped by spaces. Row 5: nine digits with no SSN word nearby are not an SSN. Row 10: the Social Security tax line has the context word but no nine-digit run. Row 12: eight digits after "Check" have no account context word. Row 13: twenty digits are longer than any account number, so the pattern cannot stand alone in them.

### Chunking (`tests/unit/ingest/test_chunk.py`)

| Words | Chunks (word ranges, end exclusive) |
|---|---|
| 0 | none |
| 10 | `[0, 10)` |
| 400 | `[0, 400)` |
| 401 | `[0, 400)`, `[350, 401)` |
| 1,000 | `[0, 400)`, `[350, 750)`, `[700, 1000)` |

Working for 1,000 words: the stride is 400 - 50 = 350, so chunks start at 0, 350 and 700; the third ends at word 1,000, the final word, so it is the last.

### Rate limit (`tests/integration/test_docs_flow.py::test_upload_rate_limit`)

Ten uploads in one hour succeed; the eleventh is 429 with `Retry-After` between 1 and 3,600; no document row is written for it.

## Edge cases

- A PDF whose every page is withheld (all scanned and unreadable) has no usable page; spec 005 marks it `manual_entry_required` (`no_readable_page`).
- A PNG declared as `application/pdf` by the client is stored as `image/png` (rule 1).
- A document deleted by retention while its extract job waits: the job finds no blob and finishes with `{"status": "skipped"}`.
- Re-uploading the same file creates a second document; uploads are not deduplicated.

## Out of scope

- Supabase Storage (spec amendment 3 keeps the bytes in Postgres behind `store.py`).
- Handwriting, non-English documents, and rotation beyond what Tesseract's `--psm 6` tolerates (a few degrees).
- Redacting names and addresses. Only identifiers that unlock accounts or identity (SSN, account and routing numbers, EIN) are removed.
- Virus scanning of uploads.

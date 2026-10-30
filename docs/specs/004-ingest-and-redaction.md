# 004: Upload, ingest and redaction

Status: Implemented, M2. Rules 24-31 (replacing a document) added after the October 29 alpha, where Replace left the old document listed beside its replacement (issue #134). Rules 32-37 (reading again after the model was unavailable) added for issue #163.

## Goal

Take a document the user uploads (a pay stub, an offer letter or a benefits summary as PDF, PNG or JPEG), keep its bytes in `document_blobs` under row-level security until the user confirms what was read from it, and turn it into pages that are safe to show a language model: text-layer PDF pages redacted as text, every other page rasterized, OCR'd and redacted in the image itself, and pages whose OCR is too unreliable to redact withheld entirely. Code: `api/ingest/` (`store.py`, `reader.py`, `ocr.py`, `redact.py`, `chunk.py`, `pipeline.py`), the upload and listing routes in `api/app/routers/docs.py`, the rate limiter in `api/app/ratelimit.py`, retention in `api/jobs/scheduler.py`, migration `0003_documents`. What the model does with the pages is spec 005.

## Inputs

| Input | Type | Valid range |
|---|---|---|
| `POST /docs` `file` | multipart file part | 1 byte to 10 MB (10,485,760 bytes); a PDF, PNG or JPEG by its leading bytes |
| `POST /docs` `type` | multipart form field | `pay_stub`, `offer_letter`, `benefits` |
| `POST /docs` `replaces` | optional multipart form field | The id of one of the user's documents of the same `type` that has not been replaced (rules 24-31) |
| Stored bytes | `document_blobs.bytes` | As uploaded |
| OCR settings | constants in `ingest/ocr.py` | Tesseract `--psm 6`, English |

## Outputs

- `POST /docs` (201): `{document_id}`. The `documents` row starts `uploaded`. FastAPI's Swagger UI, which defaults to `/docs`, is served at `/api-docs` instead.
- `GET /docs`: the user's documents that have not been replaced, newest first: `{id, type, status, status_reason, redaction_count, page_count, uploaded_at, confirmed_at, deleted_at, replaced_by_id, can_read_again}` (`can_read_again`: rule 33). `GET /docs/{id}` returns the same fields for any of the user's documents, replaced or not, plus `proposal` (spec 005).
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

    Context words match case-insensitively on word boundaries. When both kinds of label sit in a nine-digit number's window, the nearer one decides: an SSN label nearer makes it an `ssn`, an account label nearer leaves it to the `account` rule (so `SSN 123-45-6789 Routing 021000021` reports the routing number as `account`). Every pattern must stand alone: no digit, letter, `.`, `,` or `-` immediately before it, and no digit or letter immediately after it, nor `.`/`,`/`-` followed by a digit. So `1,234.56`, `2026-10-15` and `x123-45-6789` never match.
15. `redact_text(text) -> (text, count)` replaces each span with `[REDACTED]` and returns how many spans it replaced. Line breaks are never inside a span, so the redacted text keeps its lines.
16. `redact_image(image, lines) -> (image, count)` finds the spans in the page text built from `lines` (rule 13), and draws a filled black rectangle over every word box that overlaps a span, padded by 4 px on each side and clipped to the image. `count` is the number of spans. The input image is not modified.
17. A text-layer page is sent as its redacted text. An OCR page is sent as its redacted image, re-encoded as PNG and scaled so its long edge is at most 2,576 px. The document's `redaction_count` is the sum over pages that were read (withheld pages count none).
18. Masked numbers (`XXX-XX-1234`, `****4821`) are already safe and are left as printed.

### Chunking

19. `chunk_words(text, size=400, overlap=50)` splits on whitespace and returns chunks of up to 400 words joined by single spaces; chunk `k` starts at word `350 * k`; the last chunk is the first one that reaches the final word. Empty text gives no chunks.

### Retention

20. Confirming a document deletes its blob and sets `deleted_at` in the confirm transaction (spec 005).
21. Every scheduler tick (spec 002 rule 36) runs `store.expire_unconfirmed(now)` on the privileged connection: every document not `confirmed`, not yet deleted, and created more than 7 days before `now` loses its blob and becomes `failed` with `status_reason = 'expired'` and `deleted_at = now`. The tick reports the count as `expired`. The same tick deletes `rate_limit_counters` rows whose window started more than a day before `now` (`app/ratelimit.py:prune_counters`).

### Documents table and statuses

22. `documents.status` is one of `uploaded`, `extracting`, `proposed`, `confirmed`, `manual_entry_required`, `failed`. `status_reason` is set exactly when the status is `manual_entry_required` or `failed` (`refused`, `no_readable_page`, `budget`, `extraction_failed`, `unreadable_file`, `expired`, `no_model`: the worker has no gateway (outside production only, spec 003 rule 12a), or the API rejected its key or model id (spec 003 rule 24), so the user types the fields from the redacted lines). `confirmed_at` is set exactly when the status is `confirmed`.
23. `page_count` is null until a document has been read, then the real page count.

### Replacing a document

The Link screen's Replace button on a document's row uploads a new file in that document's place. Before rule 24 the API had no notion of it: Replace sent a plain upload, so the old document stayed listed beside the new one.

24. **Replace.** `POST /docs` with `replaces = <document id>` stores the new document as rule 3 does and, in the same transaction, *retires* the document it names: that document's `replaced_by_id` becomes the new document's id. The named document is locked (`SELECT ... FOR UPDATE`) before anything is written, so of two concurrent replacements of one document only the first succeeds; the second sees it replaced (rule 29). A document is replaced at most once and replaces at most one (`UNIQUE (replaced_by_id)`); `(replaced_by_id, user_id)` references `documents (id, user_id)`, so a replacement is always the same user's.
25. **What retiring does.** The retired document's blob is deleted (`store.delete`) and its `deleted_at` set to now unless it was already set; its `proposal` is cleared, because nothing will review it again. Its row stays (documents have no DELETE, spec 001), and so do its `status`, `status_reason`, `confirmed_at`, `page_count` and `redaction_count`: they record what happened to it before it was replaced. A retired document always has `deleted_at` (`CHECK (replaced_by_id IS NULL OR deleted_at IS NOT NULL)`).
26. **Confirmed values are kept.** Retiring a `confirmed` document removes nothing that was confirmed from it: its `pay_stubs` row, its `benefits_plans` and `benefits_chunks`, and the profile's match and vesting stay. The replacement is an upload like any other, read and then only a proposal until the user confirms it; once they do, its values lead the way any newer confirm does (`GET /pay-stubs` is newest pay date first, `GET /benefits-plans` newest confirmed summary first). So a user who replaces a confirmed pay stub and never confirms the new one keeps the values they confirmed.
27. **Where a retired document shows.** `GET /docs` lists only documents whose `replaced_by_id` is null, so the replacement takes the replaced document's place in the list. `GET /docs/{id}` still answers for a retired document, with `replaced_by_id` set and `proposal` null, so a screen still open on it can say it was replaced and link to the replacement.
28. **A retired document is final.** `POST /docs/{id}/extract` and `POST /docs/{id}/confirm` on it are 409 `document_replaced`, checked before `document_confirmed` and `document_deleted`. An `ingest.extract` job queued or running for it writes nothing and ends `{"status": "skipped"}`: a job that has not read the blob finds none, and one that already has finds the document no longer current when it comes to write (spec 005 rule 10). A model call it already made is spent.
29. **Refusals.** A `replaces` id the user cannot see (unknown, or another user's: row-level security hides it) is 404 `not_found`, never 403. A document of another `type` is 422 `replace_type_mismatch`; one already replaced is 409 `document_replaced`; a value that is not a UUID is 422. Every refused upload, these and rules 1, 2 and 5's (415, 413, 422, 429), rolls back the whole request: no new document is stored and the named one is untouched.
30. **Any status can be replaced**: `uploaded`, `extracting`, `proposed`, `manual_entry_required`, `failed` (an expired one included) and `confirmed`. A replacement that later turns out unreadable (`failed`, `unreadable_file`) does not bring the retired document back; the user replaces the failed one in turn.
31. **Limits and retention.** A replacement is one upload against rule 5's limit. Retention (rule 21) never touches a retired document, which already has `deleted_at` and no blob.

### Reading again

Two pay stubs uploaded while production's model key was saved under a misspelled name went to manual entry (`no_model`). A day after the key was fixed they still said "Automatic reading is off right now", and the only ways forward were typing every field or Replace: nothing asked for the reading again, and the notice described the moment of reading as if it were now. The Confirm screen's source pane also called the lines "Source, as the AI saw it" though no AI had seen them (issue #163).

32. **Why manual entry, by who caused it.** A document is `manual_entry_required` for a reason about the reading or for one about the document. *The reading was unavailable*: `no_model` (no gateway, or the API rejected the key or model id), `budget` (the user's daily LLM budget was spent before the call) and `extraction_failed` (every attempt ended in a schema or API error, spec 005 rule 13). Nothing about the document caused them, so a later reading can succeed. *The document was read*: `refused` (the model read the redacted pages and declined) and `no_readable_page` (no page could be redacted safely, rule 12, which the same bytes would repeat). These are the outcome of reading it; the person types the fields.
33. **`can_read_again`.** `DocumentOut.can_read_again` is true exactly when the document is `manual_entry_required` with a reason of the first kind, its type can be read (`pay_stub`, `benefits`), it has not been replaced (rule 28) and its file has not been deleted. It is the one place the rule lives; the client offers "Read again" when it is true.
34. **Reading again.** `POST /docs/{id}/extract` on such a document queues a new `ingest.extract` job exactly as spec 005 rule 9 does from `uploaded`: status `extracting`, `status_reason` cleared, the new job's id. It counts against the extract limit (20 per user per clock hour, 429 `rate_limited` with `Retry-After`; a refused request does not count), and the job then spends the daily LLM budget like any reading. A budget still spent sends the document back to manual entry with `budget` at no cost (the gateway refuses before any HTTP).
35. **Not again for a final outcome.** The same request on a `manual_entry_required` document with `refused` or `no_readable_page` is 409 `document_already_read`, after the 404, `document_replaced`, `document_confirmed` and `document_deleted` checks, and queues nothing.
36. **Redaction holds.** A reading again starts from the stored bytes and runs rules 6-18 again, so the model is sent only redacted pages, never the manual-entry proposal or anything typed. The new outcome (a proposal, or manual entry with its new reason) replaces the old proposal, which held only redacted source lines.
37. **Words say what happened then.** A reason is a past event: the notice says what happened when the document was read ("The AI was not available when this was read, so nothing was filled in."), never a claim about now ("Automatic reading is off right now"), and offers Read again when `can_read_again`. The source pane is titled "Source, as the AI saw it" only for lines that were sent to the model (a proposal, `refused`, `extraction_failed`); for `no_model`, `budget` and `no_readable_page` it is "Source, redacted" and says the lines were not sent to the AI.

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

### Rate limit (`tests/integration/test_docs_flow.py::test_rate_limit_is_ten_per_clock_hour`)

Ten uploads in one hour succeed; the eleventh is 429 with `Retry-After` between 1 and 3,600; no document row is written for it.

### Replace (`tests/integration/test_docs_replace.py`)

A is the user's pay stub with a blob unless the row says otherwise; B is the upload that names it in `replaces`. "Untouched" means A's row, blob and proposal are as they were and no B exists.

| # | A before | Request | Result |
|---|---|---|---|
| 1 | `manual_entry_required` (`no_model`), proposal of source lines (the October 29 alpha) | pay stub PDF, `replaces = A` | 201 `{document_id: B}`. `GET /docs` lists B (`uploaded`) and not A. A keeps `manual_entry_required` (`no_model`), gains `replaced_by_id = B` and `deleted_at = now`, loses its blob and proposal. `GET /docs/A` answers 200 with `replaced_by_id = B`, `proposal` null |
| 2 | `confirmed`, with its `pay_stubs` row | pay stub PDF, `replaces = A` | 201. `GET /docs` lists B only; `GET /pay-stubs` still returns A's stub; A's `deleted_at` keeps its confirm time |
| 3 | `confirmed` benefits summary, its plans, chunks and the profile's match | benefits PDF, `replaces = A` | 201. `GET /benefits-plans` and the profile's match unchanged; A's chunks kept |
| 4 | `extracting` under job J, which has not run | pay stub PDF, `replaces = A`, then J runs | 201; J succeeds with `{"status": "skipped"}`; A stays `extracting`, retired |
| 5 | `extracting` under job J, which has read the blob and is waiting on the model | as row 4; J then writes | J ends `{"status": "skipped"}`; A's status and proposal are not written |
| 6 | `proposed` | `POST /docs/A/confirm` and `POST /docs/A/extract` after row 1's replace | 409 `document_replaced` both; no `pay_stubs` row, no job |
| 7 | a benefits summary | pay stub PDF, `replaces = A` | 422 `replace_type_mismatch`; untouched |
| 8 | already replaced by B | pay stub PDF, `replaces = A` | 409 `document_replaced`; no third document |
| 9 | (any) | a GIF, `replaces = A` | 415; untouched |
| 10 | (none: a random id) | pay stub PDF, `replaces = <random>` | 404 `not_found`; nothing stored |
| 11 | user A's, user B asks | user B: pay stub PDF, `replaces = A` | 404 `not_found`; nothing stored for B; A untouched (`tests/rls/test_cross_user.py`) |
| 12 | 7 days old, `uploaded`, then replaced | the scheduler tick's `expire_unconfirmed` | A is not counted or changed again; B (new) is not expired |

### Reading again (`tests/integration/test_docs_read_again.py`)

| # | Document | Request | Result |
|---|---|---|---|
| 1 | Acme stub read by a worker with no model: `manual_entry_required` (`no_model`), proposal of redacted source lines | `GET /docs`, then `POST /docs/{id}/extract`, then the worker runs with a model | `can_read_again` true; 202 with a new job; the document `extracting`, `status_reason` null, `can_read_again` false; then `proposed` with the fields read, and the model was sent no SSN |
| 2 | `manual_entry_required` (`budget`), file kept | `POST /docs/{id}/extract` | 202; `extracting` |
| 3 | `manual_entry_required` (`extraction_failed`), file kept | `POST /docs/{id}/extract` | 202; `extracting` |
| 4 | `manual_entry_required` (`refused`) | `POST /docs/{id}/extract` | 409 `document_already_read`; no job; `can_read_again` false |
| 5 | `manual_entry_required` (`no_readable_page`) | `POST /docs/{id}/extract` | 409 `document_already_read`; no job |
| 6 | Row 1's document, replaced by B | `GET /docs/{id}`, `POST /docs/{id}/extract` | `can_read_again` false; 409 `document_replaced` |
| 7 | Row 1's document, 20 extract requests counted this hour | `POST /docs/{id}/extract` | 429 `rate_limited`; still `manual_entry_required` (`no_model`) |
| 8 | Row 1's document, user B asks | `POST /docs/{id}/extract` | 404 `not_found` (`tests/rls/test_cross_user.py`) |

## Edge cases

- A PDF whose every page is withheld (all scanned and unreadable) has no usable page; spec 005 marks it `manual_entry_required` (`no_readable_page`).
- A PNG declared as `application/pdf` by the client is stored as `image/png` (rule 1).
- A document deleted by retention while its extract job waits: the job finds no blob and finishes with `{"status": "skipped"}`.
- Re-uploading the same file creates a second document; uploads are not deduplicated. Replace (rule 24) is the way one upload takes another's place.
- Two Replace presses on one row before the list refreshes: the first upload retires the document, the second is 409 `document_replaced` and stores nothing (rule 29).
- A retired benefits summary's chunks stay searchable for explanations, like any confirmed summary's (rule 26); `retrieval/benefits_search.py` searches every chunk the user has, not only the newest summary's.

## Out of scope

- Supabase Storage (spec amendment 3 keeps the bytes in Postgres behind `store.py`).
- Handwriting, non-English documents, and rotation beyond what Tesseract's `--psm 6` tolerates (a few degrees).
- Redacting names and addresses. Only identifiers that unlock accounts or identity (SSN, account and routing numbers, EIN) are removed.
- Virus scanning of uploads.

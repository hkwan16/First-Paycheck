import type {
  Account,
  CalendarEvent,
  Decision,
  DocumentSummary,
  Explanation,
  Job,
  PayStub,
  Profile,
  Proposal,
  Transaction,
} from '@/lib/api/types';
import {
  sampleCalendarEvent,
  sampleDecision,
  sampleExplanation,
  sampleProfile,
} from '../fixtures/decisions';
import { emptyProfile, sampleDocument, samplePayStub, sampleProposal } from '../fixtures/documents';
import { sampleAccounts, sampleTransactions } from '../fixtures/sample';

/**
 * The in-memory API state behind the default MSW handlers. Mutations change it
 * the way the real API would, so a refetch after a PATCH reads the new value.
 * `resetDb()` runs after every test (src/test/setup.ts).
 */
export interface TestDb {
  accounts: Account[];
  transactions: Transaction[];
  jobs: Map<string, Job>;
  /** Accounts a linked item's initial sync will add when its job succeeds. */
  pendingAccounts: Map<string, Account[]>;
  /** Newest first, as `GET /docs` lists them. */
  documents: DocumentSummary[];
  /** Each document's proposal, by id; `GET /docs/{id}` shows it while reviewable. */
  proposals: Map<string, Proposal>;
  /** The proposal an extraction job writes when it succeeds. */
  nextProposal: Proposal;
  payStubs: PayStub[];
  profile: Profile;
  /** Every saved version, oldest first; `is_current` is worked out when read. */
  decisions: Decision[];
  /** Each decision's explanation rows, oldest first. */
  explanations: Map<string, Explanation[]>;
  calendar: CalendarEvent[];
  /** False: `POST /explain` answers 503 `llm_unavailable` when it needs the model. */
  llmConfigured: boolean;
  /** How the next explain runs end, one per run; a run with none left verifies. */
  explainOutcomes: ('verified' | 'fallback')[];
}

export const db: TestDb = {
  accounts: [],
  transactions: [],
  jobs: new Map(),
  pendingAccounts: new Map(),
  documents: [],
  proposals: new Map(),
  nextProposal: sampleProposal,
  payStubs: [],
  profile: emptyProfile,
  decisions: [],
  explanations: new Map(),
  calendar: [],
  llmConfigured: true,
  explainOutcomes: [],
};

const clone = <T>(value: T): T => structuredClone(value);

/**
 * The sample dataset: two Chase accounts, sixteen October transactions, and
 * the Acme pay stub read and waiting for review.
 */
export function resetDb() {
  db.accounts = clone([...sampleAccounts]);
  db.transactions = clone([...sampleTransactions]);
  db.jobs = new Map();
  db.pendingAccounts = new Map();
  const stub = sampleDocument();
  db.documents = [stub];
  db.proposals = new Map([[stub.id, clone(sampleProposal)]]);
  db.nextProposal = clone(sampleProposal);
  db.payStubs = [];
  db.profile = clone(emptyProfile);
  db.decisions = [];
  db.explanations = new Map();
  db.calendar = [];
  db.llmConfigured = true;
  db.explainOutcomes = [];
}

/**
 * Ready for decisions: the sample stub confirmed and the profile holding the
 * salary, pay schedule, filing status and match formula the 401(k) card reads.
 */
export function decisionsReady() {
  db.payStubs = [samplePayStub()];
  db.profile = clone(sampleProfile);
}

/** `decisionsReady`, plus the 401(k) decision v1 at 4%, its explanation and its check. */
export function savedDecision() {
  decisionsReady();
  const decision = sampleDecision();
  db.decisions = [decision];
  db.explanations = new Map([[decision.id, [sampleExplanation()]]]);
  db.calendar = [sampleCalendarEvent()];
}

/** A user who has linked and uploaded nothing yet. */
export function emptyDb() {
  db.accounts = [];
  db.transactions = [];
  emptyDocuments();
}

/** No documents and no confirmed pay stubs. */
export function emptyDocuments() {
  db.documents = [];
  db.proposals = new Map();
  db.payStubs = [];
}

resetDb();

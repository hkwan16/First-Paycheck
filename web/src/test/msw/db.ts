import type {
  Account,
  DocumentSummary,
  Job,
  PayStub,
  Profile,
  Proposal,
  Transaction,
} from '@/lib/api/types';
import { emptyProfile, sampleDocument, sampleProposal } from '../fixtures/documents';
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

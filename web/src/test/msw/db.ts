import type { Account, Job, Transaction } from '@/lib/api/types';
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
}

export const db: TestDb = {
  accounts: [],
  transactions: [],
  jobs: new Map(),
  pendingAccounts: new Map(),
};

const clone = <T>(value: T): T => structuredClone(value);

/** The sample dataset: two Chase accounts and sixteen October transactions. */
export function resetDb() {
  db.accounts = clone([...sampleAccounts]);
  db.transactions = clone([...sampleTransactions]);
  db.jobs = new Map();
  db.pendingAccounts = new Map();
}

/** A user who has linked nothing yet. */
export function emptyDb() {
  db.accounts = [];
  db.transactions = [];
}

resetDb();

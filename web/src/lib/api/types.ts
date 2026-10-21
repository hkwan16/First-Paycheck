import type { components } from './schema';

/*
 * Short names for the generated schema types. Aliases only: every shape is
 * defined by the API and regenerated with `pnpm gen:api`.
 */

type Schemas = components['schemas'];

export type Account = Schemas['AccountOut'];
export type AccountPatch = Schemas['AccountPatch'];
export type AccountRole = Schemas['AccountRole'];
export type AccountKind = Schemas['AccountKind'];
export type Transaction = Schemas['TransactionOut'];
export type TransactionPage = Schemas['TransactionPage'];
export type CategoryFix = Schemas['CategoryFix'];
export type Category = Schemas['CategoryPatch']['category'];
export type CategorySource = Schemas['CategorySource'];
export type Job = Schemas['JobOut'];
export type JobKind = Schemas['JobKind'];
export type JobStatus = Schemas['JobStatus'];
export type LinkToken = Schemas['LinkToken'];
export type LinkedItem = Schemas['LinkedItem'];
export type LinkItemRequest = Schemas['LinkItemRequest'];
export type ErrorResponse = Schemas['ErrorResponse'];
export type DocumentType = Schemas['DocumentType'];
export type DocumentStatus = Schemas['DocumentStatus'];
export type DocumentStatusReason = Schemas['DocumentStatusReason'];
export type DocumentSummary = Schemas['DocumentOut'];
export type DocumentDetail = Schemas['DocumentDetail'];
export type DocumentCreated = Schemas['DocumentCreated'];
export type Proposal = Schemas['Proposal'];
export type ProposedField = Schemas['ProposedField'];
export type SourceLine = Schemas['SourceLine'];
export type LineItem = Schemas['LineItem'];
export type PayStubValues = Schemas['PayStubValues'];
export type PayFrequency = Schemas['PayFrequency'];
export type PayStub = Schemas['PayStubOut'];
export type ConfirmIn = Schemas['ConfirmIn'];
export type Confirmed = Schemas['Confirmed'];
export type Profile = Schemas['ProfileOut'];
export type ProfileIn = Schemas['ProfileIn'];

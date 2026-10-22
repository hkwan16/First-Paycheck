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
export type SyncProvider = Schemas['SyncProvider'];
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
export type FilingStatus = Schemas['FilingStatus'];
export type MatchTier = Schemas['MatchTier-Output'];
export type MatchTierIn = Schemas['MatchTier-Input'];
export type K401MatchInput = Schemas['K401MatchInput'];
export type K401MatchResult = Schemas['K401MatchResult'];
export type CalculatorKind = Schemas['CalculatorKind'];
export type Decision = Schemas['DecisionOut'];
export type DecisionIn = Schemas['DecisionIn'];
export type DecisionSaved = Schemas['DecisionSaved'];
export type DecisionList = Schemas['DecisionList'];
export type CalculatorDecisions = Schemas['CalculatorDecisions'];
export type DecisionVersion = Schemas['DecisionVersion'];
export type CalendarEvent = Schemas['CalendarEventOut'];
export type Explanation = Schemas['ExplanationOut'];
export type ExplainIn = Schemas['ExplainIn'];
export type Citation = Schemas['CitationOut'];
export type NumberClaim = Schemas['NumberClaim'];

// Spending, cash flow, recurring charges and CSV import (M5).
export type SpendingSummary = Schemas['SpendingSummary'];
export type SpendingBucket = Schemas['CategoryTotal']['bucket'];
export type CategoryTotal = Schemas['CategoryTotal'];
export type CashFlow = Schemas['CashFlow'];
export type PayStubFlow = Schemas['PayStubFlow'];
export type WithholdingTotal = Schemas['WithholdingTotal'];
export type WithholdingLine = Schemas['WithholdingLine'];
export type RecurringCharge = Schemas['RecurringChargeOut'];
export type RecurringPatch = Schemas['RecurringPatch'];
export type RecurringStatus = Schemas['RecurringStatus'];
export type RecurringUserStatus = Schemas['RecurringUserStatus'];
export type RecurringCadence = Schemas['RecurringCadence'];
export type CsvImport = Schemas['CsvImport'];
export type AmountSign = Schemas['AmountSign'];

// Emergency fund, goals, health plans and benefits summaries (M6).
export type EmergencyFundInput = Schemas['EmergencyFundInput'];
export type EmergencyFundResult = Schemas['EmergencyFundResult'];
export type HealthPlansInput = Schemas['HealthPlansInput'];
export type HealthPlansResult = Schemas['HealthPlansResult'];
export type HealthPlanOption = Schemas['HealthPlanOption'];
export type HealthcareUsage = Schemas['HealthcareUsage'];
export type PlanCost = Schemas['PlanCost'];
export type PlanPair = Schemas['PlanPair'];
export type PlanKind = Schemas['PlanKind'];
export type Goal = Schemas['GoalOut'];
export type GoalPatch = Schemas['GoalPatch'];
export type GoalStatus = Schemas['GoalStatus'];
export type CalendarKind = Schemas['CalendarKind'];
export type BenefitsPlan = Schemas['BenefitsPlanOut'];
export type BenefitsValues = Schemas['BenefitsValues'];
export type PlanValues = Schemas['PlanValues'];
export type RetirementValues = Schemas['RetirementValues'];
export type PlanProposal = Schemas['PlanProposal'];
export type TierProposal = Schemas['TierProposal'];

// The W-4 withholding calculator (M7).
export type W4Input = Schemas['W4Input'];
export type W4Result = Schemas['W4Result'];
export type W4Suggestion = W4Result['suggestion'];

// Monthly check-ins, net worth and holdings (M8, spec 015).
export type CheckInSummary = Schemas['CheckInSummary'];
export type CheckInDetail = Schemas['CheckInDetail'];
export type CheckInStatus = Schemas['CheckinStatus'];
export type CheckInCashFlow = Schemas['CheckInCashFlow'];
export type PlanLine = Schemas['PlanLine'];
export type Finding = Schemas['FindingOut'];
export type FindingKind = Schemas['FindingKind'];
export type FindingSeverity = Schemas['FindingSeverity'];
export type FindingAction = Schemas['FindingAction'];
export type FindingPatch = Schemas['FindingPatch'];
/** A finding's payload: a union discriminated by its own `kind`. */
export type FindingPayload = Finding['payload'];
export type ElectionMismatchPayload = Schemas['ElectionMismatchPayload'];
export type GoalOffPacePayload = Schemas['GoalOffPacePayload'];
export type RecurringPayload = Schemas['RecurringPayload'];
export type PayChangePayload = Schemas['PayChangePayload'];
export type DeductionChangePayload = Schemas['DeductionChangePayload'];
export type UpcomingDeadlinePayload = Schemas['UpcomingDeadlinePayload'];
/** The part of the plan a finding affects (`payload.affects`). */
export type FindingAffects = NonNullable<FindingPayload['affects']>;
export type NetWorth = Schemas['NetWorthOut'];
export type NetWorthPoint = Schemas['NetWorthPoint'];
export type AccountBalance = Schemas['AccountBalanceOut'];
export type KindTotal = Schemas['KindTotal'];
export type Holdings = Schemas['HoldingsOut'];
export type AccountHoldings = Schemas['AccountHoldingsOut'];
export type Position = Schemas['PositionValue'];

// The plan, its calendar file and the PDF export (M9, spec 016).
export type Plan = Schemas['PlanOut'];
export type PlanCompleteness = Schemas['PlanCompleteness'];
export type PlanDecision = Schemas['PlanDecision'];
export type PlanFigure = Schemas['PlanFigure'];
export type PlanExplanation = Schemas['PlanExplanation'];
export type PlanPayStub = Schemas['PlanPayStub'];
export type PlanExportQueued = Schemas['PlanExportQueued'];

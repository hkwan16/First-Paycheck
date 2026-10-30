import type {
  AccountBalance,
  CalendarEvent,
  CashFlow,
  CategoryTotal,
  CheckInDetail,
  CheckInSummary,
  Finding,
  FindingPayload,
  FindingSeverity,
  Holdings,
  Job,
  NetWorth,
  PlanLine,
  SpendingSummary,
  WithholdingLine,
} from '@/lib/api/types';
import { ACCOUNT_KINDS_COUNTED, CATEGORY_BUCKETS, emptyCashflow } from './cashflow';
import { DECISION_V1_ID } from './decisions';
import { CHECKING_ID, sampleJob, SAVINGS_ID } from './sample';

/*
 * Spec 015's November user (the mockup's CheckIn.dc.html): semimonthly at
 * Acme, a 4% 401(k) election and the "HDHP + HSA" plan saved on 2026-10-20,
 * stub S1 paid 2026-10-31 and S2 paid 2026-11-15, the emergency fund goal of
 * finder row 5 and the Equinox charge. Every amount is written out as the API
 * computes it (the spec's hand-worked examples); the client never adds.
 */

export const NOVEMBER_ID = 'c1000000-0000-4000-8000-000000000011';
export const OCTOBER_ID = 'c1000000-0000-4000-8000-000000000010';
export const NOVEMBER_PERIOD = '2026-11-01';
/** The check-in's clock: spec 015's "today". */
export const CHECKIN_TODAY = '2026-11-16';

const S1_ID = '6e000000-0000-4000-8000-000000000031';
const S2_ID = '6e000000-0000-4000-8000-000000000115';
const HEALTH_DECISION_ID = 'dec00000-0000-4000-8000-000000000021';
const FUND_DECISION_ID = 'dec00000-0000-4000-8000-000000000031';
const W4_DECISION_ID = 'dec00000-0000-4000-8000-000000000041';
const GOAL_ID = '90a10000-0000-4000-8000-000000000001';
export const RETIREMENT_ID = '1a2b3c4d-0000-4000-8000-000000000401';
export const CREDIT_ID = '1a2b3c4d-0000-4000-8000-000000001234';

const findingId = (n: number) => `f1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CREATED_AT = '2026-11-16T08:02:00Z';

function finding(
  n: number,
  severity: FindingSeverity,
  key: string,
  decisionId: string | null,
  payload: FindingPayload,
): Finding {
  return {
    id: findingId(n),
    check_in_id: NOVEMBER_ID,
    kind: payload.kind,
    severity,
    key,
    decision_id: decisionId,
    payload,
    user_action: null,
    user_action_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

/** Finder row 1: the 4% election, and S2 withholding 2.00%. */
export const electionFinding = (): Finding =>
  finding(1, 'alert', `election_mismatch:k401_match:${DECISION_V1_ID}:${S2_ID}`, DECISION_V1_ID, {
    kind: 'election_mismatch',
    affects: 'k401_match',
    calculator: 'k401_match',
    pay_stub_id: S2_ID,
    pay_date: '2026-11-15',
    expected_cents: 10_833,
    actual_cents: 5_417,
    difference_cents: -5_416,
    elected_pct: '4.00',
    actual_pct: '2.00',
    plan_name: null,
  });

/** Finder row 4: the HDHP premium against a stub that still shows the old one. */
export const healthElectionFinding = (): Finding =>
  finding(
    20,
    'warning',
    `election_mismatch:health_plans:${HEALTH_DECISION_ID}:${S2_ID}`,
    HEALTH_DECISION_ID,
    {
      kind: 'election_mismatch',
      affects: 'health_plans',
      calculator: 'health_plans',
      pay_stub_id: S2_ID,
      pay_date: '2026-11-15',
      expected_cents: 3_125,
      actual_cents: 6_250,
      difference_cents: 3_125,
      elected_pct: null,
      actual_pct: null,
      plan_name: 'HDHP + HSA',
    },
  );

/** Finder row 5: three months in, 16,000 behind. */
export const goalFinding = (): Finding =>
  finding(2, 'warning', `goal_off_pace:${GOAL_ID}:${NOVEMBER_PERIOD}`, FUND_DECISION_ID, {
    kind: 'goal_off_pace',
    affects: 'emergency_fund',
    goal_id: GOAL_ID,
    started_on: '2026-08-01',
    start_balance_cents: 200_000,
    monthly_contribution_cents: 30_000,
    months_elapsed: 3,
    expected_cents: 290_000,
    balance_cents: 274_000,
    balance_as_of: '2026-11-15',
    shortfall_cents: 16_000,
    target_amount_cents: 547_000,
  });

const chargeId = (n: number) => `8d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Finder row 8. */
export const equinoxFinding = (): Finding =>
  finding(3, 'warning', `recurring_new:${chargeId(11)}:2026-11-03`, null, {
    kind: 'recurring_new',
    affects: 'spending',
    recurring_charge_id: chargeId(11),
    merchant: 'Equinox',
    cadence: 'monthly',
    typical_amount_cents: 18_500,
    previous_amount_cents: null,
    change_cents: null,
    first_seen: '2026-09-03',
    last_seen: '2026-11-03',
    user_status: null,
  });

/** Finder row 9. */
export const netflixFinding = (): Finding =>
  finding(4, 'warning', `recurring_changed:${chargeId(12)}:2026-11-12`, null, {
    kind: 'recurring_changed',
    affects: 'spending',
    recurring_charge_id: chargeId(12),
    merchant: 'Netflix',
    cadence: 'monthly',
    typical_amount_cents: 1_699,
    previous_amount_cents: 1_549,
    change_cents: 150,
    first_seen: '2026-03-12',
    last_seen: '2026-11-12',
    user_status: null,
  });

/** Finder row 17, the event due in 4 days. */
export const deadlineFinding = (): Finding =>
  finding(
    5,
    'warning',
    'upcoming_deadline:ca000000-0000-4000-8000-000000000031',
    FUND_DECISION_ID,
    {
      kind: 'upcoming_deadline',
      affects: 'emergency_fund',
      calendar_event_id: 'ca000000-0000-4000-8000-000000000031',
      calendar_kind: 'goal_contribution',
      title: 'Make your first emergency fund contribution',
      due_at: '2026-11-20',
      days_until: 4,
    },
  );

/** Finder row 12. */
export const huluFinding = (): Finding =>
  finding(6, 'info', `recurring_stopped:${chargeId(1)}:2026-09-09`, null, {
    kind: 'recurring_stopped',
    affects: 'spending',
    recurring_charge_id: chargeId(1),
    merchant: 'Hulu',
    cadence: 'monthly',
    typical_amount_cents: 1_799,
    previous_amount_cents: null,
    change_cents: null,
    first_seen: '2026-03-09',
    last_seen: '2026-09-09',
    user_status: 'cancelled',
  });

const STUBS = {
  pay_stub_id: S2_ID,
  pay_date: '2026-11-15',
  previous_pay_stub_id: S1_ID,
  previous_pay_date: '2026-10-31',
};

/** Finder row 16: S2 against S1, three changed lines. */
export const deductionFindings = (): Finding[] => [
  finding(7, 'info', `deduction_change:${S2_ID}:federal_withholding`, W4_DECISION_ID, {
    kind: 'deduction_change',
    affects: 'w4',
    ...STUBS,
    line: 'federal_withholding',
    label: 'Federal tax',
    amount_cents: 21_196,
    previous_cents: 29_776,
    change_cents: -8_580,
  }),
  finding(8, 'info', `deduction_change:${S2_ID}:retirement_contribution`, DECISION_V1_ID, {
    kind: 'deduction_change',
    affects: 'k401_match',
    ...STUBS,
    line: 'retirement_contribution',
    label: '401(k)',
    amount_cents: 5_417,
    previous_cents: 0,
    change_cents: 5_417,
  }),
  finding(9, 'info', `deduction_change:${S2_ID}:medical_premium`, HEALTH_DECISION_ID, {
    kind: 'deduction_change',
    affects: 'health_plans',
    ...STUBS,
    line: 'medical_premium',
    label: 'Health premiums',
    amount_cents: 3_125,
    previous_cents: 6_250,
    change_cents: -3_125,
  }),
];

/** Finder row 14: a raise (S3 against S1). Not in November's list; for its own tests. */
export const payChangeFinding = (): Finding =>
  finding(10, 'info', 'pay_change:6e000000-0000-4000-8000-000000000003', W4_DECISION_ID, {
    kind: 'pay_change',
    affects: 'w4',
    pay_stub_id: '6e000000-0000-4000-8000-000000000003',
    pay_date: '2026-11-15',
    previous_pay_stub_id: S1_ID,
    previous_pay_date: '2026-10-31',
    gross_cents: 291_667,
    previous_gross_cents: 270_833,
    gross_change_cents: 20_834,
    net_cents: 218_845,
    previous_net_cents: 199_604,
    net_change_cents: 19_241,
  });

/** Finder row 15: the same two stubs the other way round, a pay cut. */
export const payCutFinding = (): Finding => {
  const cut = payChangeFinding();
  cut.severity = 'warning';
  cut.payload = {
    ...(cut.payload as Extract<FindingPayload, { kind: 'pay_change' }>),
    gross_cents: 270_833,
    previous_gross_cents: 291_667,
    gross_change_cents: -20_834,
    net_cents: 199_604,
    previous_net_cents: 218_845,
    net_change_cents: -19_241,
  };
  return cut;
};

/** November's findings in the API's order: severity, then kind, then created_at and id. */
export const novemberFindings = (): Finding[] => [
  electionFinding(),
  goalFinding(),
  equinoxFinding(),
  netflixFinding(),
  deadlineFinding(),
  huluFinding(),
  ...deductionFindings(),
];

const LINE_INFO: readonly [WithholdingLine['key'], string, WithholdingLine['role'], number][] = [
  ['federal_withholding', 'Federal tax', 'tax', 21_196],
  ['social_security', 'Social Security', 'tax', 16_792],
  ['medicare', 'Medicare', 'tax', 3_927],
  ['state_tax', 'State tax', 'tax', 9_814],
  ['retirement_contribution', '401(k)', 'retirement', 5_417],
  ['medical_premium', 'Health premiums', 'health', 3_125],
  ['other_deductions', 'Other deductions', 'other', 4_670],
];

const S2_LINES: WithholdingLine[] = LINE_INFO.map(([key, label, role, amount_cents]) => ({
  key,
  label,
  role,
  amount_cents,
}));

const category = (
  name: CategoryTotal['category'],
  bucket: CategoryTotal['bucket'],
  total_cents: number,
): CategoryTotal => ({ category: name, bucket, total_cents, count: 1 });

/** November 1 to 16: S2's deposit and eight transactions. */
const NOVEMBER_SPENDING: SpendingSummary = {
  start: NOVEMBER_PERIOD,
  end: CHECKIN_TODAY,
  income_cents: 205_892,
  essentials_cents: 25_860,
  flexible_cents: 22_349,
  savings_cents: 30_000,
  other_cents: 0,
  transfers_ignored_cents: 0,
  income_outflows_ignored_cents: 0,
  uncategorized_cents: 0,
  left_over_cents: 127_683,
  essentials_pct: '12.6',
  flexible_pct: '10.9',
  savings_rate_pct: '14.6',
  transaction_count: 9,
  uncategorized_count: 0,
  paycheck_count: 1,
  ledger_rows_skipped: { count: 0, net_cents: 0 },
  account_kinds_counted: ACCOUNT_KINDS_COUNTED,
  categories: [
    category('income', 'income', 205_892),
    category('utilities', 'essentials', 8_215),
    category('phone_internet', 'essentials', 7_000),
    category('groceries', 'essentials', 7_325),
    category('dining', 'flexible', 2_150),
    category('transport', 'essentials', 3_320),
    category('subscriptions', 'flexible', 1_699),
    category('personal_care', 'flexible', 18_500),
    category('savings_investment', 'savings', 30_000),
  ],
  category_buckets: CATEGORY_BUCKETS,
};

const ROLES = {
  tax_cents: 51_729,
  retirement_cents: 5_417,
  health_cents: 3_125,
  other_cents: 4_670,
};

/** `GET /cashflow` for November 1 to 16: stub S2 (spec 015's arithmetic) and the spending above. */
export const novemberCashflow = (): CashFlow => ({
  start: NOVEMBER_PERIOD,
  end: CHECKIN_TODAY,
  pay_stubs: [
    {
      pay_stub_id: S2_ID,
      pay_date: '2026-11-15',
      gross_cents: 270_833,
      lines: structuredClone(S2_LINES),
      roles: { ...ROLES },
      deductions_cents: 64_941,
      net_cents: 205_892,
    },
  ],
  withholding: {
    gross_cents: 270_833,
    lines: structuredClone(S2_LINES),
    roles: { ...ROLES },
    deductions_cents: 64_941,
    net_cents: 205_892,
    paycheck_count: 1,
  },
  spending: structuredClone(NOVEMBER_SPENDING),
});

const line = (
  key: PlanLine['key'],
  label: string,
  actual_cents: number,
  plan_cents: number | null,
  difference_cents: number | null,
  status: PlanLine['status'] = null,
): PlanLine => ({ key, label, actual_cents, plan_cents, difference_cents, status });

/**
 * Spec 015 rule 19 for November: essentials 182,300 from the emergency fund
 * decision, savings 30,000 from its goal, the 401(k) at 4% of S2's gross
 * (10,833) and the HDHP premium for one paycheck (3,125).
 */
export const novemberPlan = (): PlanLine[] => [
  line('take_home', 'Take-home pay', 205_892, null, null),
  line('essentials', 'Essentials', 25_860, 182_300, -156_440, 'under'),
  line('flexible', 'Flexible', 22_349, null, null),
  line('other', 'Other spending', 0, null, null),
  line('savings', 'Savings', 30_000, 30_000, 0, 'on_plan'),
  line('retirement', '401(k) from pay stubs', 5_417, 10_833, -5_416, 'under'),
  line('health', 'Health premiums', 3_125, 3_125, 0, 'on_plan'),
  line('left_over', 'Left over', 127_683, null, null),
];

/** `GET /check-ins/{id}` for November: open, nothing handled yet. */
export function novemberCheckIn(overrides: Partial<CheckInDetail> = {}): CheckInDetail {
  const findings = novemberFindings();
  return {
    id: NOVEMBER_ID,
    period: NOVEMBER_PERIOD,
    triggered_by: 'schedule',
    status: 'open',
    completed_at: null,
    finding_count: findings.length,
    handled_count: 0,
    created_at: '2026-11-01T08:00:00Z',
    updated_at: CREATED_AT,
    last_run_at: CREATED_AT,
    findings,
    cash_flow: { cash_flow: novemberCashflow(), plan: novemberPlan() },
    ...overrides,
  };
}

const HANDLED_AT = '2026-11-16T18:30:00Z';

/** November with every finding handled: the third dismissed, the rest done. */
export function completedNovemberCheckIn(): CheckInDetail {
  const findings = novemberFindings().map((f, index) => ({
    ...f,
    user_action: index === 2 ? ('dismissed' as const) : ('done' as const),
    user_action_at: HANDLED_AT,
  }));
  return novemberCheckIn({
    findings,
    handled_count: findings.length,
    status: 'completed',
    completed_at: HANDLED_AT,
  });
}

/** October, completed: two findings, both handled. */
export function octoberCheckIn(): CheckInDetail {
  const findings: Finding[] = [
    {
      ...healthElectionFinding(),
      id: findingId(30),
      check_in_id: OCTOBER_ID,
      user_action: 'done',
      user_action_at: '2026-10-20T15:00:00Z',
    },
    {
      ...huluFinding(),
      id: findingId(31),
      check_in_id: OCTOBER_ID,
      user_action: 'dismissed',
      user_action_at: '2026-10-20T15:00:00Z',
    },
  ];
  return {
    id: OCTOBER_ID,
    period: '2026-10-01',
    triggered_by: 'schedule',
    status: 'completed',
    completed_at: '2026-10-20T15:00:00Z',
    finding_count: 2,
    handled_count: 2,
    created_at: '2026-10-01T08:00:00Z',
    updated_at: '2026-10-20T15:00:00Z',
    last_run_at: '2026-10-20T15:00:00Z',
    findings,
    cash_flow: { cash_flow: emptyCashflow('2026-10-01', '2026-10-31'), plan: [] },
  };
}

/** A check-in as `GET /check-ins` lists it. */
export function summaryOf(detail: CheckInDetail): CheckInSummary {
  const { findings: _findings, cash_flow: _cashFlow, ...summary } = detail;
  return summary;
}

/** `GET /calendar` events in November's window (spec 015 route row 7 and the decisions above). */
export const novemberCalendar = (): CalendarEvent[] => [
  {
    id: 'ca000000-0000-4000-8000-000000000031',
    kind: 'goal_contribution',
    title: 'Make your first emergency fund contribution',
    due_at: '2026-11-20',
    decision_id: FUND_DECISION_ID,
    status: 'upcoming',
  },
  {
    id: 'ca000000-0000-4000-8000-000000000032',
    kind: 'election_check',
    title: 'Check that your next pay stub shows your new 401(k) contribution',
    due_at: '2026-11-30',
    decision_id: DECISION_V1_ID,
    status: 'upcoming',
  },
  {
    id: 'ca000000-0000-4000-8000-000000000033',
    kind: 'enrollment_deadline',
    title: 'Health plan enrollment deadline',
    due_at: '2026-12-16',
    decision_id: HEALTH_DECISION_ID,
    status: 'upcoming',
  },
];

const balance = (
  account: Omit<AccountBalance, 'balance_as_of' | 'institution_name'> & {
    institution_name?: string | null;
  },
): AccountBalance => ({
  institution_name: 'Chase',
  balance_as_of: '2026-11-15',
  ...account,
});

/**
 * `GET /net-worth?months=12` on 2026-11-16: spec 015 route row 5 (checking,
 * savings, a credit card and the 401(k)).
 */
export function sampleNetWorth(overrides: Partial<NetWorth> = {}): NetWorth {
  return structuredClone({
    as_of: '2026-11-15',
    assets_cents: 607_754,
    liabilities_cents: 60_000,
    net_worth_cents: 547_754,
    change_cents: 97_754,
    accounts: [
      balance({
        account_id: RETIREMENT_ID,
        name: 'Acme 401(k)',
        mask: null,
        kind: 'retirement',
        role: 'retirement',
        institution_name: 'Fidelity',
        side: 'asset',
        balance_cents: 21_710,
      }),
      balance({
        account_id: SAVINGS_ID,
        name: 'Chase Savings',
        mask: '7730',
        kind: 'savings',
        role: 'emergency_fund',
        side: 'asset',
        balance_cents: 274_000,
      }),
      balance({
        account_id: CHECKING_ID,
        name: 'Chase Total Checking',
        mask: '4821',
        kind: 'checking',
        role: 'spending',
        side: 'asset',
        balance_cents: 312_044,
      }),
      balance({
        account_id: CREDIT_ID,
        name: 'Freedom Unlimited',
        mask: '1234',
        kind: 'credit',
        role: null,
        side: 'liability',
        balance_cents: 60_000,
      }),
    ],
    by_kind: [
      { kind: 'checking', side: 'asset', total_cents: 312_044 },
      { kind: 'savings', side: 'asset', total_cents: 274_000 },
      { kind: 'credit', side: 'liability', total_cents: 60_000 },
      { kind: 'retirement', side: 'asset', total_cents: 21_710 },
    ],
    series: [
      {
        month: '2026-09-01',
        as_of: '2026-09-30',
        assets_cents: 450_000,
        liabilities_cents: 0,
        net_worth_cents: 450_000,
      },
      {
        month: '2026-10-01',
        as_of: '2026-10-31',
        assets_cents: 510_000,
        liabilities_cents: 45_000,
        net_worth_cents: 465_000,
      },
      {
        month: '2026-11-01',
        as_of: CHECKIN_TODAY,
        assets_cents: 607_754,
        liabilities_cents: 60_000,
        net_worth_cents: 547_754,
      },
    ],
    ...overrides,
  });
}

/** `GET /net-worth` for a person with no balances yet (spec 015 edge case). */
export const emptyNetWorth = (): NetWorth => ({
  as_of: null,
  assets_cents: 0,
  liabilities_cents: 0,
  net_worth_cents: 0,
  change_cents: null,
  accounts: [],
  by_kind: [],
  series: [],
});

/** `GET /holdings`: the 401(k)'s target-date fund of route row 6. */
export function sampleHoldings(): Holdings {
  return {
    accounts: [
      {
        account_id: RETIREMENT_ID,
        name: 'Acme 401(k)',
        mask: null,
        kind: 'retirement',
        as_of: '2026-11-15',
        value_cents: 21_710,
        cost_basis_cents: 21_668,
        gain_cents: 42,
        holdings: [
          {
            security_id: 'sec-vsvnx',
            name: 'Vanguard Target Retirement 2070 Fund',
            ticker: 'VSVNX',
            quantity: '14.21',
            value_cents: 21_710,
            cost_basis_cents: 21_668,
            gain_cents: 42,
          },
        ],
      },
    ],
    value_cents: 21_710,
    cost_basis_cents: 21_668,
    gain_cents: 42,
  };
}

/** Route row 6 with the brokerage: VXUS has no basis, so its account and the totals have none. */
export function partialBasisHoldings(): Holdings {
  const holdings = sampleHoldings();
  holdings.accounts.push({
    account_id: '1a2b3c4d-0000-4000-8000-000000003301',
    name: 'Brokerage',
    mask: '3301',
    kind: 'investment',
    as_of: '2026-11-15',
    value_cents: 128_000,
    cost_basis_cents: null,
    gain_cents: null,
    holdings: [
      {
        security_id: 'sec-vti',
        name: 'Vanguard Total Stock Market ETF',
        ticker: 'VTI',
        quantity: '3.5',
        value_cents: 98_000,
        cost_basis_cents: 90_000,
        gain_cents: 8_000,
      },
      {
        security_id: 'sec-vxus',
        name: 'Vanguard Total International Stock ETF',
        ticker: 'VXUS',
        quantity: '4',
        value_cents: 30_000,
        cost_basis_cents: null,
        gain_cents: null,
      },
    ],
  });
  holdings.value_cents = 149_710;
  holdings.cost_basis_cents = null;
  holdings.gain_cents = null;
  return holdings;
}

/** The n-th `checkin.monthly` job `POST /check-ins` hands out. */
export const checkInJobId = (n: number) => `5c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** What a `checkin.monthly` job reports when it ends (spec 015, `CheckInRun.as_job_result`). */
export interface CheckInJobResult {
  outcome: 'created' | 'refreshed' | 'skipped';
  check_in_id: string | null;
}

/** A `checkin.monthly` job in one state. */
export function checkInJob(id: string, overrides: Partial<Job> = {}): Job {
  return sampleJob({
    id,
    kind: 'checkin.monthly',
    created_at: '2026-11-16T18:00:00Z',
    ...overrides,
  });
}

/** The job's result as the API writes it, the counts included. */
export const checkInJobResult = ({ outcome, check_in_id }: CheckInJobResult) => ({
  outcome,
  check_in_id,
  inserted: outcome === 'created' ? 9 : 0,
  updated: outcome === 'refreshed' ? 9 : 0,
  retracted: 0,
  dropped: 0,
  marked_active: 0,
});

/** A check-in run from queued, through running, to succeeded with `result`. */
export function checkInJobStates(
  id: string,
  result: CheckInJobResult = { outcome: 'refreshed', check_in_id: NOVEMBER_ID },
): Job[] {
  return [
    checkInJob(id, { status: 'queued' }),
    checkInJob(id, { status: 'running', progress: 50 }),
    checkInJob(id, {
      status: 'succeeded',
      progress: 100,
      result: checkInJobResult(result),
      finished_at: '2026-11-16T18:00:05Z',
    }),
  ];
}

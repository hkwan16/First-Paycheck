'use client';

import { useState, type ReactNode } from 'react';
import * as icons from '@/components/icons';
import {
  AlertIcon,
  ArrowRightIcon,
  ArrowSmallIcon,
  ChartIcon,
  CheckIcon,
  ClockIcon,
  DocumentIcon,
  EditIcon,
  FormIcon,
  GrowthIcon,
  HealthIcon,
  LinkIcon,
  UmbrellaIcon,
  WarningCircleIcon,
} from '@/components/icons';
import { Header } from '@/components/chrome/Header';
import { NavStep } from '@/components/chrome/NavStep';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Shell } from '@/components/chrome/Shell';
import { SideNav } from '@/components/chrome/SideNav';
import { StepFooter } from '@/components/chrome/StepFooter';
import { Badge } from '@/components/ui/Badge';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { DropZone } from '@/components/ui/DropZone';
import { IconTile } from '@/components/ui/IconTile';
import { Input } from '@/components/ui/Input';
import { KV, KVList } from '@/components/ui/KV';
import { Label } from '@/components/ui/Label';
import { ListRows } from '@/components/ui/ListRows';
import { Money, Num } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Range } from '@/components/ui/Range';
import { Seg } from '@/components/ui/Seg';
import { Select } from '@/components/ui/Select';
import { StatTile } from '@/components/ui/StatTile';
import { Swatch, type SwatchColor } from '@/components/ui/Swatch';
import { Tile } from '@/components/ui/Tile';
import { cn } from '@/lib/cn';
import { toneText } from '@/lib/design/tone';
import { checkInRoute, confirmRoute, whyRoute } from '@/lib/routes';

/*
 * Every ui and chrome component in every variant, for eyes and for the
 * Playwright snapshot. Amounts are the mockup's sample figures as integer
 * cents, exactly as the API would send them: this page formats, never computes.
 */

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card aria-labelledby={id}>
      <h2 id={id} className="m-0">
        {title}
      </h2>
      {children}
    </Card>
  );
}

function Row({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {caption && <div className="text-tiny text-ink-3">{caption}</div>}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const ICON_ENTRIES = Object.entries(icons).filter(([name]) => /^[A-Z]/.test(name)) as [
  string,
  (props: { size?: number }) => ReactNode,
][];

const LEGEND: [SwatchColor, string][] = [
  ['plum', 'Gross pay and 401(k)'],
  ['flow-tax', 'Taxes withheld'],
  ['coral', 'Health premiums and flexible spending'],
  ['ink-2', 'Take-home'],
  ['blue', 'Essentials'],
  ['teal', 'Savings'],
  ['flow-idle', 'Not yet spent'],
  ['blue-soft', 'Essentials category'],
  ['coral-soft', 'Flexible category'],
];

/** The label style for a control group that is not a single input. */
const captionClasses = 'mb-1.5 text-small font-semibold text-ink-2';

type Usage = 'low' | 'medium' | 'high';
type Filing = 'single' | 'mfj' | 'hoh';

export function KitGallery() {
  const [usage, setUsage] = useState<Usage>('low');
  const [filing, setFiling] = useState<Filing>('single');
  const [months, setMonths] = useState(3);
  const [pct, setPct] = useState(4);
  const [twoJobs, setTwoJobs] = useState(false);
  const [confirmed, setConfirmed] = useState(true);
  const [lastFile, setLastFile] = useState<string>();

  return (
    <Shell
      header={<Header chips={['Acme Corp · Semi-monthly', 'J. Rivera']} />}
      nav={
        <SideNav
          current="decisions"
          done={{ link: true, confirm: true, spending: true }}
          hrefs={{
            confirm: confirmRoute('sample'),
            why: whyRoute('sample'),
            checkIn: checkInRoute('sample'),
          }}
        />
      }
    >
      <PageTitle
        title="Component kit"
        lead="Every design system component in every variant, side by side with the mockup. Development only."
        aside={<Badge>18 sections</Badge>}
      />

      <Section id="kit-buttons" title="Buttons">
        <Row caption="md, 44px">
          <Button>Back</Button>
          <Button variant="primary">
            Review extracted fields
            <ArrowRightIcon />
          </Button>
          <Button variant="primary">
            <LinkIcon />
            Link another bank with Plaid
          </Button>
          <Button
            variant={confirmed ? 'confirmed' : 'default'}
            pressed={confirmed}
            onClick={() => setConfirmed((c) => !c)}
          >
            <CheckIcon size={14} />
            {confirmed ? 'Confirmed' : 'Confirm'}
          </Button>
        </Row>
        <Row caption="sm, 36px">
          <Button size="sm">Replace</Button>
          <Button size="sm" variant="primary">
            Save and confirm
          </Button>
          <Button size="sm" variant="confirmed" pressed>
            <CheckIcon size={14} />
            Confirmed
          </Button>
          <Button size="sm">
            <EditIcon />
            Edit
          </Button>
        </Row>
        <Row caption="loading, disabled, link">
          <Button variant="primary" loading>
            Save this decision
          </Button>
          <Button variant="primary" disabled>
            Confirm and continue
          </Button>
          <Button href="/plan" variant="primary">
            See the plan
          </Button>
          <Button href="/setup/decisions/401k">Re-run the calculator</Button>
        </Row>
        <div className="max-w-sm">
          <Button variant="primary" block>
            Sign in
          </Button>
        </div>
      </Section>

      <Section id="kit-badges" title="Badges and chips">
        <Row caption="tones">
          <Badge>Not saved</Badge>
          <Badge tone="confirmed" icon={<CheckIcon />}>
            Saved v1 · Oct 20
          </Badge>
          <Badge tone="warning">Changed since v1</Badge>
          <Badge tone="off">25% of plan</Badge>
          <Badge tone="blue">Read · 96%</Badge>
          <Badge tone="coral" icon={<CheckIcon />}>
            2 items redacted
          </Badge>
          <Badge tone="teal">Emergency fund</Badge>
          <Badge tone="plum">401(k)</Badge>
        </Row>
        <Row caption="solid, link">
          <Badge tone="confirmed" solid icon={<CheckIcon />}>
            Verified against calculator
          </Badge>
          <Badge tone="warning" solid icon={<AlertIcon size={12} strokeWidth={1.4} />}>
            Could not verify the explanation
          </Badge>
          <Badge tone="plum" href="/setup/decisions/401k">
            Affects: 401(k) match
            <ArrowSmallIcon />
          </Badge>
        </Row>
        <Row caption="chips">
          <Chip>Acme Corp · Semi-monthly</Chip>
          <Chip>J. Rivera</Chip>
          <Chip>Sample data</Chip>
        </Row>
      </Section>

      <Section id="kit-cards" title="Cards">
        <div className="grid grid-cols-2 gap-4 max-wide:grid-cols-1">
          <Card as="div">
            <strong>Default: padding 20, gap 16</strong>
            <span className="text-small text-ink-3">The default for every screen section.</span>
          </Card>
          <Card as="div" padding={24}>
            <strong>Padding 24</strong>
            <span className="text-small text-ink-3">The sign-in form.</span>
          </Card>
          <Card as="div" tint="confirmed" gap={12}>
            <Badge tone="confirmed" solid icon={<CheckIcon />}>
              Verified against calculator
            </Badge>
            <span className="text-small">tint confirmed</span>
          </Card>
          <Card as="div" tint="warning" gap={12}>
            <Badge tone="warning" solid>
              Could not verify the explanation
            </Badge>
            <span className="text-small">tint warning</span>
          </Card>
          <Card as="div" inset gap={12}>
            <div className="flex items-center justify-between gap-3">
              <strong>401(k) match calculator result</strong>
              <Badge>Fallback</Badge>
            </div>
            <span className="text-small text-ink-3">inset, for fallback content</span>
          </Card>
        </div>
      </Section>

      <Section id="kit-tiles" title="Tiles">
        <div className="grid grid-cols-2 gap-4 max-wide:grid-cols-1">
          <Tile tone="teal">
            <div className={cn('text-headline font-bold', toneText.teal)}>
              Target <Money cents={546975} decimals={0} />, reached around Oct 2027
            </div>
            <Bar value={39} tone="confirmed" label="Emergency fund progress" />
            <KVList rules="all" spacing="panel">
              <KV
                label="Saved so far"
                value={
                  <>
                    <Money cents={214000} /> · 39%
                  </>
                }
              />
              <KV label="Still to save" value={<Money cents={332975} />} />
              <KV label="At $300 a month" value="12 months" />
            </KVList>
          </Tile>
          <Tile tone="plum">
            <div className={cn('text-headline font-bold', toneText.plum)}>
              You capture the full match
            </div>
            <KVList rules="all" spacing="panel">
              <KV label="You put in per year" value={<Money cents={260000} />} />
              <KV
                label="Acme adds per year"
                value={<Money cents={260000} tone="plum" className="font-semibold" />}
              />
              <KV label="Per paycheck, before tax" value={<Money cents={10833} />} />
            </KVList>
          </Tile>
          <Tile tone="coral">
            <div className={cn('text-headline font-bold', toneText.coral)}>
              HDHP + HSA costs less at low use
            </div>
            <div className="text-small text-ink-3">
              Premiums and deductibles come from your plan documents.
            </div>
          </Tile>
          <Tile tone="blue">
            <div className={cn('text-headline font-bold', toneText.blue)}>About $0 at filing</div>
            <div className="text-tiny text-ink-3">
              Uses 2026 brackets and the standard deduction.
            </div>
          </Tile>
          <Tile>
            <strong>Neutral tile</strong>
            <span className="text-small text-ink-3">The plain recessed panel.</span>
          </Tile>
        </div>
      </Section>

      <Section id="kit-stats" title="Stat tiles">
        <div className="grid grid-cols-4 gap-3 max-wide:grid-cols-2">
          <StatTile
            tone="plum"
            label="Income"
            value={<Money cents={399208} />}
            sub="2 × $1,996.04 net"
          />
          <StatTile
            tone="blue"
            label="Essentials"
            value={<Money cents={182325} />}
            sub="46% of income"
          />
          <StatTile
            tone="coral"
            label="Flexible"
            value={<Money cents={61230} />}
            sub="15% of income"
          />
          <StatTile
            tone="teal"
            label="Savings"
            value={<Money cents={30000} />}
            sub="Savings rate 8%"
          />
        </div>
        <div className="grid grid-cols-4 gap-3 max-wide:grid-cols-2">
          <StatTile
            size="sm"
            tone="blue"
            label="Salary"
            value={<Money cents={6500000} decimals={0} />}
          />
          <StatTile
            size="sm"
            tone="plum"
            label="Gross per check"
            value={<Money cents={270833} />}
          />
          <StatTile size="sm" tone="coral" label="Net today" value={<Money cents={199604} />} />
          <StatTile
            size="sm"
            tone="teal"
            label="Net after this plan"
            value={<Money cents={200476} />}
          />
        </div>
        <div className="grid grid-cols-3 gap-3 max-wide:grid-cols-1">
          <StatTile label="Numbers checked" value="6 of 6 match" />
          <StatTile label="Citations" value="3 of 3 resolve" />
          <StatTile label="Retries" value="0" />
        </div>
      </Section>

      <Section id="kit-icon-tiles" title="Icon tiles">
        <Row caption="hues, initials">
          <IconTile tone="teal">
            <UmbrellaIcon />
          </IconTile>
          <IconTile tone="plum">
            <GrowthIcon />
          </IconTile>
          <IconTile tone="coral">
            <HealthIcon />
          </IconTile>
          <IconTile tone="blue">
            <FormIcon />
          </IconTile>
          <IconTile tone="blue" label="CH" />
          <IconTile tone="coral">
            <DocumentIcon />
          </IconTile>
          <IconTile tone="plum">
            <DocumentIcon />
          </IconTile>
        </Row>
        <Row caption="statuses, muted">
          <IconTile tone="off">
            <WarningCircleIcon />
          </IconTile>
          <IconTile tone="warning">
            <ClockIcon />
          </IconTile>
          <IconTile tone="confirmed">
            <CheckIcon size={18} />
          </IconTile>
          <IconTile tone="blue">
            <ChartIcon />
          </IconTile>
          <IconTile muted>
            <CheckIcon size={18} />
          </IconTile>
        </Row>
      </Section>

      <Section id="kit-bars" title="Bars">
        <Bar value={62} tone="confirmed" label="Fields confirmed" />
        <div className="flex flex-col gap-3">
          <Bar value={100} tone="plum" height={6} label="Net income" />
          <Bar value={100} tone="blue" height={6} label="Essentials" />
          <Bar value={87} tone="coral" height={6} label="Flexible" />
          <Bar value={100} tone="teal" height={6} label="Savings transfer" />
          <Bar
            value={25}
            tone="off"
            height={6}
            label="401(k) from pay stubs"
            valueText="25% of plan"
          />
          <Bar value={50} tone="warning" height={6} label="Warning" />
        </div>
      </Section>

      <Section id="kit-kv" title="Key and value rows">
        <div className="grid grid-cols-2 gap-6 max-wide:grid-cols-1">
          <KVList spacing="comfortable">
            <KV label="Salary" value={<Money cents={6500000} decimals={0} />} verified />
            <KV
              label="4% of salary, per year"
              value={<Money cents={260000} decimals={0} />}
              verified
            />
            <KV label="Per paycheck, before tax" value={<Money cents={10833} />} verified />
            <KV
              label="Per paycheck, after tax at your 12% marginal rate"
              value={<Money cents={9533} />}
              verified
            />
          </KVList>
          <KVList>
            <KV label="Inputs" value="Salary $65,000 · contribution 4%" />
            <KV label="Contribution for full match" value={<Num value={4} percent />} />
            <KV label="Employer match, per year" value={<Money cents={260000} decimals={0} />} />
          </KVList>
        </div>
      </Section>

      <Section id="kit-seg" title="Segmented controls">
        <div>
          <div className={captionClasses}>How much care do you expect in 2027?</div>
          <Seg
            label="Expected healthcare use"
            value={usage}
            onChange={setUsage}
            options={[
              { value: 'low', label: 'Low · about $400' },
              { value: 'medium', label: 'Medium · about $1,800' },
              { value: 'high', label: 'High · about $6,000' },
            ]}
          />
        </div>
        <div>
          <div className={captionClasses}>Step 1(c): filing status</div>
          <Seg
            label="Filing status"
            value={filing}
            onChange={setFiling}
            options={[
              { value: 'single', label: 'Single' },
              { value: 'mfj', label: 'Married filing jointly' },
              { value: 'hoh', label: 'Head of household' },
            ]}
          />
        </div>
      </Section>

      <Section id="kit-fields" title="Fields">
        <div className="grid grid-cols-2 gap-4 max-wide:grid-cols-1">
          <div>
            <Label htmlFor="kit-email">Email</Label>
            <Input id="kit-email" type="email" placeholder="you@example.com" />
          </div>
          <div>
            <Label htmlFor="kit-invalid">Gross pay</Label>
            <Input id="kit-invalid" defaultValue="2,708.3x" invalid className="tabular-nums" />
          </div>
          <div>
            <Label htmlFor="kit-role">Role</Label>
            <Select id="kit-role" defaultValue="spending">
              <option value="spending">Spending</option>
              <option value="emergency">Emergency fund</option>
              <option value="retirement">Retirement</option>
              <option value="unused">Not used</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="kit-category">Category (small)</Label>
            <Select id="kit-category" size="sm" defaultValue="groceries">
              <option value="groceries">Groceries</option>
              <option value="dining">Dining</option>
            </Select>
          </div>
          <Range
            id="kit-months"
            label="Months of essentials to hold"
            valueLabel={`${months} months`}
            min={3}
            max={6}
            value={months}
            onChange={setMonths}
          />
          <Range
            id="kit-pct"
            label="Your contribution"
            valueLabel={`${pct}% of salary`}
            min={0}
            max={15}
            value={pct}
            onChange={setPct}
          />
          <Checkbox checked={twoJobs} onChange={setTwoJobs}>
            Step 2(c): I have a second job, or my spouse works
          </Checkbox>
          <div>
            <Label htmlFor="kit-dependents">Step 3: children under 17</Label>
            <Input
              id="kit-dependents"
              type="number"
              min={0}
              max={5}
              defaultValue={0}
              size="sm"
              className="tabular-nums"
            />
          </div>
        </div>
      </Section>

      <Section id="kit-notices" title="Notices">
        <Notice title="Before any AI sees a page, SSNs and account numbers are blacked out.">
          Text PDFs are redacted as text; scanned pages are redacted in the image itself.
        </Notice>
        <Notice tone="confirmed" compact title="The math checks out.">
          Gross minus every deduction equals net pay, to the cent.
        </Notice>
        <Notice tone="warning" compact title="These don't add up.">
          Gross minus deductions is off from net pay by $0.02. Check the edited field.
        </Notice>
        <Notice tone="confirmed" compact role="status">
          Saved as a rule. These merchants will never go back to the AI for you.
        </Notice>
      </Section>

      <Section id="kit-swatches" title="Swatches">
        <div className="flex flex-wrap gap-4">
          {LEGEND.map(([color, label]) => (
            <span key={color} className="inline-flex items-center gap-1.5 text-small text-ink-2">
              <Swatch color={color} />
              {label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 text-small text-ink-2">
            <Swatch dashed />
            Worth $0
          </span>
          <span className="inline-flex items-center gap-1.5 text-small text-ink-2">
            <Swatch color="blue" size={12} />
            Node size
          </span>
        </div>
      </Section>

      <Section id="kit-list" title="List rows">
        <ListRows>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <IconTile tone="blue" label="CH" />
              <div>
                <div className="font-semibold">
                  Chase Total Checking{' '}
                  <span className="font-medium text-ink-3 tabular-nums">··4821</span>
                </div>
                <div className="text-small text-ink-3">
                  Synced 4 minutes ago · 94 transactions since July
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="kit-role-4821" className="m-0">
                Role
              </Label>
              <Select id="kit-role-4821" defaultValue="spending" className="w-auto min-w-40">
                <option value="spending">Spending</option>
                <option value="emergency">Emergency fund</option>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <IconTile tone="coral">
                <DocumentIcon />
              </IconTile>
              <div className="min-w-0">
                <div className="font-semibold">Pay stub or offer letter</div>
                <div className="text-small text-ink-3">
                  acme-paystub-2026-10-15.pdf · 1 page · uploaded 2 min ago
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Badge tone="coral" icon={<CheckIcon />}>
                2 items redacted
              </Badge>
              <Button size="sm">Replace</Button>
            </div>
          </div>
        </ListRows>
      </Section>

      <Section id="kit-drop" title="Drop zone">
        <DropZone
          accept=".pdf,.png,.jpg,.jpeg"
          title="Add another document"
          hint="PDF, PNG or JPEG. Scanned pages are read with OCR."
          onFiles={(files) => setLastFile(files[0]?.name)}
        />
        <div className="text-small text-ink-3" aria-live="polite">
          {lastFile ? `Picked ${lastFile}` : 'No file picked yet.'}
        </div>
      </Section>

      <Section id="kit-money" title="Money and numbers">
        <KVList>
          <KV label="Net per paycheck" value={<Money cents={199604} />} />
          <KV label="Salary, whole dollars" value={<Money cents={6500000} decimals={0} />} />
          <KV
            label="Net worth since Oct 20"
            value={<Money cents={85754} signed tone="confirmed" />}
          />
          <KV label="Essentials over plan" value={<Money cents={-8215} signed tone="warning" />} />
          <KV
            label="Acme adds per year"
            value={<Money cents={260000} decimals={0} tone="plum" />}
          />
          <KV label="Transactions" value={<Num value={1234} />} />
          <KV label="Shares" value={<Num value={14.21} decimals={2} />} />
          <KV label="Marginal rate" value={<Num value={12} percent />} />
        </KVList>
      </Section>

      <Section id="kit-icons" title="Icons">
        <div className="grid grid-cols-6 gap-3 max-wide:grid-cols-3">
          {ICON_ENTRIES.map(([name, Icon]) => (
            <div
              key={name}
              className="flex flex-col items-center gap-1.5 rounded-control bg-tile p-3 text-ink-2"
            >
              <Icon size={20} />
              <span className="text-tiny text-ink-3">{name.replace(/Icon$/, '')}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="kit-nav" title="Navigation steps">
        <Row>
          <NavStep>1</NavStep>
          <NavStep>2</NavStep>
          <NavStep done>3</NavStep>
          <NavStep>
            <icons.QuestionIcon />
          </NavStep>
          <NavStep>
            <icons.PlanIcon />
          </NavStep>
          <NavStep>
            <icons.TrendIcon />
          </NavStep>
        </Row>
        <PageTitle
          eyebrow={
            <>
              <Badge>401(k) match · decision v1</Badge>
              <span className="text-small text-ink-3">Saved Oct 20, 2026</span>
            </>
          }
          title="Why contribute 4% to your 401(k)"
          lead="A page title with an eyebrow and an aside."
          aside={<Badge>0 of 4 saved</Badge>}
        />
      </Section>

      <Section id="kit-footer" title="Step footer">
        <StepFooter
          back={{ href: '/setup/link' }}
          next={{ href: '/setup/spending', label: 'Review extracted fields' }}
        />
        <StepFooter
          back={{ href: '/setup/link' }}
          next={{ href: '/setup/spending', label: 'Confirm and continue', disabled: true }}
          status="3 left to confirm"
        />
        <StepFooter
          back={{ href: '/setup/decisions/w4', label: 'Back to decisions' }}
          next={{ href: '/plan', label: 'Preview the November check-in' }}
        />
      </Section>
    </Shell>
  );
}

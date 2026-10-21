'use client';

import { useEffect, useId, useRef, type Dispatch, type KeyboardEvent } from 'react';
import { CheckIcon, EditIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FieldError } from '@/components/ui/FieldError';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import type { ConfirmAction, ReviewField } from './confirmReducer';
import { confidenceBadge, fieldDisplay } from './field-format';

export interface FieldRowProps {
  field: ReviewField;
  selected: boolean;
  /** The document needs manual entry: no confidence, and "Not entered yet". */
  manual: boolean;
  /** The source pane, which the row's selection drives. */
  sourceId: string;
  dispatch: Dispatch<ConfirmAction>;
}

/**
 * One row of the mockup's `.frow` grid: the field (a button that selects its
 * source line) or its inline editor, the confidence badge, and the actions.
 * Focus follows the edit: into the input when it opens, back to Edit when it
 * closes, and onto the input when a save is refused.
 */
export function FieldRow({ field, selected, manual, sourceId, dispatch }: FieldRowProps) {
  const inputId = useId();
  const errorId = useId();
  const noteId = useId();
  const editing = field.draft !== null;
  const input = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<'input' | 'edit' | null>(null);
  const badge = confidenceBadge(field.confidence, manual);
  const { key, label } = field;

  useEffect(() => {
    if (editing && focusNext.current === 'input') input.current?.focus();
    if (!editing && focusNext.current === 'edit') editButton.current?.focus();
    focusNext.current = null;
  }, [editing]);

  useEffect(() => {
    if (field.error) input.current?.focus();
  }, [field.error]);

  const edit = () => {
    focusNext.current = 'input';
    dispatch({ type: 'edit', key });
  };
  const save = () => {
    focusNext.current = 'edit';
    dispatch({ type: 'save', key });
  };
  const cancel = () => {
    focusNext.current = 'edit';
    dispatch({ type: 'cancel', key });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  };

  const describedBy = [field.error ? errorId : null, field.note ? noteId : null]
    .filter(Boolean)
    .join(' ');
  const control = {
    id: inputId,
    value: field.draft ?? '',
    invalid: Boolean(field.error),
    'aria-describedby': describedBy || undefined,
    onKeyDown,
  };
  const controlClass = 'mt-1 max-w-[260px]';

  return (
    <div
      role="group"
      aria-label={label}
      onFocus={() => !selected && dispatch({ type: 'select', key })}
      className={cn(
        '-mx-3 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-control border-t border-line px-3 py-2',
        'transition-colors duration-(--duration-fast) ease-out max-sm:grid-cols-[minmax(0,1fr)_auto]',
        selected && 'bg-blue-tint/60',
      )}
    >
      {editing ? (
        <div className="min-w-0 py-1">
          <label htmlFor={inputId} className="block text-small text-ink-3">
            {label}
          </label>
          {field.choices ? (
            <Select
              ref={input}
              {...control}
              className={controlClass}
              onChange={(event) =>
                dispatch({ type: 'draft', key, text: event.currentTarget.value })
              }
            >
              <option value="">Not on the stub</option>
              {field.choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              ref={input}
              {...control}
              type={field.kind === 'date' ? 'date' : 'text'}
              inputMode={field.kind === 'money' ? 'decimal' : undefined}
              autoComplete="off"
              spellCheck={field.kind === 'text'}
              className={cn(controlClass, field.kind === 'money' && 'tabular-nums')}
              onChange={(event) =>
                dispatch({ type: 'draft', key, text: event.currentTarget.value })
              }
            />
          )}
          <FieldError id={errorId}>{field.error}</FieldError>
          {field.note && (
            <div id={noteId} className="mt-1 text-tiny text-ink-3">
              {field.note}
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          aria-controls={sourceId}
          aria-current={selected ? 'true' : undefined}
          onClick={() => dispatch({ type: 'select', key })}
          className="block min-h-11 w-full min-w-0 rounded-seg text-left"
        >
          <span className="block text-small text-ink-3">{label}</span>
          <span
            className={cn(
              'block text-lead font-semibold tabular-nums',
              field.value === null && 'font-normal text-ink-3',
            )}
          >
            {fieldDisplay(field, manual)}
          </span>
          {field.note && <span className="block text-tiny text-ink-3">{field.note}</span>}
        </button>
      )}

      {badge ? (
        <Badge tone={badge.tone} title="Extraction confidence">
          {badge.label}
        </Badge>
      ) : (
        <span />
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 max-sm:col-span-full max-sm:justify-start">
        {editing ? (
          <>
            <Button
              size="sm"
              // One blue action per screen: in manual entry every row is open at once.
              variant={manual ? 'default' : 'primary'}
              onClick={save}
              aria-label={`Save and confirm ${label}`}
            >
              Save and confirm
            </Button>
            {/* Nothing to go back to before a first value is typed. */}
            {!(manual && field.value === null) && (
              <Button size="sm" onClick={cancel} aria-label={`Cancel ${label}`}>
                Cancel
              </Button>
            )}
          </>
        ) : (
          <>
            {field.confirmed ? (
              <Button
                size="sm"
                variant="confirmed"
                pressed
                aria-label={`Confirmed ${label}`}
                onClick={() => dispatch({ type: 'toggle', key })}
              >
                <CheckIcon size={14} />
                Confirmed
              </Button>
            ) : (
              <Button
                size="sm"
                pressed={false}
                aria-label={`Confirm ${label}`}
                onClick={() => {
                  focusNext.current = 'input';
                  dispatch({ type: 'toggle', key });
                }}
              >
                <CheckIcon size={14} />
                Confirm
              </Button>
            )}
            <Button ref={editButton} size="sm" onClick={edit} aria-label={`Edit ${label}`}>
              <EditIcon />
              Edit
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

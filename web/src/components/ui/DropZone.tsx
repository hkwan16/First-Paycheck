'use client';

import { useId, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { UploadIcon } from '@/components/icons';
import { cn } from '@/lib/cn';

/** Whether a file satisfies an `accept` string (extensions, exact MIME types, `type/*`). */
export function fileMatchesAccept(file: File, accept: string): boolean {
  const rules = accept
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
  if (rules.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

export interface DropZoneProps {
  /** Same syntax as the input's accept attribute, e.g. ".pdf,.png,.jpg,.jpeg". */
  accept: string;
  onFiles: (files: File[]) => void;
  /** Files that did not match accept (a drop can bypass the picker's filter). */
  onReject?: (files: File[]) => void;
  title: ReactNode;
  hint?: ReactNode;
  multiple?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * From the mockup's `.drop`: a dashed target that is also a real file input.
 * The input stays in the tab order (visually hidden), so Tab reaches it and
 * Enter or Space opens the picker; the label shows its focus ring.
 */
export function DropZone({
  accept,
  onFiles,
  onReject,
  title,
  hint,
  multiple = false,
  disabled = false,
  id,
  className,
}: DropZoneProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [dragging, setDragging] = useState(false);

  const deliver = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (disabled || files.length === 0) return;
    const accepted = files.filter((file) => fileMatchesAccept(file, accept));
    const rejected = files.filter((file) => !fileMatchesAccept(file, accept));
    if (accepted.length > 0) onFiles(multiple ? accepted : accepted.slice(0, 1));
    if (rejected.length > 0) onReject?.(rejected);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    deliver(event.currentTarget.files);
    // Let the same file be chosen again after a failed upload.
    event.currentTarget.value = '';
  };

  const onDragOver = (event: DragEvent<HTMLLabelElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    deliver(event.dataTransfer.files);
  };

  return (
    <label
      htmlFor={inputId}
      data-dragging={dragging || undefined}
      onDragEnter={() => !disabled && setDragging(true)}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        'relative flex items-center gap-3.5 rounded-tile border-[1.5px] border-dashed border-ink/22 bg-well p-[18px]',
        'transition-colors duration-(--duration-fast) ease-out',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-blue',
        'data-dragging:border-blue data-dragging:bg-blue-tint/50',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={onChange}
        className="sr-only"
      />
      <UploadIcon className="flex-none text-blue" />
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        {hint !== undefined && <span className="block text-small text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

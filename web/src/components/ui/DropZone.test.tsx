import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DropZone, fileMatchesAccept } from './DropZone';

const pdf = () => new File(['%PDF'], 'stub.pdf', { type: 'application/pdf' });
const png = () => new File(['png'], 'photo.png', { type: 'image/png' });
const txt = () => new File(['hi'], 'notes.txt', { type: 'text/plain' });

describe('fileMatchesAccept', () => {
  it.each([
    ['.pdf,.png,.jpg,.jpeg', pdf(), true],
    ['.pdf,.png,.jpg,.jpeg', png(), true],
    ['.pdf,.png,.jpg,.jpeg', txt(), false],
    ['application/pdf', pdf(), true],
    ['image/*', png(), true],
    ['image/*', pdf(), false],
    ['', txt(), true],
  ])('accept %j with %o is %s', (accept, file, expected) => {
    expect(fileMatchesAccept(file, accept)).toBe(expected);
  });
});

function setup() {
  const onFiles = vi.fn();
  const onReject = vi.fn();
  render(
    <DropZone
      accept=".pdf,.png,.jpg,.jpeg"
      title="Add another document"
      hint="PDF, PNG or JPEG. Scanned pages are read with OCR."
      onFiles={onFiles}
      onReject={onReject}
    />,
  );
  return { onFiles, onReject, input: screen.getByLabelText(/Add another document/) };
}

describe('DropZone', () => {
  it('is a labeled file input that keyboard users reach with Tab', async () => {
    const { input } = setup();
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', '.pdf,.png,.jpg,.jpeg');
    await userEvent.tab();
    expect(input).toHaveFocus();
    expect(input.closest('label')).toHaveClass('border-dashed', 'has-[:focus-visible]:outline-2');
  });

  it('hands picked files to onFiles', async () => {
    const { input, onFiles } = setup();
    const file = pdf();
    await userEvent.upload(input, file);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('rejects files outside accept instead of passing them on', async () => {
    const { input, onFiles, onReject } = setup();
    const file = txt();
    await userEvent.upload(input, file, { applyAccept: false });
    expect(onFiles).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith([file]);
  });

  it('accepts dropped files and highlights while dragging', () => {
    const { input, onFiles } = setup();
    const zone = input.closest('label') as HTMLElement;
    const file = png();

    fireEvent.dragEnter(zone, { dataTransfer: { files: [file], types: ['Files'] } });
    expect(zone).toHaveAttribute('data-dragging', 'true');

    const drop = createEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } });
    fireEvent(zone, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(zone).not.toHaveAttribute('data-dragging');
  });

  it('ignores input while disabled', async () => {
    const onFiles = vi.fn();
    render(<DropZone accept=".pdf" title="Upload" onFiles={onFiles} disabled />);
    const input = screen.getByLabelText('Upload');
    expect(input).toBeDisabled();
    fireEvent.drop(input.closest('label') as HTMLElement, { dataTransfer: { files: [pdf()] } });
    expect(onFiles).not.toHaveBeenCalled();
  });
});

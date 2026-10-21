import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { KitGallery } from './KitGallery';

vi.mock('next/navigation', () => ({ usePathname: () => '/dev/kit' }));

const SECTIONS = [
  'Buttons',
  'Badges and chips',
  'Cards',
  'Tiles',
  'Stat tiles',
  'Icon tiles',
  'Bars',
  'Key and value rows',
  'Segmented controls',
  'Fields',
  'Notices',
  'Swatches',
  'List rows',
  'Drop zone',
  'Money and numbers',
  'Icons',
  'Navigation steps',
  'Step footer',
];

describe('KitGallery', () => {
  it('shows a section for every ui and chrome component', () => {
    render(<KitGallery />);
    for (const name of SECTIONS) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { level: 1, name: 'Component kit' })).toBeInTheDocument();
  });

  it('renders inside the app chrome', () => {
    render(<KitGallery />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Setup steps' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('keeps the interactive samples live', async () => {
    render(<KitGallery />);
    const group = screen.getByRole('group', { name: 'Filing status' });
    await userEvent.click(within(group).getByRole('button', { name: 'Head of household' }));
    expect(within(group).getByRole('button', { name: 'Head of household' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

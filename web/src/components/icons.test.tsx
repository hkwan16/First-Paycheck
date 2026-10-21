import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as icons from './icons';

const entries = Object.entries(icons).filter(([name]) => /^[A-Z]/.test(name));

describe('icons', () => {
  it('exports the mockup glyphs', () => {
    expect(entries.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'LogoMark',
        'CheckIcon',
        'ArrowRightIcon',
        'LinkIcon',
        'UploadIcon',
        'ShieldIcon',
        'ShieldCheckIcon',
        'DocumentIcon',
        'EditIcon',
        'AlertIcon',
        'QuestionIcon',
        'PlanIcon',
        'TrendIcon',
      ]),
    );
  });

  it.each(entries)('%s is decorative, sized, and drawn in currentColor', (_, Icon) => {
    const Component = Icon as (props: { size?: number; className?: string }) => React.ReactNode;
    const { container } = render(<Component size={24} className="probe" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveAttribute('width', '24');
    expect(svg).toHaveAttribute('height', '24');
    expect(svg).toHaveClass('probe');
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('lets a caller thicken or thin the stroke', () => {
    const { container } = render(<icons.CheckIcon strokeWidth={2.5} />);
    expect(container.querySelector('path')).toHaveAttribute('stroke-width', '2.5');
  });
});

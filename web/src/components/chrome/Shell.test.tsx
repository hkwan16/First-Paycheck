import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Shell } from './Shell';

describe('Shell', () => {
  it('lays out header, a flexible nav column and the main column', () => {
    render(
      <Shell header={<header>top</header>} nav={<nav aria-label="Setup steps">nav</nav>}>
        <h1>Screen</h1>
      </Shell>,
    );
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveClass('flex-[999_1_560px]', 'min-w-0', 'gap-6');
    const navColumn = screen.getByRole('navigation').parentElement;
    expect(navColumn).toHaveClass('flex-[1_1_200px]', 'max-w-60', 'max-nav:max-w-none');
    expect(main.parentElement).toHaveClass('flex-wrap', 'max-w-[1280px]', 'p-6', 'gap-6');
  });

  it('offers a skip link to the main column as the first tab stop', async () => {
    render(
      <Shell header={<header>top</header>} nav={<nav>nav</nav>}>
        <a href="#x">inside</a>
      </Shell>,
    );
    await userEvent.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');
  });
});

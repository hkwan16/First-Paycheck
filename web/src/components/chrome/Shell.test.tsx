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
    const navColumn = screen.getByRole('navigation').parentElement?.parentElement;
    expect(navColumn).toHaveClass('flex-[1_1_200px]', 'max-w-60', 'max-nav:max-w-none');
    expect(main.parentElement).toHaveClass('flex-wrap', 'max-w-[1280px]', 'p-6', 'gap-6');
  });

  it('keeps the nav in view while the page scrolls, where it rests below the header', () => {
    render(
      <Shell header={<header>top</header>} nav={<nav aria-label="Setup steps">nav</nav>}>
        <h1>Screen</h1>
      </Shell>,
    );
    const stuck = screen.getByRole('navigation').parentElement!;
    expect(stuck).toHaveClass('nav:sticky', 'nav:top-nav-top');
    // In a short window it is no taller than the window below the header and scrolls on its own.
    expect(stuck).toHaveClass(
      'nav:max-h-[calc(100vh-var(--spacing-nav-top))]',
      'nav:overflow-y-auto',
    );
    // Room inside the scroll box for a focus ring, which the overflow would otherwise clip.
    expect(stuck).toHaveClass('nav:-mx-1', 'nav:px-1', 'nav:pb-1');
    // Sticky holds only while no ancestor scrolls or clips: the column and the row leave overflow alone.
    for (let ancestor = stuck.parentElement; ancestor; ancestor = ancestor.parentElement) {
      expect(ancestor.className).not.toMatch(/overflow-/);
    }
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

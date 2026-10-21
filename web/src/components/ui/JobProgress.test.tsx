import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { sampleJob } from '@/test/fixtures/sample';
import { JobProgress } from './JobProgress';

describe('JobProgress', () => {
  it('shows the label, the percent and a blue bar while running', () => {
    render(
      <JobProgress
        label="Syncing First Platypus Bank"
        job={sampleJob({ status: 'running', progress: 40 })}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Syncing First Platypus Bank' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar.firstElementChild).toHaveClass('bg-blue');
    expect(screen.getByText('Syncing First Platypus Bank')).toBeInTheDocument();
    expect(screen.getByText('40%')).toHaveClass('tabular-nums');
  });

  it('keeps moving before the job reports progress', () => {
    const { rerender } = render(<JobProgress label="Syncing" job={undefined} />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByRole('status')).toHaveTextContent('Starting');

    rerender(<JobProgress label="Syncing" job={sampleJob({ status: 'queued' })} />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByRole('status')).toHaveTextContent('Waiting to start');

    rerender(<JobProgress label="Syncing" job={sampleJob({ status: 'running', progress: 0 })} />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByRole('status')).toHaveTextContent('Working');
  });

  it('announces state changes politely, not every percent', () => {
    render(<JobProgress label="Syncing" job={sampleJob({ status: 'running', progress: 70 })} />);
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Working');
    expect(live).not.toHaveTextContent('70%');
  });

  it('fills the bar and says done when the job succeeds', () => {
    render(<JobProgress label="Syncing" job={sampleJob({ status: 'succeeded', progress: 100 })} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('status')).toHaveTextContent('Done');
  });

  it('shows a failed job as a warning with a retry button', async () => {
    const onRetry = vi.fn();
    render(
      <JobProgress
        label="Syncing First Platypus Bank"
        job={sampleJob({ status: 'dead', last_error: 'ITEM_LOGIN_REQUIRED' })}
        failedMessage="The sync stopped before it finished."
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Syncing First Platypus Bank did not finish.');
    expect(alert).toHaveTextContent('The sync stopped before it finished.');
    expect(alert).toHaveClass('bg-amber-tint');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('treats an unreadable job as failed too', () => {
    render(<JobProgress label="Syncing" job={undefined} failed />);
    expect(screen.getByRole('alert')).toHaveTextContent('Syncing did not finish.');
    // Without onRetry there is nothing to press.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the retry in progress without accepting a second press', () => {
    render(
      <JobProgress
        label="Syncing"
        job={sampleJob({ status: 'dead' })}
        onRetry={() => {}}
        retrying
      />,
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveAttribute('aria-busy', 'true');
  });
});

import { afterEach, describe, expect, test, vi } from 'vitest';

describe('one-shot synchronization', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test('sets a failing exit code when synchronization fails', async () => {
    process.exitCode = undefined;
    vi.doMock('../env', () => ({ SYNC_INTERVAL_HOURS: 0 }));
    vi.doMock('../portalClient', () => ({
      fetchPortalLectures: vi.fn().mockRejectedValue(new Error('portal failed')),
    }));
    vi.doMock('../googleCalendar', () => ({
      syncGoogleCalendar: vi.fn(),
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await import('../index');

    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to sync timetable',
      expect.any(Error)
    );
  });
});

import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CalendarEventPayload } from '../googleEvents';

const state = vi.hoisted(() => ({
  events: [] as CalendarEventPayload[],
}));

vi.mock('../env', () => ({
  START_YYYYMMDD: '20260302',
  END_YYYYMMDD: '20260619',
  GOOGLE_CALENDAR_ID: 'calendar-secret@example.com',
  GOOGLE_CLIENT_EMAIL: 'service-account@example.com',
  GOOGLE_PRIVATE_KEY: 'unused-in-tests',
}));

vi.mock('../googleEvents', () => ({
  buildCalendarEvents: () => state.events,
}));

const localEvent: CalendarEventPayload = {
  sourceKey: 'course|normal|teacher|room|20260302T090000|20260302T095000',
  summary: 'Course',
  description: 'Teacher: teacher\nLocation: room',
  location: 'room',
  start: {
    dateTime: '2026-03-02T09:00:00+09:00',
    timeZone: 'Asia/Seoul',
  },
  end: {
    dateTime: '2026-03-02T09:50:00+09:00',
    timeZone: 'Asia/Seoul',
  },
};

const toEventId = (sourceKey: string) =>
  `jnu${crypto
    .createHash('sha256')
    .update(sourceKey)
    .digest('hex')
    .slice(0, 48)}`;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const installFetchMock = (
  calendarHandler: (url: string, init: RequestInit) => Response | Promise<Response>
) => {
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: 'test-token', expires_in: 3600 });
      }
      return calendarHandler(url, init);
    }
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('Google Calendar synchronization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.spyOn(crypto, 'createSign').mockReturnValue({
      update: vi.fn(),
      sign: vi.fn(() => Buffer.from('test-signature')),
    } as unknown as ReturnType<typeof crypto.createSign>);
    state.events = [localEvent];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('creates a missing deterministic event with POST and skips it next time', async () => {
    const remoteEvents: Record<string, unknown>[] = [];
    const mutations: Array<{ method: string; body: Record<string, unknown> }> = [];

    installFetchMock((_url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') return jsonResponse({ items: remoteEvents });

      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      mutations.push({ method, body });
      remoteEvents.push(body);
      return jsonResponse(body);
    });

    const { syncGoogleCalendar } = await import('../googleCalendar');
    await expect(syncGoogleCalendar([])).resolves.toEqual({
      inserted: 1,
      deleted: 0,
    });
    await expect(syncGoogleCalendar([])).resolves.toEqual({
      inserted: 0,
      deleted: 0,
    });

    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toEqual({
      method: 'POST',
      body: {
        id: toEventId(localEvent.sourceKey),
        summary: localEvent.summary,
        description: localEvent.description,
        location: localEvent.location,
        start: localEvent.start,
        end: localEvent.end,
        extendedProperties: {
          private: {
            managedBy: 'jnu-google-calendar-sync',
            sourceKey: localEvent.sourceKey,
          },
        },
      },
    });
  });

  test('updates an existing changed event with PUT', async () => {
    const eventId = toEventId(localEvent.sourceKey);
    const methods: string[] = [];

    installFetchMock((_url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        return jsonResponse({
          items: [{ id: eventId, ...localEvent, description: 'old' }],
        });
      }
      methods.push(method);
      return jsonResponse({});
    });

    const { syncGoogleCalendar } = await import('../googleCalendar');
    await expect(syncGoogleCalendar([])).resolves.toEqual({
      inserted: 1,
      deleted: 0,
    });
    expect(methods).toEqual(['PUT']);
  });

  test('deletes stale managed events', async () => {
    state.events = [];
    const staleId = 'jnustaleevent';
    const requests: Array<{ url: string; method: string }> = [];

    installFetchMock((url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') return jsonResponse({ items: [{ id: staleId }] });
      requests.push({ url, method });
      return new Response(null, { status: 204 });
    });

    const { syncGoogleCalendar } = await import('../googleCalendar');
    await expect(syncGoogleCalendar([])).resolves.toEqual({
      inserted: 0,
      deleted: 1,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('DELETE');
    expect(requests[0].url).toContain(`/events/${staleId}`);
  });

  test('falls back to PUT when a concurrent POST returns 409', async () => {
    const methods: string[] = [];

    installFetchMock((_url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') return jsonResponse({ items: [] });
      methods.push(method);
      if (method === 'POST') return jsonResponse({ error: 'conflict' }, 409);
      return jsonResponse({});
    });

    const { syncGoogleCalendar } = await import('../googleCalendar');
    await expect(syncGoogleCalendar([])).resolves.toEqual({
      inserted: 1,
      deleted: 0,
    });
    expect(methods).toEqual(['POST', 'PUT']);
  });

  test('redacts the calendar id from Google API errors', async () => {
    installFetchMock(() =>
      jsonResponse({ error: 'calendar-secret@example.com' }, 400)
    );

    const { syncGoogleCalendar } = await import('../googleCalendar');
    let error: unknown;
    try {
      await syncGoogleCalendar([]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const serializedError = `${String(error)} ${JSON.stringify(error)}`;
    expect(serializedError).not.toContain('calendar-secret@example.com');
    expect(serializedError).not.toContain('calendar-secret%40example.com');
  });
});

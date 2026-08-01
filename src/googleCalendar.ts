import crypto from 'node:crypto';

import type { Lecture } from './response';
import { buildCalendarEvents } from './googleEvents';
import {
  END_YYYYMMDD,
  GOOGLE_CALENDAR_ID,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  START_YYYYMMDD,
} from './env';
import { withRetry } from './retry';

const GOOGLE_TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

type AccessTokenState = { token: string; expiresAt: number } | null;
let accessToken: AccessTokenState = null;
const MANAGED_BY = 'jnu-google-calendar-sync';

class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly path: string
  ) {
    super(
      `Google Calendar API request failed (${status}) for ${path}: ${responseBody}`
    );
    this.name = 'GoogleApiError';
  }
}

function redactGoogleApiDetails(value: string) {
  return [GOOGLE_CALENDAR_ID, encodeURIComponent(GOOGLE_CALENDAR_ID)].reduce(
    (redacted, sensitiveValue) =>
      redacted.split(sensitiveValue).join('[redacted]'),
    value
  );
}

const base64Url = (input: Buffer | string) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

async function getAccessToken() {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000)
    return accessToken.token;

  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: GOOGLE_CLIENT_EMAIL,
    scope: CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_AUDIENCE,
    exp: iat + 3600,
    iat,
  } satisfies Record<string, unknown>;
  const header = { alg: 'RS256', typ: 'JWT' };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(payload)
  )}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'));
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetch(GOOGLE_TOKEN_AUDIENCE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!response.ok)
    throw new Error(
      `Failed to issue Google access token: ${response.status} ${response.statusText}`
    );

  const json = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  accessToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };

  return accessToken.token;
}

async function googleRequest(path: string, init: RequestInit = {}) {
  return withRetry(
    async () => {
      const token = await getAccessToken();
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(init.headers as Record<string, string> | undefined),
          },
        }
      );

      if (!response.ok) {
        const body = await response.text();
        throw new GoogleApiError(
          response.status,
          redactGoogleApiDetails(body),
          redactGoogleApiDetails(path)
        );
      }

      return response;
    },
    {
      retries: 2,
      delayMs: 1000,
      shouldRetry(error) {
        if (!(error instanceof GoogleApiError)) return false;
        return error.status === 429 || error.status >= 500;
      },
      onRetry(error, attempt, delayMs) {
        console.warn(
          `Google API request failed (attempt ${attempt}). Retrying in ${delayMs}ms...`,
          error
        );
      },
    }
  );
}

type CalendarEventLite = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: { managedBy?: string; sourceKey?: string } };
};

function toEventId(sourceKey: string) {
  const digest = crypto
    .createHash('sha256')
    .update(sourceKey)
    .digest('hex')
    .slice(0, 48);
  return `jnu${digest}`;
}

async function listManagedEventsBetween(timeMin: string, timeMax: string) {
  const calendarId = encodeURIComponent(GOOGLE_CALENDAR_ID);
  const managedEvents: CalendarEventLite[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      maxResults: '2500',
      orderBy: 'startTime',
      privateExtendedProperty: `managedBy=${MANAGED_BY}`,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await googleRequest(
      `calendars/${calendarId}/events?${params.toString()}`
    );
    const body = (await response.json()) as {
      nextPageToken?: string;
      items?: CalendarEventLite[];
    };
    managedEvents.push(...(body.items ?? []));

    pageToken = body.nextPageToken;
  } while (pageToken);

  return managedEvents;
}

function isSameEvent(
  remote: CalendarEventLite | undefined,
  local: ReturnType<typeof buildCalendarEvents>[number]
) {
  if (!remote) return false;
  return (
    remote.summary === local.summary &&
    (remote.description ?? '') === local.description &&
    (remote.location ?? '') === (local.location ?? '') &&
    remote.start?.dateTime === local.start.dateTime &&
    remote.end?.dateTime === local.end.dateTime &&
    remote.start?.timeZone === local.start.timeZone &&
    remote.end?.timeZone === local.end.timeZone
  );
}

async function upsertEvents(
  events: ReturnType<typeof buildCalendarEvents>,
  remoteById: Map<string, CalendarEventLite>
) {
  const calendarId = encodeURIComponent(GOOGLE_CALENDAR_ID);
  let inserted = 0;

  for (const event of events) {
    const eventId = toEventId(event.sourceKey);
    const body = {
      summary: event.summary,
      description: event.description,
      start: event.start,
      end: event.end,
      ...(event.location ? { location: event.location } : {}),
      extendedProperties: {
        private: {
          managedBy: MANAGED_BY,
          sourceKey: event.sourceKey,
        },
      },
    };

    if (remoteById.has(eventId)) {
      await googleRequest(`calendars/${calendarId}/events/${eventId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    } else {
      try {
        await googleRequest(`calendars/${calendarId}/events`, {
          method: 'POST',
          body: JSON.stringify({ id: eventId, ...body }),
        });
      } catch (error) {
        if (!(error instanceof GoogleApiError) || error.status !== 409)
          throw error;

        await googleRequest(`calendars/${calendarId}/events/${eventId}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      }
    }
    inserted += 1;
  }

  return inserted;
}

async function deleteStaleEvents(
  remoteEvents: CalendarEventLite[],
  localEvents: ReturnType<typeof buildCalendarEvents>
) {
  const calendarId = encodeURIComponent(GOOGLE_CALENDAR_ID);
  const localIds = new Set(localEvents.map((event) => toEventId(event.sourceKey)));
  let deleted = 0;

  for (const remoteEvent of remoteEvents) {
    if (!remoteEvent.id || localIds.has(remoteEvent.id)) continue;

    await googleRequest(
      `calendars/${calendarId}/events/${encodeURIComponent(remoteEvent.id)}`,
      {
        method: 'DELETE',
      }
    );
    deleted += 1;
  }

  return deleted;
}

export async function syncGoogleCalendar(lectures: Lecture[]) {
  const events = buildCalendarEvents(lectures);
  const timeMin = `${START_YYYYMMDD.slice(0, 4)}-${START_YYYYMMDD.slice(4, 6)}-${START_YYYYMMDD.slice(6, 8)}T00:00:00+09:00`;
  const timeMax = `${END_YYYYMMDD.slice(0, 4)}-${END_YYYYMMDD.slice(4, 6)}-${END_YYYYMMDD.slice(6, 8)}T23:59:59+09:00`;

  const remoteEvents = await listManagedEventsBetween(timeMin, timeMax);
  const remoteById = new Map(
    remoteEvents.filter((event) => event.id).map((event) => [event.id!, event])
  );

  const changedEvents = events.filter((event) => {
    const eventId = toEventId(event.sourceKey);
    const remoteEvent = remoteById.get(eventId);
    return !isSameEvent(remoteEvent, event);
  });

  const inserted = await upsertEvents(changedEvents, remoteById);
  const deleted = await deleteStaleEvents(remoteEvents, events);

  return { inserted, deleted };
}

/**
 * Provider response fixtures modelled on the documented shapes of Google Calendar API v3
 * (`calendarList`, `events` with `singleEvents=true`) and Microsoft Graph v1.0 (`calendar`,
 * `calendarView` with `Prefer: outlook.timezone="UTC"`). All data is fictional.
 */

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

export const googleCalendarList = {
  kind: 'calendar#calendarList',
  etag: '"p33k9s7r1ooo0o0g"',
  nextSyncToken: 'CKCw7tv1-_4CEhFhbGljZUBnbWFpbC5jb20=',
  items: [
    {
      kind: 'calendar#calendarListEntry',
      etag: '"1695000000000000"',
      id: 'alice@gmail.com',
      summary: 'alice@gmail.com',
      timeZone: 'Europe/Berlin',
      colorId: '14',
      backgroundColor: '#9FE1E7',
      foregroundColor: '#000000',
      selected: true,
      accessRole: 'owner',
      defaultReminders: [{ method: 'popup', minutes: 10 }],
      primary: true,
    },
    {
      kind: 'calendar#calendarListEntry',
      etag: '"1695000000000001"',
      id: 'en.german#holiday@group.v.calendar.google.com',
      summary: 'Holidays in Germany',
      summaryOverride: 'Feiertage',
      timeZone: 'Europe/Berlin',
      backgroundColor: '#16a765',
      selected: false,
      accessRole: 'reader',
    },
    {
      kind: 'calendar#calendarListEntry',
      id: 'family0123@group.calendar.google.com',
      summary: 'Family',
      backgroundColor: 'rgb(1,2,3)', // invalid → null
      accessRole: 'writer',
    },
  ],
};

export const googleEventsPage1 = {
  kind: 'calendar#events',
  summary: 'alice@gmail.com',
  timeZone: 'Europe/Berlin',
  accessRole: 'owner',
  nextPageToken: 'page-2',
  items: [
    {
      kind: 'calendar#event',
      etag: '"3391000000000000"',
      id: 'abc123timed',
      status: 'confirmed',
      htmlLink: 'https://www.google.com/calendar/event?eid=YWJjMTIzdGltZWQ',
      created: '2026-09-01T08:00:00.000Z',
      updated: '2026-09-02T08:00:00.000Z',
      summary: 'Dentist',
      description: 'Bring the <b>insurance card</b>.<br>Details: <a href="https://example.com/dentist">https://example.com/dentist</a><br>Tom &amp; Jerry',
      location: 'Hauptstraße 1, Berlin',
      creator: { email: 'alice@gmail.com', self: true },
      organizer: { email: 'alice@gmail.com', self: true },
      start: { dateTime: '2026-09-28T09:30:00+02:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-09-28T10:15:00+02:00', timeZone: 'Europe/Berlin' },
      iCalUID: 'abc123timed@google.com',
      sequence: 0,
      reminders: { useDefault: true },
      eventType: 'default',
    },
    {
      kind: 'calendar#event',
      id: 'allday456',
      status: 'confirmed',
      htmlLink: 'https://www.google.com/calendar/event?eid=YWxsZGF5NDU2',
      summary: 'Vacation',
      organizer: { email: 'alice@gmail.com', self: true },
      start: { date: '2026-10-01' },
      end: { date: '2026-10-04' },
      eventType: 'default',
    },
    {
      kind: 'calendar#event',
      id: 'weekly789_20260929T070000Z',
      status: 'confirmed',
      htmlLink: 'https://www.google.com/calendar/event?eid=d2Vla2x5',
      summary: 'Team sync',
      organizer: { email: 'boss@example.com' },
      attendees: [
        { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
        { email: 'alice@gmail.com', self: true, responseStatus: 'accepted' },
      ],
      start: { dateTime: '2026-09-29T09:00:00+02:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-09-29T09:30:00+02:00', timeZone: 'Europe/Berlin' },
      recurringEventId: 'weekly789',
      originalStartTime: { dateTime: '2026-09-29T09:00:00+02:00', timeZone: 'Europe/Berlin' },
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      conferenceData: {
        entryPoints: [
          { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij', label: 'meet.google.com/abc-defg-hij' },
          { entryPointType: 'phone', uri: 'tel:+49-30-123456', pin: '123' },
        ],
      },
    },
  ],
};

export const googleEventsPage2 = {
  kind: 'calendar#events',
  timeZone: 'Europe/Berlin',
  items: [
    {
      kind: 'calendar#event',
      id: 'declined1',
      status: 'confirmed',
      summary: 'Optional meetup',
      organizer: { email: 'someone@example.com' },
      attendees: [{ email: 'alice@gmail.com', self: true, responseStatus: 'declined' }],
      start: { dateTime: '2026-09-30T16:00:00Z' },
      end: { dateTime: '2026-09-30T17:00:00Z' },
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/123456789' }] },
      guestsCanModify: false,
    },
    {
      kind: 'calendar#event',
      id: 'wl1',
      eventType: 'workingLocation',
      summary: 'Home',
      start: { date: '2026-09-28' },
      end: { date: '2026-09-29' },
    },
    {
      kind: 'calendar#event',
      id: 'evil1',
      status: 'confirmed',
      summary: 'Evil <script>alert(1)</script>',
      htmlLink: 'javascript:alert(1)',
      hangoutLink: 'data:text/html,hi',
      start: { dateTime: '2026-10-02T10:00:00Z' },
      end: { dateTime: '2026-10-02T11:00:00Z' },
    },
  ],
};

/** 403 for any Calendar API call when the API is not enabled in the OAuth client's Cloud project. */
export const googleApiDisabled = {
  error: {
    code: 403,
    message:
      'Google Calendar API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456789012 then retry.',
    errors: [{ message: 'Google Calendar API has not been used in project 123456789012 before or it is disabled.', domain: 'usageLimits', reason: 'accessNotConfigured', extendedHelp: 'https://console.developers.google.com' }],
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'SERVICE_DISABLED',
        domain: 'googleapis.com',
        metadata: { service: 'calendar-json.googleapis.com', consumer: 'projects/123456789012' },
      },
    ],
  },
};

/** 403 when the token lacks the scope a call needs (here: calendarList without calendarlist.readonly). */
export const googleScopeInsufficient = {
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
        domain: 'googleapis.com',
        metadata: { service: 'calendar-json.googleapis.com', method: 'calendar.v3.CalendarList.List' },
      },
    ],
  },
};

/** Plain 403 (no access to this calendar or event). */
export const googleForbidden = {
  error: { code: 403, message: 'Forbidden', errors: [{ message: 'Forbidden', domain: 'global', reason: 'forbidden' }] },
};

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

export const graphCalendars = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#me/calendars(id,name,color,hexColor,canEdit,isDefaultCalendar)",
  value: [
    {
      id: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAD',
      name: 'Calendar',
      color: 'auto',
      hexColor: '',
      isDefaultCalendar: true,
      canEdit: true,
    },
    {
      id: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAE',
      name: 'Birthdays',
      color: 'lightGreen',
      hexColor: '',
      isDefaultCalendar: false,
      canEdit: false,
    },
    {
      id: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAF',
      name: 'Shared',
      color: 'lightBlue',
      hexColor: '#e3008c',
      isDefaultCalendar: false,
      canEdit: true,
    },
  ],
};

export const graphCalendarViewPage1 = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#Collection(event)",
  '@odata.nextLink':
    'https://graph.microsoft.com/v1.0/me/calendars/AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAD/calendarView?startDateTime=2026-08-26T00%3A00%3A00.000Z&endDateTime=2027-09-25T00%3A00%3A00.000Z&%24top=500&%24skip=500',
  value: [
    {
      '@odata.etag': 'W/"DwAAABYAAAB="',
      id: 'AAMkAGI2TGuLAAA=',
      subject: 'Quarterly review',
      body: { contentType: 'html', content: '<html><body><p>Agenda:</p><ul><li>Numbers</li><li>Plans</li></ul><p>Join: <a href="https://teams.microsoft.com/l/meetup-join/abc">Click here</a></p></body></html>' },
      start: { dateTime: '2026-09-30T13:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-09-30T14:30:00.0000000', timeZone: 'UTC' },
      isAllDay: false,
      location: { displayName: 'Room 4.12', locationType: 'default' },
      webLink: 'https://outlook.live.com/owa/?itemid=AAMkAGI2TGuLAAA%3D&exvsurl=1&path=/calendar/item',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
      onlineMeetingUrl: null,
      type: 'singleInstance',
      seriesMasterId: null,
      isCancelled: false,
      isOrganizer: true,
      responseStatus: { response: 'organizer', time: '0001-01-01T00:00:00Z' },
      originalStartTimeZone: 'W. Europe Standard Time',
    },
    {
      id: 'AAMkAGI2allday=',
      subject: 'Public holiday',
      body: { contentType: 'text', content: '' },
      start: { dateTime: '2026-10-03T00:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-04T00:00:00.0000000', timeZone: 'UTC' },
      isAllDay: true,
      location: { displayName: '' },
      webLink: 'https://outlook.live.com/owa/?itemid=AAMkAGI2allday%3D',
      type: 'singleInstance',
      isCancelled: false,
      isOrganizer: true,
      responseStatus: { response: 'organizer' },
      originalStartTimeZone: 'W. Europe Standard Time',
    },
  ],
};

export const graphCalendarViewPage2 = {
  value: [
    {
      id: 'AAMkAGI2occ1=',
      subject: 'Standup',
      body: { contentType: 'text', content: 'Daily standup\r\nBe on time' },
      start: { dateTime: '2026-09-29T07:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-09-29T07:15:00.0000000', timeZone: 'UTC' },
      isAllDay: false,
      type: 'occurrence',
      seriesMasterId: 'AAMkAGI2master=',
      isCancelled: false,
      isOrganizer: false,
      responseStatus: { response: 'tentativelyAccepted' },
      onlineMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/standup',
      originalStartTimeZone: 'Pacific Standard Time',
    },
    {
      id: 'AAMkAGI2cancel=',
      subject: 'Canceled: Lunch',
      start: { dateTime: '2026-10-05T11:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-05T12:00:00.0000000', timeZone: 'UTC' },
      isAllDay: false,
      type: 'singleInstance',
      isCancelled: true,
      isOrganizer: false,
      responseStatus: { response: 'declined' },
    },
    { id: 'AAMkAGI2master=', type: 'seriesMaster', subject: 'Standup', start: { dateTime: '2026-01-01T07:00:00.0000000', timeZone: 'UTC' } },
  ],
};

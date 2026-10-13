/**
 * Microsoft Graph v1.0 response fixtures (`calendar`, `calendarView` with
 * `Prefer: outlook.timezone="UTC"`): a copy of the Graph part of
 * server/src/modules/calendar/__fixtures__/providers.ts. All data is fictional.
 */

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

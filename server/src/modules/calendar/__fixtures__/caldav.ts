/** CalDAV multistatus fixtures (RFC 4918 / RFC 4791 response shapes). */
import type { FakeResponseSpec } from '../../../testing/fake-fetch.ts';
import { ics } from './ics.ts';

export function multistatus(body: string): FakeResponseSpec {
  return {
    status: 207,
    text: `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ca="http://apple.com/ns/ical/">${body}</d:multistatus>`,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  };
}

export function principalResponse(href: string, principal: string): FakeResponseSpec {
  return multistatus(
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
  );
}

export function homeResponse(href: string, home: string): FakeResponseSpec {
  return multistatus(
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${home}</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
  );
}

function collection(href: string, name: string, extra: string, comps: string[] = ['VEVENT']): string {
  const compXml = comps.map((c) => `<c:comp name="${c}"/>`).join('');
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname>${extra}<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set>${compXml}</c:supported-calendar-component-set><cs:getctag>ctag-${name}</cs:getctag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

/** Home listing: the home itself, a VEVENT calendar, a tasks-only list and a foreign-origin href. */
export function calendarsResponse(homePath: string): FakeResponseSpec {
  return multistatus(
    [
      `<d:response><d:href>${homePath}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
      collection(`${homePath}personal/`, 'Personal', '<ca:calendar-color>#FF2968FF</ca:calendar-color>'),
      collection(`${homePath}tasks/`, 'Tasks', '', ['VTODO']),
      collection('https://evil.example.net/steal/', 'Evil', ''),
      collection(`${homePath}work/`, 'Work', '<ca:calendar-color>blue</ca:calendar-color>', ['VEVENT', 'VTODO']),
    ].join(''),
  );
}

const EVENT = ics([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//x//y//EN',
  'BEGIN:VEVENT',
  'UID:dav-1',
  'DTSTART:20261005T090000Z',
  'DTEND:20261005T100000Z',
  'SUMMARY:Dentist &amp; checkup',
  'END:VEVENT',
  'END:VCALENDAR',
]);

const OUTSIDE = ics([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//x//y//EN',
  'BEGIN:VEVENT',
  'UID:dav-outside',
  'DTSTART:20261006T090000Z',
  'SUMMARY:From another collection',
  'END:VEVENT',
  'END:VCALENDAR',
]);

/** REPORT result: one object in the collection, one elsewhere on the server, one on a foreign origin. */
export function reportResponse(collectionPath: string): FakeResponseSpec {
  const item = (href: string, data: string) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>"etag-${href.length}"</d:getetag><c:calendar-data>${data}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  return multistatus(
    [
      item(`${collectionPath}dav-1.ics`, EVENT),
      item('/dav/other-user/calendar/x.ics', OUTSIDE),
      item(`${collectionPath}../../escape.ics`, OUTSIDE),
      item('https://evil.example.net/x.ics', OUTSIDE),
    ].join(''),
  );
}

/**
 * Provider response fixtures modelled on the documented shapes:
 * - Gmail API v1 `users.labels.get`, `users.messages.list`, `users.messages.get(format=metadata)`;
 * - Microsoft Graph v1.0 `mailFolder` and `message` resources (`$select`ed fields).
 * Content deliberately includes hostile text (entities, markup, bidi overrides, invisible padding).
 */

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export const GMAIL_INBOX_LABEL = {
  id: 'INBOX',
  name: 'INBOX',
  messageListVisibility: 'hide',
  labelListVisibility: 'labelShow',
  type: 'system',
  messagesTotal: 1532,
  messagesUnread: 7,
  threadsTotal: 1210,
  threadsUnread: 5,
};

export const GMAIL_LIST = {
  messages: [
    { id: '1925c0ffee000001', threadId: '1925c0ffee000001' },
    { id: '1925c0ffee000002', threadId: '1925bead00000009' },
    { id: '1925c0ffee000003', threadId: '1925c0ffee000003' },
  ],
  nextPageToken: '09876543210',
  resultSizeEstimate: 201,
};

/** 2026-09-24T07:15:00.000Z */
export const GMAIL_DATE_1 = '1790234100000';

export const GMAIL_MESSAGES: Record<string, unknown> = {
  '1925c0ffee000001': {
    id: '1925c0ffee000001',
    threadId: '1925c0ffee000001',
    labelIds: ['UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL', 'INBOX'],
    snippet: 'Hi Dana, here&#39;s the agenda for Monday &amp; the notes &lt;b&gt;attached&lt;/b&gt; &quot;v2&quot;',
    sizeEstimate: 5423,
    historyId: '2718281',
    internalDate: GMAIL_DATE_1,
    payload: {
      partId: '',
      mimeType: 'multipart/alternative',
      filename: '',
      headers: [
        { name: 'Date', value: 'Thu, 24 Sep 2026 09:15:00 +0200' },
        { name: 'From', value: '"Doe, Jane" <jane@example.com>' },
        { name: 'Subject', value: 'Agenda for Monday' },
      ],
    },
  },
  '1925c0ffee000002': {
    id: '1925c0ffee000002',
    threadId: '1925bead00000009',
    labelIds: ['CATEGORY_PROMOTIONS', 'INBOX'],
    snippet: 'Big sale \u200c\u034f\u00ad <script>alert(1)</script> &nbsp;&nbsp;ends soon',
    internalDate: '1790140000000',
    payload: {
      headers: [
        { name: 'from', value: 'deals@shop.example' },
        { name: 'subject', value: 'Invoice \u202egnp.exe\u202c for you' },
        { name: 'Date', value: 'Wed, 23 Sep 2026 05:06:40 +0000' },
      ],
    },
  },
  '1925c0ffee000003': {
    id: '1925c0ffee000003',
    threadId: '1925c0ffee000003',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: '',
    internalDate: '1790000000000',
    payload: { headers: [{ name: 'From', value: 'Bob <bob@example.org>' }] },
  },
};

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

export const GRAPH_INBOX = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('me')/mailFolders(unreadItemCount)/$entity",
  id: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgAuAAADd2ZI',
  unreadItemCount: 3,
};

export const GRAPH_ID_1 = 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AkdRJnQy8lk6Q9nXfM0nB7wAAAgEMAAAA';
export const GRAPH_ID_2 = 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AkdRJnQy8lk6Q9nXfM0nB7wAAAgENAAAA';

export const GRAPH_MESSAGES = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('me')/mailFolders('inbox')/messages(id,subject,from,receivedDateTime,isRead,bodyPreview,webLink)",
  '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=10&$skip=10',
  value: [
    {
      '@odata.etag': 'W/"CQAAABYAAAB4"',
      id: GRAPH_ID_1,
      receivedDateTime: '2026-09-24T18:02:11Z',
      subject: 'Dinner on Friday?',
      bodyPreview: 'Are you free on Friday evening?\r\n\r\nWe could try the new place &amp; then a walk.',
      isRead: false,
      webLink: 'https://outlook.live.com/owa/?ItemID=AAkALgAAAAAAHYQDEapmEc2byACqAC%2FEWg0A&exvsurl=1&viewmodel=ReadMessageItem',
      from: { emailAddress: { name: 'Alex Kim', address: 'alex@outlook.com' } },
    },
    {
      '@odata.etag': 'W/"CQAAABYAAAB5"',
      id: GRAPH_ID_2,
      receivedDateTime: '2026-09-23T07:30:00Z',
      subject: null,
      bodyPreview: '',
      isRead: true,
      webLink: 'https://evil.example/owa/?ItemID=phish',
      from: { emailAddress: { name: 'Microsoft account team', address: 'account-security-noreply@accountprotection.microsoft.com' } },
    },
  ],
};

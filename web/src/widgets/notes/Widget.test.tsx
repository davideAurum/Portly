import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useProfiles } from '../../api/profiles.ts';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { createFakeServer, type FakeServer } from '../../test/fakeServer.ts';
import { profile, widget } from '../../test/fixtures.ts';
import { mockError, renderWithProviders, type MockRequest } from '../../test/render.tsx';
import { parseWidgetConfig } from '../registry.ts';
import { MAX_NOTE_LENGTH, definition, notesConfigSchema } from './index.ts';
import { findNotesWidget, initialNote, readNoteDraft, writeNoteDraft } from './model.ts';
import NotesSettings from './Settings.tsx';
import NotesWidget from './Widget.tsx';

const ID = 'w-notes';
const DRAFT_KEY = `portly:notes-draft:${ID}`;
/** Longer than the save delay, with room for a busy machine. */
const SAVED = { timeout: 3000 };

function Frame({ children }: { children: ReactNode }) {
  const value: WidgetFrameContextValue = {
    instanceId: ID,
    title: 'Groceries',
    openSettings: () => {},
    canOpenSettings: true,
    actionsTarget: document.body,
  };
  return <WidgetFrameContext.Provider value={value}>{children}</WidgetFrameContext.Provider>;
}

/** What WidgetFrame does: the widget gets its config from the cached profiles. */
function Harness() {
  const profiles = useProfiles();
  const found = profiles.data ? findNotesWidget(profiles.data, ID) : null;
  if (!found) return null;
  return (
    <Frame>
      <NotesWidget instanceId={ID} config={parseWidgetConfig(definition, found.instance.config)} setConfig={async () => {}} size={{ w: 4, h: 5 }} editMode={false} />
    </Frame>
  );
}

function serverWith(config: Record<string, unknown>): FakeServer {
  return createFakeServer([profile('p1', 'Home', [widget(ID, 'notes', 0, 0, 4, 5, { config })])]);
}

const storedText = (server: FakeServer) => (findNotesWidget(server.profiles, ID)?.instance.config as { text?: string } | undefined)?.text;

async function renderNotes(server: FakeServer, mocks: Record<string, unknown> = {}) {
  const result = renderWithProviders(<Harness />, { apiMocks: { ...server.mocks, ...mocks } });
  const box = await screen.findByRole('textbox', { name: 'Groceries' });
  return { ...result, box };
}

describe('notes config', () => {
  it('defaults every field', () => {
    expect(notesConfigSchema.parse({})).toEqual({ text: '', textSize: 'md', font: 'sans', spellcheck: true });
  });

  it('keeps the note when another field is invalid, and cuts an overlong one', () => {
    expect(notesConfigSchema.parse({ text: 'Keep me', textSize: 'huge', font: 3, spellcheck: 'yes' })).toEqual({
      text: 'Keep me',
      textSize: 'md',
      font: 'sans',
      spellcheck: true,
    });
    expect(notesConfigSchema.parse({ text: 'x'.repeat(MAX_NOTE_LENGTH + 5) }).text).toHaveLength(MAX_NOTE_LENGTH);
    expect(notesConfigSchema.parse({ text: 42 }).text).toBe('');
  });

  it('fits the 64 KB widget config limit even at its worst', () => {
    const config = notesConfigSchema.parse({ text: '\u0001'.repeat(MAX_NOTE_LENGTH), textSize: 'lg', font: 'mono', spellcheck: false });
    expect(new TextEncoder().encode(JSON.stringify(config)).length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('notes drafts', () => {
  it('starts from the stored note, a draft over it, or asks when it changed since', () => {
    expect(initialNote(null, 'stored')).toEqual({ text: 'stored', base: 'stored', theirs: null });
    expect(initialNote({ text: 'stored', base: 'older' }, 'stored')).toEqual({ text: 'stored', base: 'stored', theirs: null });
    expect(initialNote({ text: 'same', base: 'same' }, 'stored')).toEqual({ text: 'stored', base: 'stored', theirs: null });
    expect(initialNote({ text: 'edited', base: 'stored' }, 'stored')).toEqual({ text: 'edited', base: 'stored', theirs: null });
    expect(initialNote({ text: 'edited', base: 'older' }, 'stored')).toEqual({ text: 'edited', base: 'older', theirs: 'stored' });
  });

  it('ignores a draft it cannot read', () => {
    window.localStorage.setItem(DRAFT_KEY, '{broken');
    expect(readNoteDraft(ID)).toBeNull();
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: 1, base: 'x' }));
    expect(readNoteDraft(ID)).toBeNull();
    writeNoteDraft(ID, { text: 'a', base: 'b' });
    expect(readNoteDraft(ID)).toEqual({ text: 'a', base: 'b' });
  });
});

describe('notes widget', () => {
  it('saves what is typed after a pause, over the stored config', async () => {
    const user = userEvent.setup();
    const server = serverWith({ text: 'Milk', textSize: 'lg' });
    const { box, requests } = await renderNotes(server);
    expect(box).toHaveValue('Milk');
    expect(box).toHaveAttribute('placeholder', 'Write a note…');

    await user.type(box, ', eggs');
    // Kept in this browser until the backend has it.
    expect(readNoteDraft(ID)).toEqual({ text: 'Milk, eggs', base: 'Milk' });
    await waitFor(() => expect(storedText(server)).toBe('Milk, eggs'), SAVED);

    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch?.path).toBe(`/api/profiles/p1/widgets/${ID}`);
    expect(patch?.body).toEqual({ config: { text: 'Milk, eggs', textSize: 'lg', font: 'sans', spellcheck: true } });
    // The stored note was read first.
    const patchIndex = requests.indexOf(patch!);
    expect(requests.slice(0, patchIndex).some((r) => r.method === 'GET' && r.path === '/api/profiles')).toBe(true);
    await waitFor(() => expect(readNoteDraft(ID)).toBeNull());
  });

  it('saves at once on Ctrl+S and on blur', async () => {
    const user = userEvent.setup();
    const server = serverWith({ text: '' });
    const { box } = await renderNotes(server);

    await user.type(box, 'one');
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(storedText(server)).toBe('one'));

    await user.type(box, ' two');
    fireEvent.blur(box);
    await waitFor(() => expect(storedText(server)).toBe('one two'));
  });

  it('never overwrites a note another tab changed: Keep mine saves this one', async () => {
    const user = userEvent.setup();
    const server = serverWith({ text: 'Plan' });
    const { box, requestsTo } = await renderNotes(server);
    // Another tab saves while this one still shows the old note.
    findNotesWidget(server.profiles, ID)!.instance.config = { text: 'Plan B' };

    await user.type(box, ' A');
    fireEvent.blur(box);
    expect(await screen.findByText('Another tab or PC saved this note while you were editing it.')).toBeInTheDocument();
    expect(requestsTo(`PATCH /api/profiles/p1/widgets/${ID}`)).toHaveLength(0);
    expect(box).toHaveValue('Plan A');
    expect(readNoteDraft(ID)).toEqual({ text: 'Plan A', base: 'Plan' });

    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(storedText(server)).toBe('Plan A'));
    expect(screen.queryByText('Another tab or PC saved this note while you were editing it.')).not.toBeInTheDocument();
  });

  it('Use saved shows the other version and drops the edits made here', async () => {
    const user = userEvent.setup();
    const server = serverWith({ text: 'Plan' });
    const { box, requestsTo } = await renderNotes(server);
    findNotesWidget(server.profiles, ID)!.instance.config = { text: 'Plan B' };

    await user.type(box, ' A');
    fireEvent.blur(box);
    await user.click(await screen.findByRole('button', { name: 'Use saved' }));
    expect(box).toHaveValue('Plan B');
    expect(readNoteDraft(ID)).toBeNull();
    expect(requestsTo(`PATCH /api/profiles/p1/widgets/${ID}`)).toHaveLength(0);
  });

  it('keeps the text and says it is not saved when saving fails, then retries', async () => {
    const user = userEvent.setup();
    const server = serverWith({ text: '' });
    let failing = true;
    const patch = server.mocks['PATCH /api/profiles/:id/widgets/:wid'] as (req: MockRequest) => unknown;
    const { box } = await renderNotes(server, {
      'PATCH /api/profiles/:id/widgets/:wid': (req: MockRequest) => (failing ? mockError(500, 'internal', 'Disk full') : patch(req)),
    });

    await user.type(box, 'Call the bank');
    fireEvent.blur(box);
    const unsaved = await screen.findByRole('button', { name: 'Not saved' });
    expect(await screen.findByText('Disk full')).toBeInTheDocument();
    expect(box).toHaveValue('Call the bank');
    expect(readNoteDraft(ID)).toEqual({ text: 'Call the bank', base: '' });

    failing = false;
    await user.click(unsaved);
    await waitFor(() => expect(storedText(server)).toBe('Call the bank'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Not saved' })).not.toBeInTheDocument());
    expect(readNoteDraft(ID)).toBeNull();
  });

  it('restores edits an earlier visit could not save, and saves them', async () => {
    writeNoteDraft(ID, { text: 'Typed before the tab closed', base: 'Old' });
    const server = serverWith({ text: 'Old' });
    const { box } = await renderNotes(server);
    expect(box).toHaveValue('Typed before the tab closed');
    await waitFor(() => expect(storedText(server)).toBe('Typed before the tab closed'), SAVED);
  });

  it('asks which to keep when the note changed since such edits were typed', async () => {
    writeNoteDraft(ID, { text: 'Mine', base: 'Old' });
    const server = serverWith({ text: 'Theirs' });
    const { box, requestsTo } = await renderNotes(server);
    expect(box).toHaveValue('Mine');
    expect(screen.getByText('Another tab or PC saved this note while you were editing it.')).toBeInTheDocument();
    expect(requestsTo(`PATCH /api/profiles/p1/widgets/${ID}`)).toHaveLength(0);
  });

  it('shows what another tab saved when clicked into with nothing unsaved', async () => {
    const server = serverWith({ text: 'Old' });
    const { box } = await renderNotes(server);
    findNotesWidget(server.profiles, ID)!.instance.config = { text: 'New' };
    fireEvent.focus(box);
    await waitFor(() => expect(box).toHaveValue('New'));
  });

  it('writes nothing once the widget is gone', async () => {
    const user = userEvent.setup();
    const server = serverWith({ text: 'Note' });
    const { box, requestsTo } = await renderNotes(server);
    server.profiles[0]!.layout.items = [];

    await user.type(box, '!');
    fireEvent.blur(box);
    await waitFor(() => expect(readNoteDraft(ID)).toBeNull());
    expect(requestsTo(`PATCH /api/profiles/p1/widgets/${ID}`)).toHaveLength(0);
  });

  it('follows the size, font and spelling settings and counts characters near the limit', async () => {
    const server = serverWith({ text: 'x'.repeat(MAX_NOTE_LENGTH - 10), textSize: 'lg', font: 'mono', spellcheck: false });
    const { box } = await renderNotes(server);
    expect(box).toHaveAttribute('spellcheck', 'false');
    expect(box).toHaveAttribute('maxlength', String(MAX_NOTE_LENGTH));
    expect(box.closest('[data-text-size]')).toHaveAttribute('data-text-size', 'lg');
    expect(box.closest('[data-font]')).toHaveAttribute('data-font', 'mono');
    expect(screen.getByText(`${(MAX_NOTE_LENGTH - 10).toLocaleString()} / ${MAX_NOTE_LENGTH.toLocaleString()}`)).toBeInTheDocument();
  });
});

describe('notes settings', () => {
  it('changes the text size, font and spell checking, never the note', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = notesConfigSchema.parse({ text: 'Keep' });
    render(<NotesSettings value={value} onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'Large' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, textSize: 'lg' });
    await user.click(screen.getByRole('radio', { name: 'Monospace' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, font: 'mono' });
    await user.click(screen.getByRole('switch', { name: /Check spelling/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, spellcheck: false });
  });
});

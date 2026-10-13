/**
 * Netscape bookmark file (Chrome export shape) with nesting, entities and non-http entries, as
 * used by the server's import tests (server/src/modules/bookmarks/__fixtures__/imports.ts).
 * Expected import: folders strategy → 4 groups, 5 bookmarks, 2 skipped (bookmarklet, `place:`).
 */
export const NETSCAPE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000001" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/?a=1&amp;b=2" ADD_DATE="1700000000" ICON="data:image/png;base64,iVBORw0KGgo=">Tom &amp; Jerry &lt;3</A>
        <DT><H3 ADD_DATE="1700000000">Dev</H3>
        <DL><p>
            <DT><A HREF="https://github.com/" ADD_DATE="1700000000">GitHub</A>
            <DT><A HREF="javascript:void(document.body.style.background='red')">Bookmarklet</A>
            <DT><H3>Deep</H3>
            <DL><p>
                <DT><A HREF="https://deep.example/">Deep link</A>
            </DL><p>
        </DL><p>
        <DT><A HREF="https://news.ycombinator.com/">Hacker News</A>
        <DD>A description line
        <DT><A HREF="place:sort=8&maxResults=10">Recently tagged</A>
    </DL><p>
    <DT><A HREF="https://top-level.example/">Top level</A>
    <DT><H3>Empty folder</H3>
    <DL><p>
    </DL><p>
</DL><p>
`;

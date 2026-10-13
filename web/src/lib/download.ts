/**
 * Saves a Blob the app produced itself (e.g. the config export) as a file. The object URL is
 * created from our own data and revoked right after the click; it is never taken from input.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Give the browser a moment to start the download before the URL goes away.
    setTimeout(() => URL.revokeObjectURL?.(url), 10_000);
  }
}

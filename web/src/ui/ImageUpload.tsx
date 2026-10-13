/**
 * ImageUpload (§10.4): pick or drop an image, upload it (`POST /api/uploads`) and report the
 * upload id. The preview is always `/api/uploads/<id>` (never a URL from elsewhere), resolved
 * through `useAssetUrl`: while the image is not loaded yet (a Pages page load backed by the
 * Homebase server on this PC) or when it fails to load, the empty drop zone stands in for it.
 */
import { useId, useRef, useState, type DragEvent } from 'react';
import { ImagePlus, Trash } from 'lucide-react';
import { uploadUrl } from '@homebase/shared';
import { UPLOAD_ACCEPT, checkImageFile, uploadImage } from '../api/uploads.ts';
import { useAssetUrl } from '../static/assets.ts';
import { Button } from './Button.tsx';
import { useField } from './Field.tsx';
import { Spinner } from './Spinner.tsx';
import { errorMessage } from './toast.ts';
import styles from './ImageUpload.module.css';

export interface ImageUploadProps {
  /** Current upload id, or null. */
  value: string | null;
  onChange(uploadId: string | null): void;
  /** Accessible name for the drop zone (defaults to the Field label). */
  'aria-label'?: string;
  /** Allow removing the image. */
  removable?: boolean;
  hint?: string;
  disabled?: boolean;
}

export function ImageUpload({ value, onChange, removable = true, hint, disabled, ...aria }: ImageUploadProps) {
  const field = useField();
  const inputId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const src = useAssetUrl(value ? uploadUrl(value) : null);
  const [preview, setPreview] = useState<{ src: string | null; failed: boolean }>({ src, failed: false });
  let failed = preview.failed;
  if (preview.src !== src) {
    // A new preview URL gets a new chance (adjusted while rendering, not in an effect).
    failed = false;
    setPreview({ src, failed });
  }
  const showPreview = src !== null && !failed;

  const handleFile = async (file: File | undefined) => {
    if (!file || busy) return;
    const problem = checkImageFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const uploaded = await uploadImage(file);
      onChange(uploaded.id);
    } catch (err) {
      setError(errorMessage(err, 'The image could not be uploaded.'));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) void handleFile(event.dataTransfer.files[0]);
  };

  return (
    <div className={styles.root}>
      <label
        htmlFor={inputId}
        className={styles.zone}
        data-dragging={dragging ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {showPreview ? (
          <img
            className={styles.preview}
            src={src}
            alt=""
            onError={() => setPreview((current) => (current.src === src ? { src, failed: true } : current))}
          />
        ) : null}
        <span className={styles.prompt} data-over-image={showPreview ? 'true' : undefined}>
          {busy ? <Spinner size={18} /> : <ImagePlus aria-hidden="true" className={styles.icon} />}
          <span>{busy ? 'Uploading…' : value ? 'Replace image' : 'Choose an image or drop it here'}</span>
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={UPLOAD_ACCEPT}
          className="hb-visually-hidden"
          disabled={disabled || busy}
          aria-label={aria['aria-label']}
          aria-labelledby={aria['aria-label'] ? undefined : field?.labelId}
          aria-describedby={[statusId, field?.describedBy].filter(Boolean).join(' ')}
          onChange={(event) => void handleFile(event.currentTarget.files?.[0])}
        />
      </label>
      <div className={styles.meta}>
        <p id={statusId} className={error ? styles.error : styles.hint} role={error ? 'alert' : undefined}>
          {error ?? hint ?? 'PNG, JPEG, WebP, GIF, AVIF or SVG, up to 10 MB.'}
        </p>
        {value && removable ? (
          <Button variant="ghost" size="sm" icon={Trash} onClick={() => onChange(null)} disabled={disabled || busy}>
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

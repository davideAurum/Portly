/**
 * ImageUpload (§10.4): pick or drop an image, upload it (`POST /api/uploads`) and report the
 * upload id. The preview is always `/api/uploads/<id>` (never a URL from elsewhere), resolved
 * through `useAssetUrl`: while the image is not loaded yet (a Pages page load backed by the
 * Portly server on this PC) or when it fails to load, the empty drop zone stands in for it.
 * With `prepare`, the chosen file is first turned into the one to upload (the Appearance
 * background's screen-sized copy, `theme/prepareBackground.ts`).
 */
import { useId, useRef, useState, type DragEvent } from 'react';
import { ImagePlus, Trash } from 'lucide-react';
import { uploadUrl } from '@portly/shared';
import { ImagePrepareError, MAX_UPLOAD_BYTES, UPLOAD_ACCEPT, checkImageFile, uploadImage } from '../api/uploads.ts';
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
  /**
   * Turns the chosen file into the one to upload, which must still fit the upload limit. An
   * {@link ImagePrepareError}'s message is shown as it is.
   */
  prepare?(file: File): Promise<File>;
  /** The largest file accepted before `prepare` (default: the upload limit). */
  maxSourceBytes?: number;
}

export function ImageUpload({
  value,
  onChange,
  removable = true,
  hint,
  disabled,
  prepare,
  maxSourceBytes = MAX_UPLOAD_BYTES,
  ...aria
}: ImageUploadProps) {
  const field = useField();
  const inputId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<'preparing' | 'uploading' | null>(null);
  const busy = phase !== null;
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
    const problem = checkImageFile(file, prepare ? maxSourceBytes : MAX_UPLOAD_BYTES);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    try {
      let upload = file;
      if (prepare) {
        setPhase('preparing');
        upload = await prepare(file);
        const tooLarge = checkImageFile(upload);
        if (tooLarge) {
          setError(tooLarge);
          return;
        }
      }
      setPhase('uploading');
      const uploaded = await uploadImage(upload);
      onChange(uploaded.id);
    } catch (err) {
      setError(err instanceof ImagePrepareError ? err.message : errorMessage(err, 'The image could not be uploaded.'));
    } finally {
      setPhase(null);
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
          <span>{phase === 'preparing' ? 'Preparing…' : phase === 'uploading' ? 'Uploading…' : value ? 'Replace image' : 'Choose an image or drop it here'}</span>
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

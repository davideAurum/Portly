/**
 * The Appearance background image (§7a Theme, Theme rendering): the upload, which the browser first
 * turns into a screen-sized still copy (`theme/prepareBackground.ts`), blur and dim, and an offer to
 * optimize a background stored as it was uploaded (before that step existed): an animated image, a
 * photo larger than any screen needs (3840 pixels, so a copy made while the window is on a small
 * monitor still suits a 4K one), or an SVG, BMP or ICO. The offer reads the stored image's header
 * only; optimizing uploads the copy and switches to it (the old upload is collected with the other
 * unused ones after a day).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import type { ThemeBackground } from '@portly/shared';
import { qk } from '../../api/keys.ts';
import { ImagePrepareError, fetchUpload, uploadImage } from '../../api/uploads.ts';
import { BACKGROUND_MAX_EDGE, backgroundIssue, inspectBackgroundImage, type BackgroundIssue } from '../../theme/backgroundImage.ts';
import { MAX_BACKGROUND_SOURCE_BYTES, prepareBackgroundImage } from '../../theme/prepareBackground.ts';
import { Banner } from '../../ui/Banner.tsx';
import { Button } from '../../ui/Button.tsx';
import { Field } from '../../ui/Field.tsx';
import { ImageUpload } from '../../ui/ImageUpload.tsx';
import { FieldGrid } from '../../ui/Section.tsx';
import { Slider } from '../../ui/Toggles.tsx';
import { errorMessage, toast } from '../../ui/toast.ts';
import styles from '../../styles/settings.module.css';

type ImageBackground = Extract<ThemeBackground, { type: 'image' }>;

export function ImageBackgroundEditor({
  background,
  onChange,
}: {
  background: ImageBackground | null;
  onChange(next: Partial<Omit<ImageBackground, 'type'>> & { uploadId?: string }): void;
}) {
  return (
    <div className={styles.stack}>
      <Field label="Background image">
        <ImageUpload
          value={background?.uploadId ?? null}
          removable={false}
          onChange={(uploadId) => {
            if (uploadId) onChange({ uploadId });
          }}
          prepare={(file) => prepareBackgroundImage(file)}
          maxSourceBytes={MAX_BACKGROUND_SOURCE_BYTES}
          hint="PNG, JPEG, WebP, AVIF or GIF up to 25 MB. Big photos are scaled to fit your screen, and an animated image keeps its first frame."
        />
      </Field>
      {background ? <OptimizeBackground uploadId={background.uploadId} onOptimized={(uploadId) => onChange({ uploadId })} /> : null}
      {background ? (
        <FieldGrid>
          <Field label="Blur">
            <Slider value={background.blur} min={0} max={40} onChange={(blur) => onChange({ blur })} format={(v) => `${v}px`} />
          </Field>
          <Field label="Dim" help="Darken the image so widgets stay readable.">
            <Slider
              value={background.dim}
              min={0}
              max={0.9}
              step={0.05}
              onChange={(dim) => onChange({ dim: Math.round(dim * 100) / 100 })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          </Field>
        </FieldGrid>
      ) : null}
    </div>
  );
}

type FixableIssue = Exclude<BackgroundIssue, 'unknown'>;

interface StoredBackgroundCheck {
  issue: FixableIssue | null;
  longEdge: number | null;
  svg: boolean;
}

/** What the stored background would gain from being prepared (header only, nothing decoded). */
async function checkStoredBackground(uploadId: string, signal: AbortSignal): Promise<StoredBackgroundCheck> {
  const blob = await fetchUpload(uploadId, signal);
  const info = inspectBackgroundImage(new Uint8Array(await blob.arrayBuffer()));
  const issue = info ? backgroundIssue(info, BACKGROUND_MAX_EDGE) : null;
  return { issue: issue === 'unknown' ? null : issue, longEdge: info?.longEdge ?? null, svg: info?.type === 'image/svg+xml' };
}

function offerCopy(check: StoredBackgroundCheck & { issue: FixableIssue }): { title: string; body: string } {
  switch (check.issue) {
    case 'animated':
      return {
        title: 'This background is animated',
        body: 'The page redraws the whole window for every frame of an animation, which can make the mouse stutter. Optimizing keeps the first frame as a still picture.',
      };
    case 'large':
      return {
        title: 'This photo is larger than any screen needs',
        body: `Its long side is ${(check.longEdge ?? 0).toLocaleString()} pixels; even a 4K screen shows ${BACKGROUND_MAX_EDGE.toLocaleString()}. Optimizing stores a smaller copy that looks the same and opens faster in every new tab.`,
      };
    case 'format':
      return check.svg
        ? { title: 'This background is a drawing (SVG)', body: 'Optimizing turns it into a picture sized for your screen, which is quicker to draw.' }
        : { title: 'This background can be stored more efficiently', body: 'Optimizing turns it into a compressed picture sized for your screen, which opens faster.' };
  }
}

function OptimizeBackground({ uploadId, onOptimized }: { uploadId: string; onOptimized(uploadId: string): void }) {
  const check = useQuery({
    queryKey: qk.uploads.backgroundCheck(uploadId),
    queryFn: ({ signal }) => checkStoredBackground(uploadId, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: { persist: false },
  });
  const [busy, setBusy] = useState(false);
  const data = check.data;
  if (!data || data.issue === null) return null;
  const copy = offerCopy({ ...data, issue: data.issue });

  const optimize = async () => {
    setBusy(true);
    try {
      const blob = await fetchUpload(uploadId);
      const original = new File([await blob.arrayBuffer()], 'background', { type: blob.type });
      const prepared = await prepareBackgroundImage(original, BACKGROUND_MAX_EDGE);
      if (prepared === original) {
        toast.error('This browser could not make a lighter copy of the background.');
        return;
      }
      const uploaded = await uploadImage(prepared);
      onOptimized(uploaded.id);
      toast.success('Background optimized');
    } catch (err) {
      toast.error(err instanceof ImagePrepareError ? err.message : errorMessage(err, 'The background could not be optimized.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Banner
      tone="info"
      title={copy.title}
      actions={
        <Button size="sm" icon={Sparkles} loading={busy} onClick={() => void optimize()}>
          Optimize image
        </Button>
      }
    >
      {copy.body}
    </Banner>
  );
}

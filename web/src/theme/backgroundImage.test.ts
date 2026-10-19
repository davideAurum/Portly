import { describe, expect, it } from 'vitest';
import { IMAGE_SAMPLES } from '../static/lib/__fixtures__/images.ts';
import { avif, bmp, concatBytes, gif, jpeg, latin1, png, svg, webp } from './__fixtures__/images.ts';
import {
  BACKGROUND_MAX_EDGE,
  BACKGROUND_MIN_EDGE,
  backgroundIssue,
  backgroundTargetEdge,
  imageLongEdge,
  inspectBackgroundImage,
  isAnimatedImage,
} from './backgroundImage.ts';

describe('backgroundTargetEdge', () => {
  it('is the screen long edge in device pixels, kept within 2560..3840', () => {
    expect(backgroundTargetEdge({ width: 2560, height: 1440, devicePixelRatio: 1.5 })).toBe(3840); // 4K at 150 %
    expect(backgroundTargetEdge({ width: 1920, height: 1080, devicePixelRatio: 1 })).toBe(BACKGROUND_MIN_EDGE);
    expect(backgroundTargetEdge({ width: 1440, height: 2960, devicePixelRatio: 1 })).toBe(2960); // portrait
    expect(backgroundTargetEdge({ width: 3840, height: 2160, devicePixelRatio: 2 })).toBe(BACKGROUND_MAX_EDGE);
  });

  it('falls back to the minimum for an unknown screen', () => {
    expect(backgroundTargetEdge({ width: 0, height: 0, devicePixelRatio: 1 })).toBe(BACKGROUND_MIN_EDGE);
    expect(backgroundTargetEdge({ width: Number.NaN, height: 1080, devicePixelRatio: Number.NaN })).toBe(BACKGROUND_MIN_EDGE);
    expect(backgroundTargetEdge({ width: 2560, height: 1440, devicePixelRatio: 0 })).toBe(2560);
  });
});

describe('isAnimatedImage', () => {
  it('GIF: a second image block, however the blocks are laid out', () => {
    expect(isAnimatedImage(gif(2), 'image/gif')).toBe(true);
    expect(isAnimatedImage(gif(3, { globalColorTable: false, localColorTable: true }), 'image/gif')).toBe(true);
    // A loop extension alone is not an animation; introducer-like bytes inside image data are skipped.
    expect(isAnimatedImage(gif(1), 'image/gif')).toBe(false);
    expect(isAnimatedImage(gif(1, { localColorTable: true }), 'image/gif')).toBe(false);
    expect(isAnimatedImage(IMAGE_SAMPLES.gif, 'image/gif')).toBe(false);
  });

  it('PNG: an acTL chunk before the image data announcing more than one frame', () => {
    expect(isAnimatedImage(png(10, 10, { frames: 3 }), 'image/png')).toBe(true);
    expect(isAnimatedImage(png(10, 10, { frames: 1 }), 'image/png')).toBe(false);
    expect(isAnimatedImage(png(10, 10), 'image/png')).toBe(false);
    expect(isAnimatedImage(png(10, 10, { frames: 3, actlAfterData: true }), 'image/png')).toBe(false);
  });

  it('WebP: a second ANMF frame', () => {
    expect(isAnimatedImage(webp(10, 10, 2), 'image/webp')).toBe(true);
    expect(isAnimatedImage(webp(10, 10, 1), 'image/webp')).toBe(false);
    expect(isAnimatedImage(webp(10, 10), 'image/webp')).toBe(false);
  });

  it('AVIF: the image-sequence brand', () => {
    expect(isAnimatedImage(avif([[10, 10]], 'avis'), 'image/avif')).toBe(true);
    expect(isAnimatedImage(avif([[10, 10]]), 'image/avif')).toBe(false);
  });

  it('other formats never count as animated', () => {
    expect(isAnimatedImage(jpeg(10, 10), 'image/jpeg')).toBe(false);
    expect(isAnimatedImage(svg(), 'image/svg+xml')).toBe(false);
  });

  it('truncated and hostile bytes end the walk without throwing', () => {
    const full = gif(2);
    for (let length = 0; length < full.length; length++) {
      expect(() => isAnimatedImage(full.subarray(0, length), 'image/gif')).not.toThrow();
    }
    // Chunk and block sizes far past the end of the data.
    const hugePngChunk = concatBytes(png(10, 10).subarray(0, 33), [0xff, 0xff, 0xff, 0xff], latin1('tEXt'));
    expect(isAnimatedImage(hugePngChunk, 'image/png')).toBe(false);
    const hugeRiff = concatBytes(latin1('RIFF'), [0, 0, 0, 0], latin1('WEBP'), latin1('ANMF'), [0xff, 0xff, 0xff, 0xff], latin1('ANMF'));
    expect(isAnimatedImage(hugeRiff, 'image/webp')).toBe(false);
    expect(isAnimatedImage(latin1('GIF89a\x0a\x00\x0a\x00\xff\x00\x00'), 'image/gif')).toBe(false);
  });
});

describe('imageLongEdge', () => {
  it('reads the header of every raster format', () => {
    expect(imageLongEdge(jpeg(6000, 4000), 'image/jpeg')).toBe(6000);
    expect(imageLongEdge(png(1200, 3000), 'image/png')).toBe(3000);
    expect(imageLongEdge(webp(5000, 2000), 'image/webp')).toBe(5000);
    expect(imageLongEdge(bmp(800, 600), 'image/bmp')).toBe(800);
  });

  it('AVIF: the largest ispe property (a grid image is larger than its tiles)', () => {
    expect(imageLongEdge(avif([[512, 512], [4032, 3024], [512, 512]]), 'image/avif')).toBe(4032);
    expect(imageLongEdge(avif([]), 'image/avif')).toBeNull();
    expect(imageLongEdge(IMAGE_SAMPLES.avif, 'image/avif')).toBeNull();
    const full = avif([[4032, 3024]]);
    for (let length = 0; length < full.length; length++) {
      expect(() => imageLongEdge(full.subarray(0, length), 'image/avif')).not.toThrow();
    }
  });

  it('SVG has no size', () => {
    expect(imageLongEdge(svg(), 'image/svg+xml')).toBeNull();
  });
});

describe('backgroundIssue', () => {
  const issue = (bytes: Uint8Array, target = 2560) => {
    const info = inspectBackgroundImage(bytes);
    return info ? backgroundIssue(info, target) : 'not an image';
  };

  it('keeps a still photo that fits the screen', () => {
    expect(issue(jpeg(2560, 1440))).toBeNull();
    expect(issue(png(1920, 1080))).toBeNull();
    expect(issue(webp(3840, 2160), 3840)).toBeNull();
    expect(issue(gif(1))).toBeNull();
    expect(issue(avif([[2000, 1000]]))).toBeNull();
  });

  it('flags animation first, then format, then size', () => {
    expect(issue(gif(2))).toBe('animated');
    expect(issue(webp(6000, 4000, 2))).toBe('animated');
    expect(issue(svg())).toBe('format');
    expect(issue(bmp(800, 600))).toBe('format');
    expect(issue(IMAGE_SAMPLES.ico)).toBe('format');
    expect(issue(jpeg(6000, 4000))).toBe('large');
    expect(issue(jpeg(3840, 2160), 2560)).toBe('large');
    expect(issue(jpeg(3840, 2160), 3840)).toBeNull();
  });

  it('says unknown when the header gave no size, and refuses what is not an image', () => {
    expect(issue(IMAGE_SAMPLES.avif)).toBe('unknown');
    expect(issue(latin1('not an image at all'))).toBe('not an image');
  });
});

/**
 * Profile photos are stored as a compact data URL on `users.avatar_url`, so every
 * upload is cropped to a square and downscaled to 160x160 before it leaves the
 * browser. That keeps a Supabase row tiny and makes the avatar usable in the
 * Telegram card renderer without another fetch round-trip.
 */

export const AVATAR_SIZE = 160;
/** Reject absurd source files before decoding them into a canvas. */
export const MAX_AVATAR_SOURCE_BYTES = 8 * 1024 * 1024;

export function avatarInitials(name: string): string {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'A';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image file'));
    img.src = src;
  });
}

/** Crops to a centred square, resizes to 160x160 and returns a WebP/JPEG data URL. */
export async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file (JPG, PNG, WebP).');
  }
  if (file.size > MAX_AVATAR_SOURCE_BYTES) {
    throw new Error('Image is too large — pick one under 8 MB.');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image compression is not supported in this browser');

    const scale = Math.max(AVATAR_SIZE / img.width, AVATAR_SIZE / img.height);
    const drawWidth = img.width * scale;
    const drawHeight = img.height * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      img,
      (AVATAR_SIZE - drawWidth) / 2,
      (AVATAR_SIZE - drawHeight) / 2,
      drawWidth,
      drawHeight
    );

    const webp = canvas.toDataURL('image/webp', 0.85);
    if (webp.startsWith('data:image/webp')) return webp;
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

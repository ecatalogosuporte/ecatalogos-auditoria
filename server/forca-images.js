import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const PRODUCT_IMAGE_COUNT = 4;

// Positions vary by product and source image, while retries use the same crops.
export function planDetailCrops(width, height, seed) {
  const bytes = createHash('sha256').update(String(seed)).digest();
  const random = index => bytes[index] / 255;
  const targets = [
    { zoom: 1.45, x: 0.4, y: 0.39 },
    { zoom: 1.75, x: 0.61, y: 0.5 },
    { zoom: 2.05, x: 0.47, y: 0.46 }
  ];
  return targets.map((target, index) => {
    const zoom = target.zoom + (random(index * 3) - 0.5) * 0.12;
    const cropWidth = Math.max(1, Math.round(width / zoom));
    const cropHeight = Math.max(1, Math.round(height / zoom));
    const centerX = width * (target.x + (random(index * 3 + 1) - 0.5) * 0.18);
    const centerY = height * (target.y + (random(index * 3 + 2) - 0.5) * 0.12);
    return {
      left: Math.max(0, Math.min(width - cropWidth, Math.round(centerX - cropWidth / 2))),
      top: Math.max(0, Math.min(height - cropHeight, Math.round(centerY - cropHeight / 2))),
      width: cropWidth, height: cropHeight
    };
  });
}

async function optimizedJpeg(buffer, crop) {
  for (const [width, quality] of [[2000, 90], [1800, 80], [1400, 75], [1000, 70]]) {
    let pipeline = sharp(buffer);
    if (crop) pipeline = pipeline.extract(crop);
    const photo = await pipeline.resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (photo.length <= 900000) return photo;
  }
  throw new Error('A imagem excede o limite de envio.');
}

export async function prepareProductImages(source, seed) {
  // Decode and orient only once, bounding memory before the three extra crops.
  const { data, info } = await sharp(source, { limitInputPixels: 40000000 }).rotate()
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer({ resolveWithObject: true });
  const imageSeed = `${seed}:${createHash('sha256').update(source).digest('hex')}`;
  const images = [{ order: 1, kind: 'main', buffer: await optimizedJpeg(data), crop: null }];
  for (const [index, crop] of planDetailCrops(info.width, info.height, imageSeed).entries()) {
    images.push({ order: index + 2, kind: 'detail', buffer: await optimizedJpeg(data, crop), crop });
  }
  return images;
}

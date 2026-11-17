import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { planDetailCrops, prepareProductImages } from '../server/forca-images.js';

test('detail crops vary across products, remain within image bounds and preserve the image proportions', () => {
  const rectangles = planDetailCrops(1200, 1600, 'product-a');
  assert.deepEqual(rectangles, planDetailCrops(1200, 1600, 'product-a'));
  assert.notDeepEqual(rectangles, planDetailCrops(1200, 1600, 'product-b'));
  assert.equal(new Set(rectangles.map(r => JSON.stringify(r))).size, 3);
  for (const rectangle of rectangles) {
    assert.ok(rectangle.left >= 0 && rectangle.top >= 0);
    assert.ok(rectangle.left + rectangle.width <= 1200 && rectangle.top + rectangle.height <= 1600);
    assert.ok(rectangle.width < 1200 && rectangle.height < 1600);
    assert.ok(Math.abs(rectangle.width / rectangle.height - 1200 / 1600) < 0.01);
  }
  assert.ok(rectangles[0].width > rectangles[1].width && rectangles[1].width > rectangles[2].width);
  for (const dimensions of [[1, 1], [2, 40], [500, 10]]) {
    for (const crop of planDetailCrops(...dimensions, 'small')) {
      assert.ok(crop.left >= 0 && crop.top >= 0 && crop.width > 0 && crop.height > 0);
      assert.ok(crop.left + crop.width <= dimensions[0] && crop.top + crop.height <= dimensions[1]);
    }
  }
});

test('a single source yields the main photo and three distinct JPEG zooms, stable on retry and under the upload limit', async () => {
  const width = 320, height = 480, pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = Math.round(255 * x / width); pixels[offset + 1] = Math.round(255 * y / height); pixels[offset + 2] = (x + y) % 255;
  }
  const source = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const images = await prepareProductImages(source, 'owner:pair'), retry = await prepareProductImages(source, 'owner:pair');
  assert.deepEqual(images.map(i => i.order), [1, 2, 3, 4]);
  assert.equal(images[0].kind, 'main'); assert.equal(images[0].crop, null);
  const fingerprints = [];
  for (const [index, image] of images.entries()) {
    const metadata = await sharp(image.buffer).metadata();
    assert.equal(metadata.format, 'jpeg'); assert.ok(image.buffer.length <= 900000);
    assert.deepEqual(image.buffer, retry[index].buffer);
    if (index === 0) { assert.equal(metadata.width, width); assert.equal(metadata.height, height); }
    else { assert.equal(image.kind, 'detail'); assert.ok(metadata.width < width && metadata.height < height); }
    fingerprints.push(createHash('sha256').update(image.buffer).digest('hex'));
  }
  assert.equal(new Set(fingerprints).size, 4);
});

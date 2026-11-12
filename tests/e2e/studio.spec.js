import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mockSupabase, login } from './mock-supabase.js';

const logo = new URL('../../public/logo-ecatalogos.png', import.meta.url);
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

async function expectLocked(page) {
  await expect(page.locator('#authModal')).toBeVisible();
  await expect(page.locator('#studioShell')).toBeHidden();
  await expect(page.locator('#reviewView')).toBeHidden();
  await expect(page.locator('#closeAuth')).toBeHidden();
}
async function downloaded(page, selector) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}
async function addPair(page, name = 'Sapato de couro') {
  await page.locator('#newPair').click();
  await page.locator('#productName').fill(name);
  await page.locator('#beforeFile').setInputFiles({ name: 'foto-original.png', mimeType: 'image/png', buffer: await readFile(logo) });
  await page.locator('#afterFile').setInputFiles({ name: 'foto-editada.png', mimeType: 'image/png', buffer: pixel });
  await page.locator('#savePair').click();
  await expect(page.locator('#countReady')).toHaveText('1');
}

test('requires login on load and review links, rejects incorrect passwords and hides legacy local data', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/#revisao');
  await expectLocked(page);
  await page.keyboard.press('Escape');
  await expectLocked(page);
  expect(backend.dataRequests).toBe(0);
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('ecatalogos_image_studio', 1);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({ id: 'legacy', name: 'Projeto local confidencial', created: 1 });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expectLocked(page);
  await expect(page.getByText('Projeto local confidencial')).toHaveCount(0);
  backend.rejectLogin = true;
  await page.locator('#authEmail').fill('wrong@example.com');
  await page.locator('#authPassword').fill('incorrect');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#authFeedback')).toContainText('incorretos');
  await expectLocked(page);
  expect(backend.dataRequests).toBe(0);
  await page.screenshot({ path: 'test-results/login-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/login-mobile.png', fullPage: true });
});

test('downloads each original unchanged, persists approvals and restores its own backup after login', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await login(page);
  await addPair(page);
  let before = await downloaded(page, '[data-action="download-before"]');
  let after = await downloaded(page, '[data-action="download-after"]');
  expect(before.name).toBe('foto-original.png');
  expect(before.bytes).toEqual(await readFile(logo));
  expect(after.name).toBe('foto-editada.png');
  expect(after.bytes).toEqual(pixel);
  await page.locator('#openReview').click();
  await page.locator('[data-choice="approved"]').click();
  await expect(page.locator('.review-decision')).toHaveText('✓ Aprovado');
  expect(backend.uploads).toBe(2);
  await page.reload();
  await expect(page.locator('.review-decision')).toHaveText('✓ Aprovado');
  before = await downloaded(page, '[data-download="before"]');
  after = await downloaded(page, '[data-download="after"]');
  expect(before.bytes).toEqual(await readFile(logo));
  expect(after.bytes).toEqual(pixel);
  await page.locator('#backToStudio').click();
  const png = (await downloaded(page, '[data-action="download"]')).bytes;
  expect(png.readUInt32BE(16)).toBe(1068);
  expect(png.readUInt32BE(20)).toBe(1473);
  const backup = await downloaded(page, '#downloadBackup');
  await page.locator('#archiveFile').setInputFiles({ name: backup.name, mimeType: 'application/zip', buffer: backup.bytes });
  await expect(page.locator('.project')).toHaveCount(2);
  await expect(page.locator('#countReady')).toHaveText('1');
  await page.locator('#openReview').click();
  await expect(page.locator('.review-decision')).toHaveText('✓ Aprovado');
  await page.locator('#backToStudio').click();
  await page.screenshot({ path: 'test-results/studio-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/studio-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('allows downloading a single image while the other is missing; bulk import, ordering and deletion still work', async ({ page, context }) => {
  await mockSupabase(context);
  await page.goto('/');
  await login(page);
  const buffer = await readFile(logo);
  await page.locator('#bulkFiles').setInputFiles(['sapato_antes.png', 'sapato_depois.png', 'bolsa_antes.png'].map(name => ({ name, mimeType: 'image/png', buffer })));
  await expect(page.locator('#countPairs')).toHaveText('2');
  await expect(page.locator('#countReady')).toHaveText('1');
  const partial = page.locator('.pair-card').filter({ hasText: 'BOLSA' });
  await expect(partial.locator('[data-action="download-before"]')).toBeEnabled();
  await expect(partial.locator('[data-action="download-after"]')).toBeDisabled();
  await expect(partial.locator('[data-action="download"]')).toBeDisabled();
  await page.locator('[data-action="down"]').first().click();
  await expect(page.locator('.pair-name').first()).toHaveText('Bolsa');
  await page.reload();
  await expect(page.locator('.pair-name').first()).toHaveText('Bolsa');
  expect((await downloaded(page, '[data-action="download-before"] >> nth=0')).bytes).toEqual(buffer);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#deleteProject').click();
  await expect(page.locator('#countPairs')).toHaveText('0');
  await expect(page.locator('.project')).toHaveCount(1);
});

test('fictional alias logs in with six-character password and logout immediately clears data and blocks reload', async ({ page, context }) => {
  const identity = { email: 'ecatalogos@admin.invalid', login: 'ecatalogos@admin', password: 'short6' };
  const backend = await mockSupabase(context, identity);
  await page.goto('/');
  await page.locator('#authEmail').fill(identity.login);
  await page.locator('#authForgot').click();
  await expect(page.locator('#toast')).toContainText('não possui caixa de e-mail');
  await login(page, identity);
  await expect(page.locator('#accountEmail')).toHaveText(identity.login);
  await addPair(page, 'Produto privado');
  await page.locator('#signOut').click();
  await expectLocked(page);
  await expect(page.locator('.pair-card')).toHaveCount(0);
  await expect(page.locator('#accountEmail')).toBeEmpty();
  await expect(page.locator('#authPassword')).toHaveValue('');
  await page.goto('/#revisao');
  await expectLocked(page);
  expect(backend.pairs).toHaveLength(1);
});

test('logout in another tab locks an open review without leaving images in the DOM', async ({ page, context }) => {
  await mockSupabase(context);
  await page.goto('/');
  await login(page);
  await addPair(page);
  await page.locator('#openReview').click();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('#studioShell')).toBeVisible();
  await other.locator('#signOut').click();
  await expectLocked(other);
  await expectLocked(page);
  await expect(page.locator('#reviewCards img')).toHaveCount(0);
  await expect(page.locator('#gallery img')).toHaveCount(0);
});

test('late image responses cannot reopen the Studio after logout in another tab', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/');
  await login(page);
  await addPair(page);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('#studioShell')).toBeVisible();
  const previousDownloads = backend.downloadRequests;
  let release;
  backend.downloadDelay = new Promise(resolve => { release = resolve; });
  await page.reload();
  await expect.poll(() => backend.downloadRequests).toBeGreaterThan(previousDownloads);
  await other.locator('#signOut').click();
  await expectLocked(other);
  await expectLocked(page);
  const response = page.waitForResponse(r => r.url().includes('/storage/v1/object/'));
  release();
  await response;
  await expectLocked(page);
  await expect(page.locator('.pair-card')).toHaveCount(0);
  await expect(page.locator('#gallery img')).toHaveCount(0);
});

test('missing Supabase configuration blocks the app instead of enabling local usage', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/');
  await expectLocked(page);
  await expect(page.locator('#authIntro')).toContainText('precisa ser configurado');
  await expect(page.locator('#authForm')).toBeHidden();
});

test('portable HTML also requires login and cannot open the local Studio', async ({ page, context }) => {
  await mockSupabase(context);
  await page.goto(new URL('../../comparador_ecatalogos.html', import.meta.url).href);
  await expectLocked(page);
  await expect(page.locator('.brand-mark')).toHaveAttribute('src', /^data:image\/png;base64,/);
  const hasCloud = (await readFile(fileURLToPath(new URL('../../comparador_ecatalogos.html', import.meta.url)), 'utf8')).includes('.supabase.co');
  if (hasCloud) {
    await login(page);
    await page.locator('#signOut').click();
    await expectLocked(page);
  }
});


test('click selects the paste slot, hover keeps it selected, and the inner button opens the file picker', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const backend = await mockSupabase(context);
  await page.goto('/');
  await login(page);
  await page.locator('#newPair').click();
  const copyImage = async buffer => page.evaluate(async bytes => {
    const blob = new Blob([Uint8Array.from(bytes)], { type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, [...buffer]);
  await page.screenshot({ path: 'test-results/click-to-paste.png', fullPage: true });
  let pickers = 0;
  page.on('filechooser', () => pickers++);
  // Clicking selects a stable destination; moving the pointer does not change it.
  await page.locator('#afterZone').click();
  await page.locator('#beforeZone').hover();
  await copyImage(await readFile(logo));
  await page.keyboard.press('Control+V');
  await expect(page.locator('#afterPreview')).toBeVisible();
  await expect(page.locator('#beforePreview')).toBeHidden();
  expect(pickers).toBe(0);
  await expect(page.locator('#afterZone')).toHaveClass(/paste-target/);
  // Keyboard focus also selects the destination without opening a file chooser.
  await page.locator('#beforeZone').focus();
  await copyImage(pixel);
  await page.keyboard.press('Control+V');
  await expect(page.locator('#beforePreview')).toBeVisible();
  const picker = page.waitForEvent('filechooser');
  await page.locator('#beforeChoose').click();
  await (await picker).setFiles({ name: 'do-computador.png', mimeType: 'image/png', buffer: pixel });
  expect(pickers).toBe(1);
  // Dropping an image targets the receiving square, regardless of the selection.
  const transfer = await page.evaluateHandle(bytes => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(bytes)], 'arrastada.png', { type: 'image/png' }));
    return data;
  }, [...await readFile(logo)]);
  await page.locator('#afterZone').dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await page.locator('#productName').focus();
  await page.evaluate(() => navigator.clipboard.writeText('Produto colado'));
  await page.keyboard.press('Control+V');
  await expect(page.locator('#productName')).toHaveValue('Produto colado');
  await page.screenshot({ path: 'test-results/paste-images.png', fullPage: true });
  await page.locator('#savePair').click();
  await expect(page.locator('#countReady')).toHaveText('1');
  expect(backend.uploads).toBe(2);
  const before = await downloaded(page, '[data-action="download-before"]');
  const after = await downloaded(page, '[data-action="download-after"]');
  expect(before.name).toBe('do-computador.png');
  expect(after.name).toBe('arrastada.png');
  expect(before.bytes.readUInt32BE(16)).toBe(1);
  expect(after.bytes.readUInt32BE(16)).toBe(512);
  // Images on the clipboard must not open or alter a closed dialog.
  await copyImage(pixel);
  await page.keyboard.press('Control+V');
  await expect(page.locator('#modal')).toBeHidden();
});

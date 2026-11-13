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
function zipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extra;
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
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


test('two independent browsers can use the same account and signing out does not revoke the other session', async ({ page, context, browser }) => {
  const backend = await mockSupabase(context);
  await page.goto('/');
  await login(page);
  const otherContext = await browser.newContext();
  try {
    await mockSupabase(otherContext, undefined, backend);
    const other = await otherContext.newPage();
    await other.goto(new URL('/', page.url()).href);
    await login(other);
    expect(backend.sessions.size).toBe(2);
    await page.locator('#signOut').click();
    await expectLocked(page);
    // Requiring a refresh proves the other session remains valid on the backend,
    // instead of merely displaying an already-loaded page with an unexpired JWT.
    await other.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.endsWith('-auth-token'));
      const session = JSON.parse(localStorage.getItem(key));
      const token = session.access_token.split('.');
      const claims = JSON.parse(atob(token[1].replace(/-/g, '+').replace(/_/g, '/')));
      claims.exp = Math.floor(Date.now() / 1000) - 60;
      token[1] = btoa(JSON.stringify(claims)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      session.access_token = token.join('.');
      session.expires_at = claims.exp;
      localStorage.setItem(key, JSON.stringify(session));
    });
    await other.reload();
    await expect(other.locator('#studioShell')).toBeVisible();
    await expect(other.locator('#storageStatus')).toHaveText('Salvo na nuvem');
    expect(backend.sessions.size).toBe(1);
    expect(backend.nextSession).toBe(3);
  } finally { await otherContext.close(); }
});

test('review records approved image usage, filters used and unused, and preserves it in backups', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/');
  await login(page);
  await addPair(page);
  await page.locator('#openReview').click();
  await expect(page.locator('[name="isUsed"]')).toBeDisabled();
  await page.locator('[data-choice="approved"]').click();
  await expect(page.locator('.usage-status')).toHaveText('Aprovada · Não usada');
  await page.locator('[name="isUsed"]').check();
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  expect(backend.pairs[0].is_used).toBe(false);
  await expect(page.locator('[name="usedIn"]')).toBeFocused();
  await page.locator('[name="usedIn"]').fill('   ');
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Informe onde');
  await page.locator('[name="usedIn"]').fill('Catálogo Verão / Instagram <campanha>');
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.usage-status')).toHaveText('Aprovada · Usada em Catálogo Verão / Instagram <campanha>');
  expect(backend.pairs[0].is_used).toBe(true);
  expect(backend.uploads).toBe(2);
  await page.reload();
  await expect(page.locator('[name="isUsed"]')).toBeChecked();
  await expect(page.locator('[name="usedIn"]')).toHaveValue('Catálogo Verão / Instagram <campanha>');
  await page.locator('#reviewFilter').selectOption('approved-unused');
  await expect(page.locator('.review-pair')).toHaveCount(0);
  await page.locator('#reviewFilter').selectOption('approved-used');
  await expect(page.locator('.review-pair')).toHaveCount(1);
  await page.locator('[name="isUsed"]').uncheck();
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.review-pair')).toHaveCount(0);
  await page.locator('#reviewFilter').selectOption('approved-unused');
  await expect(page.locator('.review-pair')).toHaveCount(1);
  await page.locator('[name="isUsed"]').check();
  await page.locator('[name="usedIn"]').fill('Site da loja');
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await page.locator('#reviewFilter').selectOption('all');
  await expect(page.locator('.usage-status')).toContainText('Site da loja');
  await page.locator('#backToStudio').click();
  const backup = await downloaded(page, '#downloadBackup');
  await page.locator('#archiveFile').setInputFiles({ name: backup.name, mimeType: 'application/zip', buffer: backup.bytes });
  await expect(page.locator('.project')).toHaveCount(2);
  await page.locator('#openReview').click();
  await expect(page.locator('.usage-status')).toHaveText('Aprovada · Usada em Site da loja');
  await expect(page.locator('#reviewSummary')).toContainText('1 aprovada usada');
  await page.screenshot({ path: 'test-results/review-usage-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/review-usage-mobile.png', fullPage: true });
});

test('usage edits preserve other reviewer changes and failed saves retain the draft', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/'); await login(page); await addPair(page);
  await page.locator('#openReview').click();
  await page.locator('[data-choice="approved"]').click();
  await page.locator('[name="isUsed"]').check();
  await page.locator('[name="usedIn"]').fill('Instagram');
  backend.rejectUsage = true;
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Não foi possível salvar');
  await expect(page.locator('.usage-status')).toHaveText('Aprovada · Não usada');
  await expect(page.locator('[name="usedIn"]')).toHaveValue('Instagram');
  backend.rejectUsage = false;
  backend.pairs[0].name = 'Renomeado por outra pessoa';
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.usage-status')).toContainText('Instagram');
  expect(backend.pairs[0].name).toBe('Renomeado por outra pessoa');
  await page.locator('[name="usedIn"]').fill('Catálogo');
  backend.pairs[0].review_status = 'rejected';
  backend.pairs[0].is_used = false; backend.pairs[0].used_in = '';
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('precisa estar aprovada');
  expect(backend.pairs[0].is_used).toBe(false);
  expect(backend.uploads).toBe(2);
});

test('renaming retains usage; rejecting or replacing an image clears approval and usage', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/'); await login(page); await addPair(page);
  const use = async () => {
    await page.locator('[data-choice="approved"]').click();
    await page.locator('[name="isUsed"]').check();
    await page.locator('[name="usedIn"]').fill('Catálogo');
    await page.locator('[name="usageTools"][value="b2b"]').check();
    await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
    await expect(page.locator('.usage-status')).toContainText('B2B');
  };
  await page.locator('#openReview').click(); await use();
  await page.locator('[data-choice="rejected"]').click();
  await expect(page.locator('[name="isUsed"]')).toBeDisabled();
  expect(backend.pairs[0].is_used).toBe(false);
  expect(backend.pairs[0].usage_tools).toEqual([]);
  expect(backend.pairs[0].used_in).toBe('');
  await use();
  await page.locator('#backToStudio').click();
  await page.locator('[data-action="edit"]').click();
  await page.locator('#productName').fill('Novo nome');
  await page.locator('#savePair').click();
  await expect(page.locator('#modal')).toBeHidden();
  expect(backend.pairs[0].is_used).toBe(true);
  expect(backend.pairs[0].usage_tools).toEqual(['b2b']);
  await page.locator('[data-action="edit"]').click();
  await page.locator('#afterFile').setInputFiles(logo.pathname);
  await page.locator('#savePair').click();
  await expect(page.locator('#modal')).toBeHidden();
  expect(backend.pairs[0].review_status).toBe(null);
  expect(backend.pairs[0].is_used).toBe(false);
  expect(backend.pairs[0].usage_tools).toEqual([]);
  expect(backend.pairs[0].used_in).toBe('');
});

test('only removing an existing review asks for confirmation and cancelling preserves its data', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  const dialogs = [];
  let acceptRemoval = false;
  page.on('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    dialogs.push(dialog.message());
    if (acceptRemoval) await dialog.accept(); else await dialog.dismiss();
  });
  await page.goto('/'); await login(page); await addPair(page);
  await page.locator('#openReview').click();
  await page.locator('[data-choice="approved"]').click();
  await expect(page.locator('.review-decision')).toHaveText('✓ Aprovado');
  expect(dialogs).toEqual([]);
  await page.locator('[name="isUsed"]').check();
  await page.locator('[name="usedIn"]').fill('Carrossel');
  await page.locator('[name="usageTools"][value="b2b"]').check();
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.usage-status')).toContainText('B2B');
  const saved = structuredClone(backend.pairs[0]), requests = backend.dataRequests;
  await page.locator('[data-choice="approved"]').click();
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain('remover a aprovação');
  expect(backend.dataRequests).toBe(requests);
  expect(backend.pairs[0]).toEqual(saved);
  await expect(page.locator('.review-decision')).toHaveText('✓ Aprovado');
  await expect(page.locator('[name="usedIn"]')).toHaveValue('Carrossel');
  await expect(page.locator('[name="usageTools"][value="b2b"]')).toBeChecked();
  acceptRemoval = true;
  await page.locator('[data-choice="approved"]').click();
  await expect(page.locator('.review-decision')).toHaveText('Aguardando avaliação');
  expect(backend.pairs[0]).toMatchObject({ review_status: null, reviewed_at: null, is_used: false, used_in: '', usage_tools: [] });

  await page.locator('[data-choice="rejected"]').click();
  await expect(page.locator('.review-decision')).toHaveText('✕ Reprovado');
  expect(dialogs).toHaveLength(2);
  acceptRemoval = false;
  const rejected = structuredClone(backend.pairs[0]);
  await page.locator('[data-choice="rejected"]').click();
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  expect(dialogs).toHaveLength(3);
  expect(dialogs[2]).toContain('remover a reprovação');
  expect(backend.pairs[0]).toEqual(rejected);
  await expect(page.locator('.review-decision')).toHaveText('✕ Reprovado');
  acceptRemoval = true;
  await page.locator('[data-choice="rejected"]').click();
  await expect(page.locator('.review-decision')).toHaveText('Aguardando avaliação');
  expect(backend.pairs[0].review_status).toBe(null);
  expect(dialogs).toHaveLength(4);

  await page.locator('[data-choice="approved"]').click();
  await expect(page.locator('.review-decision')).toHaveText('✓ Aprovado');
  await page.locator('[data-choice="rejected"]').click();
  await expect(page.locator('.review-decision')).toHaveText('✕ Reprovado');
  await page.locator('[data-choice="approved"]').click();
  await expect(page.locator('.review-decision')).toHaveText('✓ Aprovado');
  expect(dialogs).toHaveLength(4);
});

test('databases awaiting migration keep the gallery and approvals working with usage disabled', async ({ page, context }) => {
  const backend = await mockSupabase(context); backend.usageSupported = false;
  await page.goto('/'); await login(page); await addPair(page);
  await page.locator('#openReview').click();
  await page.locator('[data-choice="approved"]').click();
  await expect(page.locator('.review-decision')).toHaveText('✓ Aprovado');
  await expect(page.locator('[name="isUsed"]')).toBeDisabled();
  await expect(page.locator('.usage-help')).toContainText('precisa ser ativado');
  expect(Object.hasOwn(backend.pairs[0], 'is_used')).toBe(false);
});


test('login displays a loader while waiting, then restores the form after an error', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/');
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  let release;
  backend.loginDelay = new Promise(resolve => { release = resolve; });
  backend.rejectLogin = true;
  await page.locator('#authEmail').fill('studio@example.com');
  await page.locator('#authPassword').fill('test-password');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#loadingOverlay')).toBeVisible();
  await expect(page.locator('#loadingTitle')).toHaveText('Entrando na sua conta…');
  await expect(page.locator('#authSubmit')).toHaveText('Entrando…');
  await expect(page.locator('#authSubmit')).toBeDisabled();
  await expect(page.locator('#authSubmit')).toHaveAttribute('aria-busy', 'true');
  await page.screenshot({ path: 'test-results/loading-login.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/loading-mobile.png', fullPage: true });
  release();
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  await expect(page.locator('#authFeedback')).toContainText('incorretos');
  await expect(page.locator('#authSubmit')).toHaveText('Entrar na minha conta');
  await expect(page.locator('#authSubmit')).toBeEnabled();
  backend.loginDelay = null; backend.rejectLogin = false;
  await login(page);
  await expect(page.locator('#loadingOverlay')).toBeHidden();
});

test('upload progress follows real files and image loading completes after a gallery refresh', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/'); await login(page);
  await page.locator('#newPair').click();
  await page.locator('#productName').fill('Produto com loading');
  await page.locator('#beforeFile').setInputFiles(logo.pathname);
  await page.locator('#afterFile').setInputFiles({ name: 'editada.png', mimeType: 'image/png', buffer: pixel });
  await expect(page.locator('#beforeZone')).not.toHaveClass(/image-loading/);
  let releaseUpload;
  backend.uploadDelay = new Promise(resolve => { releaseUpload = resolve; });
  await page.locator('#savePair').click();
  await expect(page.locator('#loadingOverlay')).toBeVisible();
  await expect(page.locator('#loadingTitle')).toHaveText('Enviando imagens…');
  await expect(page.locator('#loadingProgress')).toHaveAttribute('max', '2');
  await expect(page.locator('#loadingProgress')).toHaveAttribute('value', '0');
  await expect(page.locator('#savePair')).toHaveText('Salvando…');
  await page.screenshot({ path: 'test-results/loading-upload.png', fullPage: true });
  releaseUpload();
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  await expect(page.locator('#countReady')).toHaveText('1');
  expect(backend.uploads).toBe(2);
  backend.uploadDelay = null;
  let releaseDownload;
  backend.downloadDelay = new Promise(resolve => { releaseDownload = resolve; });
  await page.locator('#refreshCloud').click();
  await expect(page.locator('#loadingTitle')).toHaveText('Carregando comparativos…');
  await expect(page.locator('#loadingProgress')).toHaveAttribute('max', '1');
  await expect(page.locator('#loadingDetail')).toHaveText('0 de 1 comparativos prontos');
  releaseDownload();
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  await expect(page.locator('.compare-image.image-loading')).toHaveCount(0);
  await expect(page.locator('#countReady')).toHaveText('1');
});

test('saving usage shows feedback and releases controls without losing the draft on failure', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/'); await login(page); await addPair(page);
  await page.locator('#openReview').click();
  await page.locator('[data-choice="approved"]').click();
  await page.locator('[name="isUsed"]').check();
  await page.locator('[name="usedIn"]').fill('Catálogo');
  let release;
  backend.usageDelay = new Promise(resolve => { release = resolve; });
  backend.rejectUsage = true;
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('#loadingOverlay')).toBeVisible();
  await expect(page.locator('#loadingTitle')).toHaveText('Salvando uso da imagem...');
  await expect(page.locator('#reviewView')).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Salvar uso', exact: true })).toBeEnabled();
  await expect(page.locator('[name="usedIn"]')).toHaveValue('Catálogo');
  await expect(page.locator('.usage-status')).toHaveText('Aprovada · Não usada');
});


test('review saves all fifteen tool combinations, restores them from backup and filters by tool', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/'); await login(page); await addPair(page);
  await page.locator('#openReview').click();
  await expect(page.locator('[name="usageTools"]').first()).toBeDisabled();
  await page.locator('[data-choice="approved"]').click();
  await page.locator('[name="isUsed"]').check();
  const tools = [
    { id: 'forca-de-vendas', label: 'Força de vendas' },
    { id: 'b2b', label: 'B2B' },
    { id: 'atacado-de-modas', label: 'Atacado de modas' },
    { id: 'site-ecatalogos', label: 'Site — e-catalogos.net' }
  ];
  for (let mask = 1; mask < 16; mask++) {
    for (const [index, tool] of tools.entries()) {
      await page.locator(`[name="usageTools"][value="${tool.id}"]`).setChecked(Boolean(mask & (1 << index)));
    }
    await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
    const selected = tools.filter((_, index) => mask & (1 << index));
    await expect(page.locator('.usage-status')).toHaveText(`Aprovada · Usada em ${selected.map(t => t.label).join(', ')}`);
    expect(backend.pairs[0].usage_tools).toEqual(selected.map(t => t.id));
    expect(backend.pairs[0].used_in).toBe('');
    if ([1, 3, 7, 8, 15].includes(mask)) {
      await page.reload();
      await expect(page.locator('[name="isUsed"]')).toBeChecked();
      for (const tool of tools) await expect(page.locator(`[name="usageTools"][value="${tool.id}"]`)).toBeChecked({ checked: selected.includes(tool) });
    }
  }
  expect(backend.uploads).toBe(2);
  await page.locator('[name="usedIn"]').fill('Carrossel de perfumes');
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  expect(backend.pairs[0].used_in).toBe('Carrossel de perfumes');
  await expect(page.locator('[name="usedIn"]')).toHaveValue('Carrossel de perfumes');
  await page.locator('.review-usage').screenshot({ path: 'test-results/usage-tools-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.review-usage').screenshot({ path: 'test-results/usage-tools-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#backToStudio').click();
  const backup = await downloaded(page, '#downloadBackup');
  await page.locator('#archiveFile').setInputFiles({ name: backup.name, mimeType: 'application/zip', buffer: backup.bytes });
  await expect(page.locator('.project')).toHaveCount(2);
  await page.locator('#openReview').click();
  for (const tool of tools) await expect(page.locator(`[name="usageTools"][value="${tool.id}"]`)).toBeChecked();
  await expect(page.locator('[name="usedIn"]')).toHaveValue('Carrossel de perfumes');
  await page.locator('#reviewFilter').selectOption('tool:site-ecatalogos');
  await expect(page.locator('.review-pair')).toHaveCount(1);
  await page.locator('[name="usageTools"][value="site-ecatalogos"]').uncheck();
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.review-pair')).toHaveCount(0);
  await page.locator('#reviewFilter').selectOption('tool:forca-de-vendas');
  await expect(page.locator('.review-pair')).toHaveCount(1);
  await page.locator('[name="usageTools"][value="forca-de-vendas"]').uncheck();
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.review-pair')).toHaveCount(0);
  await page.locator('#reviewFilter').selectOption('tool:b2b');
  await expect(page.locator('.review-pair')).toHaveCount(1);
  await page.locator('[name="isUsed"]').uncheck();
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.review-pair')).toHaveCount(0);
  await page.locator('#reviewFilter').selectOption('approved-unused');
  await expect(page.locator('.usage-status')).toHaveText('Aprovada · Não usada');
  await expect(page.locator('[name="usageTools"]').first()).toBeDisabled();
  expect(backend.pairs.at(-1).usage_tools).toEqual([]);
});

test('before tools are enabled the existing usage description keeps working and can be retained when enabling tools', async ({ page, context }) => {
  const backend = await mockSupabase(context); backend.usageToolsSupported = false;
  await page.goto('/'); await login(page); await addPair(page);
  await page.locator('#openReview').click();
  await page.locator('[data-choice="approved"]').click();
  await page.locator('[name="isUsed"]').check();
  await expect(page.locator('[name="usageTools"]').first()).toBeDisabled();
  await page.locator('[name="usedIn"]').fill('Carrossel do site já cadastrado');
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.usage-status')).toContainText('Carrossel do site já cadastrado');
  expect(Object.hasOwn(backend.pairs[0], 'usage_tools')).toBe(false);
  backend.usageToolsSupported = true;
  await page.reload();
  await page.locator('[name="usageTools"][value="b2b"]').check();
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.usage-status')).toContainText('B2B');
  await expect(page.locator('[name="usedIn"]')).toHaveValue('Carrossel do site já cadastrado');
  expect(backend.pairs[0].usage_tools).toEqual(['b2b']);
});

test('gallery combines absence filters and exports only matching before, after or comparison PNGs', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/'); await login(page); await addPair(page);
  const base = structuredClone(backend.pairs[0]);
  const definitions = [
    ['Novo', 'approved', []], ['B2B', 'approved', ['b2b']],
    ['Atacado', 'approved', ['atacado-de-modas']], ['Ambos', 'approved', ['b2b', 'atacado-de-modas']],
    ['Reprovado', 'rejected', []], ['Pendente', null, []], ['Só Antes', 'approved', []]
  ];
  backend.pairs = definitions.map(([name, status, tools], index) => ({ ...base, id: `fixture-${index}`, position: index,
    name: `Produto ${name}`, review_status: status, is_used: tools.length > 0, used_in: '', usage_tools: tools,
    after_path: index === 6 ? null : base.after_path }));
  const jpeg = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 3; canvas.height = 2;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 3, 2);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  backend.pairs[1].before_path = base.before_path.replace(/[^/]+$/, 'converted.jpg');
  backend.objects.set(`studio-images/${backend.pairs[1].before_path}`, { body: Buffer.from(jpeg), contentType: 'image/jpeg' });
  await page.reload();
  await expect(page.locator('.pair-card')).toHaveCount(7);
  await page.locator('#galleryStatus').selectOption('approved');
  await page.locator('[data-gallery-tool="b2b"]').selectOption('unused');
  await expect(page.locator('.pair-name')).toHaveText(['Produto Novo', 'Produto Atacado', 'Produto Só Antes']);
  await page.locator('#galleryExportMode').selectOption('before');
  await expect(page.locator('#galleryFilterSummary')).toContainText('3 PNG(s)');
  let entries = zipEntries((await downloaded(page, '#exportAll')).bytes);
  expect([...entries.keys()].filter(name => name.endsWith('.png'))).toEqual([
    'antes/01_produto-novo_antes.png', 'antes/03_produto-atacado_antes.png', 'antes/07_produto-so-antes_antes.png'
  ]);
  expect(entries.get('antes/01_produto-novo_antes.png')).toEqual(await readFile(logo));
  expect(entries.get('LEIA-ME.txt').toString()).toContain('dimensões originais');
  await page.locator('#galleryExportMode').selectOption('after');
  await expect(page.locator('#galleryFilterSummary')).toContainText('2 PNG(s)');
  entries = zipEntries((await downloaded(page, '#exportAll')).bytes);
  expect([...entries.keys()].filter(name => name.endsWith('.png'))).toEqual(['depois/01_produto-novo_depois.png', 'depois/03_produto-atacado_depois.png']);
  expect(entries.get('depois/01_produto-novo_depois.png')).toEqual(pixel);
  await page.locator('[data-gallery-tool="atacado-de-modas"]').selectOption('unused');
  await expect(page.locator('.pair-name')).toHaveText(['Produto Novo', 'Produto Só Antes']);
  await page.locator('#galleryExportMode').selectOption('comparison');
  entries = zipEntries((await downloaded(page, '#exportAll')).bytes);
  const pngNames = [...entries.keys()].filter(name => name.endsWith('.png'));
  expect(pngNames).toEqual(['comparativos/01_produto-novo_antes-depois.png']);
  expect(entries.get(pngNames[0]).readUInt32BE(16)).toBe(1068);
  expect(entries.get(pngNames[0]).readUInt32BE(20)).toBe(1473);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.gallery-filters')).toBeHidden();
  await expect(page.locator('.pair-card')).toHaveCount(2);
  await page.emulateMedia({ media: 'screen' });
  await page.locator('[data-gallery-tool="b2b"]').selectOption('used');
  await page.locator('#search').fill('B2B');
  await expect(page.locator('.pair-name')).toHaveText(['Produto B2B']);
  await page.locator('#galleryExportMode').selectOption('before');
  entries = zipEntries((await downloaded(page, '#exportAll')).bytes);
  const converted = entries.get('antes/02_produto-b2b_antes.png');
  expect(converted.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(converted.readUInt32BE(16)).toBe(3); expect(converted.readUInt32BE(20)).toBe(2);
  await page.locator('.gallery-filters').screenshot({ path: 'test-results/gallery-filters-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.gallery-filters').screenshot({ path: 'test-results/gallery-filters-mobile.png', animations: 'disabled', style: '.toast{visibility:hidden!important}' });
  await page.locator('#galleryStatus').selectOption('rejected');
  await expect(page.locator('.pair-card')).toHaveCount(0);
  await expect(page.locator('#exportAll')).toBeDisabled();
  await page.locator('#clearGalleryFilters').click();
  await expect(page.locator('.pair-card')).toHaveCount(7);
  await expect(page.locator('#search')).toHaveValue('');
  await expect(page.locator('[data-gallery-tool="b2b"]')).toHaveValue('all');
});

test('products edit tool usage directly in the gallery, preserve failed drafts and leave absence filters when saved', async ({ page, context }) => {
  const backend = await mockSupabase(context);
  await page.goto('/'); await login(page); await addPair(page);
  await page.locator('.gallery-usage summary').click();
  await expect(page.locator('#gallery [name="isUsed"]')).toBeDisabled();
  await expect(page.locator('.gallery-usage-editor')).toContainText('Aprove a imagem');
  await page.locator('#openReview').click();
  await page.locator('[data-choice="approved"]').click();
  await page.locator('#backToStudio').click();
  await page.locator('#galleryStatus').selectOption('approved');
  await page.locator('[data-gallery-tool="b2b"]').selectOption('unused');
  await page.locator('.gallery-usage summary').click();
  await page.locator('#gallery [name="isUsed"]').check();
  await page.locator('#gallery [name="usageTools"][value="b2b"]').check();
  await page.locator('#gallery [name="usageTools"][value="atacado-de-modas"]').check();
  await page.locator('#gallery [name="usedIn"]').fill('Catálogo verão');
  backend.rejectUsage = true;
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Não foi possível salvar');
  await expect(page.locator('#gallery [name="usageTools"][value="b2b"]')).toBeChecked();
  await expect(page.locator('#gallery [name="usedIn"]')).toHaveValue('Catálogo verão');
  expect(backend.pairs[0].is_used).toBe(false);
  backend.rejectUsage = false;
  await page.getByRole('button', { name: 'Salvar uso', exact: true }).click();
  await expect(page.locator('.pair-card')).toHaveCount(0);
  expect(backend.pairs[0].usage_tools).toEqual(['b2b', 'atacado-de-modas']);
  expect(backend.uploads).toBe(2);
  await page.locator('[data-gallery-tool="b2b"]').selectOption('used');
  await expect(page.locator('.pair-card')).toHaveCount(1);
  await expect(page.locator('.gallery-usage-badge')).toContainText('B2B, Atacado de modas');
  await page.reload();
  await page.locator('.gallery-usage summary').click();
  await expect(page.locator('#gallery [name="usageTools"][value="b2b"]')).toBeChecked();
  await expect(page.locator('#gallery [name="usageTools"][value="atacado-de-modas"]')).toBeChecked();
  await expect(page.locator('#gallery [name="usedIn"]')).toHaveValue('Catálogo verão');
  await page.locator('#openReview').click();
  await expect(page.locator('.usage-status')).toContainText('B2B, Atacado de modas');
  await expect(page.locator('[name="isUsed"]')).toHaveCount(1);
});

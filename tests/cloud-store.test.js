import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore, MAX_IMAGE_BYTES } from '../cloud-store.js';

function setup(usageSupported = true, toolsSupported = usageSupported) {
  const objects = new Map(), metadata = new Map(), uploads = [], removals = [];
  let writeError = false, uploadError = false;
  const client = {
    storage: { from: () => ({
      upload: async (path, blob) => {
        if (uploadError) return { error: { message: 'Upload failed' } };
        objects.set(path, blob); uploads.push(path); return { data: { path } };
      },
      download: async path => ({ data: objects.get(path) }),
      remove: async paths => { paths.forEach(p => { objects.delete(p); removals.push(p); }); return { data: [] }; }
    }) },
    from: () => ({
      upsert: async row => {
        if (writeError) return { error: { message: 'Database failed' } };
        metadata.set(row.id, { ...row }); return { data: null };
      },
      select: columns => ({ eq() { return this; }, maybeSingle: async () => ({ data: null }), limit: async () => !usageSupported ? ({ error: { code: '42703', message: 'column studio_pairs.is_used does not exist' } }) : columns === 'usage_tools' && !toolsSupported ? ({ error: { code: '42703', message: 'column studio_pairs.usage_tools does not exist' } }) : ({ data: [] }) })
    })
  };
  const store = new CloudStore(client, 'owner');
  return { store, objects, metadata, uploads, removals, failWrite: () => { writeError = true; }, failUpload: () => { uploadError = true; } };
}
const pair = () => ({ id: 'pair', projectId: 'project', name: 'Produto', order: 0, created: 1,
  beforeBlob: new Blob(['before'], { type: 'image/png' }), afterBlob: new Blob(['after'], { type: 'image/jpeg' }) });

test('review-only edits retain original images without uploading them again', async () => {
  const { store, metadata, uploads } = setup();
  const record = pair();
  await store.put('pairs', record);
  const before = metadata.get(record.id).before_path;
  await store.put('pairs', { ...record, reviewStatus: 'approved', reviewedAt: new Date().toISOString() });
  assert.equal(uploads.length, 2);
  assert.equal(metadata.get(record.id).before_path, before);
  assert.equal(metadata.get(record.id).review_status, 'approved');
});

test('failed database save removes new uploads and preserves the original images and metadata', async () => {
  const { store, objects, metadata, failWrite } = setup();
  const record = pair();
  await store.put('pairs', record);
  const saved = { ...metadata.get(record.id) };
  failWrite();
  await assert.rejects(store.put('pairs', { ...record, beforeBlob: new Blob(['replacement'], { type: 'image/png' }) }), /Database failed/);
  assert.deepEqual(metadata.get(record.id), saved);
  assert.equal(objects.size, 2);
  assert.equal(await objects.get(saved.before_path).text(), 'before');
});

test('replacement removes old files only after metadata is saved; clearing a slot removes its file', async () => {
  const { store, metadata, objects } = setup();
  const record = pair();
  await store.put('pairs', record);
  const old = metadata.get(record.id).before_path;
  const next = { ...record, beforeBlob: new Blob(['replacement'], { type: 'image/png' }) };
  await store.put('pairs', next);
  assert.equal(objects.has(old), false);
  assert.equal(objects.size, 2);
  await store.put('pairs', { ...next, beforeBlob: null });
  assert.equal(metadata.get(record.id).before_path, null);
  assert.equal(objects.size, 1);
});

test('rejects oversize images before uploading', async () => {
  const { store, uploads } = setup();
  const record = pair();
  record.beforeBlob = new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: 'image/png' });
  await assert.rejects(store.put('pairs', record), /20 MB/);
  assert.equal(uploads.length, 0);
});

test('upload failure does not write metadata', async () => {
  const { store, metadata, failUpload } = setup();
  failUpload();
  await assert.rejects(store.put('pairs', pair()), /Upload failed/);
  assert.equal(metadata.size, 0);
});


test('existing databases keep saving normal comparisons while usage waits for migration', async () => {
  const { store, metadata, uploads } = setup(false);
  const record = pair();
  await store.put('pairs', record);
  await store.put('pairs', { ...record, reviewStatus: 'approved' });
  assert.equal(store.usageSupported, false);
  assert.equal(Object.hasOwn(metadata.get(record.id), 'is_used'), false);
  assert.equal(uploads.length, 2);
  await assert.rejects(store.setUsage(record.id, true, 'Catálogo'), /precisa ser ativado/);
  await assert.rejects(store.put('pairs', { ...record, reviewStatus: 'approved', isUsed: true, usedIn: 'Catálogo' }), /precisa ser ativado/);
});


test('tool-only usage stores every selected tool once without requiring a description', async () => {
  const { store, metadata } = setup();
  await store.put('pairs', { ...pair(), reviewStatus: 'approved', isUsed: true, usedIn: '', usageTools: ['site-ecatalogos', 'b2b', 'forca-de-vendas', 'b2b', 'atacado-de-modas'] });
  assert.deepEqual(metadata.get('pair').usage_tools, ['forca-de-vendas', 'b2b', 'atacado-de-modas', 'site-ecatalogos']);
  assert.equal(metadata.get('pair').used_in, '');
  await assert.rejects(store.put('pairs', { ...pair(), reviewStatus: 'approved', isUsed: true, usedIn: '', usageTools: [] }), /selecione uma ferramenta/);
});

test('the existing usage fields keep working before the tools migration and tool data is never silently discarded', async () => {
  const { store, metadata } = setup(true, false);
  const record = { ...pair(), reviewStatus: 'approved', isUsed: true, usedIn: 'Carrossel do site' };
  await store.put('pairs', record);
  assert.equal(metadata.get('pair').used_in, record.usedIn);
  assert.equal(Object.hasOwn(metadata.get('pair'), 'usage_tools'), false);
  await assert.rejects(store.put('pairs', { ...record, usageTools: ['b2b'] }), /ferramentas de uso precisam ser ativadas/);
  assert.equal(metadata.get('pair').used_in, record.usedIn);
});

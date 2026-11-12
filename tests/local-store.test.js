import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLocalStore, migrateLocalProjects } from '../storage.js';

test('preserves existing IndexedDB records, images and review decisions across connections', async () => {
  const store = await openLocalStore();
  const project = { id: 'legacy-project', name: 'Coleção antiga', created: 1 };
  const blob = new Blob(['original'], { type: 'image/png' });
  await store.put('projects', project);
  await store.put('pairs', { id: 'legacy-pair', projectId: project.id, name: 'Sapato', order: 0, beforeBlob: blob, reviewStatus: 'approved' });
  const reopened = await openLocalStore();
  assert.deepEqual(await reopened.all('projects'), [project]);
  const [pair] = await reopened.getPairs(project.id);
  assert.equal(await pair.beforeBlob.text(), 'original');
  assert.equal(pair.reviewStatus, 'approved');
  await store.del('projects', project.id);
  assert.equal((await reopened.getPairs(project.id)).length, 0);
});

test('reorders both pairs together and refuses swaps across projects', async () => {
  const store = await openLocalStore();
  await store.put('pairs', { id: 'first', projectId: 'p', order: 0 });
  await store.put('pairs', { id: 'second', projectId: 'p', order: 1 });
  await store.put('pairs', { id: 'third', projectId: 'other', order: 2 });
  await store.movePairs('first', 'second');
  assert.deepEqual((await store.getPairs('p')).map(p => p.order), [1, 0]);
  await assert.rejects(store.movePairs('first', 'third'));
  assert.deepEqual((await store.getPairs('p')).map(p => p.order), [1, 0]);
  await store.del('projects', 'p');
  await store.del('projects', 'other');
});

test('migration resumes after upload failure without duplicating or overwriting cloud edits', async () => {
  const local = await openLocalStore();
  await local.put('projects', { id: 'migration', name: 'Local' });
  await local.put('pairs', { id: 'one', projectId: 'migration' });
  await local.put('pairs', { id: 'two', projectId: 'migration' });
  const projects = new Map(), pairs = new Map();
  let fail = true;
  const cloud = {
    all: async () => [...projects.values()],
    pairIds: async () => new Set(pairs.keys()),
    put: async (table, record) => {
      if (table === 'pairs' && record.id === 'two' && fail) throw Error('Network disconnected');
      (table === 'projects' ? projects : pairs).set(record.id, record);
    }
  };
  await assert.rejects(migrateLocalProjects(local, cloud));
  projects.get('migration').name = 'Nome editado na nuvem';
  pairs.set('one', { ...pairs.get('one'), name: 'Editado na nuvem' });
  fail = false;
  assert.equal(await migrateLocalProjects(local, cloud), 1);
  assert.equal(await migrateLocalProjects(local, cloud), 0);
  assert.equal(pairs.size, 2);
  assert.equal(projects.get('migration').name, 'Nome editado na nuvem');
  assert.equal(pairs.get('one').name, 'Editado na nuvem');
  assert.equal((await local.getPairs('migration')).length, 2);
  await local.del('projects', 'migration');
});

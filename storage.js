// Keep the original database name and version so existing projects remain available.
export function openLocalStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ecatalogos_image_studio', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pairs')) {
        db.createObjectStore('pairs', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(new LocalStore(request.result));
  });
}

export class LocalStore {
  constructor(db) { this.db = db; this.mode = 'local'; }

  request(store, mode, method, ...args) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const request = tx.objectStore(store)[method](...args);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error || request.error || new Error('Não foi possível salvar no navegador.'));
    });
  }

  all(store) { return this.request(store, 'readonly', 'getAll'); }
  put(store, record) { return this.request(store, 'readwrite', 'put', record); }
  getPairs(projectId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('pairs', 'readonly');
      const request = tx.objectStore('pairs').index('projectId').getAll(projectId);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }

  async del(store, id) {
    if (store !== 'projects') return this.request(store, 'readwrite', 'delete', id);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['projects', 'pairs'], 'readwrite');
      tx.objectStore('projects').delete(id);
      const cursor = tx.objectStore('pairs').index('projectId').openCursor(id);
      cursor.onsuccess = () => {
        if (cursor.result) { cursor.result.delete(); cursor.result.continue(); }
      };
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }

  async movePairs(firstId, secondId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('pairs', 'readwrite');
      const store = tx.objectStore('pairs');
      const first = store.get(firstId), second = store.get(secondId);
      let loaded = 0;
      const swap = () => {
        if (++loaded !== 2) return;
        if (!first.result || !second.result || first.result.projectId !== second.result.projectId) return tx.abort();
        const order = first.result.order;
        store.put({ ...first.result, order: second.result.order });
        store.put({ ...second.result, order });
      };
      first.onsuccess = second.onsuccess = swap;
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Não foi possível reordenar os comparativos.'));
    });
  }
}

// Copy only missing records: retrying a partial migration never overwrites cloud edits.
// Local records are deliberately retained after a successful copy.
export async function migrateLocalProjects(local, cloud, onProgress = () => {}) {
  const projects = await local.all('projects');
  const knownProjects = new Set((await cloud.all('projects')).map(p => p.id));
  let copied = 0;
  for (const project of projects) {
    if (!knownProjects.has(project.id)) await cloud.put('projects', project);
    const knownPairs = await cloud.pairIds(project.id);
    for (const pair of await local.getPairs(project.id)) {
      if (knownPairs.has(pair.id)) continue;
      onProgress(++copied, project.name);
      await cloud.put('pairs', pair);
    }
  }
  return copied;
}

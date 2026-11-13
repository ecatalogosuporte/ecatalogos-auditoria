import { normalizeUsageTools } from './usage-tools.js';

export const BUCKET = 'studio-images';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TABLES = { projects: 'studio_projects', pairs: 'studio_pairs' };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function check(result) {
  if (result.error) throw new Error(result.error.message || 'Não foi possível acessar a nuvem.');
  return result.data;
}

// Supabase paginates responses; avoid silently hiding records beyond its row limit.
async function rows(query) {
  const result = [];
  for (let offset = 0; ; offset += 500) {
    const page = check(await query().range(offset, offset + 499));
    result.push(...page);
    if (page.length < 500) return result;
  }
}

export class CloudStore {
  constructor(client, userId, onWarning = () => {}, onProgress = () => {}) {
    this.client = client;
    this.userId = userId;
    this.mode = 'cloud';
    this.blobs = new Map();
    this.records = new Map();
    this.onWarning = onWarning;
    this.onProgress = onProgress;
    this.usageSupported = null;
    this.usageToolsSupported = null;
  }

  query(store) { return this.client.from(TABLES[store]); }
  bucket() { return this.client.storage.from(BUCKET); }

  async supportsUsage() {
    if (this.usageSupported !== null) return this.usageSupported;
    const result = await this.query('pairs').select('is_used,used_in').eq('owner_id', this.userId).limit(1);
    if (result.error && ['42703', 'PGRST204'].includes(result.error.code) && /is_used|used_in/.test(result.error.message)) {
      this.usageSupported = false;
    } else {
      check(result);
      this.usageSupported = true;
    }
    return this.usageSupported;
  }
  async all(store) {
    if (store !== 'projects') throw new Error('Selecione um projeto para carregar os comparativos.');
    const data = await rows(() => this.query(store).select('*').eq('owner_id', this.userId).order('created_at').order('id'));
    return data.map(p => ({ id: p.id, name: p.name, created: p.created_at }));
  }

  async supportsUsageTools() {
    if (this.usageToolsSupported !== null) return this.usageToolsSupported;
    if (!await this.supportsUsage()) return (this.usageToolsSupported = false);
    const result = await this.query('pairs').select('usage_tools').eq('owner_id', this.userId).limit(1);
    if (result.error && ['42703', 'PGRST204'].includes(result.error.code) && /usage_tools/.test(result.error.message)) {
      this.usageToolsSupported = false;
    } else {
      check(result);
      this.usageToolsSupported = true;
    }
    return this.usageToolsSupported;
  }

  async pairRows(projectId, columns = '*') {
    return rows(() => this.query('pairs').select(columns).eq('owner_id', this.userId)
      .eq('project_id', projectId).order('position').order('id'));
  }

  async pairIds(projectId) {
    return new Set((await this.pairRows(projectId, 'id,position')).map(row => row.id));
  }

  async blob(path) {
    if (!path) return null;
    if (!this.blobs.has(path)) this.blobs.set(path, check(await this.bucket().download(path)));
    return this.blobs.get(path);
  }

  async getPairs(projectId) {
    await this.supportsUsage();
    await this.supportsUsageTools();
    const data = await this.pairRows(projectId);
    const result = new Array(data.length);
    let index = 0, completed = 0;
    if (data.length) this.onProgress({ phase: 'download', completed, total: data.length });
    // Bound network requests when opening a gallery with many original images.
    const worker = async () => {
      while (index < data.length) {
        const i = index++, row = data[i];
        this.records.set(row.id, row);
        const [beforeBlob, afterBlob] = await Promise.all([this.blob(row.before_path), this.blob(row.after_path)]);
        result[i] = {
          id: row.id, projectId: row.project_id, name: row.name, order: row.position,
          created: row.created_at, beforeBlob, afterBlob,
          beforeName: row.before_name, afterName: row.after_name,
          reviewStatus: row.review_status, reviewedAt: row.reviewed_at,
          isUsed: row.is_used || false, usedIn: row.used_in || '',
          usageTools: normalizeUsageTools(row.usage_tools)
        };
        this.onProgress({ phase: 'download', completed: ++completed, total: data.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(data.length, 3) }, worker));
    return result;
  }

  async previous(id) {
    if (this.records.has(id)) return this.records.get(id);
    return check(await this.query('pairs').select('*').eq('owner_id', this.userId).eq('id', id).maybeSingle());
  }

  async cleanup(paths, saved = true) {
    const existing = [...new Set(paths.filter(Boolean))];
    if (!existing.length) return;
    let error;
    try { ({ error } = await this.bucket().remove(existing)); } catch (cause) { error = cause; }
    if (error) this.onWarning(saved ? 'Dados salvos. Algumas imagens antigas não puderam ser removidas do armazenamento.' : 'Alguns arquivos de um envio incompleto não puderam ser removidos do armazenamento.');
    else existing.forEach(path => this.blobs.delete(path));
  }

  async put(store, record) {
    if (store === 'projects') {
      check(await this.query(store).upsert({ id: record.id, owner_id: this.userId, name: record.name, created_at: record.created }));
      return;
    }
    const previous = await this.previous(record.id);
    const usageSupported = await this.supportsUsage();
    const toolsSupported = await this.supportsUsageTools();
    const isUsed = Boolean(record.isUsed), usedIn = isUsed ? String(record.usedIn || '').trim() : '';
    const tools = isUsed ? normalizeUsageTools(record.usageTools) : [];
    if (isUsed && !usageSupported) throw new Error('O registro de uso precisa ser ativado pelo responsável pela Auditoria.');
    if (tools.length && !toolsSupported) throw new Error('As ferramentas de uso precisam ser ativadas pelo responsável pela Auditoria.');
    if (isUsed && (record.reviewStatus !== 'approved' || (!usedIn && !tools.length) || usedIn.length > 300)) {
      throw new Error('Para marcar como usada, aprove a imagem e selecione uma ferramenta ou informe onde ela está sendo utilizada (até 300 caracteres).');
    }
    const uploaded = [];
    const uploadTotal = ['before', 'after'].filter(slot => {
      const blob = record[`${slot}Blob`], path = previous?.[`${slot}_path`];
      return blob && !(path && this.blobs.get(path) === blob);
    }).length;
    if (uploadTotal) this.onProgress({ phase: 'upload', completed: 0, total: uploadTotal });
    const next = {
      id: record.id, owner_id: this.userId, project_id: record.projectId, name: record.name,
      position: record.order, created_at: record.created,
      before_name: record.beforeName || '', after_name: record.afterName || '',
      review_status: record.reviewStatus || null, reviewed_at: record.reviewedAt || null
    };
    if (usageSupported) Object.assign(next, { is_used: isUsed, used_in: usedIn });
    if (toolsSupported) next.usage_tools = tools;
    try {
      for (const slot of ['before', 'after']) {
        const blob = record[`${slot}Blob`], oldPath = previous?.[`${slot}_path`];
        if (!blob) { next[`${slot}_path`] = null; continue; }
        if (oldPath && this.blobs.get(oldPath) === blob) { next[`${slot}_path`] = oldPath; continue; }
        if (!IMAGE_TYPES.has(blob.type)) throw new Error('Use imagens JPG, PNG, WebP ou GIF.');
        if (blob.size > MAX_IMAGE_BYTES) throw new Error('Cada imagem pode ter até 20 MB.');
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[blob.type];
        // New immutable path: a failed database write never destroys the saved image.
        const path = `${this.userId}/${record.projectId}/${record.id}/${slot}-${crypto.randomUUID()}.${ext}`;
        check(await this.bucket().upload(path, blob, { contentType: blob.type, upsert: false }));
        uploaded.push(path);
        this.onProgress({ phase: 'upload', completed: uploaded.length, total: uploadTotal });
        this.blobs.set(path, blob);
        next[`${slot}_path`] = path;
      }
      if (uploadTotal) this.onProgress({ phase: 'save' });
      check(await this.query(store).upsert(next));
    } catch (error) {
      await this.cleanup(uploaded, false);
      throw error;
    }
    this.records.set(record.id, next);
    await this.cleanup(['before', 'after'].map(slot => previous?.[`${slot}_path`]).filter(path => path && path !== next.before_path && path !== next.after_path));
  }

  async del(store, id) {
    const deleted = store === 'projects' ? await this.pairRows(id) : [await this.previous(id)].filter(Boolean);
    check(await this.query(store).delete().eq('owner_id', this.userId).eq('id', id));
    deleted.forEach(row => this.records.delete(row.id));
    await this.cleanup(deleted.flatMap(row => [row.before_path, row.after_path]));
  }

  async movePairs(firstId, secondId) {
    check(await this.client.rpc('studio_swap_pairs', { first_id: firstId, second_id: secondId }));
  }

  async setUsage(id, isUsed, usedIn, usageTools = []) {
    if (!await this.supportsUsage()) throw new Error('O registro de uso precisa ser ativado pelo responsável pela Auditoria.');
    const toolsSupported = await this.supportsUsageTools();
    const tools = isUsed ? normalizeUsageTools(usageTools) : [];
    const location = isUsed ? String(usedIn || '').trim() : '';
    if (tools.length && !toolsSupported) throw new Error('As ferramentas de uso precisam ser ativadas pelo responsável pela Auditoria.');
    if (isUsed && ((!location && !tools.length) || location.length > 300)) throw new Error('Informe onde a imagem está sendo usada ou selecione uma ferramenta (até 300 caracteres).');
    const fields = { is_used: Boolean(isUsed), used_in: location };
    if (toolsSupported) fields.usage_tools = tools;
    // Update only usage fields so edits from a second reviewer do not overwrite images or names.
    const result = await this.query('pairs').update(fields)
      .eq('owner_id', this.userId).eq('id', id).eq('review_status', 'approved')
      .select(toolsSupported ? 'id,is_used,used_in,usage_tools' : 'id,is_used,used_in').single();
    if (result.error?.code === 'PGRST116') throw new Error('A imagem precisa estar aprovada. Atualize a revisão e tente novamente.');
    const saved = check(result);
    const cached = this.records.get(id);
    if (cached) this.records.set(id, { ...cached, ...fields });
    return { isUsed: saved.is_used, usedIn: saved.used_in, usageTools: normalizeUsageTools(saved.usage_tools) };
  }
}

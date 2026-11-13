import { normalizeUsageTools } from './usage-tools.js';

export function filterGalleryPairs(pairs, { search = '', status = 'all', tools = {} } = {}) {
  const term = search.trim().toLocaleLowerCase('pt-BR');
  return pairs.filter(pair => {
    const approved = pair.reviewStatus === 'approved';
    if (!pair.name.toLocaleLowerCase('pt-BR').includes(term)) return false;
    if (status === 'pending' && ['approved', 'rejected'].includes(pair.reviewStatus)) return false;
    if (['approved', 'rejected'].includes(status) && pair.reviewStatus !== status) return false;
    if (status === 'approved-used' && !(approved && pair.isUsed)) return false;
    if (status === 'approved-unused' && !(approved && !pair.isUsed)) return false;
    const usedTools = approved && pair.isUsed ? normalizeUsageTools(pair.usageTools) : [];
    return Object.entries(tools).every(([id, mode]) =>
      mode === 'used' ? usedTools.includes(id) : mode === 'unused' ? !usedTools.includes(id) : true);
  });
}

export const USAGE_TOOLS = [
  { id: 'forca-de-vendas', label: 'Força de vendas' },
  { id: 'b2b', label: 'B2B' },
  { id: 'atacado-de-modas', label: 'Atacado de modas' },
  { id: 'site-ecatalogos', label: 'Site — e-catalogos.net' }
];

export function normalizeUsageTools(value) {
  if (!Array.isArray(value)) return [];
  return USAGE_TOOLS.filter(tool => value.includes(tool.id)).map(tool => tool.id);
}

export function usageToolLabels(value) {
  const selected = normalizeUsageTools(value);
  return USAGE_TOOLS.filter(tool => selected.includes(tool.id)).map(tool => tool.label).join(', ');
}

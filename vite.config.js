import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY)?.trim();
  if (Boolean(url) !== Boolean(key)) throw new Error('Configure VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY juntas, ou deixe ambas vazias para manter o acesso bloqueado até configurar.');
  if (url && !/^https?:\/\//.test(url)) throw new Error('VITE_SUPABASE_URL deve ser a URL HTTP(S) do projeto Supabase.');
  if (key?.startsWith('sb_secret_')) throw new Error('Use a chave pública publishable, nunca uma chave secret.');
  if (key?.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
      if (payload.role === 'service_role') throw new Error('A chave service_role não pode ser exposta no frontend. Use a chave anon ou publishable.');
    } catch (error) {
      if (error.message.includes('service_role')) throw error;
    }
  }
  return {};
});

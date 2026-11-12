import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY)?.trim();
export const cloudClient = url && key ? createClient(url, key) : null;

export function authMessage(error) {
  const text = error?.message || '';
  if (/invalid login credentials/i.test(text)) return 'E-mail, usuário ou senha incorretos.';
  if (/email not confirmed/i.test(text)) return 'Confirme seu e-mail antes de entrar.';
  if (/already registered/i.test(text)) return 'Este e-mail já está cadastrado. Entre com sua senha.';
  if (/rate limit|too many requests|security purposes/i.test(text)) return 'Aguarde um pouco antes de tentar novamente.';
  if (/fetch|network/i.test(text)) return 'Não foi possível conectar. Verifique sua internet e tente novamente.';
  if (/signup.*disabled|signups not allowed/i.test(text)) return 'O cadastro está fechado. Peça acesso ao responsável pelo eCatalogos Auditoria.';
  return text || 'Não foi possível concluir. Tente novamente.';
}

// This is a login alias, not an authorization role. Supabase still authenticates
// the password and enforces the same owner-only policies as every other account.
// .invalid is reserved and cannot deliver mail; provision this account confirmed.
export const STUDIO_LOGIN = 'ecatalogos@admin';
export const STUDIO_AUTH_EMAIL = 'ecatalogos@admin.invalid';

export function loginEmail(value) {
  const login = String(value || '').trim();
  return login.toLowerCase() === STUDIO_LOGIN ? STUDIO_AUTH_EMAIL : login;
}

export function displayLogin(email) {
  return String(email || '').toLowerCase() === STUDIO_AUTH_EMAIL ? STUDIO_LOGIN : email || '';
}

export function isStudioLogin(value) {
  return loginEmail(value).toLowerCase() === STUDIO_AUTH_EMAIL;
}

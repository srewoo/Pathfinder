export interface TenantConfig {
  name: string;
  origin: string;
  loginUrl?: string;
  authCookieDomain?: string;
}

export function resolveTenantUrl(path: string, tenant: TenantConfig): string {
  return new URL(path, tenant.origin).toString();
}

export function templateCookieDomain(cookie: { domain: string }, tenant: TenantConfig): string {
  if (!tenant.authCookieDomain) return cookie.domain;
  return tenant.authCookieDomain;
}

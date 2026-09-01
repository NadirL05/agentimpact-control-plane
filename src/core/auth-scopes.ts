/**
 * Scopes Bearer pour le control plane — allowlist stricte par identité.
 */

export type AuthScope = 'bridge' | 'hermes' | 'admin';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

type RouteRule = {
  method: HttpMethod;
  pattern: RegExp;
};

const BRIDGE_RULES: RouteRule[] = [
  { method: 'GET', pattern: /^\/health$/ },
  { method: 'GET', pattern: /^\/missions$/ },
  { method: 'GET', pattern: /^\/missions\/[0-9a-f-]{36}$/i },
  { method: 'GET', pattern: /^\/api\/approvals\/pending$/ },
  { method: 'POST', pattern: /^\/api\/proposals$/ },
  { method: 'GET', pattern: /^\/api\/proposals\/[0-9a-f-]{36}$/i },
];

const HERMES_RULES: RouteRule[] = [
  ...BRIDGE_RULES,
  { method: 'GET', pattern: /^\/actions$/ },
  { method: 'POST', pattern: /^\/actions$/ },
  { method: 'POST', pattern: /^\/api\/actions$/ },
  { method: 'POST', pattern: /^\/missions$/ },
  { method: 'POST', pattern: /^\/missions\/[0-9a-f-]{36}\/dispatch$/i },
  { method: 'PATCH', pattern: /^\/missions\/[0-9a-f-]{36}\/result$/i },
  { method: 'PATCH', pattern: /^\/actions\/[0-9a-f-]{36}\/(approve|reject)$/i },
  { method: 'POST', pattern: /^\/api\/approvals$/ },
  { method: 'POST', pattern: /^\/api\/approvals\/request$/ },
  { method: 'GET', pattern: /^\/leads$/ },
  { method: 'POST', pattern: /^\/leads$/ },
  { method: 'GET', pattern: /^\/api\/briefs\/daily$/ },
  { method: 'GET', pattern: /^\/api\/drive\/search$/ },
  { method: 'POST', pattern: /^\/api\/drive\/execute$/ },
  { method: 'GET', pattern: /^\/api\/growth\/pipeline$/ },
  { method: 'POST', pattern: /^\/api\/growth\/qualify$/ },
  { method: 'POST', pattern: /^\/api\/fullenrich\/enrich$/ },
  { method: 'GET', pattern: /^\/api\/clients\/metrics$/ },
  { method: 'GET', pattern: /^\/api\/clients\/autonomy$/ },
  { method: 'POST', pattern: /^\/api\/clients\/[^/]+\/report$/ },
  { method: 'GET', pattern: /^\/profiles$/ },
  { method: 'GET', pattern: /^\/policies$/ },
  { method: 'GET', pattern: /^\/workflows$/ },
  { method: 'GET', pattern: /^\/api\/outreach\// },
  { method: 'POST', pattern: /^\/api\/outreach\// },
  { method: 'GET', pattern: /^\/api\/demos\// },
  { method: 'POST', pattern: /^\/api\/demos\// },
  { method: 'GET', pattern: /^\/api\/training\// },
  { method: 'POST', pattern: /^\/api\/training\// },
  { method: 'GET', pattern: /^\/api\/gmail\// },
  { method: 'POST', pattern: /^\/api\/gmail\// },
  { method: 'POST', pattern: /^\/api\/github\/spec$/ },
  { method: 'POST', pattern: /^\/api\/github\/execute$/ },
  { method: 'POST', pattern: /^\/api\/github\/review$/ },
];

const ADMIN_RULES: RouteRule[] = [
  ...HERMES_RULES,
  { method: 'POST', pattern: /^\/api\/proposals\/[0-9a-f-]{36}\/promote$/i },
  { method: 'POST', pattern: /^\/api\/proposals\/[0-9a-f-]{36}\/reject$/i },
];

const SCOPE_RULES: Record<AuthScope, RouteRule[]> = {
  bridge: BRIDGE_RULES,
  hermes: HERMES_RULES,
  admin: ADMIN_RULES,
};

/** Routes avec mécanisme d'auth propre (signature webhook, etc.). */
const WEBHOOK_EXEMPT: RouteRule[] = [
  { method: 'POST', pattern: /^\/api\/github\/webhook$/ },
  { method: 'POST', pattern: /^\/api\/fullenrich\/webhook$/ },
  { method: 'GET', pattern: /^\/training$/ },
];

export function isWebhookExempt(method: string, path: string): boolean {
  const m = method.toUpperCase() as HttpMethod;
  return WEBHOOK_EXEMPT.some((r) => r.method === m && r.pattern.test(path));
}

export function isRouteAllowed(scope: AuthScope, method: string, path: string): boolean {
  const m = method.toUpperCase() as HttpMethod;
  const rules = SCOPE_RULES[scope];
  return rules.some((r) => r.method === m && r.pattern.test(path));
}

/**
 * Variables de contexte Hono partagées (middleware auth → handlers).
 */

import type { AuthScope } from './auth-scopes.js';

export type AppVariables = {
  authScope: AuthScope;
};

export type AppEnv = {
  Variables: AppVariables;
};

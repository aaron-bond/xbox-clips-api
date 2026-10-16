/**
 * Bindings as the Worker sees them. `Env` is generated from wrangler.jsonc by
 * `npm run cf-typegen`; the secret is added here because `wrangler types` only
 * sees secrets present in a local `.dev.vars`.
 */
export type AppEnv = Env & {
  XBL_API_KEY: string;
};

// `node --import ./e2e/support/register-alias.mjs ...`: enables ./alias-hooks.mjs (app `@/` imports from plain Node).
import { register } from 'node:module';

register('./alias-hooks.mjs', import.meta.url);

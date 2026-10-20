// Node module-resolution hooks so plain `node` can import the app's TypeScript sources (src/**) the way Next's
// bundler does: the `@/` alias (tsconfig "paths") and extensionless relative imports (`./x` -> ./x.ts / ./x/index.ts).
// Registered by ./register-alias.mjs; used by the seed script (./seed.mts). Test/tooling only.
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const EXTS = ['.ts', '.tsx', '.mts', '.js', '.mjs'];

function probe(base) {
    if (existsSync(base) && statSync(base).isFile()) return base;
    for (const ext of EXTS) if (existsSync(base + ext)) return base + ext;
    for (const ext of EXTS) {
        const idx = join(base, `index${ext}`);
        if (existsSync(idx)) return idx;
    }
    return null;
}

export async function resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
        const hit = probe(join(SRC, specifier.slice(2)));
        if (hit) return next(pathToFileURL(hit).href, context);
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
        const parent = fileURLToPath(context.parentURL);
        if (parent.startsWith(SRC)) {
            const hit = probe(resolvePath(dirname(parent), specifier));
            if (hit) return next(pathToFileURL(hit).href, context);
        }
    }
    try {
        return await next(specifier, context);
    } catch (err) {
        // CommonJS package subpaths without an "exports" map (e.g. `next/server`): the bundler adds ".js".
        if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^[@a-z]/i.test(specifier) && specifier.includes('/') && !/\.[cm]?js$/.test(specifier)) {
            return next(`${specifier}.js`, context);
        }
        throw err;
    }
}

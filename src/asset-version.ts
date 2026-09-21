import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A short fingerprint of everything in public/.
 *
 * Static assets are served with a long cache lifetime, which is right for
 * performance and wrong for correctness: after a deploy, browsers keep serving
 * the previous stylesheet against freshly rendered HTML, and the page renders
 * half-styled until the cache expires. Appending this to every asset URL makes
 * a changed file a different URL, so a deploy invalidates exactly the files
 * that changed and nothing else.
 *
 * Computed once at startup: the files cannot change while the process runs.
 */
export function computeAssetVersion(publicDir: string): string {
  const hash = createHash('sha1');
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(entry).update(readFileSync(full));
    }
  };
  try {
    walk(publicDir);
  } catch {
    // If public/ cannot be read the app still has to boot; a constant version
    // simply means no cache busting.
    return 'dev';
  }
  return hash.digest('hex').slice(0, 10);
}

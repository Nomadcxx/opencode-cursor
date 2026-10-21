/**
 * One open-cursor setup per OpenCode 2 location.
 *
 * Two copies of this package can load into one OpenCode 2 server: the npm
 * `plugins` entry and a 1.x symlink left in the config `plugin/` directory,
 * which 2.x still loads. Each copy would start its own proxy and model
 * discovery and register the same provider. Copies are separate module
 * instances, so the claim lives on `globalThis` under a registry symbol.
 */

const CLAIMS = Symbol.for("open-cursor.opencode2.location-claims");

type ClaimRegistry = Map<string, string>;

function registry(): ClaimRegistry {
  const scope = globalThis as typeof globalThis & { [CLAIMS]?: ClaimRegistry };
  scope[CLAIMS] ??= new Map();
  return scope[CLAIMS];
}

export type LocationClaim =
  | { claimed: true; release: () => void }
  | { claimed: false; owner: string };

/** Claim `directory` for the copy at `module`; a second copy gets the owner back. */
export function claimLocation(directory: string, module: string): LocationClaim {
  const claims = registry();
  const owner = claims.get(directory);
  if (owner !== undefined && owner !== module) {
    return { claimed: false, owner };
  }
  claims.set(directory, module);
  return {
    claimed: true,
    release: () => {
      if (claims.get(directory) === module) claims.delete(directory);
    },
  };
}

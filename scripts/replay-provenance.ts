import { execFileSync } from 'node:child_process';
import type { ReplayProvenance } from '../src/data/replay-store';

/**
 * Collect the provenance stamped into a recording by `pnpm bake` / `pnpm snapshot:replay`.
 *
 * Lives beside the scripts rather than in `src/data/` because it shells out to git and reads argv:
 * `snapshotReplay` takes the result as a parameter precisely so it stays pure Db access and testable
 * without a working tree. See ReplayProvenance for why each field is recorded.
 */

/**
 * The app commit, from git, or 'unknown'.
 *
 * Every failure here is a legitimate operating condition, not an error: the image ships the source
 * with `.git` excluded (see .dockerignore), and both bake and snapshot run inside a container on the
 * box. So a missing git, a missing repository, and a source tree with no history all resolve to
 * 'unknown' — which is why the caller must pass `--commit` there, and why the field is a string
 * rather than something a reader can mistake for "this ran at no commit".
 */
export function gitCommit(cwd?: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[0-9a-f]{7,40}$/.test(out)) return 'unknown';
    // A dirty tree is not the commit it reports. Silently stamping the clean hash would attribute a
    // recording to code that does not include what produced it, which is the one thing this field is
    // for; the suffix keeps the hash usable while saying so.
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
    return dirty ? `${out}-dirty` : out;
  } catch {
    return 'unknown';
  }
}

/** `--flag value` or `--flag=value` from argv, matching the convention in scripts/bench-corpus.ts. */
function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(`--${flag}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return argv.find(a => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
}

/**
 * Resolve all three provenance fields from the flags, the environment, and git — in that precedence.
 *
 * The flag wins over the environment because the environment is what the box already has and the flag
 * is what the operator asserts for THIS bake. The tier has no autodiscovery on purpose: reading it
 * would mean an Atlas Admin API call with admin credentials from a script that otherwise needs only
 * a database user, so it is supplied (`--tier M30`) or recorded as 'unknown'.
 */
export function collectProvenance(o: {
  argv?: string[]; env?: NodeJS.ProcessEnv | Record<string, string | undefined>; llmModel: string; cwd?: string;
}): ReplayProvenance {
  const argv = o.argv ?? [];
  const env = o.env ?? {};
  return {
    app_commit: argValue(argv, 'commit') ?? env.APP_COMMIT ?? gitCommit(o.cwd),
    atlas_tier: argValue(argv, 'tier') ?? env.ATLAS_TIER ?? 'unknown',
    llm_model: o.llmModel || 'unknown',
  };
}

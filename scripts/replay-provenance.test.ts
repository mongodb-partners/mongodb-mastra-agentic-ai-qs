import { describe, it, expect } from 'vitest';
import { collectProvenance, gitCommit } from './replay-provenance';

describe('collectProvenance', () => {
  const base = { llmModel: 'claude-haiku-4-5' };

  it('takes the flags over the environment', () => {
    // The environment is what the box happens to carry; the flag is what the operator asserts for
    // THIS bake. A box whose APP_COMMIT is stale must not silently win over an explicit --commit.
    expect(collectProvenance({
      ...base,
      argv: ['--commit', 'aaa1111', '--tier', 'M30'],
      env: { APP_COMMIT: 'bbb2222', ATLAS_TIER: 'M10' },
    })).toEqual({ app_commit: 'aaa1111', atlas_tier: 'M30', llm_model: 'claude-haiku-4-5' });
  });

  it('accepts --flag=value as well as --flag value', () => {
    expect(collectProvenance({ ...base, argv: ['--commit=ccc3333', '--tier=M40'] }))
      .toMatchObject({ app_commit: 'ccc3333', atlas_tier: 'M40' });
  });

  it('falls back to the environment when no flag is given', () => {
    expect(collectProvenance({ ...base, argv: [], env: { APP_COMMIT: 'ddd4444', ATLAS_TIER: 'M20' } }))
      .toMatchObject({ app_commit: 'ddd4444', atlas_tier: 'M20' });
  });

  it("records the tier as 'unknown' rather than guessing it", () => {
    // There is deliberately no autodiscovery: reading the tier means an Atlas Admin API call with
    // admin credentials, from a script that otherwise needs only a database user.
    expect(collectProvenance({ ...base, argv: [], env: {} }).atlas_tier).toBe('unknown');
  });

  it("records an empty LLM_MODEL as 'unknown', never as an empty string", () => {
    // Config guarantees a non-empty model, but this field is also written by a bake in a container
    // where the value comes from the environment. '' would render as a blank next to "model", which a
    // reader takes for a value rather than an absence.
    expect(collectProvenance({ argv: [], env: {}, llmModel: '' }).llm_model).toBe('unknown');
  });

  it('never returns a missing or non-string field, so no caller needs a guard', () => {
    const p = collectProvenance({ argv: [], env: {}, llmModel: '' });
    expect(Object.keys(p).sort()).toEqual(['app_commit', 'atlas_tier', 'llm_model']);
    for (const v of Object.values(p)) expect(typeof v).toBe('string');
    for (const v of Object.values(p)) expect(v.length).toBeGreaterThan(0);
  });
});

describe('gitCommit', () => {
  it('returns a short hash in a repository', () => {
    // This repo IS one, so the happy path is exercisable without a fixture. A `-dirty` suffix is
    // expected while the working tree has edits — that is the point of the suffix.
    expect(gitCommit()).toMatch(/^([0-9a-f]{7,40}(-dirty)?|unknown)$/);
  });

  it("returns 'unknown' outside a repository instead of throwing", () => {
    // The real case this covers: `pnpm bake` runs inside the container, and .dockerignore excludes
    // .git — so git either is absent or has nothing to answer with. That must degrade to a recorded
    // 'unknown' (and the --commit flag), never take the bake down after the LLM run has been paid for.
    expect(gitCommit('/')).toBe('unknown');
  });
});

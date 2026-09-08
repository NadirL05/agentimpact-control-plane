# R8 bootstrap preparation

This is local preparation, not an approved production launcher.
No worker, provider request, service activation, migration or GitHub operation
is performed by these modules. R7 and its quarantine are never accessed.

Run `python3 -B -m unittest discover -s infra/codex-canary -p 'test_*.py' -v`
from the repository root. Tests build their own fixture in temporary directories;
they do not require root, Docker, PostgreSQL, credentials or network access.

The publication library uses an immutable preflight UUID below a private root,
with separate incoming, extracting, validated, published, failed and manifest
directories. Linux renameat2 with RENAME_NOREPLACE is required. There is no
overwrite fallback. Archive paths, types, sizes, counts and hashes are validated
before extraction. Empty directories must be explicitly present in the archive.
Published files have mode 0400; directories have mode 0700.

A successful repeated publication checks the IDs, archive digest, inventory,
published inode and device, stored archive and manifests. It does not extract
again. A partial or mismatched destination blocks. Failed extraction objects and
failure manifests remain available; production objects are never deleted.
The containing production root and all ancestors must be trusted, nonsymlink
directories. Local test roots are explicitly injected instead of production paths.

Power loss before the success manifest is durable produces a blocking partial
transaction. Automatic crash recovery is deliberately not claimed. Root alone
can reconcile that object after inspection. Publication requires private parent
directories: this is not a defense against another privileged root process.

`verified_bytes.py` compiles the same bytes whose digest it checks. A test replaces
the original pathname after verification and proves that the replacement is not
executed. A production wrapper still needs explicit exception-to-exit handling
and immutable constants; no production wrapper has been issued.

## CodexPolicy contract

`build_fixture.py` emits a registry accepted by
`codexRepositoryRegistrySchema.strict()` with exactly:

`repoId`, `mirrorPath`, `allowedPaths`, `maxDiffBytes`, `requiredTests`.

`base_sha` is recorded in `plan.json` and bound through the attempt/lease
contracts, not through CodexPolicy. Publisher remains disabled in the
control-plane runtime (`publisherEnabled:false`); it is never a policy key.

`policy.proposed.json` is therefore installable against the deployed Zod schema.
Root production installation and the real Codex canary remain separate gated
operations. Offline tests still perform no worker start, provider call,
migration, credential change or flag flip.


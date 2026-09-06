# Migrations 008–009: secure approval validation

The original 008 could accept fabricated approvals from callback-owned temporary
tables: function-level `search_path=public` implicitly searched temporary
relations first. This fix secures name resolution and isolates the owner without
changing V1 data, schema ACLs, credentials or feature flags.

## Evidence and migration strategy

Original source: `c08bfa89ec579744f85aff4d3886c2d81d57202c`.
Original migration SHA256:
`3c3ac38e02cfc1c85205b6835587178015de3ffa16b07ab9d32a9947c9e4289b`.
The exploit was reproduced on disposable PostgreSQL 16.3 and 18.3 PGlite engines:
no genuine approval, four temporary shadow tables, result accepted. The patched
migration rejects the same fixture with callback TEMP still granted. These are
PostgreSQL WASM engines; native multi-connection locking is covered separately
by the existing PostgreSQL 16 CI suite.

Migration strategy: **PATCH_008_PLUS_009**. Nadir confirmed that the vulnerable
008 was applied in at least one persistent environment outside production.
Production remains confirmed at schema prefix 007, with 008 not applied and
PR43 not deployed. No persistent database was accessed or modified by this fix.

Fresh installations apply corrected 008 followed by 009. Existing original008
installations apply 009 directly: never replay 008, drop the function or install
the vulnerable fixture. Existing secure008 installations also accept 009.
`009_v2_secure_approval_repair.sql` uses CREATE OR REPLACE to retain the exact
function signature, OID and dependent objects, and leaves approval data intact.

## Privilege boundary

Signature: `public.mission_execution_approval_valid(uuid,uuid,text,text,text)`.
The application schema is frozen during installation; native isolated tests use
an allowlisted `v2_*` schema. The installed SECURITY DEFINER function fixes
`search_path=pg_catalog, pg_temp`. All four tables are qualified:
`mission_approval_bindings`, `agent_actions`, `agent_approvals`, `mission_attempts`.
It references no application sequence/type or `agent_missions`. Clock calls,
types and comparison operators use `pg_catalog`. Runtime SQL is static;
installation formatting accepts no callback-supplied identifier.

Owner `agentimpact_approval_validator` is NOLOGIN, without superuser, database
creation, role creation, inheritance, replication or RLS bypass. Memberships
in either direction are rejected. It receives schema USAGE and SELECT on the
four tables. UPDATE on only the `id` column of actions/approvals is necessary
for PostgreSQL row locking; the function does not update rows. The callback
receives no such UPDATE grant and cannot become the owner. Row locks remain
until transaction end, and expiration is checked again after lock acquisition.

Creation, owner transfer, PUBLIC/default EXECUTE revocation and callback grant
share one transaction. Only the owner and `agentimpact_codex_control` have
explicit EXECUTE. Database administrators retain their inherent authority.
Installation requires a trusted DBA, who does not own the installed function.
009 removes historic callback grant options and delegated EXECUTE grants too.
Its CASCADE operations apply only to function grants, never tables or objects.

The migration rejects callback schema CREATE and unexpected CREATE ACLs instead
of globally revoking privileges that V1 might use. TEMP restriction is secondary
and not included: PUBLIC database grants and service usage would require a
separate inventory. Tests deliberately grant callback TEMP.

## Read-only operator inventory

Run in each known persistent database through an existing authorized DBA
session. Record the environment and catalog output, never credentials or
approval payloads. Zero rows proves absence only in the inspected database.

```sql
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
       pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
       p.proacl, pg_get_functiondef(p.oid)
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
WHERE p.proname='mission_execution_approval_valid';

SELECT has_schema_privilege('agentimpact_codex_control','public','CREATE'),
       has_database_privilege('agentimpact_codex_control',current_database(),'TEMP');
```

An existing unsafe definition selects 009, after operator review and separate
deployment authorization. Never drop the function or replay 008. Fresh 008
rejects a pre-existing owner. 009 reuses it only if it owns this exact function,
has no forbidden attributes/memberships, and has no direct rights or owned
objects outside the validator scope. Unexpected column/table/schema grants,
grant options or cross-database dependencies cause refusal and DBA inventory.

## Future installation and second passage

This PR authorizes no deployment. After separate merge/deployment authorization,
verify the source SHA, complete 004–007 schema and corrected 007 writer index;
keep flags OFF and worker/publisher inactive; create and verify database/file
backups. Use the existing protected DBA connection, `ON_ERROR_STOP` and a trusted
application schema. Never install with callback-controlled session settings.

Verify the entire installed body against the reviewed source, `prosecdef`,
`proconfig`, owner, memberships, table/column grants and function ACLs. Run
substitution tests only in disposable databases. This mission authorizes no
offensive production test.

008 is one-shot. A repeat refuses with SQLSTATE 55000 and message
`migration_008_already_present_requires_inventory`; roll back the failed
transaction. An operator runner must detect and verify the complete installed
definition and privileges, then skip a correct installation. A matching name
or schema prefix is insufficient. Do not mask partial application with
`IF NOT EXISTS`. On mismatch keep flags OFF and stop for review.

009 requires the exact existing five-argument function and rejects missing or
ambiguous overloads. It is repeatable: replacement reinstalls the same secure
body, owner and ACL while retaining the OID and data. The operator still checks
catalog state before execution; an unknown owner/privilege state is not silently
repaired. All DDL and grant changes are in one transaction. A failure requires
ROLLBACK and review, with no attempt to revive the insecure definition.

Functional rollback keeps all V2/Codex flags OFF and restores previously verified
application artifacts if needed. Keep the secure function; never restore the
vulnerable definition, delete approvals or blindly reverse grants. Database
repair requires its own reviewed procedure.

## Regression coverage

`secure-approval.test.ts` runs both pinned engines: exact four-table exploit,
each shadow relation, hostile caller search paths/clocks, genuine and missing
approvals, tampered/expired/rejected bindings, wrong role, schema CREATE denial,
actual callback claim/start, forbidden owner role switch, installer default ACL
cleanup, installed catalog/body verification and one-shot rollback.
Fixtures use synthetic approvals and fake budgets. No real worker, provider,
publisher or production database is invoked.

The same security matrix runs on three paths per engine: fresh secure008,
original008 followed by 009, and secure008 followed by 009. The historical test
fixture is pinned to the original commit and is never an installation migration.
Repair tests prove the exploit before repair and refusal afterward, preservation
of genuine approval rows, function OID and a dependent view, cleanup of delegated
EXECUTE, repeated 009 stability, missing008 rejection, and transactional refusal
of owner privilege drift. Installed bodies must equal the corrected008 body.

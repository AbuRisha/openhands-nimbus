# Row-level security in the OPENHANDS database

**There are two databases and this file describes one of them.** Naming which
is not pedantry: the same query returns opposite answers, and a correction
carried across would replace a true statement with a false one.

| | **this file** — openhands | **Nimbus business DB** |
|---|---|---|
| where | inside the container, Azure | OVH box, `15.204.252.63` |
| role | `nimbusadmin` | `nimbus` |
| `rolsuper` | **False** | **True** |
| `rolbypassrls` | True | True |
| public tables | **9** | **75** |

`SELECT ... WHERE rolname='nimbusadmin'` against the Nimbus DB returns no rows —
the role does not exist there. The table count is the quickest tell that you are
looking at the wrong system.

The two also have OPPOSITE hazards, from the same pair of facts. Here, every
application role still has `BYPASSRLS`, so a policy written today does nothing
until the flag drops — safe, and inert. On the Nimbus side the flag half is
already done (`nimbus_app`, `nimbus_gw`, `nimbus_proxy_ovh` are all
`NOSUPERUSER NOBYPASSRLS`, demonstrated with a live policy: `nimbus` saw 2 rows,
`nimbus_app` saw 1), so a policy takes effect **immediately** and a careless
`ENABLE ROW LEVEL SECURITY` on a customer table starts denying reads to the live
site the moment it lands.

## What dominates the estimate on BOTH sides

Setting the tenant key per connection when the app uses a **pool**.
`SET app.current_customer` is session-scoped, so a value set for one request
leaks into the next request that borrows the same connection — wrong tenant,
silently, with no error to notice. It has to be `SET LOCAL` inside a
transaction, which means every query path must run in one. That constraint, not
the policies, is the work.

## The openhands measurement

Run against production from inside the running container on 2026-08-08, so the
credentials never left it:

    az containerapp exec -n openhands-nimbus -g nimbus-ai-swedencentral \
      --revision <active> --command "python -c \"...\" <base64>"

## What came back

    IDENTITY            {'current_user': 'nimbusadmin', 'rolsuper': False,
                         'rolbypassrls': True, 'rolcreaterole': True}
    PUBLIC_TABLES       9
    RLS_ENABLED_TABLES  0
    POLICIES            0

## What that changes

**`rolbypassrls = true` is confirmed.** It had been passed around as established
fact while nobody had run the query; it holds.

**`rolsuper` is FALSE.** Anything describing this connection as "superuser" is
wrong. `nimbusadmin` has `BYPASSRLS` and `CREATEROLE`, which is a different and
narrower thing — it matters because advice aimed at a superuser (and worry aimed
at one) does not apply.

**RLS is not configured at all — 0 tables with `rowsecurity`, 0 policies.** This
is the part that changes the work. The natural reading of "our role bypasses
RLS" is that policies exist and this role steps around them, so the fix is to
stop bypassing. That is not the situation. There is nothing to bypass. The
`BYPASSRLS` flag is currently moot, and would only start mattering the moment
someone writes the first policy.

So enabling per-tenant isolation is not "drop BYPASSRLS from the role". It is:
write policies for 9 tables from scratch, decide the tenant key and how it is
set per connection, and *then* drop `BYPASSRLS` — because until that flag goes,
the app's own role will ignore every policy written. A change that removes the
flag first, or writes policies first and calls it done, produces confident
isolation that does not isolate.

## Re-run it rather than cite it

Nine tables and zero policies is a fact with a date on it. The command is above;
it takes seconds.

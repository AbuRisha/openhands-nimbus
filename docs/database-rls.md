# Row-level security: measured, not assumed

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

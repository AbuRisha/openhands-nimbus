"""Applied by the interpreter before any application code runs.

Python imports ``sitecustomize`` automatically at startup when it is importable,
which is the only hook that reaches the AGENT SERVER — a separate process
spawned as ``python -m ...`` that imports the SDK rather than our application.
Both repairs below (model capabilities, nudge cap) must land in that process.

GATED ON AN ENV VAR, AND THAT IS NOT OPTIONAL
---------------------------------------------
Being on PYTHONPATH means EVERY interpreter start in the image runs this —
health probes, CLI tools, one-off scripts, anything. The first version imported
litellm and the SDK unconditionally, which is hundreds of milliseconds and a
large import graph, and Azure's default startup probe began failing immediately
and continuously (revision 0000054, "Probe of StartUp failed with status code:
1", hundreds of consecutive failures) while the app itself still served traffic.

So the work only runs when NIMBUS_AGENT_BOOTSTRAP is set, which
process_sandbox_service sets on the agent-server child and nothing else does.
Every other interpreter start pays one os.environ lookup and exits this file.

Each step keeps its own try block: a failure in capability registration must not
disable the nudge cap, or vice versa. Both swallow exceptions because a raise
here would break interpreter start across the whole image — turning a missing
capability flag into a total outage.
"""

import os

# Prove the hook ran, in a way that does not depend on logging.
#
# sitecustomize executes BEFORE the application configures logging, so a
# logger.info() here is dropped by Python's lastResort handler (WARNING and
# above only) whether or not this file executed. That made "no log line" look
# like "never ran" — an absence of evidence that reads exactly like evidence of
# absence, and it nearly cost a fourth wrong diagnosis.
#
# stderr is unconditional and lands in container logs, and a file marker
# survives for inspection. Both are cheap and run once per process.
def _nimbus_mark(status: str) -> None:
    import sys

    try:
        print(f'NIMBUS_BOOTSTRAP {status}', file=sys.stderr, flush=True)
    except Exception:
        pass
    try:
        with open('/tmp/nimbus_bootstrap.log', 'a', encoding='utf-8') as fh:
            fh.write(status + '\n')
    except Exception:
        pass


if not os.environ.get("NIMBUS_AGENT_BOOTSTRAP"):
    _nimbus_mark('skipped:flag-not-set')
else:
    _nimbus_mark('start')
    try:
        from nimbus_model_caps import register_nimbus_model_caps

        _nimbus_mark(f'vision:{register_nimbus_model_caps()}')
    except Exception as e:  # noqa: BLE001 - never break interpreter start
        _nimbus_mark(f'vision:FAILED:{type(e).__name__}')

    try:
        from nimbus_nudge_cap import install_nudge_cap

        _nimbus_mark(f'nudge:{install_nudge_cap()}')
    except Exception as e:  # noqa: BLE001
        _nimbus_mark(f'nudge:FAILED:{type(e).__name__}')

    try:
        # Separate try for the same reason as the others: these are unrelated
        # repairs sharing the only hook that reaches the agent process.
        from nimbus_provider_fallback import install_provider_fallback

        _nimbus_mark(f'provider:{install_provider_fallback()}')
    except Exception as e:  # noqa: BLE001
        _nimbus_mark(f'provider:FAILED:{type(e).__name__}')

    try:
        # Must run in THIS process: cost is computed by the agent's Telemetry
        # when the response comes back, and only reaches the app server as an
        # already-summed number on the metrics snapshot.
        from nimbus_gateway_cost import install_gateway_cost

        _nimbus_mark(f'cost:{install_gateway_cost()}')
    except Exception as e:  # noqa: BLE001
        _nimbus_mark(f'cost:FAILED:{type(e).__name__}')

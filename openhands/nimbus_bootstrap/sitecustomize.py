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

if os.environ.get("NIMBUS_AGENT_BOOTSTRAP"):
    try:
        from nimbus_model_caps import register_nimbus_model_caps

        register_nimbus_model_caps()
    except Exception:  # noqa: BLE001 - never break interpreter start
        pass

    try:
        from nimbus_nudge_cap import install_nudge_cap

        install_nudge_cap()
    except Exception:  # noqa: BLE001
        pass

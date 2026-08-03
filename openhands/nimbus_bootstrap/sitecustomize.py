"""Applied by the interpreter before any application code runs.

Python imports ``sitecustomize`` automatically at startup when it is importable,
which is the only hook that reaches the AGENT SERVER — a separate process
spawned as ``python -m ...`` that imports the SDK rather than our application.
The vision capability check lives in that process, so registering model
capabilities anywhere in the app server would have no effect on it.

Deliberately does almost nothing: one dict update against litellm's in-memory
registry, no network, no I/O. Anything slower or more fragile does not belong in
a hook that every Python process in the image pays for.

Wrapped so it can never raise. A failure here would break every interpreter
start in the image — turning a missing capability flag into a total outage.
"""

try:
    from nimbus_model_caps import register_nimbus_model_caps

    register_nimbus_model_caps()
except Exception:  # noqa: BLE001 - see the docstring; never break interpreter start
    pass

try:
    # Separate try: a failure to register model capabilities must not also
    # disable the nudge cap, and vice versa. They are unrelated repairs that
    # happen to share the only hook that reaches the agent process.
    from nimbus_nudge_cap import install_nudge_cap

    install_nudge_cap()
except Exception:  # noqa: BLE001
    pass

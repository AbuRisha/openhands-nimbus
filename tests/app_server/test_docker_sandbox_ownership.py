"""Docker sandboxes had no owner at all, so listing could not be scoped.

The other two sandbox backends record an owner and merely failed to filter on
it. Docker was a step behind: `created_by_user_id` was hardcoded None, the
labels carried only `sandbox_spec_id`, and the container name is
f'{prefix}{sandbox_id}'. `search_sandboxes` filtered on that name prefix alone
and returned every container on the host — each carrying the `session_api_key`
that `validate_session_key` accepts and the agent proxy routes on.

WHY THE OTHER FIX COULD NOT BE PORTED. `process_sandbox_service` scopes with
`process_info.user_id == self.user_id`. With the left side hardcoded None,
that comparison is False for every authenticated caller, so copying it would
have hidden every container from everyone. Ownership had to be RECORDED before
it could be filtered — which is why this is a label, not a one-line predicate.

Latent, not live: `config.py:353` selects Docker in the bare `else`, and
production runs `RUNTIME=process`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException

from openhands.app_server.sandbox import docker_sandbox_service as mod
from openhands.app_server.sandbox.sandbox_models import SandboxInfo, SandboxStatus
from openhands.app_server.user.specifiy_user_context import ADMIN


class _Ctx:
    def __init__(self, user_id=None):
        self._user_id = user_id

    async def get_user_id(self):
        return self._user_id


class _Container:
    """Only what the code under test reads."""

    def __init__(self, name, owner=None, created_at=0):
        self.name = name
        self.created_at = created_at
        labels = {'sandbox_spec_id': 'img:1'}
        if owner is not None:
            labels[mod.OWNER_LABEL] = owner
        self.attrs = {'Config': {'Labels': labels}}


class _Docker:
    def __init__(self, containers):
        self._containers = containers

    @property
    def containers(self):
        return self

    def list(self, all=True):  # noqa: A002 - docker's own kwarg name
        return self._containers


def _info(container) -> SandboxInfo:
    """A real SandboxInfo — SandboxPage validates its items, so a duck-typed
    stand-in passes the filter under test and then fails at the boundary."""
    return SandboxInfo(
        id=container.name,
        created_by_user_id=mod._owner_of(container),
        sandbox_spec_id='img:1',
        status=SandboxStatus.RUNNING,
        session_api_key='sk-test',
        exposed_urls=[],
        created_at=datetime(2026, 1, 1, tzinfo=UTC)
        + timedelta(seconds=container.created_at),
    )


class _Svc:
    """Binds the real method; stubs only what it touches."""

    search_sandboxes = mod.DockerSandboxService.search_sandboxes

    def __init__(self, ctx, containers):
        self.user_context = ctx
        self.docker_client = _Docker(containers)
        self.container_name_prefix = 'oh-agent-server-'

    async def _container_to_checked_sandbox_info(self, container):
        return _info(container)


def _c(name, owner=None):
    return _Container(f'oh-agent-server-{name}', owner=owner)


class TestOwnerLabel:
    def test_the_owner_is_recorded_at_create(self):
        labels = mod._labels_for('img:1', 'cust-1')

        assert labels[mod.OWNER_LABEL] == 'cust-1'
        assert labels['sandbox_spec_id'] == 'img:1'

    def test_no_owner_means_no_label_rather_than_an_empty_one(self):
        """'' would be a real value every unowned container shares."""
        labels = mod._labels_for('img:1', None)

        assert mod.OWNER_LABEL not in labels

    def test_an_empty_owner_is_also_omitted(self):
        assert mod.OWNER_LABEL not in mod._labels_for('img:1', '')

    def test_the_owner_reads_back(self):
        assert mod._owner_of(_c('a', owner='cust-1')) == 'cust-1'

    def test_a_container_from_before_labels_reads_as_unknown(self):
        """None means "we do not know", never "nobody"."""
        assert mod._owner_of(_c('a')) is None

    def test_a_container_with_no_attrs_does_not_explode(self):
        broken = _c('a')
        broken.attrs = None

        assert mod._owner_of(broken) is None


class TestListingIsScoped:
    @pytest.mark.asyncio
    async def test_only_your_own_containers_are_returned(self, monkeypatch):
        monkeypatch.setattr(mod, 'auth_required', lambda: True)
        svc = _Svc(
            _Ctx('cust-1'),
            [_c('a', owner='cust-1'), _c('b', owner='cust-2')],
        )

        page = await svc.search_sandboxes()

        assert [i.id for i in page.items] == ['oh-agent-server-a']

    @pytest.mark.asyncio
    async def test_containers_from_before_labels_are_excluded(self, monkeypatch):
        """The migration decision, stated as a test.

        An unlabelled container has an unknown owner, and unknown is not
        "yours". Excluding them changes what an existing local docker setup
        sees; showing them keeps the leak. This pins which way that went.
        """
        monkeypatch.setattr(mod, 'auth_required', lambda: True)
        svc = _Svc(_Ctx('cust-1'), [_c('old'), _c('new', owner='cust-1')])

        page = await svc.search_sandboxes()

        assert [i.id for i in page.items] == ['oh-agent-server-new']

    @pytest.mark.asyncio
    async def test_containers_outside_the_prefix_are_still_ignored(
        self, monkeypatch
    ):
        # The pre-existing behaviour must survive the new filter.
        monkeypatch.setattr(mod, 'auth_required', lambda: True)
        other = _Container('some-unrelated-container', owner='cust-1')
        svc = _Svc(_Ctx('cust-1'), [other, _c('a', owner='cust-1')])

        page = await svc.search_sandboxes()

        assert [i.id for i in page.items] == ['oh-agent-server-a']


class TestAbsentIdentity:
    @pytest.mark.asyncio
    async def test_refuses_when_identity_is_absent_and_auth_is_required(
        self, monkeypatch
    ):
        monkeypatch.setattr(mod, 'auth_required', lambda: True)
        svc = _Svc(_Ctx(None), [_c('a', owner='cust-1')])

        with pytest.raises(HTTPException) as excinfo:
            await svc.search_sandboxes()

        assert excinfo.value.status_code == 401

    @pytest.mark.asyncio
    async def test_an_elevated_context_lists_across_customers(self, monkeypatch):
        """Webhooks and validate_session_key legitimately span tenants.

        Refusing here — or scoping to ADMIN's own None — breaks every callback
        in the product, which is how a fail-closed change gets reverted.
        """
        monkeypatch.setattr(mod, 'auth_required', lambda: True)
        svc = _Svc(ADMIN, [_c('a', owner='cust-1'), _c('b', owner='cust-2')])

        page = await svc.search_sandboxes()

        assert len(page.items) == 2

    @pytest.mark.asyncio
    async def test_OSS_KEEPS_WORKING_when_auth_is_not_required(self, monkeypatch):
        """DefaultUserAuth returns None for every caller by design.

        If this fails, the fix has become an outage for every deployment that
        never opted into Nimbus auth.
        """
        monkeypatch.setattr(mod, 'auth_required', lambda: False)
        svc = _Svc(_Ctx(None), [_c('a'), _c('b', owner='cust-2')])

        page = await svc.search_sandboxes()

        assert len(page.items) == 2

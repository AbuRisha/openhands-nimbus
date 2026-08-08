"""image_generate / video_generate, with the network replaced by a recorder.

Nothing here touches api.nimbusapi.net. Every test installs a fake
``httpx.Client`` that records what the tool would have sent and hands back a
canned response, because the things most likely to break are the request shape
(a wrong host or a missing field is a 400 that reads like an outage) and the
failure path (a tool that raises kills the turn it was called in).

The registration test is the one that catches the expensive mistake. A tool
whose name is not in the registry at conversation start is silently absent — the
app server skips it, the agent never sees it, and nothing logs an error.
"""

from __future__ import annotations

import base64
import json
from types import SimpleNamespace

import httpx
import pytest

from openhands.nimbus_bootstrap import nimbus_media_tools as media
from openhands.sdk import ImageContent, TextContent

PNG_BYTES = b'\x89PNG\r\n\x1a\n-not-a-real-png-but-real-bytes'
MP4_BYTES = b'\x00\x00\x00 ftypisom-not-a-real-mp4'
PNG_B64 = base64.b64encode(PNG_BYTES).decode()
MP4_B64 = base64.b64encode(MP4_BYTES).decode()

KEY = 'sk-nim-live-testkey'
BASE = 'https://api.nimbusapi.net'


class _FakeResponse:
    """Just enough of httpx.Response for _post_media."""

    def __init__(self, status_code: int, payload=None, text: str | None = None):
        self.status_code = status_code
        self._payload = payload
        self.text = text if text is not None else json.dumps(payload)

    def json(self):
        if self._payload is None:
            # httpx raises a JSONDecodeError, which is a ValueError.
            raise ValueError('not json')
        return self._payload


class _Recorder:
    """Stands in for httpx.Client and keeps every request it was handed."""

    def __init__(self):
        self.calls: list[dict] = []
        self.responses: list = []
        self.raises: BaseException | None = None

    def install(self, monkeypatch):
        recorder = self

        class _Client:
            def __init__(self, timeout=None, **kwargs):
                self.timeout = timeout

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def post(self, url, headers=None, json=None):
                recorder.calls.append(
                    {
                        'url': url,
                        'headers': headers or {},
                        'body': json or {},
                        'timeout': self.timeout,
                    }
                )
                if recorder.raises is not None:
                    raise recorder.raises
                return recorder.responses.pop(0)

        monkeypatch.setattr(media.httpx, 'Client', _Client)
        return self

    @property
    def only_call(self) -> dict:
        assert len(self.calls) == 1, f'expected exactly one request, got {self.calls}'
        return self.calls[0]


@pytest.fixture
def http(monkeypatch) -> _Recorder:
    return _Recorder().install(monkeypatch)


@pytest.fixture
def image_executor(tmp_path) -> media.ImageGenerateExecutor:
    return media.ImageGenerateExecutor(
        base_url=BASE, api_key=KEY, working_dir=str(tmp_path)
    )


@pytest.fixture
def video_executor(tmp_path) -> media.VideoGenerateExecutor:
    return media.VideoGenerateExecutor(
        base_url=BASE, api_key=KEY, working_dir=str(tmp_path)
    )


def _conv_state(tmp_path, base_url: str = BASE, api_key: str = KEY):
    """The two attributes create() actually reads off the conversation."""
    return SimpleNamespace(
        agent=SimpleNamespace(llm=SimpleNamespace(base_url=base_url, api_key=api_key)),
        workspace=SimpleNamespace(working_dir=str(tmp_path)),
    )


# --------------------------------------------------------------------------- #
# registration
# --------------------------------------------------------------------------- #


def test_both_tools_are_registered():
    """Naming an unregistered tool is a silent no-op, so assert the names."""
    from openhands.sdk.tool import list_registered_tools

    registered = list_registered_tools()
    assert 'image_generate' in registered
    assert 'video_generate' in registered


def test_tool_names_are_pinned():
    """The app server wires these literals in; a rename must fail loudly here."""
    assert media.ImageGenerateTool.name == 'image_generate'
    assert media.VideoGenerateTool.name == 'video_generate'


def test_registration_is_idempotent():
    """Two entry points register these: module import, and sitecustomize.

    Registering the same name twice logs a duplicate warning today and the SDK's
    own TODO says it will eventually raise.
    """
    from openhands.sdk.tool import list_registered_tools

    before = list_registered_tools().count('image_generate')
    media.register_nimbus_media_tools()
    assert list_registered_tools().count('image_generate') == before


def test_the_llm_sees_a_valid_tool_schema(tmp_path):
    tool = media.VideoGenerateTool.create(conv_state=_conv_state(tmp_path))[0]
    schema = tool.to_openai_tool()
    assert schema['function']['name'] == 'video_generate'
    assert schema['function']['parameters']['required'] == ['prompt']
    assert 'duration_seconds' in schema['function']['parameters']['properties']


@pytest.mark.parametrize(
    'observation',
    [
        media.ImageGenerateObservation(
            content=[
                TextContent(text='ok'),
                ImageContent(image_urls=['data:image/png;base64,AAA']),
            ],
            model='gemini-3.1-flash-image',
            file_paths=['/workspace/.nimbus-media/image-1.png'],
        ),
        media.VideoGenerateObservation(
            content=[TextContent(text='ok')],
            model='veo-3-fast-720p',
            file_path='/workspace/.nimbus-media/video-1.mp4',
            duration_seconds=4,
        ),
    ],
    ids=['image', 'video'],
)
def test_observations_survive_the_webhook_round_trip(observation):
    """The child posts events to the app server, which re-validates them.

    ``kind`` is the bare class name, so a class the app server has never defined
    cannot be validated — which is why it imports this module too.
    """
    from openhands.sdk.tool import Observation

    dumped = json.loads(json.dumps(observation.model_dump()))
    assert dumped['kind'] == type(observation).__name__

    restored = Observation.model_validate(dumped)
    assert type(restored) is type(observation)
    assert restored.model == observation.model


def test_create_builds_an_executable_tool(tmp_path):
    tools = media.ImageGenerateTool.create(conv_state=_conv_state(tmp_path))
    assert len(tools) == 1
    tool = tools[0]
    assert tool.executor is not None
    assert tool.action_type is media.ImageGenerateAction
    assert tool.observation_type is media.ImageGenerateObservation


def test_create_survives_a_conversation_with_no_key(tmp_path, http):
    """create() runs while the conversation is being built.

    Raising there fails the whole conversation, so a missing key has to surface
    at call time as an ordinary tool error instead.
    """
    tools = media.ImageGenerateTool.create(
        conv_state=_conv_state(tmp_path, api_key=None)
    )
    observation = tools[0].executor(media.ImageGenerateAction(prompt='a cat'))
    assert observation.is_error
    assert 'no Nimbus API key' in observation.text
    assert http.calls == []


# --------------------------------------------------------------------------- #
# image_generate — request shape
# --------------------------------------------------------------------------- #


def test_image_request_shape(http, image_executor):
    http.responses.append(
        _FakeResponse(200, {'created': 1, 'data': [{'b64_json': PNG_B64}]})
    )

    image_executor(media.ImageGenerateAction(prompt='  a red bicycle  ', n=2))

    call = http.only_call
    assert call['url'] == 'https://api.nimbusapi.net/v1/images/generations'
    assert call['headers']['Authorization'] == f'Bearer {KEY}'
    assert call['headers']['Content-Type'] == 'application/json'
    assert call['body'] == {
        'model': 'gemini-3.1-flash-image',
        'prompt': 'a red bicycle',
        'n': 2,
        'response_format': 'url',
    }


def test_image_size_is_only_sent_when_asked_for(http, image_executor):
    http.responses.append(_FakeResponse(200, {'data': [{'b64_json': PNG_B64}]}))
    image_executor(media.ImageGenerateAction(prompt='x', size='1024x1024'))
    assert http.only_call['body']['size'] == '1024x1024'


def test_image_model_prefix_is_stripped(http, image_executor):
    """The catalog shows google/… ; the gateway wants the bare alias."""
    http.responses.append(_FakeResponse(200, {'data': [{'b64_json': PNG_B64}]}))
    image_executor(
        media.ImageGenerateAction(prompt='x', model='google/gemini-3.1-flash-image')
    )
    assert http.only_call['body']['model'] == 'gemini-3.1-flash-image'


def test_base_url_with_v1_suffix_is_not_doubled(tmp_path):
    """The deployment has moved between the bare origin and a /v1 suffix."""
    llm = SimpleNamespace(base_url='https://api.nimbusapi.net/v1/', api_key=KEY)
    assert media._base_url(llm) == 'https://api.nimbusapi.net'


def test_base_url_falls_back_to_the_measured_host(monkeypatch):
    monkeypatch.delenv('NIMBUS_API_BASE_URL', raising=False)
    monkeypatch.delenv('LLM_BASE_URL', raising=False)
    llm = SimpleNamespace(base_url=None, api_key=KEY)
    assert media._base_url(llm) == 'https://api.nimbusapi.net'


# --------------------------------------------------------------------------- #
# image_generate — success
# --------------------------------------------------------------------------- #


def test_image_success_writes_the_file_and_renders_inline(
    http, image_executor, tmp_path
):
    http.responses.append(
        _FakeResponse(200, {'created': 1, 'data': [{'b64_json': PNG_B64}]})
    )

    observation = image_executor(media.ImageGenerateAction(prompt='a red bicycle'))

    assert not observation.is_error
    assert observation.model == 'gemini-3.1-flash-image'
    assert len(observation.file_paths) == 1

    written = tmp_path / '.nimbus-media'
    files = list(written.iterdir())
    assert len(files) == 1
    assert files[0].suffix == '.png'
    assert files[0].read_bytes() == PNG_BYTES

    images = [c for c in observation.content if isinstance(c, ImageContent)]
    assert len(images) == 1
    assert images[0].image_urls[0] == f'data:image/png;base64,{PNG_B64}'
    assert 'a red bicycle' in observation.text


def test_image_hosted_url_is_passed_through_without_a_local_copy(
    http, image_executor, tmp_path
):
    http.responses.append(
        _FakeResponse(200, {'data': [{'url': 'https://cdn.example/a.png'}]})
    )

    observation = image_executor(media.ImageGenerateAction(prompt='x'))

    assert not observation.is_error
    assert observation.file_paths == []
    images = [c for c in observation.content if isinstance(c, ImageContent)]
    assert images[0].image_urls == ['https://cdn.example/a.png']
    assert not (tmp_path / '.nimbus-media').exists()


def test_image_data_uri_payload_is_stripped_before_decoding(
    http, image_executor, tmp_path
):
    """Some paths return a full data: URI where the contract says bare base64."""
    http.responses.append(
        _FakeResponse(
            200, {'data': [{'b64_json': f'data:image/webp;base64,{PNG_B64}'}]}
        )
    )

    observation = image_executor(media.ImageGenerateAction(prompt='x'))

    assert not observation.is_error
    written = next((tmp_path / '.nimbus-media').iterdir())
    assert written.suffix == '.webp'
    assert written.read_bytes() == PNG_BYTES


def test_image_is_not_replayed_to_the_model(http, image_executor):
    """A non-vision model 400s on an image block, failing the whole turn.

    The image stays in ``content`` for the UI; only text goes back to the LLM.
    """
    http.responses.append(_FakeResponse(200, {'data': [{'b64_json': PNG_B64}]}))

    observation = image_executor(media.ImageGenerateAction(prompt='x'))

    assert any(isinstance(c, ImageContent) for c in observation.content)
    assert all(isinstance(c, TextContent) for c in observation.to_llm_content)


# --------------------------------------------------------------------------- #
# image_generate — failure
# --------------------------------------------------------------------------- #


def test_image_upstream_error_is_returned_not_raised(http, image_executor):
    http.responses.append(
        _FakeResponse(
            402,
            {'error': {'message': 'insufficient_balance', 'type': 'billing'}},
        )
    )

    observation = image_executor(media.ImageGenerateAction(prompt='x'))

    assert observation.is_error
    assert 'HTTP 402' in observation.text
    assert 'insufficient_balance' in observation.text


def test_image_200_with_an_error_body_is_a_failure(http, image_executor):
    """The gateway's own billing guard rejects these too; status is not enough."""
    http.responses.append(
        _FakeResponse(200, {'error': {'message': 'model_not_allowed'}})
    )

    observation = image_executor(media.ImageGenerateAction(prompt='x'))

    assert observation.is_error
    assert 'model_not_allowed' in observation.text


def test_image_unknown_model_never_reaches_the_network(http, image_executor):
    """Unknown ids do not 404 upstream — they fall through to a routing error."""
    observation = image_executor(
        media.ImageGenerateAction(prompt='x', model='dall-e-9')
    )

    assert observation.is_error
    assert 'dall-e-9' in observation.text
    assert 'gemini-3.1-flash-image' in observation.text
    assert http.calls == []


def test_image_empty_prompt_never_reaches_the_network(http, image_executor):
    observation = image_executor(media.ImageGenerateAction(prompt='   '))
    assert observation.is_error
    assert 'prompt is empty' in observation.text
    assert http.calls == []


def test_image_timeout_says_it_may_still_have_been_billed(http, image_executor):
    """A client that gives up early is still charged; the agent must know."""
    http.raises = httpx.ConnectTimeout('too slow')

    observation = image_executor(media.ImageGenerateAction(prompt='x'))

    assert observation.is_error
    assert 'timed out' in observation.text
    assert 'billed' in observation.text


def test_image_empty_data_array_is_a_failure(http, image_executor):
    http.responses.append(_FakeResponse(200, {'created': 1, 'data': []}))
    observation = image_executor(media.ImageGenerateAction(prompt='x'))
    assert observation.is_error
    assert 'no images' in observation.text


def test_image_non_json_body_is_a_failure(http, image_executor):
    http.responses.append(_FakeResponse(200, None, text='<html>502</html>'))
    observation = image_executor(media.ImageGenerateAction(prompt='x'))
    assert observation.is_error
    assert 'non-JSON' in observation.text


# --------------------------------------------------------------------------- #
# video_generate
# --------------------------------------------------------------------------- #


def test_video_request_shape(http, video_executor):
    http.responses.append(
        _FakeResponse(200, {'data': [{'b64_json': MP4_B64, 'mime_type': 'video/mp4'}]})
    )

    video_executor(
        media.VideoGenerateAction(
            prompt='a drone shot',
            model='google/veo-3-fast-720p',
            duration_seconds=6,
            aspect_ratio='9:16',
        )
    )

    call = http.only_call
    assert call['url'] == 'https://api.nimbusapi.net/v1/videos/generations'
    assert call['headers']['Authorization'] == f'Bearer {KEY}'
    assert call['body'] == {
        'model': 'veo-3-fast-720p',
        'prompt': 'a drone shot',
        'duration_seconds': 6,
        'aspect_ratio': '9:16',
    }


def test_video_client_timeout_clears_the_upstream_deadline(http, video_executor):
    """Routing entries carry primary_timeout_ms=210000; give up later, not sooner."""
    http.responses.append(_FakeResponse(200, {'data': [{'b64_json': MP4_B64}]}))
    video_executor(media.VideoGenerateAction(prompt='x'))
    assert http.only_call['timeout'].read >= 210.0


def test_video_success_writes_the_mp4_and_reports_the_path(
    http, video_executor, tmp_path
):
    http.responses.append(
        _FakeResponse(
            200,
            {
                'data': [
                    {
                        'b64_json': MP4_B64,
                        'mime_type': 'video/mp4',
                        'resolution': '720p',
                        'duration_seconds': 4,
                    }
                ],
                'usage': {'video_seconds': 4},
            },
        )
    )

    observation = video_executor(media.VideoGenerateAction(prompt='a drone shot'))

    assert not observation.is_error
    assert observation.model == 'veo-3-fast-720p'
    assert observation.duration_seconds == 4
    assert observation.file_path is not None

    written = next((tmp_path / '.nimbus-media').iterdir())
    assert written.suffix == '.mp4'
    assert written.read_bytes() == MP4_BYTES
    assert str(written) in observation.text


def test_video_never_inlines_the_mp4(http, video_executor):
    """Multi-MB base64 on the event log, the socket frame and every replay."""
    http.responses.append(_FakeResponse(200, {'data': [{'b64_json': MP4_B64}]}))

    observation = video_executor(media.VideoGenerateAction(prompt='x'))

    assert all(isinstance(c, TextContent) for c in observation.content)
    assert MP4_B64 not in observation.text


def test_video_missing_usage_is_not_a_failure(http, video_executor):
    """veo-3.1-fast-720p returned 200 with no quantity at all on 2026-08-01."""
    http.responses.append(_FakeResponse(200, {'data': [{'b64_json': MP4_B64}]}))

    observation = video_executor(
        media.VideoGenerateAction(prompt='x', duration_seconds=8)
    )

    assert not observation.is_error
    assert observation.duration_seconds == 8


def test_video_operation_id_is_reported_rather_than_polled(http, video_executor):
    """Every model that answers with an operation id is 404 upstream.

    This tool is synchronous-only, so an op id means the contract changed —
    name it instead of silently polling an endpoint nobody has ever parsed.
    """
    http.responses.append(_FakeResponse(200, {'id': 'op_abc123', 'status': 'running'}))

    observation = video_executor(media.VideoGenerateAction(prompt='x'))

    assert observation.is_error
    assert 'op_abc123' in observation.text
    assert 'synchronous' in observation.text


def test_video_bad_duration_never_reaches_the_network(http, video_executor):
    observation = video_executor(
        media.VideoGenerateAction(prompt='x', duration_seconds=5)
    )
    assert observation.is_error
    assert 'duration_seconds' in observation.text
    assert http.calls == []


def test_video_bad_aspect_ratio_never_reaches_the_network(http, video_executor):
    observation = video_executor(
        media.VideoGenerateAction(prompt='x', aspect_ratio='1:1')
    )
    assert observation.is_error
    assert 'aspect_ratio' in observation.text
    assert http.calls == []


def test_video_unknown_model_never_reaches_the_network(http, video_executor):
    observation = video_executor(media.VideoGenerateAction(prompt='x', model='veo-9'))
    assert observation.is_error
    assert 'veo-9' in observation.text
    assert http.calls == []


def test_video_upstream_error_is_returned_not_raised(http, video_executor):
    http.responses.append(
        _FakeResponse(403, {'error': {'message': 'model_not_allowed'}})
    )

    observation = video_executor(media.VideoGenerateAction(prompt='x'))

    assert observation.is_error
    assert 'HTTP 403' in observation.text
    assert 'model_not_allowed' in observation.text


def test_no_key_is_ever_echoed_into_an_observation(http, video_executor):
    http.responses.append(_FakeResponse(401, {'error': {'message': 'invalid_key'}}))
    observation = video_executor(media.VideoGenerateAction(prompt='x'))
    assert KEY not in observation.text


# --------------------------------------------------------------------------- #
# app-server wiring
# --------------------------------------------------------------------------- #


def test_app_server_emits_both_tool_names(monkeypatch):
    """Registering agent-side is only half of it — the name must be requested."""
    from openhands.app_server.app_conversation.live_status_app_conversation_service import (  # noqa: E501
        _add_nimbus_extra_tools,
    )

    monkeypatch.setenv('RUNTIME', 'process')
    names = [t.name for t in _add_nimbus_extra_tools([])]
    assert 'image_generate' in names
    assert 'video_generate' in names


@pytest.mark.parametrize('runtime', ['remote', 'docker', ''])
def test_app_server_withholds_the_media_tools_from_a_stock_image(monkeypatch, runtime):
    """Only the process sandbox puts nimbus_bootstrap on the child's PYTHONPATH.

    Every other RUNTIME spawns a stock agent-server image, where these names are
    unresolvable — and the registry gate cannot see that, because the app server
    registered them itself by importing the module.
    """
    from openhands.app_server.app_conversation.live_status_app_conversation_service import (  # noqa: E501
        _add_nimbus_extra_tools,
    )

    monkeypatch.setenv('RUNTIME', runtime)
    names = [t.name for t in _add_nimbus_extra_tools([])]
    assert 'image_generate' not in names
    assert 'video_generate' not in names


def test_app_server_skips_names_the_agent_side_registry_lacks(monkeypatch):
    """The gate that exists because an unresolvable name kills the conversation."""
    import openhands.sdk.tool as sdk_tool
    from openhands.app_server.app_conversation.live_status_app_conversation_service import (  # noqa: E501
        _add_nimbus_extra_tools,
    )

    monkeypatch.setenv('RUNTIME', 'process')
    monkeypatch.setattr(sdk_tool, 'list_registered_tools', lambda: ['terminal'])

    assert _add_nimbus_extra_tools([]) == []

"""``image_generate`` and ``video_generate`` — Nimbus media as agent tools.

The customer already pays for image and video generation on their own API key.
Until now the agent could only reach it by writing a curl command through the
terminal tool, which means the key has to be in the sandbox environment — and it
deliberately is not (see ``_SANDBOX_ENV_ALLOWLIST`` in
``app_server/sandbox/process_sandbox_service.py``: LLM_API_KEY and
NIMBUS_API_KEY are both excluded). These two tools close that gap the only way
the boundary allows: the key arrives on the conversation's LLM config, and never
touches the environment.

WHY THIS LIVES IN nimbus_bootstrap
----------------------------------
Tool registration is per-process and happens on import. Under RUNTIME=process
the agent is a separate child spawned as ``python -m openhands.agent_server``,
and the only code we control that runs inside it is this directory — injected
onto the child's PYTHONPATH and imported from ``sitecustomize``. A tool
registered anywhere else exists in the app server and is unresolvable in the
child, which is the exact failure the ``_add_nimbus_extra_tools`` docstring
records ("ToolDefinition 'apply_patch' is not registered").

The app server imports this module too — for the registry gate, and because it
must be able to deserialise the observations the child posts back through the
webhook. ``kind`` is the bare class name, so a class this process has never
defined cannot be validated.

ONE MODULE OBJECT, TWO IMPORT PATHS
-----------------------------------
The child imports ``nimbus_media_tools`` (bare, off PYTHONPATH); the app server
imports ``openhands.nimbus_bootstrap.nimbus_media_tools``. Those are different
processes so they never collide today — but if any process ever did both, Python
would execute this file twice and define two classes named
``ImageGenerateObservation``. ``_get_checked_concrete_subclasses`` raises
"Duplicate class definition" on that, and it raises during event
DESERIALISATION, so the blast radius is every event in the process, not just
ours. The sys.modules aliasing below makes the second import return the first
module object instead.

SYNCHRONOUS ONLY, ON PURPOSE
----------------------------
``POST /v1/videos/generations`` blocks for 35-180s and returns the MP4 inline;
there is no job id to poll. The gateway does expose
``GET /v1/videos/generations/:opId``, but the only three models documented to
return an operation id (kling-v3-t2v, Wan2.6-T2V, viduq3-pro) are all
``upstream 404 model_not_found`` as of 2026-07-26 and appear in neither the
routing table nor the upstream allowlist. No code in either repo has ever parsed
that endpoint's response body. Writing a poll loop against a contract nobody has
observed would be untested speculation, so the op-id branch below reports the id
and says polling is unsupported rather than pretending to wait.

The cost of synchronous is real: a call parks the agent loop for up to four
minutes. That is inherent to the upstream, not a choice made here.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

import httpx
from pydantic import Field

from openhands.sdk import ImageContent, TextContent
from openhands.sdk.tool import (
    Action,
    Observation,
    ToolAnnotations,
    ToolDefinition,
    ToolExecutor,
    list_registered_tools,
    register_tool,
)

if TYPE_CHECKING:
    from openhands.sdk.conversation.state import ConversationState

# See "ONE MODULE OBJECT, TWO IMPORT PATHS" above. setdefault, so whichever path
# gets here first owns the classes and the other one is handed the same module.
for _alias in ('nimbus_media_tools', 'openhands.nimbus_bootstrap.nimbus_media_tools'):
    sys.modules.setdefault(_alias, sys.modules[__name__])

logger = logging.getLogger(__name__)

# Measured against the live gateway, not read off a price table: every id below
# resolves and reaches the upstream. A row in the gateway's pricing map is NOT
# evidence a model exists — most per-image ids priced there answer
# "upstream 404 model_not_found".
#
# Validating here rather than letting the gateway decide is not belt-and-braces.
# The media endpoints dispatch WITHOUT strict routing, so an unknown id falls
# through to the LiteLLM default, which has no image route at all and answers
# 400 "no fallback model group found" — an error that reads like a gateway
# outage instead of a typo.
IMAGE_MODELS: frozenset[str] = frozenset(
    {
        'gemini-3.1-flash-image',
        'gpt-image-2',
    }
)

VIDEO_MODELS: frozenset[str] = frozenset(
    {
        'sora-2',
        'veo-2-720p',
        'veo-3-720p',
        'veo-3-720p-audio',
        'veo-3-1080p',
        'veo-3-1080p-audio',
        'veo-3-fast-720p',
        'veo-3-fast-720p-audio',
        'veo-3-fast-1080p',
        'veo-3-fast-1080p-audio',
        'veo-3.1-720p',
        'veo-3.1-720p-audio',
        'veo-3.1-1080p',
        'veo-3.1-1080p-audio',
        'veo-3.1-fast-720p',
        'veo-3.1-fast-720p-audio',
        'veo-3.1-fast-1080p',
        'veo-3.1-fast-1080p-audio',
    }
)

# Both defaults are GENERATION-verified end to end (a real PNG, a real 2.1MB
# MP4). The rest of the roster is only ROUTING-verified, so a default drawn from
# it would make a first-try failure look like a bug in this tool.
DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image'
DEFAULT_VIDEO_MODEL = 'veo-3-fast-720p'

# The upstream rejects anything else outright.
VIDEO_DURATIONS: tuple[int, ...] = (4, 6, 8)
VIDEO_ASPECT_RATIOS: tuple[str, ...] = ('16:9', '9:16')

# The gateway's own upstream header timeout is 90s but video routing entries
# carry primary_timeout_ms=210000, and a client that gives up early is still
# billed — the gateway finishes and settles regardless. So the client timeout is
# the one number that must not be too small.
MEDIA_TIMEOUT_S = 240.0
_CONNECT_TIMEOUT_S = 15.0

# Measured-good host. Only used when the conversation's LLM carries no base_url;
# api.nimbusapi.net serves the media endpoints and llm.getnimbus.net does not
# (same key, same model, 200 vs 400 "no fallback model group found").
_FALLBACK_BASE_URL = 'https://api.nimbusapi.net'

# Generated files land here inside the workspace so the agent can hand them to
# another tool. Dotted so it stays out of the way of the user's own tree.
_MEDIA_DIRNAME = '.nimbus-media'

# A 1024x1024 PNG is ~1.4MB as a data URI, which is fine to carry on the event.
# An 8s 1080p clip is not, and the event log, the websocket frame and every
# history replay all pay for it. Above this the file path is the only handle.
_MAX_INLINE_BYTES = 6 * 1024 * 1024

_DATA_URI_RE = re.compile(
    r'^data:(?P<mime>[\w.+/-]+);base64,(?P<payload>.*)$', re.DOTALL
)

# Mirrors the gateway's own prefix stripping so a model named the way the
# catalog shows it (``google/veo-3-fast-720p``) validates instead of 400ing.
_PROVIDER_PREFIXES = (
    'google/',
    'openai/',
    'azure/',
    'anthropic/',
    'xai/',
    'x-ai/',
    'nimbus/',
)

_EXTENSION_BY_MIME = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
}


class _MediaCallError(Exception):
    """A failure the agent should read as text.

    Everything that can go wrong upstream raises this, and both executors turn
    it into ``is_error=True`` observation content. Nothing from this module is
    allowed to propagate into the agent loop: a tool that can kill the turn it
    was called in is worse than no tool.
    """


def _strip_provider_prefix(model: str) -> str:
    lowered = model.strip().lower()
    for prefix in _PROVIDER_PREFIXES:
        if lowered.startswith(prefix):
            return model.strip()[len(prefix) :]
    return model.strip()


def _api_key(llm: Any) -> str | None:
    """The customer's own ``sk-nim-live-`` key, off the conversation's LLM.

    This is the only credential the agent process has, by design, and it is also
    the correct one: it bills the balance the generation should come out of.
    """
    key = getattr(llm, 'api_key', None)
    if key is None:
        return None
    if hasattr(key, 'get_secret_value'):
        key = key.get_secret_value()
    key = str(key).strip()
    return key or None


def _base_url(llm: Any) -> str:
    """Origin to POST the media endpoints at, without a trailing ``/v1``.

    Taken from the LLM config first because the KEY comes from there: host and
    credential have to agree, and a customer on their own model has neither a
    Nimbus key nor a Nimbus host. The env vars are only consulted when the LLM
    carries no base_url at all; NIMBUS_API_BASE_URL is preferred over
    LLM_BASE_URL because it is the name reserved for this API (allowlisted
    through the sandbox boundary already, and this is its first consumer).
    """
    candidates = (
        getattr(llm, 'base_url', None),
        os.getenv('NIMBUS_API_BASE_URL'),
        os.getenv('LLM_BASE_URL'),
        _FALLBACK_BASE_URL,
    )
    for candidate in candidates:
        if not candidate:
            continue
        base = str(candidate).strip().rstrip('/')
        if not base:
            continue
        # The deployment has moved between the bare origin and a /v1 suffix more
        # than once, so normalise instead of trusting either.
        if base.endswith('/v1'):
            base = base[: -len('/v1')]
        return base
    return _FALLBACK_BASE_URL


def _upstream_message(response: httpx.Response) -> str:
    """The gateway's own explanation, trimmed to something an agent can read."""
    try:
        body = response.json()
    except ValueError:
        return response.text[:400].strip() or '<empty response body>'
    if isinstance(body, dict):
        error = body.get('error')
        if isinstance(error, dict):
            message = error.get('message') or error.get('code')
            if message:
                return str(message)[:400]
        if isinstance(error, str):
            return error[:400]
    return str(body)[:400]


def _post_media(
    url: str, api_key: str, body: dict[str, Any], timeout_s: float = MEDIA_TIMEOUT_S
) -> dict[str, Any]:
    """POST and return the decoded JSON, or raise :class:`_MediaCallError`."""
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    try:
        with httpx.Client(
            timeout=httpx.Timeout(timeout_s, connect=_CONNECT_TIMEOUT_S)
        ) as client:
            response = client.post(url, headers=headers, json=body)
    except httpx.TimeoutException:
        raise _MediaCallError(
            f'the request to {url} timed out after {timeout_s:.0f}s. Generation '
            'may still have completed and been billed upstream — check before '
            'retrying.'
        )
    except httpx.HTTPError as e:
        raise _MediaCallError(f'could not reach {url}: {type(e).__name__}')

    if response.status_code >= 400:
        raise _MediaCallError(
            f'HTTP {response.status_code} from {url}: {_upstream_message(response)}'
        )

    try:
        payload = response.json()
    except ValueError:
        raise _MediaCallError(
            f'{url} returned a non-JSON body: {response.text[:200].strip()}'
        )
    if not isinstance(payload, dict):
        raise _MediaCallError(
            f'{url} returned {type(payload).__name__}, expected an object'
        )
    # A 200 carrying an error body is a real case here — the gateway's own
    # billing guard rejects it the same way rather than trusting the status.
    if payload.get('error'):
        raise _MediaCallError(
            f'{url} returned 200 with an error: {_upstream_message(response)}'
        )
    return payload


def _decode_b64(raw: str) -> tuple[bytes, str | None]:
    """Bytes plus the mime type the payload declared, if it declared one.

    Some paths hand back a full ``data:...;base64,`` URI where the contract says
    bare base64. Both live callers on the site strip it defensively before
    decoding and so does this.
    """
    match = _DATA_URI_RE.match(raw.strip())
    mime = None
    if match:
        mime = match.group('mime')
        raw = match.group('payload')
    return base64.b64decode(raw, validate=False), mime


def _write_media(
    working_dir: str, stem: str, data: bytes, mime: str | None, default_ext: str
) -> str | None:
    """Persist generated bytes next to the agent's work; None if that failed.

    Best effort on purpose. A read-only or full workspace must degrade to "here
    is the image" rather than losing a generation the customer already paid for.
    """
    try:
        directory = Path(working_dir) / _MEDIA_DIRNAME
        directory.mkdir(parents=True, exist_ok=True)
        extension = _EXTENSION_BY_MIME.get(mime or '', default_ext)
        path = directory / f'{stem}{extension}'
        path.write_bytes(data)
        return str(path)
    except OSError as e:
        logger.warning('nimbus_media: could not write %s (%s)', stem, type(e).__name__)
        return None


def _human_size(num_bytes: int) -> str:
    if num_bytes >= 1024 * 1024:
        return f'{num_bytes / (1024 * 1024):.1f}MB'
    return f'{num_bytes / 1024:.0f}KB'


# --------------------------------------------------------------------------- #
# image_generate
# --------------------------------------------------------------------------- #

IMAGE_TOOL_DESCRIPTION = f"""Generate images with the customer's Nimbus API key.

* Text-to-image only. The prompt is the whole input; there is no reference-image
  or editing mode (every model 400s or silently text-to-images instead).
* Available models: {', '.join(sorted(IMAGE_MODELS))}. Defaults to
  {DEFAULT_IMAGE_MODEL}. Any other id is rejected before the request is sent.
* `size`, `quality` and `style` are only honoured by gpt-image-2; the
  gemini path ignores them.
* Takes 10-90s. Each image is billed to the customer, so generate one at a time
  and only re-run when the result is actually wrong.
* Saves every image into {_MEDIA_DIRNAME}/ in the working directory and reports
  the paths, so the file can be passed to another tool.
"""


class ImageGenerateAction(Action):
    """Schema for a Nimbus text-to-image request."""

    prompt: str = Field(description='What to draw. This is the entire input.')
    model: str | None = Field(
        default=None,
        description=(
            f'Image model id. One of: {", ".join(sorted(IMAGE_MODELS))}. '
            f'Defaults to {DEFAULT_IMAGE_MODEL}.'
        ),
    )
    size: str | None = Field(
        default=None,
        description=(
            'Pixel size such as "1024x1024". Only gpt-image-2 honours it; the '
            'gemini path ignores it entirely.'
        ),
    )
    n: int = Field(
        default=1,
        ge=1,
        le=4,
        description='How many images to generate. Each one is billed separately.',
    )


class ImageGenerateObservation(Observation):
    """Result of a Nimbus text-to-image request."""

    model: str = Field(description='The image model that produced these images.')
    file_paths: list[str] = Field(
        default_factory=list,
        description='Absolute paths of the images written into the workspace.',
    )

    @property
    def to_llm_content(self) -> Sequence[TextContent | ImageContent]:
        """Text only — the image stays in ``content`` for the UI to render.

        Feeding the generated image back to the model looks free and is not. Not
        every model a customer can select is vision-capable, and an image_url
        block on one that isn't fails the whole turn, so a successful generation
        would break the conversation it was requested in. The customer sees the
        image in the chat either way.
        """
        parts: list[TextContent | ImageContent] = []
        if self.is_error:
            parts.append(TextContent(text=self.ERROR_MESSAGE_HEADER))
        parts.extend(item for item in self.content if isinstance(item, TextContent))
        return parts


class ImageGenerateExecutor(
    ToolExecutor[ImageGenerateAction, ImageGenerateObservation]
):
    def __init__(self, base_url: str, api_key: str | None, working_dir: str) -> None:
        self._url = f'{base_url}/v1/images/generations'
        self._api_key = api_key
        self._working_dir = working_dir

    def __call__(
        self, action: ImageGenerateAction, conversation: Any = None
    ) -> ImageGenerateObservation:
        model = _strip_provider_prefix(action.model or DEFAULT_IMAGE_MODEL)
        try:
            payload = self._generate(action, model)
        except _MediaCallError as e:
            return ImageGenerateObservation(
                content=[TextContent(text=f'Image generation failed: {e}')],
                is_error=True,
                model=model,
            )
        except Exception as e:  # noqa: BLE001 - never raise into the agent loop
            logger.exception('nimbus_media: image_generate crashed')
            return ImageGenerateObservation(
                content=[
                    TextContent(
                        text=f'Image generation failed: {type(e).__name__}: {e}'
                    )
                ],
                is_error=True,
                model=model,
            )
        return payload

    def _generate(
        self, action: ImageGenerateAction, model: str
    ) -> ImageGenerateObservation:
        if not self._api_key:
            raise _MediaCallError(
                'no Nimbus API key is available on this conversation, so the '
                'generation cannot be billed to anyone.'
            )
        prompt = action.prompt.strip()
        if not prompt:
            raise _MediaCallError('prompt is empty.')
        if model not in IMAGE_MODELS:
            raise _MediaCallError(
                f'{model!r} is not an available image model. '
                f'Use one of: {", ".join(sorted(IMAGE_MODELS))}.'
            )

        body: dict[str, Any] = {
            'model': model,
            'prompt': prompt,
            'n': action.n,
            'response_format': 'url',
        }
        if action.size:
            body['size'] = action.size

        payload = _post_media(self._url, self._api_key, body)
        items = payload.get('data')
        if not isinstance(items, list) or not items:
            raise _MediaCallError('the gateway returned no images.')

        stamp = time.strftime('%Y%m%d-%H%M%S')
        urls: list[str] = []
        paths: list[str] = []
        notes: list[str] = []

        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            remote_url = item.get('url')
            if isinstance(remote_url, str) and remote_url.startswith(
                ('http://', 'https://')
            ):
                # Hosted images need no local copy to render, and fetching one
                # would be a second billable-adjacent round trip for nothing.
                urls.append(remote_url)
                notes.append(f'{index + 1}. {remote_url}')
                continue
            encoded = item.get('b64_json')
            if not isinstance(encoded, str) or not encoded:
                continue
            try:
                data, embedded_mime = _decode_b64(encoded)
            except (ValueError, TypeError):
                raise _MediaCallError(f'image {index + 1} was not valid base64.')
            mime = embedded_mime or item.get('mime_type') or 'image/png'
            path = _write_media(
                self._working_dir, f'image-{stamp}-{index + 1}', data, mime, '.png'
            )
            if path:
                paths.append(path)
            if len(data) <= _MAX_INLINE_BYTES:
                urls.append(f'data:{mime};base64,{base64.b64encode(data).decode()}')
            notes.append(
                f'{index + 1}. {path or "(not saved)"} ({_human_size(len(data))})'
            )

        if not urls and not paths:
            raise _MediaCallError(
                'the gateway returned a response with no usable image data.'
            )

        summary = [
            f'Generated {len(notes)} image(s) with {model}.',
            f'Prompt: {prompt}',
        ]
        summary.extend(notes)
        content: list[TextContent | ImageContent] = [
            TextContent(text='\n'.join(summary))
        ]
        if urls:
            content.append(ImageContent(image_urls=urls))
        return ImageGenerateObservation(
            content=content, is_error=False, model=model, file_paths=paths
        )


class ImageGenerateTool(ToolDefinition[ImageGenerateAction, ImageGenerateObservation]):
    """Text-to-image against the customer's own Nimbus API key."""

    name: ClassVar[str] = 'image_generate'

    @classmethod
    def create(
        cls, conv_state: ConversationState, **params: Any
    ) -> Sequence[ImageGenerateTool]:
        llm = conv_state.agent.llm
        # A missing key does NOT stop the tool from being created. create() runs
        # while the conversation is being built, so raising here fails the whole
        # conversation; the executor reports it as a normal tool error instead.
        return [
            cls(
                description=IMAGE_TOOL_DESCRIPTION,
                action_type=ImageGenerateAction,
                observation_type=ImageGenerateObservation,
                annotations=ToolAnnotations(
                    title='image_generate',
                    readOnlyHint=False,
                    destructiveHint=False,
                    idempotentHint=False,
                    openWorldHint=True,
                ),
                executor=ImageGenerateExecutor(
                    base_url=_base_url(llm),
                    api_key=_api_key(llm),
                    working_dir=conv_state.workspace.working_dir,
                ),
            )
        ]


# --------------------------------------------------------------------------- #
# video_generate
# --------------------------------------------------------------------------- #

VIDEO_TOOL_DESCRIPTION = f"""Generate short videos with the customer's Nimbus API key.

* Text-to-video only, and synchronous: the call blocks for 35-180s and returns
  the finished MP4. There is no job to poll.
* Available models: {', '.join(sorted(VIDEO_MODELS))}. Defaults to
  {DEFAULT_VIDEO_MODEL}. Any other id is rejected before the request is sent.
* duration_seconds must be one of {', '.join(str(d) for d in VIDEO_DURATIONS)};
  aspect_ratio must be one of {', '.join(VIDEO_ASPECT_RATIOS)}.
* Billed per second of video and expensive. Generate one clip, show it, and only
  re-run when the customer asks for a change.
* The MP4 is written into {_MEDIA_DIRNAME}/ in the working directory; the
  observation reports the path, not the bytes.
"""


class VideoGenerateAction(Action):
    """Schema for a Nimbus text-to-video request."""

    prompt: str = Field(description='What should happen in the clip.')
    model: str | None = Field(
        default=None,
        description=(
            f'Video model id. One of: {", ".join(sorted(VIDEO_MODELS))}. '
            f'Defaults to {DEFAULT_VIDEO_MODEL}.'
        ),
    )
    duration_seconds: int = Field(
        default=4,
        description=(
            'Clip length in seconds. Only '
            f'{", ".join(str(d) for d in VIDEO_DURATIONS)} are accepted.'
        ),
    )
    aspect_ratio: str = Field(
        default='16:9',
        description=f'One of {", ".join(VIDEO_ASPECT_RATIOS)}.',
    )


class VideoGenerateObservation(Observation):
    """Result of a Nimbus text-to-video request."""

    model: str = Field(description='The video model that produced this clip.')
    file_path: str | None = Field(
        default=None, description='Absolute path of the MP4 written into the workspace.'
    )
    video_url: str | None = Field(
        default=None, description='Hosted URL, when the gateway returned one.'
    )
    duration_seconds: int | None = Field(
        default=None, description='Length of the generated clip in seconds.'
    )


class VideoGenerateExecutor(
    ToolExecutor[VideoGenerateAction, VideoGenerateObservation]
):
    def __init__(self, base_url: str, api_key: str | None, working_dir: str) -> None:
        self._url = f'{base_url}/v1/videos/generations'
        self._api_key = api_key
        self._working_dir = working_dir

    def __call__(
        self, action: VideoGenerateAction, conversation: Any = None
    ) -> VideoGenerateObservation:
        model = _strip_provider_prefix(action.model or DEFAULT_VIDEO_MODEL)
        try:
            return self._generate(action, model)
        except _MediaCallError as e:
            return VideoGenerateObservation(
                content=[TextContent(text=f'Video generation failed: {e}')],
                is_error=True,
                model=model,
            )
        except Exception as e:  # noqa: BLE001 - never raise into the agent loop
            logger.exception('nimbus_media: video_generate crashed')
            return VideoGenerateObservation(
                content=[
                    TextContent(
                        text=f'Video generation failed: {type(e).__name__}: {e}'
                    )
                ],
                is_error=True,
                model=model,
            )

    def _generate(
        self, action: VideoGenerateAction, model: str
    ) -> VideoGenerateObservation:
        if not self._api_key:
            raise _MediaCallError(
                'no Nimbus API key is available on this conversation, so the '
                'generation cannot be billed to anyone.'
            )
        prompt = action.prompt.strip()
        if not prompt:
            raise _MediaCallError('prompt is empty.')
        if model not in VIDEO_MODELS:
            raise _MediaCallError(
                f'{model!r} is not an available video model. '
                f'Use one of: {", ".join(sorted(VIDEO_MODELS))}.'
            )
        if action.duration_seconds not in VIDEO_DURATIONS:
            raise _MediaCallError(
                f'duration_seconds must be one of '
                f'{", ".join(str(d) for d in VIDEO_DURATIONS)}, '
                f'got {action.duration_seconds}.'
            )
        if action.aspect_ratio not in VIDEO_ASPECT_RATIOS:
            raise _MediaCallError(
                f'aspect_ratio must be one of {", ".join(VIDEO_ASPECT_RATIOS)}, '
                f'got {action.aspect_ratio!r}.'
            )

        body: dict[str, Any] = {
            'model': model,
            'prompt': prompt,
            'duration_seconds': action.duration_seconds,
            'aspect_ratio': action.aspect_ratio,
        }
        payload = _post_media(self._url, self._api_key, body)

        items = payload.get('data')
        if not isinstance(items, list) or not items or not isinstance(items[0], dict):
            # The async models that answer with an operation id are all dead
            # upstream, so this is a contract change rather than a normal path —
            # say what came back instead of silently polling something untested.
            operation_id = payload.get('id') or payload.get('operation_id')
            if operation_id:
                raise _MediaCallError(
                    f'the gateway returned operation id {operation_id!r} instead of a '
                    'video. This tool only supports synchronous generation; poll '
                    f'GET /v1/videos/generations/{operation_id} manually if needed.'
                )
            raise _MediaCallError('the gateway returned no video.')

        item = items[0]
        # usage.video_seconds is the billed quantity and is frequently absent —
        # veo-3.1-fast-720p returned 200 with no quantity at all on 2026-08-01.
        # Absence is not failure; fall back to what was asked for.
        reported = item.get('duration_seconds')
        duration = reported if isinstance(reported, int) else action.duration_seconds

        remote_url = item.get('url')
        if isinstance(remote_url, str) and remote_url.startswith(
            ('http://', 'https://')
        ):
            return VideoGenerateObservation(
                content=[
                    TextContent(
                        text=(
                            f'Generated a {duration}s {action.aspect_ratio} clip with '
                            f'{model}.\nPrompt: {prompt}\nURL: {remote_url}'
                        )
                    )
                ],
                is_error=False,
                model=model,
                video_url=remote_url,
                duration_seconds=duration,
            )

        encoded = item.get('b64_json')
        if not isinstance(encoded, str) or not encoded:
            raise _MediaCallError('the gateway returned a response with no video data.')
        try:
            data, embedded_mime = _decode_b64(encoded)
        except (ValueError, TypeError):
            raise _MediaCallError('the returned video was not valid base64.')
        mime = embedded_mime or item.get('mime_type') or 'video/mp4'

        stamp = time.strftime('%Y%m%d-%H%M%S')
        path = _write_media(self._working_dir, f'video-{stamp}', data, mime, '.mp4')
        if not path:
            raise _MediaCallError(
                f'generated a {_human_size(len(data))} clip but could not write it '
                f'into {self._working_dir}. The generation has already been billed.'
            )

        resolution = item.get('resolution')
        summary = [
            f'Generated a {duration}s {action.aspect_ratio} clip with {model}.',
            f'Prompt: {prompt}',
            f'Saved to {path} ({_human_size(len(data))}'
            + (f', {resolution}' if isinstance(resolution, str) else '')
            + ')',
        ]
        return VideoGenerateObservation(
            content=[TextContent(text='\n'.join(summary))],
            is_error=False,
            model=model,
            file_path=path,
            duration_seconds=duration,
        )


class VideoGenerateTool(ToolDefinition[VideoGenerateAction, VideoGenerateObservation]):
    """Text-to-video against the customer's own Nimbus API key."""

    name: ClassVar[str] = 'video_generate'

    @classmethod
    def create(
        cls, conv_state: ConversationState, **params: Any
    ) -> Sequence[VideoGenerateTool]:
        llm = conv_state.agent.llm
        return [
            cls(
                description=VIDEO_TOOL_DESCRIPTION,
                action_type=VideoGenerateAction,
                observation_type=VideoGenerateObservation,
                annotations=ToolAnnotations(
                    title='video_generate',
                    readOnlyHint=False,
                    destructiveHint=False,
                    idempotentHint=False,
                    openWorldHint=True,
                ),
                executor=VideoGenerateExecutor(
                    base_url=_base_url(llm),
                    api_key=_api_key(llm),
                    working_dir=conv_state.workspace.working_dir,
                ),
            )
        ]


def register_nimbus_media_tools() -> list[str]:
    """Register both tools and return the names, for the bootstrap breadcrumb.

    Idempotent because there are two entry points: this file registers on import
    the way every SDK tool definition does, and sitecustomize calls this function
    by name so the child's startup log says which tools it got. Registering the
    same name twice logs "Duplicate tool name registerd" today, and the SDK's own
    TODO on that line says it will eventually raise.
    """
    registered = set(list_registered_tools())
    for tool_cls in (ImageGenerateTool, VideoGenerateTool):
        if tool_cls.name not in registered:
            register_tool(tool_cls.name, tool_cls)
    return [ImageGenerateTool.name, VideoGenerateTool.name]


# Module-scope registration, exactly like every SDK tool definition: importing
# the module is what puts the name in the registry.
register_nimbus_media_tools()

"""Azure deployments Nimbus uses for itself. NOT a product surface.

Speech-to-text and text-to-speech are things the product needs in order to work
— the mic in the composer, reading a reply aloud. They are deliberately NOT
sold: no catalog entry, no docs page, no customer-callable ``/v1/...`` route,
and no per-request billing. Owner decision 2026-08-04/05 is to absorb the cost,
because it is small and because offering them as models would mean supporting
them as models.

This is the same arrangement as ``lib/internalAi.ts`` in nimbus-v2, deliberately
duplicated rather than shared: the two apps are separate deployments in separate
languages, and a shared service would put a network hop and a second failure
mode in front of a feature whose entire value is that it degrades to a free
browser API when anything goes wrong.

WHY AZURE, WHEN AZURE WAS REMOVED
---------------------------------
Azure was stripped from the customer GATEWAY — the contracted upstream is
SpiderSense, which serves chat and image generation only. The Azure AI accounts
themselves were never deleted. This talks to one directly, server-side, and
resells nothing.

DEPLOYMENTS (nimbus-aifoundry-eus2, eastus2)
--------------------------------------------
  gpt-4o-mini-transcribe   capacity 50 — preferred over ``whisper``, whose
                           capacity of 3 is fully consumed
  nimbus-internal-tts      gpt-4o-mini-tts, capacity 10 — created 2026-08-04

Both verified with live calls on 2026-08-05, including a TTS -> STT round trip
that returned the input sentence verbatim.

DEGRADING
---------
Every function returns None rather than raising when the credential is absent,
so a missing env var degrades a feature instead of 500-ing a route. Callers must
handle None; the frontend falls back to the browser's own SpeechRecognition and
speechSynthesis, which cost nothing and need no upstream.
"""

from __future__ import annotations

import os
from typing import Final

import httpx

_DEFAULT_ENDPOINT: Final[str] = (
    'https://nimbus-aifoundry-eus2.cognitiveservices.azure.com'
)
_API_VERSION: Final[str] = '2024-06-01'
# Speech synthesis is only on the preview line.
_TTS_API_VERSION: Final[str] = '2025-03-01-preview'

STT_DEPLOYMENT: Final[str] = 'gpt-4o-mini-transcribe'
TTS_DEPLOYMENT: Final[str] = 'nimbus-internal-tts'

# gpt-4o-mini-tts accepts 2000 chars. Cap below that so one pathological reply
# cannot eat the deployment's whole minute of capacity; longer text falls back
# to speechSynthesis client-side, which has no such limit.
MAX_TTS_CHARS: Final[int] = 1800

# 25MB, matching the site's ceiling and the deployment's own limit.
MAX_AUDIO_BYTES: Final[int] = 25 * 1024 * 1024

_TIMEOUT: Final[float] = 60.0


def _endpoint() -> str:
    return (os.getenv('NIMBUS_INTERNAL_AI_ENDPOINT') or _DEFAULT_ENDPOINT).rstrip('/')


def _key() -> str | None:
    key = os.getenv('NIMBUS_INTERNAL_AI_KEY') or ''
    return key if len(key) > 20 else None


def internal_ai_available() -> bool:
    """Whether internal AI is configured. Cheap; safe to call per request."""
    return _key() is not None


async def transcribe(
    audio: bytes, filename: str, content_type: str, language: str | None = None
) -> str | None:
    """Transcribe audio. None when unconfigured or on any failure."""
    key = _key()
    if not key:
        return None
    url = (
        f'{_endpoint()}/openai/deployments/{STT_DEPLOYMENT}'
        f'/audio/transcriptions?api-version={_API_VERSION}'
    )
    files = {'file': (filename, audio, content_type)}
    data = {'language': language} if language else None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                url, headers={'api-key': key}, files=files, data=data
            )
        if response.status_code != 200:
            return None
        text = response.json().get('text')
        return text.strip() if isinstance(text, str) else None
    except Exception:
        # Deliberately broad: a transcription failure must never surface as a
        # 500. The caller degrades to the browser recogniser.
        return None


async def speak(text: str, voice: str = 'alloy') -> bytes | None:
    """Synthesise speech as MP3 bytes. None when unconfigured or on failure."""
    key = _key()
    if not key:
        return None
    url = (
        f'{_endpoint()}/openai/deployments/{TTS_DEPLOYMENT}'
        f'/audio/speech?api-version={_TTS_API_VERSION}'
    )
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                url,
                headers={'api-key': key, 'Content-Type': 'application/json'},
                json={
                    'model': 'gpt-4o-mini-tts',
                    'input': text,
                    'voice': voice,
                    'response_format': 'mp3',
                },
            )
        return response.content if response.status_code == 200 else None
    except Exception:
        return None

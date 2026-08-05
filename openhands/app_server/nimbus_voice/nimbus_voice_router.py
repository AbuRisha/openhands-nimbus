"""Voice endpoints for Nimbus Chat: dictate into the composer, hear a reply.

Both run on Nimbus' own Azure deployments (see ``internal_ai``) rather than the
customer gateway. Nothing here is sold, catalogued or billed — the platform
absorbs the cost, so these routes deliberately do not touch metering.

Both return 501 when internal AI is unconfigured. That is not a failure state:
the frontend treats these routes as an upgrade over the browser's built-in
SpeechRecognition and speechSynthesis, so an unconfigured deployment still has
working voice, just a plainer voice.

Auth: these live under /api/, which NimbusAuthGateMiddleware default-denies
without a verified Nimbus session. No extra dependency is needed here, and
adding one would imply the middleware is optional.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field

from openhands.app_server.nimbus_voice.internal_ai import (
    MAX_AUDIO_BYTES,
    MAX_TTS_CHARS,
    STT_DEPLOYMENT,
    internal_ai_available,
    speak,
    transcribe,
)

router = APIRouter(prefix='/api/nimbus/voice', tags=['nimbus-voice'])

# The deployment's own voice set. An unknown value is coerced rather than
# rejected: a bad voice is not worth failing a request the user can hear.
_ALLOWED_VOICES = frozenset(
    {
        'alloy',
        'ash',
        'ballad',
        'coral',
        'echo',
        'fable',
        'nova',
        'sage',
        'shimmer',
        'verse',
    }
)


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TTS_CHARS)
    voice: str = 'alloy'


class TranscriptionResponse(BaseModel):
    text: str
    model: str
    # Zero because the platform absorbs it, not because it is free to us. Named
    # so the client can show no cost line without guessing.
    cost_usd: float = 0.0
    internal: bool = True


@router.post('/transcribe', response_model=TranscriptionResponse)
async def transcribe_audio(
    file: Annotated[UploadFile, File()],
    language: Annotated[str | None, Form()] = None,
) -> TranscriptionResponse:
    if not internal_ai_available():
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail='nimbus_internal_ai_not_configured',
        )

    audio = await file.read()
    if not audio:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail='empty_file'
        )
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail='file_too_large',
        )

    text = await transcribe(
        audio,
        file.filename or 'recording.webm',
        file.content_type or 'audio/webm',
        language=language or None,
    )
    if text is None:
        # Configured but the call failed — distinct from 501, because the two
        # need different fixes.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail='transcription_failed'
        )
    return TranscriptionResponse(text=text, model=STT_DEPLOYMENT)


@router.post('/speak')
async def speak_text(body: SpeakRequest) -> Response:
    if not internal_ai_available():
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail='nimbus_internal_ai_not_configured',
        )

    voice = body.voice if body.voice in _ALLOWED_VOICES else 'alloy'
    audio = await speak(body.text, voice=voice)
    if audio is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail='speech_failed'
        )
    return Response(
        content=audio,
        media_type='audio/mpeg',
        # Same text, same audio; let a replay come from cache.
        headers={'Cache-Control': 'private, max-age=300'},
    )

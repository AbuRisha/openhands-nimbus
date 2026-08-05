"""Voice routes degrade rather than fail.

The point of every assertion here is that an unconfigured or broken deployment
produces a specific, distinguishable status — never a 500 and never a success
with no audio — because the frontend uses the difference to decide whether to
fall back to the browser's own speech APIs.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openhands.app_server.nimbus_voice import internal_ai
from openhands.app_server.nimbus_voice.nimbus_voice_router import router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def no_credential(monkeypatch):
    monkeypatch.delenv('NIMBUS_INTERNAL_AI_KEY', raising=False)


def _configure(monkeypatch):
    # Length matters: internal_ai treats anything <= 20 chars as unset, so a
    # short placeholder would silently read as "not configured".
    monkeypatch.setenv('NIMBUS_INTERNAL_AI_KEY', 'k' * 40)


class TestUnconfigured:
    def test_transcribe_501s(self, client):
        response = client.post(
            '/api/nimbus/voice/transcribe',
            files={'file': ('a.webm', b'bytes', 'audio/webm')},
        )
        assert response.status_code == 501
        assert response.json()['detail'] == 'nimbus_internal_ai_not_configured'

    def test_speak_501s(self, client):
        response = client.post('/api/nimbus/voice/speak', json={'text': 'hello'})
        assert response.status_code == 501

    def test_short_key_is_treated_as_absent(self, monkeypatch, client):
        monkeypatch.setenv('NIMBUS_INTERNAL_AI_KEY', 'too-short')
        assert internal_ai.internal_ai_available() is False
        assert (
            client.post('/api/nimbus/voice/speak', json={'text': 'x'}).status_code
            == 501
        )


class TestTranscribe:
    def test_empty_upload_is_rejected_before_the_upstream(self, monkeypatch, client):
        _configure(monkeypatch)
        called = False

        async def _never(*args, **kwargs):
            nonlocal called
            called = True
            return None

        monkeypatch.setattr(internal_ai, 'transcribe', _never)
        # Patch the router's imported reference too — it binds at import time.
        monkeypatch.setattr(
            'openhands.app_server.nimbus_voice.nimbus_voice_router.transcribe', _never
        )
        response = client.post(
            '/api/nimbus/voice/transcribe',
            files={'file': ('a.webm', b'', 'audio/webm')},
        )
        assert response.status_code == 400
        assert response.json()['detail'] == 'empty_file'
        assert called is False

    def test_upstream_failure_is_502_not_500(self, monkeypatch, client):
        _configure(monkeypatch)

        async def _fail(*args, **kwargs):
            return None

        monkeypatch.setattr(
            'openhands.app_server.nimbus_voice.nimbus_voice_router.transcribe', _fail
        )
        response = client.post(
            '/api/nimbus/voice/transcribe',
            files={'file': ('a.webm', b'bytes', 'audio/webm')},
        )
        assert response.status_code == 502
        assert response.json()['detail'] == 'transcription_failed'

    def test_success_reports_zero_cost_and_the_deployment(self, monkeypatch, client):
        _configure(monkeypatch)

        async def _ok(*args, **kwargs):
            return 'hello there'

        monkeypatch.setattr(
            'openhands.app_server.nimbus_voice.nimbus_voice_router.transcribe', _ok
        )
        response = client.post(
            '/api/nimbus/voice/transcribe',
            files={'file': ('a.webm', b'bytes', 'audio/webm')},
        )
        assert response.status_code == 200
        body = response.json()
        assert body['text'] == 'hello there'
        assert body['model'] == internal_ai.STT_DEPLOYMENT
        # Absorbed, not free to us — the client shows no cost line for it.
        assert body['cost_usd'] == 0.0
        assert body['internal'] is True


class TestSpeak:
    def test_returns_audio_bytes(self, monkeypatch, client):
        _configure(monkeypatch)

        async def _ok(text, voice='alloy'):
            return b'ID3-fake-mp3'

        monkeypatch.setattr(
            'openhands.app_server.nimbus_voice.nimbus_voice_router.speak', _ok
        )
        response = client.post('/api/nimbus/voice/speak', json={'text': 'hi'})
        assert response.status_code == 200
        assert response.headers['content-type'] == 'audio/mpeg'
        assert response.content == b'ID3-fake-mp3'

    def test_unknown_voice_is_coerced_not_rejected(self, monkeypatch, client):
        _configure(monkeypatch)
        seen = {}

        async def _capture(text, voice='alloy'):
            seen['voice'] = voice
            return b'audio'

        monkeypatch.setattr(
            'openhands.app_server.nimbus_voice.nimbus_voice_router.speak', _capture
        )
        response = client.post(
            '/api/nimbus/voice/speak', json={'text': 'hi', 'voice': 'nonsense'}
        )
        assert response.status_code == 200
        assert seen['voice'] == 'alloy'

    def test_text_over_the_cap_is_rejected(self, monkeypatch, client):
        _configure(monkeypatch)
        response = client.post(
            '/api/nimbus/voice/speak',
            json={'text': 'x' * (internal_ai.MAX_TTS_CHARS + 1)},
        )
        # 422 from the model constraint. The client checks the length itself and
        # uses speechSynthesis instead, so this is the backstop, not the path.
        assert response.status_code == 422

    def test_empty_text_is_rejected(self, monkeypatch, client):
        _configure(monkeypatch)
        assert (
            client.post('/api/nimbus/voice/speak', json={'text': ''}).status_code == 422
        )

    def test_upstream_failure_is_502(self, monkeypatch, client):
        _configure(monkeypatch)

        async def _fail(text, voice='alloy'):
            return None

        monkeypatch.setattr(
            'openhands.app_server.nimbus_voice.nimbus_voice_router.speak', _fail
        )
        response = client.post('/api/nimbus/voice/speak', json={'text': 'hi'})
        assert response.status_code == 502
        assert response.json()['detail'] == 'speech_failed'

import os
import io
import httpx
from fastapi import UploadFile
from groq import Groq

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "onwK4e9ZLuTAKqWW03F9")  # Daniel - British male
ELEVENLABS_MODEL = "eleven_turbo_v2_5"  # fastest + best quality


async def text_to_speech(text: str) -> bytes:
    """
    Convert text to speech using ElevenLabs Daniel (British male voice).
    Returns raw MP3 audio bytes.
    """
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": {
            "stability": 0.55,          # calm, consistent - JARVIS-like
            "similarity_boost": 0.80,   # stays close to voice character
            "style": 0.15,              # subtle expressiveness
            "use_speaker_boost": True,
        },
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        return resp.content


async def speech_to_text(audio_file: UploadFile) -> str:
    """
    Transcribe audio using Groq Whisper (fast, free).
    Returns transcribed text string.
    """
    groq_client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))
    audio_bytes = await audio_file.read()
    audio_buffer = io.BytesIO(audio_bytes)
    audio_buffer.name = audio_file.filename or "audio.webm"

    transcription = groq_client.audio.transcriptions.create(
        file=(audio_buffer.name, audio_buffer, audio_file.content_type or "audio/webm"),
        model="whisper-large-v3-turbo",
        language="en",
        response_format="text",
    )
    return transcription.strip() if isinstance(transcription, str) else transcription.text.strip()

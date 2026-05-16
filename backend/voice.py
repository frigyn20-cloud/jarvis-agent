import os
import io
import re
import httpx
from fastapi import UploadFile
from groq import Groq

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "onwK4e9ZLuTAKqWW03F9")  # Daniel - British male
ELEVENLABS_MODEL = "eleven_turbo_v2_5"  # fastest + cheapest

# Max characters sent to ElevenLabs per response (~2500 chars ≈ ~400 credits)
# Keeping under 600 chars keeps cost under ~100 credits per response
TTS_MAX_CHARS = 600


def clean_for_tts(text: str) -> str:
    """
    Strip markdown, tables, symbols and truncate before sending to ElevenLabs.
    This dramatically reduces credit usage and improves naturalness.
    """
    # Remove markdown tables (lines with | pipes)
    lines = text.split("\n")
    lines = [l for l in lines if not re.match(r"^\s*[|\-]{2,}", l)]
    text = "\n".join(lines)

    # Remove markdown formatting
    text = re.sub(r"#{1,6}\s+", "", text)          # headers
    text = re.sub(r"\*{1,3}([^*]+)\*{1,3}", r"\1", text)  # bold/italic
    text = re.sub(r"`{1,3}[^`]*`{1,3}", "", text)  # code blocks
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)  # links
    text = re.sub(r"^[-*+]\s+", "", text, flags=re.MULTILINE)  # bullet points
    text = re.sub(r"^\d+\.\s+", "", text, flags=re.MULTILINE)  # numbered lists

    # Replace pipe-separated values with natural speech
    text = re.sub(r"\s*\|\s*", ", ", text)

    # Replace symbols with spoken equivalents
    text = text.replace(" | ", ", ")
    text = text.replace("|", ", ")
    text = re.sub(r"([+-]?\d+\.?\d*)%", r"\1 percent", text)
    text = re.sub(r"\$([\d,]+)", r"\1 dollars", text)
    text = re.sub(r"#(\d+)", r"number \1", text)

    # Collapse multiple spaces/newlines
    text = re.sub(r"\n{2,}", ". ", text)
    text = re.sub(r"\n", " ", text)
    text = re.sub(r"  +", " ", text)
    text = text.strip()

    # Truncate to max chars at a sentence boundary
    if len(text) > TTS_MAX_CHARS:
        truncated = text[:TTS_MAX_CHARS]
        # Try to cut at last sentence end
        last_period = max(truncated.rfind("."), truncated.rfind("!"), truncated.rfind("?"))
        if last_period > TTS_MAX_CHARS // 2:
            text = truncated[:last_period + 1]
        else:
            text = truncated.rstrip() + "."

    return text


async def text_to_speech(text: str) -> bytes:
    """
    Convert text to speech using ElevenLabs Daniel (British male voice).
    Cleans and truncates text first to save credits.
    Returns raw MP3 audio bytes.
    """
    cleaned = clean_for_tts(text)

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    payload = {
        "text": cleaned,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": {
            "stability": 0.55,
            "similarity_boost": 0.80,
            "style": 0.15,
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

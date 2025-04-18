from ninja import NinjaAPI, Schema
from django.shortcuts import get_object_or_404
from typing import List, Optional
from .models import Transcription, TranscriptSegment

api = NinjaAPI()

# Schemas
class TranscriptionSchema(Schema):
    id: int
    title: str
    created_at: str

class TranscriptionCreateSchema(Schema):
    title: str

class TranscriptSegmentSchema(Schema):
    id: int
    text: str
    speaker: Optional[str]
    start_time: float
    end_time: float
    is_final: bool

# API Endpoints
@api.post("/transcriptions/", response=TranscriptionSchema)
def create_transcription(request, data: TranscriptionCreateSchema):
    transcription = Transcription.objects.create(
        title=data.title
    )
    return transcription

@api.get("/transcriptions/", response=List[TranscriptionSchema])
def list_transcriptions(request):
    return Transcription.objects.all()

@api.get("/transcriptions/{transcription_id}/", response=TranscriptionSchema)
def get_transcription(request, transcription_id: int):
    return get_object_or_404(Transcription, id=transcription_id)

@api.get("/transcriptions/{transcription_id}/segments/", response=List[TranscriptSegmentSchema])
def get_transcript_segments(request, transcription_id: int):
    transcription = get_object_or_404(Transcription, id=transcription_id)
    return TranscriptSegment.objects.filter(transcription=transcription)
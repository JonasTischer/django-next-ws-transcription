# Building a Real-Time Transcription System with Django and Next.js

In this tutorial, we'll build a live audio transcription system that processes audio in real-time and displays transcription results as they become available. We'll use WebSockets to enable bidirectional communication between the frontend and backend.

## Architecture Overview

Our system consists of:

- **Frontend**: Next.js application that captures audio and displays transcription results
- **Backend**: Django application with Django Ninja for REST APIs and Django Channels for WebSocket communication
- **Transcription Service**: Deepgram API for real-time audio-to-text conversion with speaker diarization
- **Infrastructure**: Local development setup with Redis for WebSocket channel layer

## Project Structure

```
django-next-ws-transcription/
├── backend/               # Django backend
│   ├── wstranscription/   # Django project settings
│   ├── transcription/     # Main application
│   ├── manage.py
│   └── requirements.txt   # Python dependencies
│
└── frontend/              # Next.js frontend
    ├── app/               # Next.js app directory
    ├── components/        # React components
    ├── package.json       # JS dependencies
    └── next.config.js
```

## Part 1: Setting Up the Backend

Let's start by setting up our Django backend with Django Ninja and Django Channels.

### 1. Create the Django Project

```bash
uv init backend
uv add django
uv run django-admin startproject wstranscription .
uv add django-ninja django-cors-headers channels channels-redis daphne
uv run django-admin startapp transcription
```

### 2. Configure Django Settings

Edit `backend/wstranscription/settings.py`:

```python
# Add installed apps
INSTALLED_APPS = [
    'daphne',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',

    # Third-party apps
    'corsheaders',
    'channels',

    # Local apps
    'transcription',
]

# Add CORS settings
CORS_ALLOW_ALL_ORIGINS = True  # In production, specify exact origins
CORS_ALLOW_CREDENTIALS = True

# Configure Channels
ASGI_APPLICATION = 'wstranscription.asgi.application'
CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            'hosts': [('localhost', 6379)],
        },
    },
}

# Rest of your settings...
```

### 3. Configure ASGI for Channels

Update `backend/wstranscription/asgi.py`:

```python
import os
from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'wstranscription.settings')

application = get_asgi_application()
```

### 4. Create Models

Create `backend/transcription/models.py`:

```python
from django.db import models

class Transcription(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    title = models.CharField(max_length=255)

    def __str__(self):
        return self.title

class TranscriptSegment(models.Model):
    transcription = models.ForeignKey(Transcription, related_name='segments', on_delete=models.CASCADE)
    text = models.TextField()
    speaker = models.CharField(max_length=100, null=True, blank=True)
    start_time = models.FloatField()  # in seconds
    end_time = models.FloatField()  # in seconds
    is_final = models.BooleanField(default=False)

    class Meta:
        ordering = ['start_time']

    def __str__(self):
        return f"{self.speaker}: {self.text[:50]}..."
```

### 5. Create WebSocket Consumer

Create `backend/transcription/consumers.py`:

```python
import asyncio
import json
import logging
import os

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async

from deepgram import (
    DeepgramClient,
    DeepgramClientOptions,
    LiveTranscriptionEvents,
    LiveOptions,
)

from .models import TranscriptSegment, Transcription

logger = logging.getLogger(__name__)

# Load Deepgram API Key from environment variable
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
if not DEEPGRAM_API_KEY:
    logger.error("DEEPGRAM_API_KEY environment variable not set!")
    # Handle missing key appropriately in production (e.g., raise exception)

class TranscriptionConsumer(AsyncWebsocketConsumer):
    """
    Handles WebSocket connections for live transcription using Deepgram SDK.
    """
    async def connect(self):
        """
        Called when the WebSocket connection is opened from the frontend.
        Establishes connection to Deepgram's streaming API.
        """
        try:
            # Extract transcription_id from the URL route
            self.transcription_id = self.scope['url_route']['kwargs']['transcription_id']
            self.transcription_group_name = f'transcription_{self.transcription_id}'
            logger.info(f"Client connecting for transcription_id: {self.transcription_id}")
        except KeyError:
            logger.error("Could not extract transcription_id from URL scope.")
            await self.close(code=4001) # Custom close code for missing ID
            return

        # Accept the WebSocket connection from the client *first*
        await self.accept()
        logger.info(f"Client WebSocket connection accepted for {self.transcription_id}")

        # Initialize Deepgram client configuration
        config: DeepgramClientOptions = DeepgramClientOptions(
            verbose=logging.DEBUG # Or logging.INFO
        )
        # Initialize Deepgram client
        deepgram: DeepgramClient = DeepgramClient(DEEPGRAM_API_KEY, config)

        # Create the Deepgram live transcription connection object
        try:
            # Using SDK v3 syntax for async live connection
            self.dg_connection = deepgram.listen.asynclive.v("1")

            # Register event listeners
            self.dg_connection.on(LiveTranscriptionEvents.Transcript, self.on_deepgram_message)
            self.dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, self.on_deepgram_utterance_end)
            self.dg_connection.on(LiveTranscriptionEvents.SpeechStarted, self.on_deepgram_speech_started)
            self.dg_connection.on(LiveTranscriptionEvents.Error, self.on_deepgram_error)
            self.dg_connection.on(LiveTranscriptionEvents.Close, self.on_deepgram_close)

            # Define Deepgram options
            options: LiveOptions = LiveOptions(
                model="nova-2", # Or your preferred model
                language="en", # Or desired language
                encoding="linear16", # Ensure this matches frontend if sending raw PCM
                sample_rate=16000,   # Ensure this matches frontend if sending raw PCM
                punctuate=True,
                interim_results=True,
                diarize=True, # Enable speaker diarization
                smart_format=True,
            )

            # Start the Deepgram connection
            if not await self.dg_connection.start(options):
                logger.error("Failed to start Deepgram connection.")
                await self.close(code=1011) # Internal error
                return

            logger.info(f"Successfully connected to Deepgram for {self.transcription_id}")
            await self.send_client_message('status', 'Deepgram connection successful. Ready for audio.')

        except Exception as e:
            logger.error(f"Error initializing or starting Deepgram connection: {e}", exc_info=True)
            await self.send_client_message('error', f"Could not connect to transcription service: {e}")
            await self.close(code=1011)

    async def disconnect(self, close_code):
        """
        Called when the WebSocket connection from the frontend closes.
        Cleans up the Deepgram connection.
        """
        logger.info(f"Client WebSocket disconnecting for {self.transcription_id} with code: {close_code}")

        # Gracefully close the Deepgram connection if it exists and is open
        if hasattr(self, 'dg_connection') and self.dg_connection:
            logger.info("Attempting to close Deepgram connection...")
            await self.dg_connection.finish()
            logger.info("Deepgram connection finish called.")

        logger.info(f"Client WebSocket disconnected fully for {self.transcription_id}")

    async def receive(self, text_data=None, bytes_data=None):
        """
        Called when a message is received from the client's WebSocket.
        """
        if text_data:
            logger.debug(f"Received text data (ignoring): {text_data}")
            # Handle potential control messages if needed

        elif bytes_data:
            # Received an audio chunk from the frontend
            if hasattr(self, 'dg_connection') and self.dg_connection:
                # Send the audio data to Deepgram
                await self.dg_connection.send(bytes_data)
            else:
                logger.warning("Received audio data, but Deepgram connection is not active.")

    # --- Deepgram Event Handlers ---

    async def on_deepgram_message(self, *args, result, **kwargs):
        """
        Handles 'Transcript' events from the Deepgram SDK.
        """
        try:
            sentence = result.channel.alternatives[0].transcript
            speaker = None
            start_time = result.start
            end_time = start_time + result.duration

            # Get speaker from word level if diarization is enabled
            if result.channel.alternatives[0].words:
                speaker_id_num = result.channel.alternatives[0].words[0].speaker
                speaker = f"speaker_{speaker_id_num}"

            if sentence:
                is_final = result.is_final
                speech_final = result.speech_final

                logger.debug(f"DG Transcript: Final={is_final}, SpeechFinal={speech_final}, Speaker={speaker}, Text='{sentence}'")

                # Send the transcription segment to the frontend client
                await self.send_client_message(
                    'transcript_segment',
                    {
                        'text': sentence,
                        'is_final': is_final,
                        'speech_final': speech_final,
                        'speaker': speaker,
                        'start': start_time,
                        'end': end_time,
                    }
                )

                # Save final segments to the database
                if speech_final or is_final:
                    await self.save_transcript_segment(
                        sentence, speaker, start_time, end_time, is_final, speech_final
                    )

        except Exception as e:
            logger.error(f"Error processing Deepgram message: {e}", exc_info=True)

    async def on_deepgram_speech_started(self, *args, **kwargs):
        logger.debug("Deepgram detected speech started.")
        await self.send_client_message('event', {'type': 'speech_started'})

    async def on_deepgram_utterance_end(self, *args, **kwargs):
        logger.debug("Deepgram detected utterance end.")
        await self.send_client_message('event', {'type': 'utterance_end'})

    async def on_deepgram_error(self, *args, error, **kwargs):
        logger.error(f"Received error from Deepgram: {error}")
        error_message = str(error.message) if hasattr(error, 'message') else str(error)
        await self.send_client_message('error', f"Transcription service error: {error_message}")
        await self.close(code=1011)

    async def on_deepgram_close(self, *args, **kwargs):
        logger.info("Deepgram connection closed.")

    # --- Utility Methods ---

    async def send_client_message(self, message_type, data):
        """ Helper to send structured JSON messages to the client WebSocket. """
        await self.send(text_data=json.dumps({
            'type': message_type,
            'payload': data,
        }))

    async def save_transcript_segment(self, text, speaker, start_time, end_time, is_final, speech_final):
        """
        Save a transcript segment to the database.
        """
        if not text:
            return

        try:
            transcription_instance = Transcription.objects.aget(id=self.transcription_id)
            TranscriptSegment.objects.acreate(
                transcription=transcription_instance,
                text=text,
                speaker_label=speaker,
                start_time_offset=start_time,
                end_time_offset=end_time,
            )
            logger.info(f"Saved segment for {self.transcription_id}: Speaker={speaker}, Text='{text[:50]}...'")
        except Transcription.DoesNotExist:
            logger.error(f"Transcription with id {self.transcription_id} not found. Cannot save segment.")
        except Exception as e:
            logger.error(f"Error saving transcript segment to DB: {e}", exc_info=True)
```

### 6. Set Up WebSocket Routing

Create `backend/transcription/routing.py`:

```python
from django.urls import re_path
from . import consumers

websocket_urlpatterns = [
    re_path(r'ws/transcribe/(?P<transcription_id>\w+)$', consumers.TranscriptionConsumer.as_asgi()),
]
```

### 7. Create REST API with Django Ninja

Create `backend/transcription/api.py`:

```python
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
```

### 8. Update Project URLs

Update `backend/wstranscription/urls.py`:

```python
from django.contrib import admin
from django.urls import path
from transcription.api import api

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', api.urls),
]
```

## Part 2: Setting Up the Frontend

Now let's build our Next.js frontend that will record audio and display live transcription results.

### 1. Create the Next.js Project

```bash
mkdir -p frontend
cd frontend
npx create-next-app@latest . --ts --app --eslint
npm install axios websocket
```

### 2. Create WebSocket Service

Create `frontend/app/services/transcriptionService.ts`:

```typescript
interface TranscriptSegment {
  text: string;
  is_final: boolean;
  speech_final: boolean;
  speaker: string | null;
  start: number;
  end: number;
}

interface WebSocketMessage {
  type: string;
  payload: any;
}

class TranscriptionService {
  private websocket: WebSocket | null = null;
  private isConnected: boolean = false;
  private mediaRecorder: MediaRecorder | null = null;
  public onTranscriptReceived: ((data: TranscriptSegment) => void) | null = null;
  public onConnectionStatusChange: ((status: boolean) => void) | null = null;

  connect(transcriptionId: string): void {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${process.env.NEXT_PUBLIC_API_HOST}/ws/transcribe/${transcriptionId}`;

    this.websocket = new WebSocket(wsUrl);

    this.websocket.onopen = () => {
      console.log('WebSocket connection established');
      this.isConnected = true;
      if (this.onConnectionStatusChange) {
        this.onConnectionStatusChange(true);
      }
    };

    this.websocket.onmessage = (event: MessageEvent) => {
      const data: WebSocketMessage = JSON.parse(event.data);

      if (data.type === 'transcript_segment' && this.onTranscriptReceived) {
        this.onTranscriptReceived(data.payload as TranscriptSegment);
      } else if (data.type === 'status' || data.type === 'error') {
        console.log(`${data.type}:`, data.payload);
      }
    };

    this.websocket.onclose = () => {
      console.log('WebSocket connection closed');
      this.isConnected = false;
      if (this.onConnectionStatusChange) {
        this.onConnectionStatusChange(false);
      }
    };

    this.websocket.onerror = (error: Event) => {
      console.error('WebSocket error:', error);
      this.isConnected = false;
      if (this.onConnectionStatusChange) {
        this.onConnectionStatusChange(false);
      }
    };
  }

  startRecording(): void {
    if (!this.isConnected) {
      console.error('WebSocket not connected');
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        this.mediaRecorder = new MediaRecorder(stream);

        this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0 && this.isConnected && this.websocket) {
            this.websocket.send(event.data);
          }
        };

        // Set up audio chunk intervals (smaller for more real-time experience)
        this.mediaRecorder.start(100); // Get data every 100ms
        console.log('Recording started');
      })
      .catch(error => {
        console.error('Error accessing microphone:', error);
      });
  }

  stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
      console.log('Recording stopped');
    }
  }

  disconnect(): void {
    this.stopRecording();

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
  }
}

// Singleton instance
const transcriptionService = new TranscriptionService();
export default transcriptionService;
```

### 3. Create the Transcription Component

Create `frontend/app/components/LiveTranscription.tsx`:

```typescript
'use client';

import React, { useState, useEffect, useRef } from 'react';
import transcriptionService from '../services/transcriptionService';

interface TranscriptSegment {
  text: string;
  is_final: boolean;
  speech_final: boolean;
  speaker: string | null;
  start: number;
  end: number;
}

interface LiveTranscriptionProps {
  transcriptionId: string;
}

export default function LiveTranscription({ transcriptionId }: LiveTranscriptionProps) {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom of transcript
  const scrollToBottom = () => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [transcript]);

  useEffect(() => {
    // Set up connection status handler
    transcriptionService.onConnectionStatusChange = (status: boolean) => {
      setIsConnected(status);
    };

    // Set up transcript receiver handler
    transcriptionService.onTranscriptReceived = (data: TranscriptSegment) => {
      setTranscript(prev => {
        // If this is a final version of a partial segment, replace it
        if (data.is_final) {
          // Filter out any partial segments with the same time range
          const filtered = prev.filter(segment =>
            !(segment.start === data.start && segment.end === data.end && !segment.is_final)
          );
          return [...filtered, data];
        } else {
          // For partial segments, add them but they might be replaced later
          return [...prev, data];
        }
      });
    };

    // Connect to WebSocket for this transcription
    transcriptionService.connect(transcriptionId);

    // Clean up on unmount
    return () => {
      transcriptionService.disconnect();
    };
  }, [transcriptionId]);

  const handleStartRecording = () => {
    if (!isConnected) {
      alert('WebSocket not connected. Please try again.');
      return;
    }

    transcriptionService.startRecording();
    setIsRecording(true);
  };

  const handleStopRecording = () => {
    transcriptionService.stopRecording();
    setIsRecording(false);
  };

  // Group transcript segments by speaker
  const groupedTranscript = transcript.reduce((groups: Record<string, TranscriptSegment[]>, segment) => {
    const speaker = segment.speaker || 'Unknown';
    if (!groups[speaker]) {
      groups[speaker] = [];
    }
    groups[speaker].push(segment);
    return groups;
  }, {});

  return (
    <div className="live-transcription">
      <div className="controls">
        <div className="status">
          Connection: {isConnected ? 'Connected' : 'Disconnected'}
        </div>
        {!isRecording ? (
          <button
            onClick={handleStartRecording}
            disabled={!isConnected}
            className="start-button"
          >
            Start Recording
          </button>
        ) : (
          <button
            onClick={handleStopRecording}
            className="stop-button"
          >
            Stop Recording
          </button>
        )}
      </div>

      <div className="transcript-container">
        {Object.entries(groupedTranscript).map(([speaker, segments], speakerIndex) => (
          <div key={speakerIndex} className="speaker-group">
            <div className="speaker-label">{speaker}</div>
            <div className="speaker-segments">
              {segments.map((segment, index) => (
                <div
                  key={`${segment.start}-${index}`}
                  className={`segment ${segment.is_final ? 'final' : 'partial'}`}
                >
                  {segment.text}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div ref={transcriptEndRef} />
      </div>

      <style jsx>{`
        .live-transcription {
          display: flex;
          flex-direction: column;
          height: 100%;
          max-width: 800px;
          margin: 0 auto;
        }

        .controls {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem;
          background-color: #f5f5f5;
          border-bottom: 1px solid #ccc;
        }

        .start-button, .stop-button {
          padding: 0.5rem 1rem;
          border: none;
          border-radius: 4px;
          font-weight: bold;
          cursor: pointer;
        }

        .start-button {
          background-color: #4caf50;
          color: white;
        }

        .start-button:disabled {
          background-color: #cccccc;
          cursor: not-allowed;
        }

        .stop-button {
          background-color: #f44336;
          color: white;
        }

        .transcript-container {
          flex: 1;
          padding: 1rem;
          overflow-y: auto;
          background-color: white;
        }

        .speaker-group {
          margin-bottom: 1.5rem;
        }

        .speaker-label {
          font-weight: bold;
          margin-bottom: 0.5rem;
          color: #333;
        }

        .segment {
          margin-bottom: 0.25rem;
          line-height: 1.5;
        }

        .partial {
          opacity: 0.7;
        }

        .final {
          opacity: 1;
        }
      `}</style>
    </div>
  );
}
```

### 4. Create a Transcription Page

Create `frontend/app/transcriptions/[id]/page.tsx`:

```typescript
'use client';

import LiveTranscription from '../../components/LiveTranscription';

interface TranscriptionPageProps {
  params: {
    id: string;
  };
}

export default function TranscriptionPage({ params }: TranscriptionPageProps) {
  const transcriptionId = params.id;

  return (
    <div className="transcription-page">
      <header>
        <h1>Transcription #{transcriptionId}</h1>
      </header>

      <main>
        <LiveTranscription transcriptionId={transcriptionId} />
      </main>

      <style jsx>{`
        .transcription-page {
          display: flex;
          flex-direction: column;
          height: 100vh;
        }

        header {
          padding: 1rem 2rem;
          background-color: #2c3e50;
          color: white;
        }

        main {
          flex: 1;
          overflow: hidden;
        }
      `}</style>
    </div>
  );
}
```

### 5. Configure Environment Variables

Create `frontend/.env.local`:

```
NEXT_PUBLIC_API_HOST=localhost:8000
```

## Part 3: Running the Application

### 1. Start the Backend

```bash
cd backend

# Start Redis for Channels
docker run -p 6379:6379 -d redis:alpine

# Run migrations
uv run python manage.py makemigrations
uv run python manage.py migrate

# Start the Django server with Daphne
daphne -b 0.0.0.0 -p 8000 wstranscription.asgi:application
```

### 2. Start the Frontend

```bash
cd frontend
npm run dev
```

Now your application should be accessible at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000/api/

## Conclusion

You've now built a complete real-time transcription system using WebSockets with Django Channels on the backend and Next.js on the frontend. The system:

1. Captures audio from the user's microphone
2. Streams the audio data to the backend via WebSockets
3. Forwards the audio to Deepgram for real-time transcription with speaker diarization
4. Receives transcription results and forwards them to the frontend
5. Displays the transcription results in real-time with speaker identification

This architecture provides a responsive user experience with minimal latency, making it suitable for applications like meeting transcription, medical dictation, and more.

Future enhancements could include:
- Adding authentication to secure WebSocket connections
- Implementing error recovery and reconnection logic
- Adding post-processing features like summarization or note generation

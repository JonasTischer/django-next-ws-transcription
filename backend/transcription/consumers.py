import json
import logging
import os

from channels.generic.websocket import AsyncWebsocketConsumer

from deepgram import (
    DeepgramClient,
    DeepgramClientOptions,
    LiveTranscriptionEvents,
    LiveOptions,
)
logger = logging.getLogger(__name__)

class TranscriptionConsumer(AsyncWebsocketConsumer):
    """
    Handles WebSocket connections for live transcription using Deepgram SDK.
    """
    async def connect(self):
        """
        Called when the WebSocket connection is opened from the frontend.
        Establishes connection to Deepgram's streaming API.
        """
        from transcription.models import Transcription
        try:
            # Extract encounter_id (or transcription_id) from the URL route
            # Ensure your routing.py captures this correctly
            self.transcription_id = self.scope['url_route']['kwargs']['transcription_id']
            self.room_group_name = f'transcription_{self.transcription_id}'
            logger.info(f"Client connecting for transcription_id: {self.transcription_id}")
        except KeyError:
            logger.error("Could not extract transcription_id from URL scope.")
            await self.close(code=4001) # Custom close code for missing ID
            return

        # --- Authentication/Authorization of the client connection would go here ---

        # Join room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )

        # Accept the WebSocket connection from the client *first*
        await self.accept()
        logger.info(f"Client WebSocket connection accepted for {self.transcription_id}")

        # Initialize Deepgram client configuration
        # You can customize options like logging level, etc.
        config: DeepgramClientOptions = DeepgramClientOptions(
            verbose=logging.DEBUG # Or logging.INFO
            # You might add options like 'keepalive': 'true' if needed
        )

        # Initialize Deepgram client
        deepgram: DeepgramClient = DeepgramClient(os.getenv("DEEPGRAM_API_KEY"), config)

        # Create the Deepgram live transcription connection object
        try:
            # Using SDK v3 syntax for async live connection
            self.dg_connection = deepgram.listen.asynclive.v("1")

            # Register event listeners (methods defined below)
            self.dg_connection.on(LiveTranscriptionEvents.Transcript, self.on_deepgram_message)
            self.dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, self.on_deepgram_utterance_end)
            self.dg_connection.on(LiveTranscriptionEvents.SpeechStarted, self.on_deepgram_speech_started)
            self.dg_connection.on(LiveTranscriptionEvents.Error, self.on_deepgram_error)
            self.dg_connection.on(LiveTranscriptionEvents.Close, self.on_deepgram_close)
            # Add listeners for other events as needed (Metadata, SpeakerStarted)

            # Define Deepgram options
            options: LiveOptions = LiveOptions(
                model="nova-2", # Or your preferred model
                language="en", # Or desired language
                # encoding="linear16", # Ensure this matches frontend if sending raw PCM
                # sample_rate=16000,   # Ensure this matches frontend if sending raw PCM
                # channels=1, # Usually default is 1, specify if needed
                punctuate=True,
                interim_results=True,
                diarize=True, # Enable speaker diarization
                # Add other options like 'endpointing', 'vad_events', etc.
            )

            # Start the Deepgram connection
            # This returns True on success, False on failure
            if not await self.dg_connection.start(options):
                logger.error("Failed to start Deepgram connection.")
                await self.close(code=4000) # Internal error - Use valid code
                return

            logger.info(f"Successfully connected to Deepgram for {self.transcription_id}")
            await self.send_client_message('status', 'Deepgram connection successful. Ready for audio.')

        except Exception as e:
            logger.error(f"Error initializing or starting Deepgram connection: {e}", exc_info=True)
            await self.send_client_message('error', f"Could not connect to transcription service: {e}")
            await self.close(code=4000) # Internal error - Use valid code

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
            # SDK should trigger the on_deepgram_close event upon successful finish
            logger.info("Deepgram connection finish called.")

        # Leave room group
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

        logger.info(f"Client WebSocket disconnected fully for {self.transcription_id}")

    async def receive(self, text_data=None, bytes_data=None):
        """
        Called when a message is received from the client's WebSocket.
        """
        from transcription.models import TranscriptSegment
        if text_data:
            logger.debug(f"Received text data (ignoring): {text_data}")
            # Handle potential control messages if needed
            # e.g., if text_data == '{"type": "stop"}': await self.disconnect(1000)

        elif bytes_data:
            # Received an audio chunk from the frontend
            # logger.debug(f"Received audio chunk: {len(bytes_data)} bytes") # Can be very verbose
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
            # The 'result' object is already parsed by the SDK
            # Refer to Deepgram documentation for the exact structure of 'result'
            # based on your chosen options (diarize, etc.)
            # Example structure (may vary slightly):
            # result.channel.alternatives[0].transcript
            # result.channel.alternatives[0].words -> List[Word] (Word has word, start, end, speaker, confidence)
            # result.is_final
            # result.speech_final (indicates end of an utterance)

            sentence = result.channel.alternatives[0].transcript
            speaker = None # Placeholder
            start_time = result.start # Start time of the result segment
            end_time = start_time + result.duration # Calculate end time

            # Attempt to get speaker from word level if diarization is enabled
            if result.channel.alternatives[0].words:
                 # Use speaker of the first word in the segment as representative
                 speaker_id_num = result.channel.alternatives[0].words[0].speaker
                 speaker = f"speaker_{speaker_id_num}" # Format as string

            if sentence: # Only process if there's text
                is_final = result.is_final # Whether the segment itself is final
                speech_final = result.speech_final # Whether this marks the end of speech segment

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
                        # Include word-level details if needed by frontend
                        # 'words': [w.to_dict() for w in result.channel.alternatives[0].words]
                    }
                )

                # Save final segments to the database asynchronously
                # Use speech_final=True to mark utterance ends, or is_final=True for segment ends
                if speech_final or is_final:
                    # Trigger background save - consider batching saves if performance is an issue
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
        """ Handles error events from the Deepgram SDK. """
        logger.error(f"Received error from Deepgram: {error}")
        error_message = str(error.message) if hasattr(error, 'message') else str(error)
        await self.send_client_message('error', f"Transcription service error: {error_message}")
        # Optionally close the client connection on critical errors
        await self.close(code=4000) # Internal Error - Use valid code

    async def on_deepgram_close(self, *args, **kwargs):
        """ Handles the close event from the Deepgram SDK connection. """
        logger.info("Deepgram connection closed.")
        # You might want to inform the client or attempt to reconnect depending on the close reason
        # await self.send_client_message('status', 'Transcription service connection closed.')
        # await self.close(code=1000) # Normal closure initiated by backend

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
        Runs in a synchronous context managed by database_sync_to_async.
        """
        # Use speech_final or is_final to decide what constitutes a savable segment
        # This logic might need refinement based on desired granularity
        if not text:
            return # Don't save empty segments

        try:
            from transcription.models import Transcription, TranscriptSegment
            # Assuming Transcription model exists and ID is valid
            transcription_instance = Transcription.objects.aget(id=self.transcription_id)

            # Create the segment - adjust field names based on your actual model
            TranscriptSegment.objects.acreate(
                transcription=transcription_instance, # Foreign key instance
                text=text,
                speaker_label=speaker, # Field name from praxibot_db_schema_v2
                start_time_offset=start_time, # Field name suggestion
                end_time_offset=end_time, # Field name suggestion
                # Add other fields like is_final if your model has them
            )
            logger.info(f"Saved segment for {self.transcription_id}: Speaker={speaker}, Text='{text[:50]}...'")
        except Transcription.DoesNotExist:
             logger.error(f"Transcription with id {self.transcription_id} not found. Cannot save segment.")
        except Exception as e:
            logger.error(f"Error saving transcript segment to DB: {e}", exc_info=True)

    async def transcription_message(self, event):
        message = event['message']

        # Send message to WebSocket
        await self.send(text_data=json.dumps({
            'message': message
        }))


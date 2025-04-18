'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useMicrophone, MicrophoneState, MicrophoneEvents } from '../context/MicrophoneContext';
import simpleBackendService, { TranscriptSegment, BackendConnectionStatus } from '../services/transcriptionService';
import Visualizer from './Visualizer';

interface LiveTranscriptionProps {
  transcriptionId: string;
}

export default function LiveTranscription({ transcriptionId }: LiveTranscriptionProps) {
  // --- State Variables ---
  const { setupMicrophone, microphone, startMicrophone, stopMicrophone, microphoneState } =
    useMicrophone();
  const [backendStatus, setBackendStatus] = useState<BackendConnectionStatus>('disconnected');
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // --- Scroll function ---
  const scrollToBottom = () => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  useEffect(() => { scrollToBottom(); }, [transcript]);

  // --- Initial Setup ---
  useEffect(() => {
    console.log("Requesting microphone setup...");
    setupMicrophone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount

  // --- Backend Connection ---
  useEffect(() => {
    if (microphoneState === MicrophoneState.Ready && backendStatus === 'disconnected') {
      console.log("Microphone ready, attempting backend connection...");
      setIsProcessing(true);
      setErrorMessage(null);
      setBackendStatus('connecting');

      simpleBackendService.connect(
        transcriptionId,
        handleBackendMessage,
        handleBackendError,
        handleBackendClose
      ).then(connected => {
        if (connected) {
          console.log("Backend connected successfully.");
          setBackendStatus('connected');
          setIsProcessing(false);
        } else {
          console.error("Backend connection failed.");
          if (!errorMessage) setErrorMessage('Failed to connect to backend.');
          setBackendStatus('disconnected'); // Or 'error' if connect provides details
          setIsProcessing(false);
        }
      }).catch(err => {
          console.error("Error during backend connection:", err);
          setErrorMessage(`Error connecting to backend: ${err instanceof Error ? err.message : String(err)}`);
          setBackendStatus('error');
          setIsProcessing(false);
      });
    }
  }, [microphoneState, backendStatus, transcriptionId]); // Dependencies for connection logic

  // --- Data Handling (Microphone -> Backend & Backend -> UI) ---
  useEffect(() => {
    if (!microphone || backendStatus !== 'connected') {
      return; // Exit if mic not ready or backend not connected
    }

    const handleMicData = (event: BlobEvent) => {
      if (event.data.size > 0 && backendStatus === 'connected') {
        simpleBackendService.sendAudio(event.data);
      }
    };

    // Start microphone and add listener only when backend is connected
    if (microphoneState === MicrophoneState.Ready || microphoneState === MicrophoneState.Paused) {
        console.log("Backend connected, starting microphone and adding data listener.");
        startMicrophone(); // Should change state to Opening -> Open
        microphone.addEventListener(MicrophoneEvents.DataAvailable, handleMicData);
    } else if (microphoneState === MicrophoneState.Open) {
        // If already open (e.g., reconnect), ensure listener is attached
         console.log("Microphone already open, ensuring data listener is attached.");
         // Remove first to avoid duplicates if effect re-runs unexpectedly
         microphone.removeEventListener(MicrophoneEvents.DataAvailable, handleMicData);
         microphone.addEventListener(MicrophoneEvents.DataAvailable, handleMicData);
    }


    // Cleanup function for this effect
    return () => {
      console.log("Cleaning up microphone data listener.");
      microphone.removeEventListener(MicrophoneEvents.DataAvailable, handleMicData);
      // We might stop the mic here *if* the backend disconnects,
      // but handleStop and handleBackendClose/Error handle stopping for other cases.
    };
    // Rerun when mic instance, state, or backend status changes
  }, [microphone, microphoneState, backendStatus, startMicrophone]);


  // --- Backend WebSocket Callbacks (Minor adjustments for state consistency) ---
  const handleBackendMessage = useCallback((type: 'transcript_segment' | 'status' | 'error' | 'event', payload: any) => {
      // Removed isMountedRef check
      if (type === 'transcript_segment') {
            setTranscript(prev => {
                const data = payload as TranscriptSegment;
                const existingIndex = prev.findIndex(s => s.start === data.start && !s.is_final); // Renamed for clarity

                if (!data.is_final && existingIndex > -1) {
                    // Replace existing partial segment
                    const nextTranscript = [...prev];
                    nextTranscript[existingIndex] = data;
                    return nextTranscript.sort((a, b) => a.start - b.start);
                } else {
                     // Remove any prior partial for this start time if current is final, then add
                    const filtered = data.is_final ? prev.filter(s => !(s.start === data.start && !s.is_final)) : prev;
                    return [...filtered, data].sort((a, b) => a.start - b.start);
                }
            });
      } else if (type === 'error') {
          console.error(`Backend Error Payload: ${payload}`);
          setErrorMessage(`Backend Error: ${payload}`);
          stopMicrophone(); // Stop mic on backend error
          simpleBackendService.disconnect(); // Ensure backend disconnect
          setBackendStatus('error');
          setIsProcessing(false);
      } else if (type === 'status') {
           console.log(`Backend Status Message: ${payload}`);
           // Could update UI based on specific status messages if needed
      } else if (type === 'event') {
            console.log(`Backend Event: ${payload}`);
            // Handle specific events like 'speech_started', 'speech_ended' if backend sends them
      }
  }, [stopMicrophone]); // Added stopMicrophone dependency

  const handleBackendError = useCallback((message: string) => {
      console.error(`Backend WS Error Callback: ${message}`);
      setErrorMessage(`WebSocket Error: ${message}`);
      setBackendStatus('error');
      stopMicrophone(); // Stop mic on WS error
      // Backend service likely closed already, but ensure state reflects it
      setIsProcessing(false);
  }, [stopMicrophone]); // Added stopMicrophone dependency

  const handleBackendClose = useCallback((event: CloseEvent) => {
       console.log(`Backend WS Closed: Code=${event.code}, Clean=${event.wasClean}, Reason=${event.reason}`);
       setBackendStatus('disconnected');
       // Only show error if closed unexpectedly during active recording
       if (!event.wasClean && microphoneState === MicrophoneState.Open) {
            setErrorMessage(`Connection closed unexpectedly (Code: ${event.code})`);
       }
       // Ensure mic is stopped if backend closes while it might be running
       if (microphoneState === MicrophoneState.Open || microphoneState === MicrophoneState.Opening || microphoneState === MicrophoneState.Paused || microphoneState === MicrophoneState.Pausing) {
           stopMicrophone();
       }
       setIsProcessing(false);
       setTranscript([]); // Clear transcript on disconnect? Optional.
  }, [microphoneState, stopMicrophone]); // Added dependencies

  // --- Component Unmount Cleanup ---
  useEffect(() => {
    return () => {
        console.log('LiveTranscription unmounting: stopping mic and disconnecting backend.');
        if (microphone && (microphone.state === 'recording' || microphone.state === 'paused')) {
            stopMicrophone();
        }
        simpleBackendService.disconnect();
    };
  }, [microphone, stopMicrophone]); // Ensure microphone instance is available for check

  // --- Button Handlers ---
  const handleStart = () => {
      // Start is now implicitly handled by useEffect when mic is Ready and backend Connects
      // This button could potentially trigger setupMicrophone again if needed,
      // but the main flow relies on useEffect.
      // For simplicity, let's make Start attempt setup if not ready.
      if (microphoneState === MicrophoneState.NotSetup || microphoneState === MicrophoneState.Error) {
          console.log("Start clicked: Triggering microphone setup...");
          setIsProcessing(true); // Show immediate feedback
          // Wrap setupMicrophone in try/catch as it doesn't return a promise
          try {
              setupMicrophone();
              // setIsProcessing will be cleared by effects or if setup fails
          } catch (err: any) { // Explicitly type err
              console.error("Error during explicit setupMicrophone call:", err);
              setErrorMessage(`Microphone setup failed: ${err.message || 'Unknown error'}`);
              setIsProcessing(false); // Clear processing if setup fails immediately
          }
      } else {
          console.log("Start clicked, but microphone is already setting up or ready. Waiting for connection...");
          // Optionally provide feedback, though useEffect handles the connection logic
           if (backendStatus === 'disconnected' && microphoneState === MicrophoneState.Ready) {
               setIsProcessing(true); // Indicate connection attempt is in progress
           }
      }
  };

  const handleStop = () => {
      console.log('Stop requested by user.');
      setIsProcessing(true); // Indicate stopping process
      stopMicrophone(); // Stop recording first
      simpleBackendService.disconnect(); // Then disconnect backend
      setBackendStatus('disconnected'); // Explicitly set status
      setErrorMessage(null); // Clear any previous errors
      setTranscript([]); // Clear transcript on stop
      // setIsProcessing will be set to false by handleBackendClose or WS error callbacks
      // or immediately if already disconnected/stopped
      if (backendStatus === 'disconnected' && microphoneState !== MicrophoneState.Open && microphoneState !== MicrophoneState.Pausing) {
           setIsProcessing(false);
      }
  };

  // --- UI Render Logic ---
  const getMicStatusText = (state: MicrophoneState | null): string => {
      if (state === null) return 'Initializing';
      switch (state) {
          case MicrophoneState.NotSetup: return 'Not Setup';
          case MicrophoneState.SettingUp: return 'Setting Up...';
          case MicrophoneState.Ready: return 'Ready';
          case MicrophoneState.Opening: return 'Opening...';
          case MicrophoneState.Open: return 'Recording';
          case MicrophoneState.Error: return 'Mic Error';
          case MicrophoneState.Pausing: return 'Pausing...';
          case MicrophoneState.Paused: return 'Paused';
          default: return 'Unknown';
      }
  };
  const uiMicStatusText = getMicStatusText(microphoneState);

  // Button visibility/state logic based on new MicrophoneState
  const canStart = microphoneState === MicrophoneState.Ready ||
                   microphoneState === MicrophoneState.Paused ||
                   microphoneState === MicrophoneState.NotSetup || // Allow initiating setup
                   microphoneState === MicrophoneState.Error;     // Allow retrying setup

  const canStop = microphoneState === MicrophoneState.Open ||
                  microphoneState === MicrophoneState.Opening || // Allow stopping during opening
                  microphoneState === MicrophoneState.Paused ||  // Allow stopping if paused
                  microphoneState === MicrophoneState.Pausing; // Allow stopping during pausing


  const isStartDisabled = isProcessing ||
                         microphoneState === MicrophoneState.SettingUp ||
                         microphoneState === MicrophoneState.Opening ||
                         (microphoneState === MicrophoneState.Ready && backendStatus === 'connecting');


  const isStopDisabled = isProcessing ||
                        microphoneState === MicrophoneState.NotSetup ||
                        microphoneState === MicrophoneState.Ready || // Can't stop if only ready
                        microphoneState === MicrophoneState.SettingUp ||
                        microphoneState === MicrophoneState.Error;


  let startButtonText = 'Start Recording';
  if (isProcessing && (microphoneState === MicrophoneState.SettingUp || backendStatus === 'connecting')) {
      startButtonText = 'Initializing...';
  } else if (isProcessing) {
       startButtonText = 'Processing...';
  } else if (microphoneState === MicrophoneState.Paused) {
      startButtonText = 'Resume Recording'; // Or keep as 'Start' if resume isn't explicit concept here
  }

  let stopButtonText = 'Stop Recording';
   if (isProcessing && (microphoneState === MicrophoneState.Pausing || backendStatus === 'disconnected')) {
        stopButtonText = 'Stopping...';
   } else if (isProcessing) {
       stopButtonText = 'Processing...';
   }

  return (
     <div className="live-transcription">
       <div className="visualizer-container">
            {/* Pass the MediaRecorder instance directly */}
            {microphone && <Visualizer microphone={microphone} />}
       </div>

       <div className="controls">
        <div className="status-section">
          <div className="status">
             {/* Added specific classes for backend status */}
            Backend: <span className={`status-backend status-${backendStatus}`}>{backendStatus}</span>
          </div>
          <div className="status">
             {/* Added specific classes for mic status */}
            Microphone: <span className={`status-mic status-mic-${microphoneState ?? 'null'}`}>{uiMicStatusText}</span>
          </div>
        </div>

        <div className="button-section">
          {canStart && (
            <button
              onClick={handleStart}
              disabled={isStartDisabled}
              className="button start-button"
              title={microphoneState === MicrophoneState.Error ? "Mic Error - Retry?" : "Start Recording"}
            >
              {startButtonText}
            </button>
          )}
          {canStop && (
            <button
              onClick={handleStop}
              disabled={isStopDisabled}
              className="button stop-button"
            >
             {stopButtonText}
            </button>
          )}
        </div>
      </div>

      {errorMessage && (
        <div className="error-message">
          {errorMessage}
        </div>
      )}

      <div className="transcript-container">
        {transcript.length === 0 && !isProcessing && microphoneState !== MicrophoneState.Open && microphoneState !== MicrophoneState.Opening && (
            <div className="placeholder">
                 {microphoneState === MicrophoneState.Error ? 'Microphone setup failed. Try starting again.'
                 : backendStatus === 'error' ? `Backend connection error: ${errorMessage || 'Unknown'}`
                 : (microphoneState === MicrophoneState.NotSetup || microphoneState === MicrophoneState.Ready) ? 'Press Start Recording'
                 : backendStatus === 'disconnected' ? 'Disconnected. Press Start Recording to reconnect.'
                 : 'Waiting for audio...' // Default placeholder
                 }
            </div>
         )}
        {transcript.map((segment, index) => (
             <div key={`${segment.start}-${index}-${segment.is_final}`}
                  className={`segment ${segment.is_final ? 'final' : 'partial'}`}>
               {segment.speaker && <span className="speaker-label">{segment.speaker}: </span>}
               {segment.text}
             </div>
         ))}
        <div ref={transcriptEndRef} />
      </div>

      {/* Styles need updates for new status classes */}
      <style jsx>{`
        .live-transcription { display: flex; flex-direction: column; height: 100%; max-height: 90vh; max-width: 800px; margin: 1rem auto; border: 1px solid #ccc; border-radius: 8px; overflow: hidden; position: relative; padding-top: 100px; }
        .visualizer-container { position: absolute; top: 0; left: 0; width: 100%; height: 100px; background-color: #111; z-index: 0; }
        .controls { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; padding: 0.8rem 1rem; background-color: rgba(248, 249, 250, 0.9); border-bottom: 1px solid #dee2e6; gap: 1rem; position: relative; z-index: 1; }
        .status-section { display: flex; flex-direction: column; gap: 0.25rem; }
        .status { font-size: 0.9rem; color: #495057; }
        .status span { font-weight: bold; padding: 0.1rem 0.4rem; border-radius: 3px; color: white; } /* Base style */

        /* Backend Status Styles */
        .status-backend.status-connecting { background-color: #ffc107; color: black; }
        .status-backend.status-connected { background-color: #28a745; }
        .status-backend.status-disconnected { background-color: #6c757d; }
        .status-backend.status-error { background-color: #dc3545; }

        /* Microphone Status Styles (using MicrophoneState enum values) */
        .status-mic { background-color: #6c757d; } /* Default/NotSetup */
        .status-mic.status-mic-${MicrophoneState.SettingUp} { background-color: #ffc107; color: black; }
        .status-mic.status-mic-${MicrophoneState.Ready} { background-color: #17a2b8; } /* Info blue */
        .status-mic.status-mic-${MicrophoneState.Opening} { background-color: #007bff; } /* Primary blue */
        .status-mic.status-mic-${MicrophoneState.Open} { background-color: #28a745; } /* Success green */
        .status-mic.status-mic-${MicrophoneState.Error} { background-color: #dc3545; } /* Danger red */
        .status-mic.status-mic-${MicrophoneState.Pausing} { background-color: #ffc107; color: black; } /* Warning yellow */
        .status-mic.status-mic-${MicrophoneState.Paused} { background-color: #6c757d; } /* Secondary gray */
        .status-mic.status-mic-null { background-color: #6c757d; } /* Initializing */


        .button-section { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .button { padding: 0.6rem 1.2rem; border: none; border-radius: 5px; font-weight: 500; cursor: pointer; transition: background-color 0.2s ease; font-size: 0.9rem; color: white; }
        .button:disabled { opacity: 0.6; cursor: not-allowed; }
        .start-button { background-color: #28a745; }
        .stop-button { background-color: #dc3545; }
        .error-message { padding: 0.8rem 1rem; background-color: #f8d7da; color: #721c24; border-bottom: 1px solid #f5c6cb; text-align: center; font-size: 0.9rem; }
        .transcript-container { flex: 1; padding: 1rem 1.5rem; overflow-y: auto; background-color: white; line-height: 1.6; color: #333; }
        .placeholder { text-align: center; color: #6c757d; margin-top: 2rem; font-style: italic; padding: 1rem; }
        .segment { margin-bottom: 0.5rem; padding: 0.25rem 0.5rem; border-radius: 4px; }
        .partial { opacity: 0.7; background-color: #f0f0f0; }
        .final { opacity: 1; background-color: #e9ecef; }
        .speaker-label { font-weight: bold; margin-right: 0.5em; color: #0056b3; }
      `}</style>
     </div>
  );
}
// Define possible connection states for the backend WebSocket
export type BackendConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// Re-define TranscriptSegment if not imported globally
export interface TranscriptSegment {
  text: string;
  is_final: boolean;
  speech_final: boolean;
  speaker: string | null;
  start: number;
  end: number;
}

// Define structure for messages FROM backend (adjust based on consumers.py)
interface BackendWebSocketMessage {
  type: 'transcript_segment' | 'status' | 'error' | 'event';
  payload: any;
}

type MessageCallback = (type: 'transcript_segment' | 'status' | 'error' | 'event', payload: any) => void;
type ErrorCallback = (message: string) => void;
type CloseCallback = (event: CloseEvent) => void;

class SimpleBackendService {
  private websocket: WebSocket | null = null;

  // --- Callbacks (Set by the component) ---
  private onMessage: MessageCallback = () => {};
  private onError: ErrorCallback = () => {};
  private onClose: CloseCallback = () => {};

  // --- Public API Methods ---

  public connect(
    transcriptionId: string,
    onMessageCallback: MessageCallback,
    onErrorCallback: ErrorCallback,
    onCloseCallback: CloseCallback
  ): Promise<boolean> {
    return new Promise((resolve) => {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            console.warn('Backend WS already connected.');
            resolve(true);
            return;
        }
        if (this.websocket && this.websocket.readyState === WebSocket.CONNECTING) {
             console.warn('Backend WS connection already in progress.');
             // We could wait here, but simplest is to let the caller handle it or retry
             resolve(false);
             return;
        }

        // Assign callbacks
        this.onMessage = onMessageCallback;
        this.onError = onErrorCallback;
        this.onClose = onCloseCallback;

        // Construct WebSocket URL
        const apiHost = (process.env.NEXT_PUBLIC_API_HOST || 'localhost:8000').replace(/^https?:\/\//, '');
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${apiHost}/ws/transcribe/${transcriptionId}/`;

        console.log(`Attempting to connect Backend WS: ${wsUrl}`);

        try {
            this.websocket = new WebSocket(wsUrl);
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.onError(`Failed to create WebSocket: ${error instanceof Error ? error.message : String(error)}`);
            this.websocket = null;
            resolve(false);
            return;
        }

        this.websocket.onopen = () => {
            console.log('Backend WS Connected.');
            resolve(true); // Resolve promise on successful connection
        };

        this.websocket.onmessage = (event: MessageEvent) => {
            try {
                const message: BackendWebSocketMessage = JSON.parse(event.data);
                if (message.type === 'transcript_segment' || message.type === 'status' || message.type === 'error' || message.type === 'event') {
                    this.onMessage(message.type, message.payload);
                } else {
                    console.warn('Received unknown message type from backend:', message.type);
                }
            } catch (error) {
                console.error('Failed to parse message from backend:', event.data, error);
                this.onError('Received invalid message format from server.');
            }
        };

        this.websocket.onclose = (event: CloseEvent) => {
            console.log(`Backend WS closed: Code=${event.code}, Reason='${event.reason}', WasClean=${event.wasClean}`);
            this.onClose(event); // Notify component
            this.websocket = null; // Clear reference
        };

        this.websocket.onerror = (error: Event) => {
            console.error('Backend WS Error Event:', error);
            // Error event often precedes close event
            this.onError('WebSocket connection error occurred.');
             // onclose will likely be called after this, triggering cleanup
        };
    });
  }

  public disconnect(): void {
    console.log('Backend WS disconnect requested.');
    if (this.websocket) {
        if (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING) {
            this.websocket.close(1000, 'Client disconnecting normally');
        }
        // onclose handler will set websocket to null
    } else {
        console.log('Backend WS already disconnected.');
    }
  }

  public sendAudio(data: Blob): boolean {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(data);
      return true;
    } else {
      // console.warn('Cannot send audio: Backend WS not open.'); // Can be noisy
      return false;
    }
  }
}

// Export a new instance (or keep singleton if preferred, but might be less clean)
const simpleBackendService = new SimpleBackendService();
export default simpleBackendService;

// Removed redundant type exports - they are already exported where defined
// export type { TranscriptSegment, BackendConnectionStatus };
'use client';

import LiveTranscription from '../../../components/LiveTranscription';
import { MicrophoneContextProvider } from '@/context/MicrophoneContext';

import { useParams } from 'next/navigation'


export default function TranscriptionPage() {
  const params = useParams();
  const transcriptionId = params.id as string;

  if (!transcriptionId) {
    return <div>Loading or Invalid Transcription ID...</div>;
  }

  return (
    <MicrophoneContextProvider>
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
    </MicrophoneContextProvider>
  );
}
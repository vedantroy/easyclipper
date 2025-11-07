import { useEffect, useRef, useState } from 'react'
import { canUseWhisperWeb, downloadWhisperModel, resampleTo16Khz, toCaptions, transcribe } from '@remotion/whisper-web'
import { audioBufferToWav, loadAudioBuffer, trimAudioBuffer } from '@/lib/audio-utils'
import { formatTime } from '@/lib/time'
import type { CachedTranscript, Caption } from '@/types/transcript'

type ProcessingScreenProps = {
  file: File
  fileHash: string
  useChunking: boolean
  numChunks: number
  debugMode: boolean
  debugChunks: number
  onCancel: () => void
  onComplete: (fileHash: string, cacheData: CachedTranscript, totalTime: number) => Promise<void> | void
  // onError: (message: string) => void
  onAudioBufferReady?: (buffer: AudioBuffer) => void
  isCancelDisabled?: boolean
}

const NUM_PHASES = 2 // resample + transcribe

export function ProcessingScreen({
  file,
  fileHash,
  useChunking,
  numChunks,
  debugMode,
  debugChunks,
  onCancel,
  onComplete,
  // onError,
  onAudioBufferReady,
  isCancelDisabled = false,
}: ProcessingScreenProps) {
  const [status, setStatus] = useState('Preparing transcription...')
  const [progress, setProgress] = useState(0)
  const [estimatedTimeRemaining, setEstimatedTimeRemaining] = useState('')
  const startTimeRef = useRef<number>(Date.now())
  const cancelledRef = useRef(false)
  const audioBufferRef = useRef<AudioBuffer | null>(null)

  const safeSetStatus = (value: string) => {
    if (!cancelledRef.current) {
      setStatus(value)
    }
  }

  const safeSetProgress = (value: number) => {
    if (!cancelledRef.current) {
      setProgress(value)
    }
  }

  const safeSetEta = (value: string) => {
    if (!cancelledRef.current) {
      setEstimatedTimeRemaining(value)
    }
  }

  const updateOverall = (chunkIndex: number, phaseIndex: number, phaseProgress: number, totalChunks: number) => {
    const completedUnits = (chunkIndex * NUM_PHASES) + phaseIndex + Math.max(0, Math.min(1, phaseProgress))
    const totalUnits = totalChunks * NUM_PHASES
    const overall = (completedUnits / totalUnits) * 100
    const clamped = Math.max(0, Math.min(100, overall))
    safeSetProgress(clamped)

    if (clamped >= 1) {
      const elapsed = (Date.now() - startTimeRef.current) / 1000
      const fraction = clamped / 100
      if (fraction > 0) {
        const remaining = elapsed * (1 - fraction) / fraction
        safeSetEta(formatTime(remaining))
      }
    }
  }

  const ensureAudioBuffer = async () => {
    if (audioBufferRef.current) {
      return audioBufferRef.current
    }
    const buffer = await loadAudioBuffer(file)
    audioBufferRef.current = buffer
    onAudioBufferReady?.(buffer)
    return buffer
  }

  useEffect(() => {
    cancelledRef.current = false
    startTimeRef.current = Date.now()
    setProgress(0)
    setEstimatedTimeRemaining('')
    safeSetStatus('Preparing transcription...')

    const run = async () => {
      try {
        const modelToUse = 'tiny.en'

        safeSetStatus('Checking browser compatibility...')
        const { supported, detailedReason } = await canUseWhisperWeb(modelToUse)
        if (!supported) {
          throw new Error(`Whisper Web is not supported in this environment: ${detailedReason}`)
        }

        safeSetStatus('Downloading model...')
        await downloadWhisperModel({
          model: modelToUse,
          onProgress: ({ progress }) => {
            if (!cancelledRef.current) {
              safeSetStatus(`Downloading model (${Math.round(progress * 100)}%)...`)
            }
          },
        })

        let filesToTranscribe: File[] = [file]
        let loadedBuffer: AudioBuffer | null = null

        if (useChunking) {
          safeSetStatus('Chunking audio using Web Audio API...')
          loadedBuffer = await ensureAudioBuffer()
          const totalDuration = loadedBuffer.length / loadedBuffer.sampleRate
          const chunkDuration = totalDuration / numChunks
          const chunks: File[] = []

          for (let i = 0; i < numChunks; i++) {
            const startTime = i * chunkDuration
            const endTime = Math.min((i + 1) * chunkDuration, totalDuration)
            const trimmedBuffer = trimAudioBuffer(loadedBuffer, startTime, endTime)
            const wavBlob = await audioBufferToWav(trimmedBuffer)
            const chunkFile = new File([wavBlob], `chunk_${i}.wav`, { type: 'audio/wav' })
            chunks.push(chunkFile)
          }

          filesToTranscribe = chunks
        } else {
          await ensureAudioBuffer()
        }

        const allCaptions: Caption[] = []
        const chunksToProcess = (debugMode && useChunking)
          ? Math.min(debugChunks, filesToTranscribe.length)
          : filesToTranscribe.length

        for (let i = 0; i < chunksToProcess; i++) {
          if (cancelledRef.current) return

          const currentFile = filesToTranscribe[i]
          const chunkLabel = useChunking ? ` (chunk ${i + 1}/${chunksToProcess})` : ''

          safeSetStatus(`Resampling audio${chunkLabel}...`)
          const channelWaveform = await resampleTo16Khz({
            file: currentFile,
            onProgress: (p) => {
              if (cancelledRef.current) return
              updateOverall(i, 0, p, chunksToProcess)
              safeSetStatus(`Resampling audio${chunkLabel} (${Math.round(p * 100)}%)...`)
            },
          })

          safeSetStatus(`Transcribing${chunkLabel}...`)
          const whisperWebOutput = await transcribe({
            channelWaveform,
            model: modelToUse,
            onProgress: (p) => {
              if (cancelledRef.current) return
              updateOverall(i, 1, p, chunksToProcess)
              safeSetStatus(`Transcribing${chunkLabel} (${Math.round(p * 100)}%)...`)
            },
          })

          const { captions } = toCaptions({ whisperWebOutput })

          if (useChunking && loadedBuffer) {
            const chunkStartTime = i * (loadedBuffer.length / loadedBuffer.sampleRate / numChunks)
            const chunkStartTimeMs = chunkStartTime * 1000

            captions.forEach(caption => {
              if (caption.startMs !== caption.endMs) {
                allCaptions.push({
                  text: caption.text,
                  startMs: caption.startMs + chunkStartTimeMs,
                  endMs: caption.endMs + chunkStartTimeMs,
                  confidence: caption.confidence
                })
              }
            })
          } else {
            captions.forEach(caption => {
              if (caption.startMs !== caption.endMs) {
                allCaptions.push({
                  text: caption.text,
                  startMs: caption.startMs,
                  endMs: caption.endMs,
                  confidence: caption.confidence
                })
              }
            })
          }
        }

        const cacheData: CachedTranscript = {
          hash: fileHash,
          fileName: file.name,
          fileSize: file.size,
          processedAt: new Date().toLocaleString(),
          numChunks: useChunking ? numChunks : 1,
          chunkingEnabled: useChunking,
          modelUsed: 'tiny.en',
          captions: allCaptions
        }

        const totalTime = (Date.now() - startTimeRef.current) / 1000
        if (!cancelledRef.current) {
          try {
            await onComplete(fileHash, cacheData, totalTime)
          } catch (completionError) {
            const message = completionError instanceof Error ? completionError.message : 'Unknown error'
            safeSetStatus(`Error: ${message}`)
            // onError(message)
          }
        }
      } catch (error) {
        if (cancelledRef.current) return
        const message = error instanceof Error ? error.message : 'Unknown error'
        safeSetStatus(`Error: ${message}`)
        // onError(message)
      }
    }

    void run()

    return () => {
      cancelledRef.current = true
    }
  }, [
    debugChunks,
    debugMode,
    file,
    fileHash,
    numChunks,
    onAudioBufferReady,
    onComplete,
    // onError,
    useChunking,
  ])

  return (
    <div
      style={{
        padding: '2rem',
        maxWidth: '800px',
        margin: '0 auto',
        color: '#333',
        backgroundColor: '#fff',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          padding: '1rem',
          backgroundColor: '#fff3cd',
          border: '1px solid #ffeaa7',
          borderRadius: '4px',
        }}
      >
        <strong>Status:</strong> {status}
        {progress > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: '0.5rem',
                fontSize: '0.9em',
                color: '#666',
              }}
            >
              <span>Progress: {Math.round(progress)}%</span>
              {estimatedTimeRemaining && <span>Est. remaining: {estimatedTimeRemaining}</span>}
            </div>
            <div
              style={{
                width: '100%',
                height: '20px',
                backgroundColor: '#e9ecef',
                borderRadius: '10px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: '100%',
                  backgroundColor: '#4caf50',
                  transition: 'width 0.3s ease',
                  borderRadius: '10px',
                }}
              />
            </div>
          </div>
        )}
      </div>

      <button
        onClick={onCancel}
        disabled={isCancelDisabled}
        style={{
          padding: '0.75rem 1rem',
          border: `1px solid ${isCancelDisabled ? '#ddd' : '#f5c2c7'}`,
          backgroundColor: isCancelDisabled ? '#f5f5f5' : '#f8d7da',
          color: isCancelDisabled ? '#888' : '#842029',
          borderRadius: '4px',
          fontWeight: 600,
          cursor: isCancelDisabled ? 'not-allowed' : 'pointer',
          minWidth: '180px',
          alignSelf: 'flex-start',
        }}
      >
        Cancel & restart
      </button>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { canUseWhisperWeb, downloadWhisperModel, resampleTo16Khz, toCaptions, transcribe } from '@remotion/whisper-web'
import { audioBufferToWav, loadAudioBuffer, trimAudioBuffer } from '@/lib/audio-utils'
import { formatTime } from '@/lib/time'
import type { CachedTranscript, Caption } from '@/types/transcript'

type ProcessingScreenProps = {
  file: File
  fileHash: string
  onCancel: () => void
  onComplete: (fileHash: string, cacheData: CachedTranscript, totalTime: number) => Promise<void> | void
  onAudioBufferReady?: (buffer: AudioBuffer) => void
}

type ProcessingConfig = {
  useChunking: boolean
  numChunks: number
  debugMode: boolean
  debugChunks: number
}

export function ProcessingScreen({
  file,
  fileHash,
  onCancel,
  onComplete,
  onAudioBufferReady,
}: ProcessingScreenProps) {
  const [useChunking, setUseChunking] = useState(false)
  const [numChunks, setNumChunks] = useState(4)
  const [debugMode, setDebugMode] = useState(false)
  const [debugChunks, setDebugChunks] = useState(1)
  const [status, setStatus] = useState('Ready to start processing.')
  const [progress, setProgress] = useState(0)
  const [estimatedTimeRemaining, setEstimatedTimeRemaining] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [activeConfig, setActiveConfig] = useState<ProcessingConfig | null>(null)

  const audioBufferRef = useRef<AudioBuffer | null>(null)
  const cancelledRef = useRef(false)
  const startTimeRef = useRef(0)

  const resetState = () => {
    cancelledRef.current = true
    audioBufferRef.current = null
    setActiveConfig(null)
    setStatus('Ready to start processing.')
    setProgress(0)
    setEstimatedTimeRemaining('')
    setErrorMessage(null)
    setIsRunning(false)
  }

  useEffect(() => {
    resetState()
    cancelledRef.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileHash])

  const ensureAudioBuffer = async () => {
    if (audioBufferRef.current) {
      return audioBufferRef.current
    }
    const buffer = await loadAudioBuffer(file)
    audioBufferRef.current = buffer
    onAudioBufferReady?.(buffer)
    return buffer
  }

  const updateOverall = (chunkIndex: number, phaseIndex: number, phaseProgress: number, totalChunks: number) => {
    const NUM_PHASES = 2
    const completedUnits = (chunkIndex * NUM_PHASES) + phaseIndex + Math.max(0, Math.min(1, phaseProgress))
    const totalUnits = totalChunks * NUM_PHASES
    const overall = (completedUnits / totalUnits) * 100
    const clamped = Math.max(0, Math.min(100, overall))
    setProgress(clamped)

    if (clamped >= 1) {
      const elapsed = (Date.now() - startTimeRef.current) / 1000
      const fraction = clamped / 100
      if (fraction > 0) {
        const remaining = elapsed * (1 - fraction) / fraction
        setEstimatedTimeRemaining(formatTime(remaining))
      }
    }
  }

  useEffect(() => {
    if (!activeConfig) return
    let cancelled = false
    cancelledRef.current = false
    startTimeRef.current = Date.now()
    setIsRunning(true)
    setProgress(0)
    setEstimatedTimeRemaining('')

    const run = async () => {
      try {
        const { useChunking: chunkingEnabled, numChunks: chunkCount, debugMode: debugEnabled, debugChunks } = activeConfig
        const modelToUse = 'tiny.en'

        setStatus('Checking browser compatibility...')
        const { supported, detailedReason } = await canUseWhisperWeb(modelToUse)
        if (!supported) {
          throw new Error(`Whisper Web is not supported in this environment: ${detailedReason}`)
        }

        setStatus('Downloading model...')
        await downloadWhisperModel({
          model: modelToUse,
          onProgress: ({ progress }) => {
            if (!cancelled && !cancelledRef.current) {
              setStatus(`Downloading model (${Math.round(progress * 100)}%)...`)
            }
          },
        })

        let filesToTranscribe: File[] = [file]
        let loadedBuffer: AudioBuffer | null = null

        if (chunkingEnabled) {
          setStatus('Chunking audio...')
          loadedBuffer = await ensureAudioBuffer()
          const totalDuration = loadedBuffer.length / loadedBuffer.sampleRate
          const chunkDuration = totalDuration / chunkCount
          const chunks: File[] = []

          for (let i = 0; i < chunkCount; i++) {
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
        const chunksToProcess = (debugEnabled && chunkingEnabled)
          ? Math.min(debugChunks, filesToTranscribe.length)
          : filesToTranscribe.length

        for (let i = 0; i < chunksToProcess; i++) {
          if (cancelled || cancelledRef.current) return

          const currentFile = filesToTranscribe[i]
          const chunkLabel = chunkingEnabled ? ` (chunk ${i + 1}/${chunksToProcess})` : ''

          setStatus(`Resampling audio${chunkLabel}...`)
          const channelWaveform = await resampleTo16Khz({
            file: currentFile,
            onProgress: (p) => {
              if (cancelled || cancelledRef.current) return
              updateOverall(i, 0, p, chunksToProcess)
              setStatus(`Resampling audio${chunkLabel} (${Math.round(p * 100)}%)...`)
            },
          })

          setStatus(`Transcribing${chunkLabel}...`)
          const whisperWebOutput = await transcribe({
            channelWaveform,
            model: modelToUse,
            onProgress: (p) => {
              if (cancelled || cancelledRef.current) return
              updateOverall(i, 1, p, chunksToProcess)
              setStatus(`Transcribing${chunkLabel} (${Math.round(p * 100)}%)...`)
            },
          })

          const { captions } = toCaptions({ whisperWebOutput })

          if (chunkingEnabled && loadedBuffer) {
            const chunkStartTime = i * (loadedBuffer.length / loadedBuffer.sampleRate / chunkCount)
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
          numChunks: chunkingEnabled ? chunkCount : 1,
          chunkingEnabled,
          modelUsed: modelToUse,
          captions: allCaptions
        }

        const totalTime = (Date.now() - startTimeRef.current) / 1000
        if (!cancelled && !cancelledRef.current) {
          await onComplete(fileHash, cacheData, totalTime)
        }
      } catch (error) {
        if (cancelled || cancelledRef.current) return
        const message = error instanceof Error ? error.message : 'Unknown error'
        setStatus(`Error: ${message}`)
        setErrorMessage(message)
      } finally {
        if (!cancelled) {
          setIsRunning(false)
        }
      }
    }

    void run()

    return () => {
      cancelled = true
      cancelledRef.current = true
    }
  }, [activeConfig, file, fileHash, onAudioBufferReady, onComplete])

  const handleStart = () => {
    const sanitizedChunks = Math.max(2, Math.floor(numChunks || 2))
    const sanitizedDebugChunks = Math.max(1, Math.floor(debugChunks || 1))
    setStatus('Preparing transcription...')
    setProgress(0)
    setEstimatedTimeRemaining('')
    setErrorMessage(null)
    setActiveConfig({
      useChunking,
      numChunks: sanitizedChunks,
      debugMode,
      debugChunks: sanitizedDebugChunks
    })
  }

  const handleCancelClick = () => {
    cancelledRef.current = true
    onCancel()
  }

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
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div>
          <strong>File:</strong> {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={useChunking}
            disabled={isRunning}
            onChange={(e) => setUseChunking(e.target.checked)}
          />
          Enable chunking
        </label>

        {useChunking && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span>Number of chunks</span>
            <input
              type="number"
              min={2}
              max={32}
              value={numChunks}
              disabled={isRunning}
              onChange={(e) => setNumChunks(Number(e.target.value) || 2)}
              style={{ width: '120px', padding: '0.25rem' }}
            />
          </label>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={debugMode}
            disabled={isRunning}
            onChange={(e) => setDebugMode(e.target.checked)}
          />
          Debug mode (limit processed chunks)
        </label>

        {debugMode && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span>Chunks to process</span>
            <input
              type="number"
              min={1}
              value={debugChunks}
              disabled={isRunning}
              onChange={(e) => setDebugChunks(Number(e.target.value) || 1)}
              style={{ width: '120px', padding: '0.25rem' }}
            />
          </label>
        )}

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button
            onClick={handleStart}
            disabled={isRunning}
            style={{
              padding: '0.75rem 1rem',
              backgroundColor: isRunning ? '#ccc' : '#4caf50',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              fontWeight: 600,
              cursor: isRunning ? 'not-allowed' : 'pointer'
            }}
          >
            {isRunning ? 'Processing…' : 'Start processing'}
          </button>

          <button
            onClick={handleCancelClick}
            style={{
              padding: '0.75rem 1rem',
              border: '1px solid #f5c2c7',
              backgroundColor: '#f8d7da',
              color: '#842029',
              borderRadius: '4px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Cancel & restart
          </button>
        </div>
      </div>

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

      {errorMessage && (
        <div style={{ color: '#842029', backgroundColor: '#f8d7da', padding: '0.75rem', borderRadius: '4px' }}>
          {errorMessage}
        </div>
      )}
    </div>
  )
}

import { useState, useRef } from 'react'
import { transcribe, canUseWhisperWeb, resampleTo16Khz, downloadWhisperModel, toCaptions } from '@remotion/whisper-web'
import './App.css'

function App() {
  const [status, setStatus] = useState<string>('Ready to transcribe')
  const [transcription, setTranscription] = useState<string>('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [useChunking, setUseChunking] = useState(false)
  const [numChunks, setNumChunks] = useState(4)
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null)
  const [debugMode, setDebugMode] = useState(false)
  const [debugChunks, setDebugChunks] = useState(1)
  const [audioUrl, setAudioUrl] = useState<string>('')
  const [currentTime, setCurrentTime] = useState(0)
  const [captionsData, setCaptionsData] = useState<Array<{text: string, startMs: number, endMs: number, confidence: number | null}>>([])
  const [activeCaptionIndex, setActiveCaptionIndex] = useState<number>(-1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
    }
    return audioContextRef.current
  }

  const loadAudioBuffer = async (file: File): Promise<AudioBuffer> => {
    const audioContext = initAudioContext()
    const arrayBuffer = await file.arrayBuffer()
    return await audioContext.decodeAudioData(arrayBuffer)
  }

  const trimAudioBuffer = (buffer: AudioBuffer, startTime: number, endTime: number): AudioBuffer => {
    const audioContext = initAudioContext()
    const sampleRate = buffer.sampleRate
    const startSample = Math.floor(startTime * sampleRate)
    const endSample = Math.floor(endTime * sampleRate)
    const duration = endSample - startSample

    const trimmedBuffer = audioContext.createBuffer(
      buffer.numberOfChannels,
      duration,
      sampleRate
    )

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const sourceData = buffer.getChannelData(channel)
      const trimmedData = trimmedBuffer.getChannelData(channel)
      
      for (let i = 0; i < duration; i++) {
        trimmedData[i] = sourceData[startSample + i]
      }
    }

    return trimmedBuffer
  }

  const audioBufferToWav = async (buffer: AudioBuffer): Promise<Blob> => {
    const numberOfChannels = buffer.numberOfChannels
    const sampleRate = buffer.sampleRate
    const format = 1 // PCM
    const bitDepth = 16
    
    const bytesPerSample = bitDepth / 8
    const blockAlign = numberOfChannels * bytesPerSample
    
    const data = []
    for (let channel = 0; channel < numberOfChannels; channel++) {
      data.push(buffer.getChannelData(channel))
    }
    
    const length = data[0].length
    const arrayBuffer = new ArrayBuffer(44 + length * numberOfChannels * bytesPerSample)
    const view = new DataView(arrayBuffer)
    
    // WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i))
      }
    }
    
    writeString(0, 'RIFF')
    view.setUint32(4, 36 + length * numberOfChannels * bytesPerSample, true)
    writeString(8, 'WAVE')
    writeString(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, format, true)
    view.setUint16(22, numberOfChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * blockAlign, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, bitDepth, true)
    writeString(36, 'data')
    view.setUint32(40, length * numberOfChannels * bytesPerSample, true)
    
    // Write audio data
    let offset = 44
    for (let i = 0; i < length; i++) {
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, data[channel][i]))
        view.setInt16(offset, sample * 0x7FFF, true)
        offset += 2
      }
    }
    
    return new Blob([arrayBuffer], { type: 'audio/wav' })
  }

  const handleTimeUpdate = () => {
    if (!audioRef.current) return

    const currentTimeMs = audioRef.current.currentTime * 1000
    setCurrentTime(currentTimeMs)

    // Find the active caption
    const activeIndex = captionsData.findIndex(caption =>
      currentTimeMs >= caption.startMs && currentTimeMs <= caption.endMs
    )

    if (activeIndex !== activeCaptionIndex) {
      setActiveCaptionIndex(activeIndex)
    }
  }

  const chunkAudioFile = async (file: File, numChunks: number): Promise<File[]> => {
    let buffer = audioBuffer
    if (!buffer) {
      setStatus('Loading audio buffer...')
      buffer = await loadAudioBuffer(file)
      setAudioBuffer(buffer)
    }
    
    const totalDuration = buffer.length / buffer.sampleRate
    const chunkDuration = totalDuration / numChunks
    const chunks: File[] = []
    
    for (let i = 0; i < numChunks; i++) {
      const startTime = i * chunkDuration
      const endTime = Math.min((i + 1) * chunkDuration, totalDuration)
      
      const trimmedBuffer = trimAudioBuffer(buffer, startTime, endTime)
      const wavBlob = await audioBufferToWav(trimmedBuffer)
      const chunkFile = new File([wavBlob], `chunk_${i}.wav`, { type: 'audio/wav' })
      chunks.push(chunkFile)
    }
    
    return chunks
  }

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setIsProcessing(true)
    setTranscription('')
    setCaptionsData([])
    setActiveCaptionIndex(-1)

    // Create URL for audio playback
    const url = URL.createObjectURL(file)
    setAudioUrl(url)
    
    console.log('File info:', {
      name: file.name,
      size: file.size,
      type: file.type,
      duration: 'unknown', // Will be calculated during processing
      sizeInMB: (file.size / 1024 / 1024).toFixed(2) + ' MB'
    })
    
    try {
      const modelToUse = 'tiny.en'
      
      setStatus('Checking browser compatibility...')
      const { supported, detailedReason } = await canUseWhisperWeb(modelToUse)
      if (!supported) {
        throw new Error(`Whisper Web is not supported in this environment: ${detailedReason}`)
      }

      setStatus('Downloading model...')
      await downloadWhisperModel({
        model: modelToUse,
        onProgress: ({ progress }) => setStatus(`Downloading model (${Math.round(progress * 100)}%)...`),
      })

      let filesToTranscribe: File[] = [file]
      let loadedBuffer: AudioBuffer | null = null
      
      if (useChunking) {
        setStatus('Chunking audio using Web Audio API...')
        // Load the buffer and store it locally
        loadedBuffer = await loadAudioBuffer(file)
        setAudioBuffer(loadedBuffer)
        
        // Now use the local buffer for chunking
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
        console.log(`Created ${filesToTranscribe.length} chunks`)
      }

      const allTranscriptions: string[] = []
      const allCaptions: Array<{text: string, startMs: number, endMs: number, confidence: number | null}> = []

      // In debug mode with chunking, only process the specified number of chunks
      const chunksToProcess = (debugMode && useChunking) ? Math.min(debugChunks, filesToTranscribe.length) : filesToTranscribe.length

      for (let i = 0; i < chunksToProcess; i++) {
        const currentFile = filesToTranscribe[i]
        const chunkLabel = useChunking ? ` (chunk ${i + 1}/${numChunks})` : ''

        setStatus(`Resampling audio${chunkLabel}...`)
        console.log(`Starting resample step${chunkLabel}`)
        const channelWaveform = await resampleTo16Khz({
          file: currentFile,
          onProgress: (progress) => setStatus(`Resampling audio${chunkLabel} (${Math.round(progress * 100)}%)...`),
        })
        console.log(`Resample complete${chunkLabel}, channelWaveform length:`, channelWaveform.length)

        setStatus(`Transcribing${chunkLabel}...`)
        console.log(`Starting transcribe step${chunkLabel}`)
        const whisperWebOutput = await transcribe({
          channelWaveform,
          model: modelToUse,
          onProgress: (progress) => setStatus(`Transcribing${chunkLabel} (${Math.round(progress * 100)}%)...`),
        })
        console.log(`Transcribe complete${chunkLabel}`)

        // Convert to captions format
        const { captions } = toCaptions({
          whisperWebOutput,
        })
        console.log('Captions:', captions)

        if (useChunking && loadedBuffer) {
          const chunkStartTime = i * (loadedBuffer.length / loadedBuffer.sampleRate / numChunks)

          // Add adjusted captions to the global list, filtering out empty duration captions
          captions.forEach(caption => {
            if (caption.startMs !== caption.endMs) {
              allCaptions.push({
                text: caption.text,
                startMs: caption.startMs + (chunkStartTime * 1000),
                endMs: caption.endMs + (chunkStartTime * 1000),
                confidence: caption.confidence
              })
            }
          })

          const chunkTranscriptionWithTimestamps = captions.map(caption => {
            // Calculate absolute timestamp by adding chunk start time to caption timestamp
            const absoluteStartMs = caption.startMs + (chunkStartTime * 1000)
            const absoluteEndMs = caption.endMs + (chunkStartTime * 1000)

            const formatTime = (ms: number) => {
              const hours = Math.floor(ms / 3600000)
              const minutes = Math.floor((ms % 3600000) / 60000)
              const seconds = Math.floor((ms % 60000) / 1000)
              const milliseconds = ms % 1000
              return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`
            }

            return `[${formatTime(absoluteStartMs)} --> ${formatTime(absoluteEndMs)}] ${caption.text} (confidence: ${caption.confidence?.toFixed(3) ?? 'N/A'})`
          }).join('\n')

          allTranscriptions.push(chunkTranscriptionWithTimestamps)
        } else {
          // Add all captions to the global list, filtering out empty duration captions
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

          // For non-chunked transcription, display captions with their timestamps
          const transcriptionWithTimestamps = captions.map(caption => {
            const formatTime = (ms: number) => {
              const hours = Math.floor(ms / 3600000)
              const minutes = Math.floor((ms % 3600000) / 60000)
              const seconds = Math.floor((ms % 60000) / 1000)
              const milliseconds = ms % 1000
              return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`
            }

            return `[${formatTime(caption.startMs)} --> ${formatTime(caption.endMs)}] ${caption.text} (confidence: ${caption.confidence?.toFixed(3) ?? 'N/A'})`
          }).join('\n')

          allTranscriptions.push(transcriptionWithTimestamps)
        }
      }

      const finalTranscription = allTranscriptions.join('\n\n')
      setTranscription(finalTranscription)
      setCaptionsData(allCaptions)
      setStatus('Transcription complete!')
      
    } catch (error) {
      console.error('Error transcribing:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <>
      <div style={{ 
        padding: '2rem', 
        maxWidth: '800px', 
        margin: '0 auto',
        color: '#333',
        backgroundColor: '#fff',
        minHeight: '100vh'
      }}>
        <h1 style={{ color: '#333', marginBottom: '2rem' }}>Audio Transcription with Whisper</h1>
        
        <div style={{ marginBottom: '2rem' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={handleFileSelect}
            disabled={isProcessing}
            style={{ 
              marginBottom: '1rem', 
              display: 'block',
              padding: '0.5rem',
              fontSize: '1rem',
              border: '1px solid #ccc',
              borderRadius: '4px'
            }}
          />

          <div style={{ marginBottom: '1rem', padding: '1rem', border: '1px solid #ddd', borderRadius: '4px', backgroundColor: '#f9f9f9' }}>
            <label style={{ display: 'flex', alignItems: 'center', marginBottom: '0.5rem', color: '#333' }}>
              <input
                type="checkbox"
                checked={useChunking}
                onChange={(e) => setUseChunking(e.target.checked)}
                disabled={isProcessing}
                style={{ marginRight: '0.5rem' }}
              />
              Enable chunking for long files (Web Audio API)
            </label>

            {useChunking && (
              <div style={{ marginLeft: '1.5rem' }}>
                <label style={{ color: '#333', display: 'block', marginBottom: '0.25rem' }}>
                  Number of chunks: {numChunks}
                </label>
                <input
                  type="range"
                  min="2"
                  max="20"
                  value={numChunks}
                  onChange={(e) => setNumChunks(Number(e.target.value))}
                  disabled={isProcessing}
                  style={{ width: '100%' }}
                />
                <div style={{ fontSize: '0.85em', color: '#666', marginTop: '0.25rem' }}>
                  Each chunk will be ~{Math.round(100/numChunks)}% of the file
                </div>

                <label style={{ display: 'flex', alignItems: 'center', marginTop: '0.75rem', color: '#333' }}>
                  <input
                    type="checkbox"
                    checked={debugMode}
                    onChange={(e) => setDebugMode(e.target.checked)}
                    disabled={isProcessing}
                    style={{ marginRight: '0.5rem' }}
                  />
                  Debug mode (limit chunks to transcribe)
                </label>

                {debugMode && (
                  <div style={{ marginLeft: '1.5rem', marginTop: '0.5rem' }}>
                    <label style={{ color: '#333', display: 'block', marginBottom: '0.25rem' }}>
                      Chunks to transcribe: {debugChunks}
                    </label>
                    <input
                      type="range"
                      min="1"
                      max={Math.min(numChunks, 5)}
                      value={debugChunks}
                      onChange={(e) => setDebugChunks(Number(e.target.value))}
                      disabled={isProcessing}
                      style={{ width: '100%' }}
                    />
                    <div style={{ fontSize: '0.85em', color: '#666', marginTop: '0.25rem' }}>
                      Will transcribe {debugChunks} of {numChunks} chunks
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          
          <div style={{ 
            padding: '1rem', 
            backgroundColor: isProcessing ? '#fff3cd' : '#d4edda',
            border: `1px solid ${isProcessing ? '#ffeaa7' : '#c3e6cb'}`,
            borderRadius: '4px',
            marginBottom: '1rem',
            color: '#333'
          }}>
            <strong>Status:</strong> {status}
          </div>
        </div>

        {audioUrl && (
          <div style={{
            marginBottom: '2rem',
            padding: '1rem',
            backgroundColor: '#f8f9fa',
            border: '1px solid #dee2e6',
            borderRadius: '4px'
          }}>
            <h3 style={{ color: '#333', marginTop: 0, marginBottom: '1rem' }}>Audio Playback</h3>
            <audio
              ref={audioRef}
              controls
              src={audioUrl}
              onTimeUpdate={handleTimeUpdate}
              style={{ width: '100%' }}
            />
          </div>
        )}

        {captionsData.length > 0 && (
          <div style={{
            padding: '1rem',
            backgroundColor: '#f8f9fa',
            border: '1px solid #dee2e6',
            borderRadius: '4px',
            maxHeight: '400px',
            overflowY: 'auto',
            marginBottom: '2rem'
          }}>
            <h3 style={{ color: '#333', marginTop: 0, marginBottom: '1rem' }}>Captions (Synced with Audio)</h3>
            <p style={{
              lineHeight: '1.8',
              fontSize: '1.1em',
              color: '#333',
              margin: 0
            }}>
              {captionsData.map((caption, index) => {
                const isActive = index === activeCaptionIndex

                return (
                  <span
                    key={index}
                    style={{
                      padding: isActive ? '2px 4px' : '0',
                      backgroundColor: isActive ? '#ffd700' : 'transparent',
                      borderRadius: isActive ? '3px' : '0',
                      transition: 'all 0.3s ease',
                      color: isActive ? '#000' : '#333',
                      fontWeight: isActive ? 'bold' : 'normal',
                      borderBottom: '1px solid #e0e0e0',
                      boxShadow: isActive ? '0 2px 4px rgba(255, 215, 0, 0.3)' : 'none'
                    }}
                  >
                    {caption.text}
                  </span>
                )
              }).reduce<React.ReactNode[]>((acc, curr, index) => {
                if (index === 0) return [curr]
                return [...acc, ' ', curr]
              }, [])}
            </p>
          </div>
        )}

      </div>
    </>
  )
}

export default App

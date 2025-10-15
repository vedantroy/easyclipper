import { useState, useRef, useMemo, useEffect } from 'react'
import { transcribe, canUseWhisperWeb, resampleTo16Khz, downloadWhisperModel, toCaptions } from '@remotion/whisper-web'
import ReactSlider from 'react-slider'
import { useDropzone } from 'react-dropzone'
import localforage from 'localforage'
import { Virtuoso  } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import './App.css'

// Cache storage interface
interface CachedTranscript {
  hash: string
  fileName: string
  fileSize: number
  processedAt: string
  numChunks: number
  chunkingEnabled: boolean
  modelUsed: string
  captions: Array<{text: string, startMs: number, endMs: number, confidence: number | null}>
}

// Stronger caption type for local use
type Caption = { text: string; startMs: number; endMs: number; confidence: number | null }

// Generate SHA-256 hash of file content
async function hashFile(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  return hashHex
}

// Format time in seconds to human readable
function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`
  } else if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return `${mins}m ${secs}s`
  } else {
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    return `${hours}h ${mins}m`
  }
}

// Group consecutive words into chunks so each chunk becomes ONE virtual row.
function chunkCaptions(
  caps: Caption[],
  maxChars = 400,
  maxGapMs = 900
) {
  const chunks: { start: number; end: number; startMs: number; endMs: number }[] = []
  if (!caps.length) return chunks

  let start = 0
  let charCount = 0

  for (let i = 0; i < caps.length; i++) {
    const wordLength = caps[i].text.length
    const spaceNeeded = i > start ? 1 : 0 // space before word (except first)
    const totalNeeded = charCount + spaceNeeded + wordLength

    // Check if we should break the chunk
    const tooLong = totalNeeded > maxChars && i > start // Don't break on first word
    const hasGap = i > 0 && (caps[i].startMs - caps[i - 1].endMs) > maxGapMs

    if (tooLong || hasGap) {
      // End current chunk at previous word
      chunks.push({
        start,
        end: i - 1,
        startMs: caps[start].startMs,
        endMs: caps[i - 1].endMs
      })
      start = i
      charCount = wordLength
    } else {
      charCount = totalNeeded
    }
  }

  // Add final chunk
  if (start < caps.length) {
    chunks.push({
      start,
      end: caps.length - 1,
      startMs: caps[start].startMs,
      endMs: caps[caps.length - 1].endMs
    })
  }

  return chunks
}

// Simple chunking that splits on periods (sentences)
function chunkCaptionsSimple(
  caps: Caption[],
  minChars = 400,
  maxChars = 600
) {
  const chunks: { start: number; end: number; startMs: number; endMs: number }[] = []
  if (!caps.length) return chunks

  let start = 0
  let charCount = 0

  for (let i = 0; i < caps.length; i++) {
    const word = caps[i].text
    const wordLength = word.length
    const spaceNeeded = i > start ? 1 : 0
    charCount += spaceNeeded + wordLength

    // Check if this word ends with a period and we have enough chars
    const endsWithPeriod = word.endsWith('.') || word === '.'
    const hasEnoughChars = charCount >= minChars
    const tooManyChars = charCount >= maxChars

    if ((endsWithPeriod && hasEnoughChars) || tooManyChars) {
      // End chunk here
      chunks.push({
        start,
        end: i,
        startMs: caps[start].startMs,
        endMs: caps[i].endMs
      })
      start = i + 1
      charCount = 0
    }
  }

  // Add remaining words as final chunk
  if (start < caps.length) {
    chunks.push({
      start,
      end: caps.length - 1,
      startMs: caps[start].startMs,
      endMs: caps[caps.length - 1].endMs
    })
  }

  return chunks
}

// Search helpers
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const isTypingInInput = (el: EventTarget | null) =>
  el && (el as HTMLElement).closest('input, textarea, [contenteditable="true"], [role="textbox"]')

type Match = { chunkIdx: number; startIdx: number; endIdx: number }

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
  const [captionsData, setCaptionsData] = useState<Caption[]>([])
  const [activeCaptionIndex, setActiveCaptionIndex] = useState<number>(-1)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedRange, setSelectedRange] = useState<{start: number, end: number} | null>(null)
  const [subclipUrl, setSubclipUrl] = useState<string>('')
  const [trimValues, setTrimValues] = useState<[number, number]>([0, 100])
  const [subclipDuration, setSubclipDuration] = useState<number>(0)
  const [progress, setProgress] = useState<number>(0)
  const [estimatedTimeRemaining, setEstimatedTimeRemaining] = useState<string>('')

  // Search state
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [activeMatch, setActiveMatch] = useState(-1)

  const audioContextRef = useRef<AudioContext | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const subclipAudioRef = useRef<HTMLAudioElement>(null)
  const startTimeRef = useRef<number>(0)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // Build chunks for virtualization (one chunk = one row).
  const { chunks, wordToChunk } = useMemo(() => {
    const cs = chunkCaptionsSimple(captionsData, 400, 1200) // Use sentence-based chunking
    const map: number[] = new Array(captionsData.length)
    cs.forEach((c, idx) => { for (let i = c.start; i <= c.end; i++) map[i] = idx })
    return { chunks: cs, wordToChunk: map }
  }, [captionsData])

  // Memoized chunk texts and word offsets for search
  const { chunkTexts, chunkWordOffsets } = useMemo(() => {
    const texts = chunks.map(ch =>
      captionsData.slice(ch.start, ch.end + 1).map(c => c.text).join(' ')
    )
    const offsets = chunks.map(ch => {
      let offset = 0
      const wordOffsets: number[] = []
      for (let i = ch.start; i <= ch.end; i++) {
        wordOffsets.push(offset)
        offset += captionsData[i].text.length + (i < ch.end ? 1 : 0) // +1 for space
      }
      return wordOffsets
    })
    return { chunkTexts: texts, chunkWordOffsets: offsets }
  }, [chunks, captionsData])

  // Find all matches across chunks
  const matches = useMemo((): Match[] => {
    if (!searchQuery.trim()) return []

    const results: Match[] = []
    let pattern: RegExp

    try {
      const escaped = escapeRegExp(searchQuery.trim())
      const flags = caseSensitive ? 'g' : 'gi'
      const regex = wholeWord ? `\\b${escaped}\\b` : escaped
      pattern = new RegExp(regex, flags)
    } catch {
      return [] // Invalid regex
    }

    chunkTexts.forEach((text, chunkIdx) => {
      let match
      while ((match = pattern.exec(text)) !== null) {
        results.push({
          chunkIdx,
          startIdx: match.index,
          endIdx: match.index + match[0].length
        })
        if (!pattern.global) break
      }
    })

    return results
  }, [searchQuery, caseSensitive, wholeWord, chunkTexts])

  // Auto-scroll to the active word's chunk
  useEffect(() => {
    if (activeCaptionIndex >= 0) {
      const chunkIdx = wordToChunk[activeCaptionIndex]
      if (chunkIdx != null) {
        virtuosoRef.current?.scrollToIndex({
          index: chunkIdx, align: 'center', behavior: 'auto'
        })
      }
    }
  }, [activeCaptionIndex, wordToChunk])

  // Keyboard handlers for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F to open search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (!isTypingInInput(e.target)) {
          e.preventDefault()
          setShowSearch(true)
        }
      }

      // Escape to close search
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false)
        setSearchQuery('')
        setActiveMatch(-1)
      }

      // Enter to navigate matches
      if (e.key === 'Enter' && showSearch && matches.length > 0) {
        e.preventDefault()
        const newActiveMatch = e.shiftKey
          ? (activeMatch - 1 + matches.length) % matches.length
          : (activeMatch + 1) % matches.length
        setActiveMatch(newActiveMatch)

        // Scroll to match
        const match = matches[newActiveMatch]
        virtuosoRef.current?.scrollToIndex({
          index: match.chunkIdx,
          align: 'center',
          behavior: 'smooth'
        })
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showSearch, matches, activeMatch])

  // Reset active match when search changes
  useEffect(() => {
    setActiveMatch(matches.length > 0 ? 0 : -1)
  }, [matches])

  // Simple, phase-aware progress + ETA (no 10/90 guessing)
  const NUM_PHASES = 2 // 0: resample, 1: transcribe
  const updateOverall = (chunkIndex: number, phaseIndex: number, phaseProgress: number, chunksTotal: number) => {
    const completedUnits = (chunkIndex * NUM_PHASES) + phaseIndex + Math.max(0, Math.min(1, phaseProgress))
    const totalUnits = chunksTotal * NUM_PHASES
    const overall = (completedUnits / totalUnits) * 100
    const clamped = Math.max(0, Math.min(100, overall))
    setProgress(clamped)
    // ETA after 1% to avoid wild swings
    if (clamped >= 1) {
      const elapsed = (Date.now() - startTimeRef.current) / 1000
      const frac = clamped / 100
      if (frac > 0) {
        const remaining = elapsed * (1 - frac) / frac
        setEstimatedTimeRemaining(formatTime(remaining))
      }
    }
  }

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

  const handleCaptionClick = async (index: number) => {
    if (!selectionMode) {
      // First click - enter selection mode
      setSelectionMode(true)
      setSelectedRange({ start: index, end: index })
    } else {
      // Second click - complete selection
      const startIdx = Math.min(selectedRange!.start, index)
      const endIdx = Math.max(selectedRange!.start, index)

      setSelectedRange({ start: startIdx, end: endIdx })

      // Create subclip
      if (audioBuffer) {
        const startMs = captionsData[startIdx].startMs
        const endMs = captionsData[endIdx].endMs

        const startTime = startMs / 1000
        const endTime = endMs / 1000

        const duration = endTime - startTime
        setSubclipDuration(duration)
        setTrimValues([0, 100]) // Reset trim values

        const trimmedBuffer = trimAudioBuffer(audioBuffer, startTime, endTime)
        const wavBlob = await audioBufferToWav(trimmedBuffer)
        const url = URL.createObjectURL(wavBlob)

        // Clean up old URL if exists
        if (subclipUrl) {
          URL.revokeObjectURL(subclipUrl)
        }

        setSubclipUrl(url)
      }
    }
  }

  const handleTrimChange = async (values: [number, number]) => {
    setTrimValues(values)

    if (!audioBuffer || !selectedRange) return

    const startMs = captionsData[selectedRange.start].startMs
    const endMs = captionsData[selectedRange.end].endMs

    const originalStartTime = startMs / 1000
    const originalEndTime = endMs / 1000
    const originalDuration = originalEndTime - originalStartTime

    // Calculate trimmed times based on percentage
    const trimStartOffset = (values[0] / 100) * originalDuration
    const trimEndOffset = (values[1] / 100) * originalDuration

    const trimmedStartTime = originalStartTime + trimStartOffset
    const trimmedEndTime = originalStartTime + trimEndOffset

    const trimmedBuffer = trimAudioBuffer(audioBuffer, trimmedStartTime, trimmedEndTime)
    const wavBlob = await audioBufferToWav(trimmedBuffer)
    const url = URL.createObjectURL(wavBlob)

    // Clean up old URL if exists
    if (subclipUrl) {
      URL.revokeObjectURL(subclipUrl)
    }

    setSubclipUrl(url)
  }

  const clearSelection = () => {
    setSelectionMode(false)
    setSelectedRange(null)
    if (subclipUrl) {
      URL.revokeObjectURL(subclipUrl)
      setSubclipUrl('')
    }
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (acceptedFiles) => {
      const file = acceptedFiles[0]
      if (file) {
        processFile(file)
      }
    },
    accept: {
      'audio/*': []
    },
    multiple: false
  })

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

  const processFile = async (file: File) => {
    setIsProcessing(true)
    setTranscription('')
    setCaptionsData([])
    setActiveCaptionIndex(-1)
    setProgress(0)
    startTimeRef.current = Date.now()
    setEstimatedTimeRemaining('')

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
      // Generate hash and check cache
      setStatus('Checking cache...')
      console.log('Starting cache check for file:', file.name, 'size:', file.size)

      const fileHash = await hashFile(file)
      console.log('Generated file hash:', fileHash)

      const cached = await localforage.getItem<CachedTranscript>(fileHash)
      console.log('Cache lookup result:', cached ? 'FOUND' : 'NOT FOUND')

      if (cached) {
        console.log('Cache data:', {
          fileName: cached.fileName,
          fileSize: cached.fileSize,
          captionsCount: cached.captions.length,
          numChunks: cached.numChunks,
          processedAt: cached.processedAt
        })

        // Found in cache - ask user
        const useCache = window.confirm(
          `This file was processed before (${cached.processedAt}).\n` +
          `Load from cache? (${cached.captions.length} captions, ${cached.numChunks} chunks)`
        )

        if (useCache) {
          console.log('User chose to load from cache, starting cache load...')
          setStatus('Loading from cache...')

          console.log('Setting captions data, count:', cached.captions.length)
          setCaptionsData(cached.captions)

          // Load audio buffer for sub-clipping functionality
          console.log('Loading audio buffer for sub-clipping...')
          const buffer = await loadAudioBuffer(file)
          setAudioBuffer(buffer)
          console.log('Audio buffer loaded')

          console.log('Generating transcription text...')
          // Generate transcription text for display
          const transcriptionText = cached.captions.map((caption, index) => {
            if (index % 100 === 0) {
              console.log(`Processing caption ${index + 1}/${cached.captions.length}`)
            }
            const formatTime = (ms: number) => {
              const hours = Math.floor(ms / 3600000)
              const minutes = Math.floor((ms % 3600000) / 60000)
              const seconds = Math.floor((ms % 60000) / 1000)
              const milliseconds = ms % 1000
              return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`
            }
            return `[${formatTime(caption.startMs)} --> ${formatTime(caption.endMs)}] ${caption.text} (confidence: ${caption.confidence?.toFixed(3) ?? 'N/A'})`
          }).join('\n')

          console.log('Setting transcription text, length:', transcriptionText.length)
          setTranscription(transcriptionText)
          setStatus('Loaded from cache!')
          setIsProcessing(false)
          console.log('Cache load complete!')
          return
        } else {
          console.log('User chose not to use cache, proceeding with normal processing')
        }
      } else {
        console.log('No cache entry found, proceeding with normal processing')
      }

      // Continue with normal processing
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
        const chunkLabel = useChunking ? ` (chunk ${i + 1}/${chunksToProcess})` : ''

        setStatus(`Resampling audio${chunkLabel}...`)
        console.log(`Starting resample step${chunkLabel}`)
        const channelWaveform = await resampleTo16Khz({
          file: currentFile,
          onProgress: (p) => {
            updateOverall(i, 0, p, chunksToProcess)
            setStatus(`Resampling audio${chunkLabel} (${Math.round(p * 100)}%)...`)
          },
        })
        console.log(`Resample complete${chunkLabel}, channelWaveform length:`, channelWaveform.length)

        setStatus(`Transcribing${chunkLabel}...`)
        console.log(`Starting transcribe step${chunkLabel}`)
        const whisperWebOutput = await transcribe({
          channelWaveform,
          model: modelToUse,
          onProgress: (p) => {
            updateOverall(i, 1, p, chunksToProcess)
            setStatus(`Transcribing${chunkLabel} (${Math.round(p * 100)}%)...`)
          },
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

      // Save to cache
      setStatus('Saving to cache...')
      console.log('Preparing to save to cache, captions count:', allCaptions.length)

      const cacheData: CachedTranscript = {
        hash: fileHash,
        fileName: file.name,
        fileSize: file.size,
        processedAt: new Date().toLocaleString(),
        numChunks: useChunking ? numChunks : 1,
        chunkingEnabled: useChunking,
        modelUsed: modelToUse,
        captions: allCaptions
      }

      console.log('Cache data prepared:', {
        hash: fileHash,
        fileName: file.name,
        fileSize: file.size,
        captionsCount: allCaptions.length,
        dataSize: JSON.stringify(cacheData).length + ' characters'
      })

      try {
        await localforage.setItem(fileHash, cacheData)
        console.log('Successfully saved to cache with hash:', fileHash)
      } catch (cacheError) {
        console.error('Failed to save to cache:', cacheError)
        // Continue anyway, don't fail the whole process
      }

      setProgress(100)
      const totalTime = (Date.now() - startTimeRef.current) / 1000
      setStatus(`Transcription complete! (Total time: ${formatTime(totalTime)})`)

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
        maxWidth: '1200px',
        width: 'min(100vw - 4rem, 1200px)',
        margin: '0 auto',
        color: '#333',
        backgroundColor: '#fff',
        minHeight: '100vh'
      }}>

        <div style={{ marginBottom: '2rem' }}>
          <div
            {...getRootProps()}
            style={{
              border: `2px dashed ${isDragActive ? '#4caf50' : '#ccc'}`,
              borderRadius: '8px',
              padding: '2rem',
              textAlign: 'center',
              cursor: isProcessing ? 'not-allowed' : 'pointer',
              backgroundColor: isDragActive ? '#f0f8f0' : '#fafafa',
              transition: 'all 0.3s ease',
              opacity: isProcessing ? 0.6 : 1
            }}
          >
            <input {...getInputProps()} disabled={isProcessing} />
            {isDragActive ? (
              <p style={{ color: '#4caf50', margin: 0, fontSize: '1.1em' }}>
                Drop the audio file here...
              </p>
            ) : (
              <div>
                <p style={{ color: '#666', margin: '0 0 0.5rem 0', fontSize: '1.1em' }}>
                  Drag & drop an audio file here, or click to select
                </p>
                <p style={{ color: '#999', margin: 0, fontSize: '0.9em' }}>
                  Supports MP3, WAV, M4A, and other audio formats
                </p>
              </div>
            )}
          </div>

          <div style={{ marginTop: '3rem', marginBottom: '1rem', padding: '1rem', border: '1px solid #ddd', borderRadius: '4px' }}>
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

            {isProcessing && progress > 0 && (
              <div style={{ marginTop: '1rem' }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '0.5rem',
                  fontSize: '0.9em',
                  color: '#666'
                }}>
                  <span>Progress: {Math.round(progress)}%</span>
                  {estimatedTimeRemaining && (
                    <span>Est. remaining: {estimatedTimeRemaining}</span>
                  )}
                </div>
                <div style={{
                  width: '100%',
                  height: '20px',
                  backgroundColor: '#e9ecef',
                  borderRadius: '10px',
                  overflow: 'hidden'
                }}>
                  <div style={{
                    width: `${progress}%`,
                    height: '100%',
                    backgroundColor: '#4caf50',
                    transition: 'width 0.3s ease',
                    borderRadius: '10px'
                  }} />
                </div>
              </div>
            )}
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

        {/* Search UI */}
        {showSearch && (
          <div style={{
            position: 'fixed',
            top: '20px',
            right: '20px',
            backgroundColor: '#fff',
            border: '1px solid #ccc',
            borderRadius: '8px',
            padding: '1rem',
            boxShadow: '0 4px 8px rgba(0,0,0,0.1)',
            zIndex: 1000,
            minWidth: '300px'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="text"
                  placeholder="Search captions..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    flex: 1,
                    padding: '0.5rem',
                    border: '1px solid #ccc',
                    borderRadius: '4px'
                  }}
                  autoFocus
                />
                <button
                  onClick={() => setShowSearch(false)}
                  style={{
                    padding: '0.5rem',
                    backgroundColor: '#dc3545',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ display: 'flex', gap: '1rem', fontSize: '0.9em' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <input
                    type="checkbox"
                    checked={caseSensitive}
                    onChange={(e) => setCaseSensitive(e.target.checked)}
                  />
                  Case sensitive
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <input
                    type="checkbox"
                    checked={wholeWord}
                    onChange={(e) => setWholeWord(e.target.checked)}
                  />
                  Whole word
                </label>
              </div>

              {matches.length > 0 && (
                <div style={{ fontSize: '0.85em', color: '#666', textAlign: 'center' }}>
                  {activeMatch + 1} of {matches.length} matches
                </div>
              )}

              {searchQuery && matches.length === 0 && (
                <div style={{ fontSize: '0.85em', color: '#999', textAlign: 'center' }}>
                  No matches found
                </div>
              )}
            </div>
          </div>
        )}

        {captionsData.length > 0 && (
          <div
            style={{
              padding: '1rem',
              backgroundColor: '#f8f9fa',
              border: '1px solid #dee2e6',
              borderRadius: '4px',
              height: 400,
              marginBottom: '2rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem'
            }}
          >
            {selectionMode && (
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: '#fffacd',
                  borderRadius: '4px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <span style={{ color: '#666' }}>
                  Selection mode active - click another caption to select range
                </span>
                <button
                  onClick={clearSelection}
                  style={{
                    padding: '0.25rem 0.5rem',
                    backgroundColor: '#dc3545',
                    color: 'white',
                    border: 'none',
                    borderRadius: '3px',
                    cursor: 'pointer'
                  }}
                >
                  Clear Selection
                </button>
              </div>
            )}
            <div style={{ flex: 1 }}>
              <Virtuoso
                ref={virtuosoRef}
                totalCount={chunks.length}
                overscan={300}
                style={{ height: '100%' }}
                itemContent={(chunkIdx) => {
                  const ch = chunks[chunkIdx]
                  const slice = captionsData.slice(ch.start, ch.end + 1)
                  const chunkText = chunkTexts[chunkIdx] || ''

                  // Find matches for this chunk
                  const chunkMatches = matches.filter(m => m.chunkIdx === chunkIdx)
                  const activeChunkMatch = activeMatch >= 0 ? matches[activeMatch] : null

                  // Render text with highlighting
                  const renderWithHighlights = () => {
                    if (!searchQuery.trim() || chunkMatches.length === 0) {
                      // No search or no matches - render normally
                      return slice.map((c, i) => {
                        const idx = ch.start + i
                        const isActive = idx === activeCaptionIndex
                        const isSelected =
                          selectedRange && idx >= selectedRange.start && idx <= selectedRange.end
                        const isSelectionStart = selectedRange && idx === selectedRange.start
                        const isSelectionEnd = selectedRange && idx === selectedRange.end
                        return (
                          <span
                            key={idx}
                            onClick={() => handleCaptionClick(idx)}
                            style={{
                              padding: (isActive || isSelected) ? '2px 4px' : 0,
                              backgroundColor: isSelected ? '#90EE90' : (isActive ? '#ffd700' : 'transparent'),
                              borderRadius: (isActive || isSelected) ? 3 : 0,
                              transition: 'all 0.3s ease',
                              color: (isActive || isSelected) ? '#000' : '#333',
                              fontWeight: (isActive || isSelected) ? 'bold' : 'normal',
                              borderBottom: '1px solid #e0e0e0',
                              boxShadow: isActive
                                ? '0 2px 4px rgba(255, 215, 0, 0.3)'
                                : (isSelected ? '0 2px 4px rgba(144, 238, 144, 0.3)' : 'none'),
                              cursor: 'pointer',
                              userSelect: 'none',
                              border: isSelectionStart
                                ? '2px solid green'
                                : (isSelectionEnd ? '2px solid red' : 'none'),
                              textDecoration: 'underline',
                              textDecorationColor: '#999',
                              textDecorationThickness: '1px',
                              marginRight: 4
                            }}
                            title={`${(c.startMs/1000).toFixed(2)}s → ${(c.endMs/1000).toFixed(2)}s`}
                          >
                            {c.text}
                          </span>
                        )
                      })
                    }

                    // Split text by matches for highlighting
                    const sortedMatches = [...chunkMatches].sort((a, b) => a.startIdx - b.startIdx)
                    const parts: Array<{ text: string; isMatch: boolean; isActiveMatch: boolean }> = []
                    let lastEnd = 0

                    sortedMatches.forEach(match => {
                      // Add text before match
                      if (match.startIdx > lastEnd) {
                        parts.push({
                          text: chunkText.slice(lastEnd, match.startIdx),
                          isMatch: false,
                          isActiveMatch: false
                        })
                      }
                      // Add match
                      parts.push({
                        text: chunkText.slice(match.startIdx, match.endIdx),
                        isMatch: true,
                        isActiveMatch: activeChunkMatch === match
                      })
                      lastEnd = match.endIdx
                    })

                    // Add remaining text
                    if (lastEnd < chunkText.length) {
                      parts.push({
                        text: chunkText.slice(lastEnd),
                        isMatch: false,
                        isActiveMatch: false
                      })
                    }

                    // Convert back to spans with proper word mapping
                    const result: React.ReactElement[] = []
                    let wordIndex = 0

                    parts.forEach((part, partIdx) => {
                      const partWords = part.text.split(/(\s+)/)

                      partWords.forEach((word, wordIdx) => {
                        if (word.trim()) {
                          // This is a word
                          const idx = ch.start + wordIndex
                          const isActive = idx === activeCaptionIndex
                          const isSelected =
                            selectedRange && idx >= selectedRange.start && idx <= selectedRange.end
                          const isSelectionStart = selectedRange && idx === selectedRange.start
                          const isSelectionEnd = selectedRange && idx === selectedRange.end

                          const caption = slice[wordIndex]
                          if (caption) {
                            result.push(
                              <span
                                key={`${idx}-${partIdx}-${wordIdx}`}
                                onClick={() => handleCaptionClick(idx)}
                                style={{
                                  padding: (isActive || isSelected) ? '2px 4px' : 0,
                                  backgroundColor: part.isMatch
                                    ? (part.isActiveMatch ? '#ff6b6b' : '#ffeb3b')
                                    : (isSelected ? '#90EE90' : (isActive ? '#ffd700' : 'transparent')),
                                  borderRadius: (isActive || isSelected || part.isMatch) ? 3 : 0,
                                  transition: 'all 0.3s ease',
                                  color: (isActive || isSelected || part.isMatch) ? '#000' : '#333',
                                  fontWeight: (isActive || isSelected || part.isMatch) ? 'bold' : 'normal',
                                  borderBottom: '1px solid #e0e0e0',
                                  boxShadow: part.isActiveMatch
                                    ? '0 2px 4px rgba(255, 107, 107, 0.5)'
                                    : (part.isMatch
                                      ? '0 2px 4px rgba(255, 235, 59, 0.5)'
                                      : (isActive
                                        ? '0 2px 4px rgba(255, 215, 0, 0.3)'
                                        : (isSelected ? '0 2px 4px rgba(144, 238, 144, 0.3)' : 'none'))),
                                  cursor: 'pointer',
                                  userSelect: 'none',
                                  border: isSelectionStart
                                    ? '2px solid green'
                                    : (isSelectionEnd ? '2px solid red' : 'none'),
                                  textDecoration: 'underline',
                                  textDecorationColor: '#999',
                                  textDecorationThickness: '1px',
                                  marginRight: 4
                                }}
                                title={`${(caption.startMs/1000).toFixed(2)}s → ${(caption.endMs/1000).toFixed(2)}s`}
                              >
                                {caption.text}
                              </span>
                            )
                            wordIndex++
                          }
                        } else if (word) {
                          // This is whitespace - add it without incrementing wordIndex
                          result.push(<span key={`space-${partIdx}-${wordIdx}`}>{word}</span>)
                        }
                      })
                    })

                    return result
                  }

                  return (
                    <p
                      style={{
                        margin: '8px 12px',
                        lineHeight: 1.8,
                        fontSize: '1.1em',
                        color: '#333',
                        whiteSpace: 'normal',
                        wordBreak: 'break-word',
                        textAlign: 'left',
                      }}
                    >
                      {renderWithHighlights()}
                    </p>
                  )
                }}
              />
            </div>
          </div>
        )}

        {subclipUrl && (
          <div style={{
            marginTop: '1rem',
            padding: '0.75rem',
            backgroundColor: '#e8f5e9',
            border: '2px solid #4caf50',
            borderRadius: '4px',
            position: 'sticky',
            bottom: '20px',
            display: 'flex',
            gap: '1rem',
            alignItems: 'center'
          }}>
            <audio
              ref={subclipAudioRef}
              controls
              src={subclipUrl}
              style={{ flex: '1', minWidth: '200px' }}
            />

            <div style={{ flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {selectedRange && (
                <div style={{ fontSize: '0.85em', color: '#666' }}>
                  Captions {selectedRange.start + 1}-{selectedRange.end + 1}
                  ({((captionsData[selectedRange.end].endMs - captionsData[selectedRange.start].startMs) / 1000).toFixed(1)}s)
                </div>
              )}

              <div style={{ fontSize: '0.85em', color: '#666' }}>
                Trim: {((trimValues[0] / 100) * subclipDuration).toFixed(1)}-{((trimValues[1] / 100) * subclipDuration).toFixed(1)}s
              </div>

              <ReactSlider
                className="horizontal-slider"
                thumbClassName="thumb"
                trackClassName="track"
                value={trimValues}
                onChange={(value) => handleTrimChange(value as [number, number])}
                min={0}
                max={100}
                minDistance={5}
                renderThumb={(props) => (
                  <div
                    {...props}
                    style={{
                      ...props.style,
                      height: '16px',
                      width: '16px',
                      borderRadius: '50%',
                      backgroundColor: '#4caf50',
                      border: '2px solid #fff',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                      cursor: 'grab'
                    }}
                  />
                )}
                renderTrack={(props, state) => (
                  <div
                    {...props}
                    style={{
                      ...props.style,
                      height: '4px',
                      borderRadius: '2px',
                      backgroundColor: state.index === 1 ? '#4caf50' : '#ddd'
                    }}
                  />
                )}
              />
            </div>
          </div>
        )}

      </div>
    </>
  )
}

export default App

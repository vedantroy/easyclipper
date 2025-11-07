import { useState, useRef, useMemo, useEffect } from 'react'
import ReactSlider from 'react-slider'
import localforage from 'localforage'
import { Virtuoso  } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import { useQueryParams, StringParam } from 'use-query-params'
// import { SoundTouch, SimpleFilter } from 'soundtouchjs'
import './App.css'
import { UploadScreen } from '@/components/screens/upload-screen'
import { ProcessingScreen } from '@/components/screens/processing-screen'
import { loadAudioBuffer, trimAudioBuffer, audioBufferToWav } from '@/lib/audio-utils'
import { formatTime } from '@/lib/time'
import type { Caption, CachedTranscript } from '@/types/transcript'

// Speed edit type for persistent highlighting
type SpeedEdit = { id: string; startIdx: number; endIdx: number; rate: number }

// --- Transform pipeline types ---
type SpeedXform = { kind: 'speed'; startSec: number; endSec: number; rate: number }
type TrimXform  = { kind: 'trim';  startPct: number; endPct: number }
type Transform  = SpeedXform | TrimXform

const formatTimestampMs = (ms: number): string => {
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const milliseconds = ms % 1000
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`
}

const captionsToTranscription = (captions: Caption[]): string => {
  return captions.map(caption => (
    `[${formatTimestampMs(caption.startMs)} --> ${formatTimestampMs(caption.endMs)}] ${caption.text} (confidence: ${caption.confidence?.toFixed(3) ?? 'N/A'})`
  )).join('\n')
}

// Group consecutive words into chunks so each chunk becomes ONE virtual row.
// function chunkCaptions(
//   caps: Caption[],
//   maxChars = 400,
//   maxGapMs = 900
// ) {
//   const chunks: { start: number; end: number; startMs: number; endMs: number }[] = []
//   if (!caps.length) return chunks

//   let start = 0
//   let charCount = 0

//   for (let i = 0; i < caps.length; i++) {
//     const wordLength = caps[i].text.length
//     const spaceNeeded = i > start ? 1 : 0 // space before word (except first)
//     const totalNeeded = charCount + spaceNeeded + wordLength

//     // Check if we should break the chunk
//     const tooLong = totalNeeded > maxChars && i > start // Don't break on first word
//     const hasGap = i > 0 && (caps[i].startMs - caps[i - 1].endMs) > maxGapMs

//     if (tooLong || hasGap) {
//       // End current chunk at previous word
//       chunks.push({
//         start,
//         end: i - 1,
//         startMs: caps[start].startMs,
//         endMs: caps[i - 1].endMs
//       })
//       start = i
//       charCount = wordLength
//     } else {
//       charCount = totalNeeded
//     }
//   }

//   // Add final chunk
//   if (start < caps.length) {
//     chunks.push({
//       start,
//       end: caps.length - 1,
//       startMs: caps[start].startMs,
//       endMs: caps[caps.length - 1].endMs
//     })
//   }

//   return chunks
// }

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
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null)
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
  const [activeFile, setActiveFile] = useState<File | null>(null)
  const [query, setQuery] = useQueryParams({
    page: StringParam,
    hash: StringParam
  })
  const currentPage = query.page ?? 'upload'
  const currentHash = typeof query.hash === 'string' ? query.hash : null
  useEffect(() => {
    if (!query.page) {
      setQuery({ page: 'upload' }, 'replaceIn')
    }
  }, [query.page, setQuery])

  // Search state
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [activeMatch, setActiveMatch] = useState(-1)

  // Detail view subclip modal state
  const [showDetailView, setShowDetailView] = useState(false)
  const hasCaptions = captionsData.length > 0
  const isActiveProcess = progress > 0 && progress < 100

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (showDetailView) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }

    // Cleanup on unmount
    return () => {
      document.body.style.overflow = ''
    }
  }, [showDetailView])
  const [subclipSpeedSelection, setSubclipSpeedSelection] = useState<{start: number, end: number} | null>(null)
  const [speedMultiplier, setSpeedMultiplier] = useState(1.0)
  const [speedEdits, setSpeedEdits] = useState<SpeedEdit[]>([])
  const [transforms, setTransforms] = useState<Transform[]>([])

  const audioRef = useRef<HTMLAudioElement>(null)
  const subclipAudioRef = useRef<HTMLAudioElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // Helper to check if a word index is in any speed edit range
  const isIdxInSpeedEdit = (idx: number) => {
    return speedEdits.some(edit => idx >= edit.startIdx && idx <= edit.endIdx)
  }

  // Get speed edit for a specific index
  const getSpeedEditForIdx = (idx: number): SpeedEdit | undefined => {
    return speedEdits.find(edit => idx >= edit.startIdx && idx <= edit.endIdx)
  }

  // Check if a range overlaps with existing speed edits
  const hasOverlap = (startIdx: number, endIdx: number, excludeId?: string) => {
    return speedEdits.some(edit => {
      if (excludeId && edit.id === excludeId) return false
      return !(endIdx < edit.startIdx || startIdx > edit.endIdx)
    })
  }

  // --- fixes ---
  // 1) safer time helpers
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const ensureAscending = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const

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

  // 4) keep the UI duration in sync with transforms (users thought "speed" did nothing)
  useEffect(() => {
    const render = async () => {
      if (!audioBuffer || !selectedRange) return
      const baseStartSec = captionsData[selectedRange.start].startMs / 1000
      const baseEndSec   = captionsData[selectedRange.end].endMs   / 1000
      const base = trimAudioBuffer(audioBuffer, baseStartSec, baseEndSec)
      let cur = base

      const speedTransforms = transforms.filter(t => t.kind === 'speed') as SpeedXform[]
      if (speedTransforms.length > 0) {
        cur = applyMultipleSpeedSegments(cur, speedTransforms)
      }

      const trim = transforms.find(t => t.kind === 'trim') as TrimXform | undefined
      if (trim) {
        const baseDur = base.duration
        const t0Base = (trim.startPct / 100) * baseDur
        const t1Base = (trim.endPct   / 100) * baseDur
        const t0 = speedTransforms.length > 0 ? mapTimeThroughMultipleSpeeds(t0Base, speedTransforms) : t0Base
        const t1 = speedTransforms.length > 0 ? mapTimeThroughMultipleSpeeds(t1Base, speedTransforms) : t1Base
        const [tStart, tEnd] = ensureAscending(t0, t1)
        cur = trimAudioBuffer(cur, tStart, tEnd)
      }

      // NEW: reflect the *current* duration (after speed/trim) so the trim readout is correct
      setSubclipDuration(cur.duration)

      const wav = await audioBufferToWav(cur)
      const url = URL.createObjectURL(wav)
      if (subclipUrl) URL.revokeObjectURL(subclipUrl)
      setSubclipUrl(url)
    }
    render()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioBuffer, selectedRange, transforms])

  // 3) rewrite the resampler (fix rounding & edge handling)
  // const applySpeedSegment = (buffer: AudioBuffer, xf: SpeedXform): AudioBuffer => {
  //   const ctx = initAudioContext()
  //   const r = Number.isFinite(xf.rate) && xf.rate > 0 ? xf.rate : 1

  //   const sr = buffer.sampleRate
  //   const startSample = clamp(Math.floor(xf.startSec * sr), 0, buffer.length)
  //   const endSample   = clamp(Math.floor(xf.endSec   * sr), startSample, buffer.length)

  //   // nothing to change, copy-through
  //   if (r === 1 || endSample <= startSample) return buffer

  //   const preLen    = startSample
  //   const segLenIn  = endSample - startSample
  //   const segLenOut = Math.max(1, Math.round(segLenIn / r)) // <- floor caused drift & "collapsed" tiny regions
  //   const postLen   = buffer.length - endSample
  //   const outLen    = preLen + segLenOut + postLen

  //   const out = ctx.createBuffer(buffer.numberOfChannels, outLen, sr)

  //   for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
  //     const src = buffer.getChannelData(ch)
  //     const dst = out.getChannelData(ch)

  //     // 3a) pre
  //     dst.set(src.subarray(0, preLen), 0)

  //     // 3b) resample segment with linear interpolation
  //     // map output index -> input position inside [startSample, endSample)
  //     // using exact ratio to avoid cumulative error
  //     const base = preLen
  //     for (let i = 0; i < segLenOut; i++) {
  //       const pos = startSample + (i * segLenIn) / segLenOut // <- was i * rate; this eliminates rounding error
  //       const idx = Math.floor(pos)
  //       const frac = pos - idx
  //       const i0 = clamp(idx, 0, endSample - 1)
  //       const i1 = clamp(idx + 1, 0, endSample - 1)
  //       dst[base + i] = src[i0] * (1 - frac) + src[i1] * frac
  //     }

  //     // 3c) post
  //     dst.set(src.subarray(endSample), preLen + segLenOut)
  //   }

  //   return out
  // }

  // Apply multiple speed segments
  const applyMultipleSpeedSegments = (buffer: AudioBuffer, speedTransforms: SpeedXform[]): AudioBuffer => {
    if (speedTransforms.length === 0) return buffer

    // Sort speed transforms by start time
    const sortedTransforms = [...speedTransforms].sort((a, b) => a.startSec - b.startSec)

    const ctx = initAudioContext()
    const sr = buffer.sampleRate
    const outputChannels: Float32Array[] = []

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const channelData = buffer.getChannelData(ch)
      const segments: Float32Array[] = []
      let lastEndSample = 0

      for (const xf of sortedTransforms) {
        const rate = Number.isFinite(xf.rate) && xf.rate > 0 ? xf.rate : 1
        const startSample = clamp(Math.floor(xf.startSec * sr), 0, buffer.length)
        const endSample = clamp(Math.floor(xf.endSec * sr), startSample, buffer.length)

        // Add unprocessed segment before this speed edit
        if (lastEndSample < startSample) {
          segments.push(channelData.slice(lastEndSample, startSample))
        }

        // Process the speed segment
        if (rate !== 1 && endSample > startSample) {
          const middle = channelData.slice(startSample, endSample)
          segments.push(timeStretchWSEW(middle, rate, sr))
        } else {
          segments.push(channelData.slice(startSample, endSample))
        }

        lastEndSample = endSample
      }

      // Add remaining unprocessed audio
      if (lastEndSample < channelData.length) {
        segments.push(channelData.slice(lastEndSample))
      }

      // Concatenate all segments
      const totalLength = segments.reduce((sum, seg) => sum + seg.length, 0)
      const outputChannel = new Float32Array(totalLength)
      let offset = 0
      for (const seg of segments) {
        outputChannel.set(seg, offset)
        offset += seg.length
      }

      outputChannels.push(outputChannel)
    }

    // Create output buffer
    const outputBuffer = ctx.createBuffer(
      buffer.numberOfChannels,
      outputChannels[0].length,
      sr
    )

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      outputBuffer.getChannelData(ch).set(outputChannels[ch])
    }

    return outputBuffer
  }

  // WSOLA (Waveform Similarity Overlap-Add) time stretching
  const timeStretchWSEW = (input: Float32Array, rate: number, sampleRate: number): Float32Array => {
    // Window size and hop size in samples
    const windowMs = 30 // Window size in milliseconds
    const windowSize = Math.round((windowMs / 1000) * sampleRate)
    const hopSize = Math.round(windowSize / 2)
    const searchRange = Math.round(windowSize / 4)

    // Calculate output length
    const outputLength = Math.round(input.length / rate)
    const output = new Float32Array(outputLength)

    let inputPos = 0
    let outputPos = 0

    // Copy first window directly
    const firstWindow = Math.min(windowSize, input.length, outputLength)
    for (let i = 0; i < firstWindow; i++) {
      output[i] = input[i]
    }
    outputPos = hopSize
    inputPos = Math.round(hopSize * rate)

    // Process remaining audio
    while (outputPos < outputLength - windowSize && inputPos < input.length - windowSize) {
      // Find best matching position in search range
      let bestOffset = 0
      let bestCorr = -Infinity

      const searchStart = Math.max(0, inputPos - searchRange)
      const searchEnd = Math.min(input.length - windowSize, inputPos + searchRange)

      // Find best correlation point
      for (let offset = searchStart; offset <= searchEnd; offset++) {
        let corr = 0
        const overlapSize = Math.min(hopSize, input.length - offset, outputLength - outputPos)

        for (let i = 0; i < overlapSize; i++) {
          corr += input[offset + i] * output[outputPos - hopSize + i]
        }

        if (corr > bestCorr) {
          bestCorr = corr
          bestOffset = offset
        }
      }

      // Overlap-add the best matching window
      const overlapSize = Math.min(hopSize, input.length - bestOffset, outputLength - outputPos)

      // Crossfade overlap region
      for (let i = 0; i < overlapSize; i++) {
        const fade = i / overlapSize
        output[outputPos + i] = output[outputPos + i] * (1 - fade) + input[bestOffset + i] * fade
      }

      // Copy non-overlapping part
      const copySize = Math.min(hopSize, input.length - bestOffset - overlapSize, outputLength - outputPos - overlapSize)
      for (let i = 0; i < copySize; i++) {
        output[outputPos + overlapSize + i] = input[bestOffset + overlapSize + i]
      }

      // Update positions
      outputPos += hopSize
      inputPos = Math.round(outputPos * rate)
    }

    // Handle remaining samples
    const remaining = Math.min(input.length - inputPos, outputLength - outputPos)
    if (remaining > 0 && outputPos < outputLength && inputPos < input.length) {
      for (let i = 0; i < remaining; i++) {
        if (outputPos + i < outputLength && inputPos + i < input.length) {
          output[outputPos + i] = input[inputPos + i]
        }
      }
    }

    return output
  }

  // Map time through multiple speed segments
  const mapTimeThroughMultipleSpeeds = (t: number, speedTransforms: SpeedXform[]): number => {
    if (speedTransforms.length === 0) return t

    // Sort transforms by start time
    const sorted = [...speedTransforms].sort((a, b) => a.startSec - b.startSec)
    let currentTime = t
    let offset = 0

    for (const xf of sorted) {
      const rate = Number.isFinite(xf.rate) && xf.rate > 0 ? xf.rate : 1
      const [startSec, endSec] = ensureAscending(xf.startSec, xf.endSec)

      if (currentTime <= startSec) {
        // Time is before this segment
        return offset + currentTime
      } else if (currentTime <= endSec) {
        // Time is within this segment
        return offset + startSec + (currentTime - startSec) / rate
      } else {
        // Time is after this segment, accumulate offset
        offset += startSec + (endSec - startSec) / rate - endSec
        currentTime = currentTime // Keep original time for next iteration
      }
    }

    return offset + currentTime
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

  const handleWordClick = async (e: React.MouseEvent, index: number) => {
    // Ctrl (Win/Linux) or Cmd (macOS) => seek to audio position
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      e.stopPropagation()

      const word = captionsData[index]
      if (!word || !audioRef.current) return

      // Seek to word start time and play if paused
      audioRef.current.currentTime = word.startMs / 1000
      if (audioRef.current.paused) {
        audioRef.current.play().catch(() => {})
      }

      // Instant visual sync
      setActiveCaptionIndex(index)
      const chunkIdx = wordToChunk[index]
      if (chunkIdx != null) {
        virtuosoRef.current?.scrollToIndex({
          index: chunkIdx,
          align: 'center',
          behavior: 'auto'
        })
      }
      return
    }

    // Regular click => handle selection behavior
    handleCaptionClick(index)
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

      // Set up base subclip metadata; pipeline effect will render audio
      if (audioBuffer) {
        const startMs = captionsData[startIdx].startMs
        const endMs   = captionsData[endIdx].endMs
        setSubclipDuration((endMs - startMs) / 1000)
        setTrimValues([0, 100])
        // reset transforms (no speed by default; trim 0..100 no-op)
        setTransforms([{ kind: 'trim', startPct: 0, endPct: 100 }])
      }
    }
  }

  const handleTrimChange = (values: [number, number]) => {
    setTrimValues(values)
    // Upsert TRIM transform (executes *after* speed in the effect)
    setTransforms(prev => {
      const others = prev.filter(t => t.kind !== 'trim')
      return [...others, { kind: 'trim', startPct: values[0], endPct: values[1] }]
    })
  }

  const clearSelection = () => {
    setSelectionMode(false)
    setSelectedRange(null)
    setTransforms([])
    if (subclipUrl) {
      URL.revokeObjectURL(subclipUrl)
      setSubclipUrl('')
    }
  }

  const applySpeedAdjustment = () => {
    if (!audioBuffer || !selectedRange || !subclipSpeedSelection) return

    const startIdx = selectedRange.start + subclipSpeedSelection.start
    const endIdx = selectedRange.start + subclipSpeedSelection.end

    // Check for overlaps
    if (hasOverlap(startIdx, endIdx)) {
      alert('This selection overlaps with an existing speed edit. Please choose a different range.')
      return
    }

    const baseStartSec = captionsData[selectedRange.start].startMs / 1000
    const startSecLocal = Math.max(0, captionsData[startIdx].startMs / 1000 - baseStartSec)
    const endSecLocal = Math.max(startSecLocal, captionsData[endIdx].endMs / 1000 - baseStartSec)

    // Add new speed edit
    const newEdit: SpeedEdit = {
      id: `speed-${Date.now()}`,
      startIdx,
      endIdx,
      rate: speedMultiplier
    }

    setSpeedEdits(prev => [...prev, newEdit])

    // Update transforms with all speed edits
    setTransforms(prev => {
      const nonSpeedTransforms = prev.filter(t => t.kind !== 'speed')
      const speedTransforms: Transform[] = [...speedEdits, newEdit].map(edit => ({
        kind: 'speed' as const,
        startSec: captionsData[edit.startIdx].startMs / 1000 - baseStartSec,
        endSec: captionsData[edit.endIdx].endMs / 1000 - baseStartSec,
        rate: edit.rate
      }))
      return [...nonSpeedTransforms, ...speedTransforms]
    })

    setSubclipSpeedSelection(null)
  }

  const handleFileAccepted = async (file: File, fileHash: string) => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
    }

    setActiveFile(file)
    setCaptionsData([])
    setTranscription('')
    setProgress(0)
    setEstimatedTimeRemaining('')
    setAudioBuffer(null)

    const objectUrl = URL.createObjectURL(file)
    setAudioUrl(objectUrl)
    setCurrentTime(0)

    try {
      const cached = await localforage.getItem<CachedTranscript>(fileHash)
      if (cached) {
        setCaptionsData(cached.captions)
        setTranscription(captionsToTranscription(cached.captions))
        setProgress(100)
        setStatus('Loaded cached transcript!')
        setQuery({ page: 'edit', hash: fileHash }, 'replace')

        try {
          const buffer = await loadAudioBuffer(file)
          setAudioBuffer(buffer)
        } catch (bufferError) {
          console.warn('Failed to load audio buffer for cached file:', bufferError)
        }

        return
      }

      setStatus('Preparing processing pipeline...')
      setQuery({ page: 'processing', hash: fileHash }, 'replace')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error('Error preparing file for processing:', error)
      setStatus(`Error: ${message}`)
      setQuery({ page: 'upload', hash: undefined }, 'replace')
    }
  }

  const resetEditorState = () => {
    setStatus('Ready to transcribe')
    setTranscription('')
    setCaptionsData([])
    setAudioUrl('')
    setAudioBuffer(null)
    setActiveCaptionIndex(-1)
    setSelectionMode(false)
    setSelectedRange(null)
    setSubclipUrl('')
    setTrimValues([0, 100])
    setSubclipDuration(0)
    setProgress(0)
    setEstimatedTimeRemaining('')
    setSpeedEdits([])
    setTransforms([])
    setSubclipSpeedSelection(null)
    setSpeedMultiplier(1.0)
    setCurrentTime(0)
    setShowSearch(false)
    setSearchQuery('')
    setActiveMatch(-1)
    setShowDetailView(false)
    setActiveFile(null)
  }

  const handleClearCache = async () => {
    if (!currentHash) {
      return
    }

    try {
      await localforage.removeItem(currentHash)
    } catch (error) {
      console.error('Failed to remove cache entry:', error)
    } finally {
      resetEditorState()
      setQuery({ page: 'upload', hash: undefined }, 'replace')
    }
  }

  const handleProcessingComplete = async (fileHash: string, cacheData: CachedTranscript, totalTime: number) => {
    try {
      await localforage.setItem(fileHash, cacheData)
      console.log('Successfully saved to cache with hash:', fileHash)
    } catch (cacheError) {
      console.error('Failed to save to cache:', cacheError)
    }

    setTranscription(captionsToTranscription(cacheData.captions))
    setCaptionsData(cacheData.captions)
    setProgress(100)
    setStatus(`Transcription complete! (Total time: ${formatTime(totalTime)})`)
    setQuery({ page: 'edit', hash: fileHash }, 'replace')
  }

  useEffect(() => {
    if (currentPage !== 'edit' || !currentHash || hasCaptions) {
      return
    }

    let cancelled = false
    setStatus('Loading cached transcript...')
    setAudioUrl('')
    setAudioBuffer(null)

    const restoreFromCache = async () => {
      try {
        const cached = await localforage.getItem<CachedTranscript>(currentHash)
        if (!cached) {
          if (!cancelled) {
            setStatus('No cached transcript found for this hash. Returning to upload.')
            setQuery({ page: 'upload', hash: undefined }, 'replace')
          }
          return
        }

        if (cancelled) return

        setCaptionsData(cached.captions)
        setTranscription(captionsToTranscription(cached.captions))
        setProgress(100)
        setStatus('Loaded cached transcript! Upload the source file again to enable audio playback.')
      } catch (error) {
        console.error('Failed to load cached transcript via query params:', error)
        if (!cancelled) {
          setStatus('Error loading cached transcript.')
          setQuery({ page: 'upload', hash: undefined }, 'replace')
        }
      }
    }

    restoreFromCache()

    return () => {
      cancelled = true
    }
  }, [currentHash, currentPage, hasCaptions, setQuery])

  const invalidProcessingPage = currentPage === 'processing' && (!activeFile || !currentHash);
  useEffect(() => {
    if (invalidProcessingPage) {
      setQuery({ page: 'upload', hash: undefined}, 'replace')
    }
  }, [invalidProcessingPage])

  if (invalidProcessingPage) {
    return <div>bug</div>
  }

  if (currentPage === 'upload') {
    return <UploadScreen onFileAccepted={handleFileAccepted} />
  } else if (currentPage === 'processing') {
    return (
      <ProcessingScreen
        file={activeFile!!}
        fileHash={currentHash!!}
        onCancel={handleClearCache}
        onComplete={handleProcessingComplete}
        onAudioBufferReady={setAudioBuffer}
      />
    )
  }

  const isClearCacheDisabled = !currentHash
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

        <div style={{
          marginBottom: '2rem',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          alignItems: 'stretch'
        }}>
          <div style={{ flex: '1 1 300px' }}>
            <div style={{
              padding: '1rem',
              backgroundColor: isActiveProcess ? '#fff3cd' : '#d4edda',
              border: `1px solid ${isActiveProcess ? '#ffeaa7' : '#c3e6cb'}`,
              borderRadius: '4px',
              color: '#333',
              height: '100%'
            }}>
              <strong>Status:</strong> {status}

              {isActiveProcess && (
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

          <button
            onClick={handleClearCache}
            disabled={isClearCacheDisabled}
            style={{
              padding: '0.75rem 1rem',
              border: `1px solid ${isClearCacheDisabled ? '#ddd' : '#f5c2c7'}`,
              backgroundColor: isClearCacheDisabled ? '#f5f5f5' : '#f8d7da',
              color: isClearCacheDisabled ? '#888' : '#842029',
              borderRadius: '4px',
              fontWeight: 600,
              cursor: isClearCacheDisabled ? 'not-allowed' : 'pointer',
              transition: 'background-color 0.2s ease',
              minWidth: '180px',
              alignSelf: 'flex-start'
            }}
          >
            Clear cache & restart
          </button>
        </div>

        {audioUrl && (
          <div style={{ marginBottom: '2rem' }}>
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
                        const isSpeedEdited = isIdxInSpeedEdit(idx)
                        return (
                          <span
                            key={idx}
                            onClick={(e) => !isSpeedEdited ? handleWordClick(e, idx) : undefined}
                            style={{
                              padding: (isActive || isSelected || isSpeedEdited) ? '2px 4px' : 0,
                              backgroundColor: isSelected ? '#90EE90' : (isActive ? '#ffd700' : 'transparent'),
                              borderRadius: (isActive || isSelected || isSpeedEdited) ? 3 : 0,
                              transition: 'all 0.3s ease',
                              color: (isActive || isSelected || isSpeedEdited) ? '#000' : '#333',
                              fontWeight: (isActive || isSelected || isSpeedEdited) ? 'bold' : 'normal',
                              borderBottom: '1px solid #e0e0e0',
                              outline: isSpeedEdited ? '2px solid #2196f3' : 'none',
                              boxShadow: isSpeedEdited
                                ? 'inset 0 0 0 9999px rgba(33,150,243,0.15)'
                                : (isActive
                                  ? '0 2px 4px rgba(255, 215, 0, 0.3)'
                                  : (isSelected ? '0 2px 4px rgba(144, 238, 144, 0.3)' : 'none')),
                              cursor: isSpeedEdited ? 'default' : 'pointer',
                              userSelect: 'none',
                              border: isSelectionStart
                                ? '2px solid green'
                                : (isSelectionEnd ? '2px solid red' : 'none'),
                              textDecoration: 'underline',
                              textDecorationColor: '#999',
                              textDecorationThickness: '1px',
                              marginRight: 4
                            }}
                            title={(() => {
                              const edit = getSpeedEditForIdx(idx)
                              return `${(c.startMs/1000).toFixed(2)}s → ${(c.endMs/1000).toFixed(2)}s${edit ? ` • Speed ${edit.rate}x` : ''}`
                            })()}
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
                                onClick={(e) => handleWordClick(e, idx)}
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

            {selectedRange && (
              <div style={{ flex: '0 0 auto', fontSize: '0.85em', color: '#666' }}>
                Captions {selectedRange.start + 1}-{selectedRange.end + 1}
                ({((captionsData[selectedRange.end].endMs - captionsData[selectedRange.start].startMs) / 1000).toFixed(1)}s)
              </div>
            )}


            <button
              onClick={() => setShowDetailView(true)}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#2196f3',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '0.9em',
                whiteSpace: 'nowrap'
              }}
            >
              Detail View
            </button>
          </div>
        )}

        {/* Detail View Subclip Modal */}
        {showDetailView && subclipUrl && selectedRange && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            zIndex: 2000,
            display: 'flex',
            flexDirection: 'column',
            padding: '2rem'
          }}>
            <div style={{
              backgroundColor: '#fff',
              borderRadius: '8px',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden'
            }}>
              {/* Header */}
              <div style={{
                padding: '1rem',
                borderBottom: '1px solid #ddd',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <h2 style={{ margin: 0, color: '#333' }}>
                  Subclip Editor - Captions {selectedRange.start + 1}-{selectedRange.end + 1}
                </h2>
                <button
                  onClick={() => setShowDetailView(false)}
                  style={{
                    padding: '0.5rem 1rem',
                    backgroundColor: '#dc3545',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Close
                </button>
              </div>

              {/* Content */}
              <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                padding: '1rem',
                gap: '1rem',
                minHeight: 0,
                overflow: 'hidden'
              }}>
                {/* Audio Controls */}
                <div style={{
                  display: 'flex',
                  gap: '1rem',
                  alignItems: 'center',
                  padding: '1rem',
                  backgroundColor: '#f8f9fa',
                  borderRadius: '4px'
                }}>
                  <audio
                    controls
                    src={subclipUrl}
                    style={{ flex: 1 }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: '200px' }}>
                    <div style={{ fontSize: '0.9em', color: '#666' }}>
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
                      renderThumb={(props) => {
                        const { key, ...restProps } = props
                        return (
                          <div
                            key={key}
                            {...restProps}
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
                        )
                      }}
                      renderTrack={(props, state) => {
                        const { key, ...restProps } = props
                        return (
                          <div
                            key={key}
                            {...restProps}
                            style={{
                              ...props.style,
                              height: '4px',
                              borderRadius: '2px',
                              backgroundColor: state.index === 1 ? '#4caf50' : '#ddd'
                            }}
                          />
                        )
                      }}
                    />
                  </div>
                </div>

                {/* Applied Transformations - Compact */}
                {speedEdits.length > 0 && (
                  <div style={{
                    padding: '0.5rem',
                    backgroundColor: '#f8f9fa',
                    borderRadius: '4px',
                    border: '1px solid #dee2e6'
                  }}>
                    <div style={{ fontSize: '0.9em', fontWeight: 'bold', marginBottom: '0.5rem', color: '#333' }}>Applied Speed Edits</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', maxHeight: '120px', overflow: 'auto' }}>
                      {speedEdits.map(edit => {
                        const relativeStart = edit.startIdx - selectedRange.start + 1
                        const relativeEnd = edit.endIdx - selectedRange.start + 1
                        return (
                          <div
                            key={edit.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '0.25rem 0.5rem',
                              backgroundColor: '#e3f2fd',
                              border: '1px solid #90caf9',
                              borderRadius: '4px',
                              fontSize: '0.85em'
                            }}
                          >
                            <span style={{ color: '#1976d2' }}>
                              {edit.rate}x: words {relativeStart}-{relativeEnd}
                            </span>
                            <button
                              onClick={() => {
                                setSpeedEdits(prev => prev.filter(e => e.id !== edit.id))
                                setTransforms(prev => {
                                  const nonSpeed = prev.filter(t => t.kind !== 'speed')
                                  const baseStartSec = captionsData[selectedRange.start].startMs / 1000
                                  const speedTransforms = speedEdits
                                    .filter(e => e.id !== edit.id)
                                    .map(e => ({
                                      kind: 'speed' as const,
                                      startSec: captionsData[e.startIdx].startMs / 1000 - baseStartSec,
                                      endSec: captionsData[e.endIdx].endMs / 1000 - baseStartSec,
                                      rate: e.rate
                                    }))
                                  return [...nonSpeed, ...speedTransforms]
                                })
                              }}
                              style={{
                                padding: '0.2rem 0.4rem',
                                backgroundColor: '#dc3545',
                                color: 'white',
                                border: 'none',
                                borderRadius: '3px',
                                cursor: 'pointer',
                                fontSize: '0.8em'
                              }}
                            >
                              ×
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Speed Controls - Compact with inline apply */}
                <div style={{
                  padding: '0.5rem',
                  backgroundColor: '#f0f8ff',
                  borderRadius: '4px',
                  border: '1px solid #cce7ff'
                }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.9em', fontWeight: 'bold', color: '#333' }}>Speed:</span>
                    {[1.0, 1.5, 2.0, 3.0, 4.0].map(speed => (
                      <button
                        key={speed}
                        onClick={() => setSpeedMultiplier(speed)}
                        style={{
                          padding: '0.3rem 0.6rem',
                          backgroundColor: speedMultiplier === speed ? '#2196f3' : '#fff',
                          color: speedMultiplier === speed ? 'white' : '#333',
                          border: '1px solid #2196f3',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontSize: '0.85em'
                        }}
                      >
                        {speed}x
                      </button>
                    ))}
                    {subclipSpeedSelection && (
                      <>
                        <span style={{ color: '#666', fontSize: '0.85em', marginLeft: 'auto' }}>
                          Selected: {subclipSpeedSelection.start + 1}-{subclipSpeedSelection.end + 1}
                        </span>
                        <button
                          onClick={applySpeedAdjustment}
                          style={{
                            padding: '0.3rem 0.8rem',
                            backgroundColor: '#28a745',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '0.85em',
                            fontWeight: 'bold'
                          }}
                        >
                          Apply {speedMultiplier}x
                        </button>
                        <button
                          onClick={() => setSubclipSpeedSelection(null)}
                          style={{
                            padding: '0.3rem 0.6rem',
                            backgroundColor: '#6c757d',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '0.85em'
                          }}
                        >
                          Clear
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Subclip Words - Fixed scrolling */}
                <div style={{
                  flex: 1,
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0
                }}>
                  <div style={{
                    padding: '0.5rem',
                    borderBottom: '1px solid #ddd',
                    fontSize: '0.9em',
                    fontWeight: 'bold',
                    color: '#333',
                    flexShrink: 0
                  }}>
                    Words in Subclip (Click to select range for speed adjustment)
                  </div>
                  <div style={{
                    flex: 1,
                    overflow: 'auto',
                    padding: '0.75rem'
                  }}>
                    <div style={{
                      lineHeight: 1.8,
                      fontSize: '1.1em'
                    }}>
                    {captionsData.slice(selectedRange.start, selectedRange.end + 1).map((caption, i) => {
                      const globalIdx = selectedRange.start + i
                      const isInSpeedSelection = subclipSpeedSelection &&
                        i >= subclipSpeedSelection.start && i <= subclipSpeedSelection.end
                      const isSpeedSelectionStart = subclipSpeedSelection && i === subclipSpeedSelection.start
                      const isSpeedSelectionEnd = subclipSpeedSelection && i === subclipSpeedSelection.end
                      const isPersisted = isIdxInSpeedEdit(globalIdx)

                      return (
                        <span
                          key={globalIdx}
                          onClick={!isPersisted ? () => {
                            if (!subclipSpeedSelection) {
                              setSubclipSpeedSelection({ start: i, end: i })
                            } else {
                              const start = Math.min(subclipSpeedSelection.start, i)
                              const end = Math.max(subclipSpeedSelection.start, i)
                              setSubclipSpeedSelection({ start, end })
                            }
                          } : undefined}
                          style={{
                            padding: (isInSpeedSelection || isPersisted) ? '2px 4px' : 0,
                            backgroundColor: isInSpeedSelection ? '#ffeb3b' : (isPersisted ? '#e3f2fd' : 'transparent'),
                            outline: isPersisted ? '2px solid #2196f3' : 'none',
                            borderRadius: (isInSpeedSelection || isPersisted) ? 3 : 0,
                            cursor: isPersisted ? 'default' : 'pointer',
                            userSelect: 'none',
                            border: isSpeedSelectionStart
                              ? '2px solid #2196f3'
                              : (isSpeedSelectionEnd ? '2px solid #f44336' : 'none'),
                            marginRight: 4,
                            transition: 'all 0.2s ease'
                          }}
                          title={(() => {
                            const edit = getSpeedEditForIdx(globalIdx)
                            return `${(caption.startMs/1000).toFixed(2)}s → ${(caption.endMs/1000).toFixed(2)}s${edit ? ` • Speed ${edit.rate}x` : ''}`
                          })()}
                        >
                          {caption.text}
                        </span>
                      )
                    })}
                    </div>
                  </div>
                  {speedEdits.length > 0 && (
                    <div style={{
                      padding: '0.5rem',
                      borderTop: '1px solid #ddd',
                      flexShrink: 0
                    }}>
                      <button
                        onClick={() => {
                          setSpeedEdits([])
                          setTransforms(prev => prev.filter(t => t.kind !== 'speed'))
                        }}
                        style={{
                          padding: '0.3rem 0.8rem',
                          backgroundColor: '#ef5350',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontSize: '0.85em'
                        }}
                      >
                        Clear All Speed Edits
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  )
}

export default App

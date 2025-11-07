export interface Caption {
  text: string
  startMs: number
  endMs: number
  confidence: number | null
}

export interface CachedTranscript {
  hash: string
  fileName: string
  fileSize: number
  processedAt: string
  numChunks: number
  chunkingEnabled: boolean
  modelUsed: string
  captions: Caption[]
}

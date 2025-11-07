let audioContext: AudioContext | null = null

const getAudioContext = () => {
  if (audioContext) {
    return audioContext
  }
  const AudioContextCtor = (window.AudioContext || (window as any).webkitAudioContext)
  audioContext = new AudioContextCtor()
  return audioContext
}

export const loadAudioBuffer = async (file: File): Promise<AudioBuffer> => {
  const ctx = getAudioContext()
  const arrayBuffer = await file.arrayBuffer()
  return await ctx.decodeAudioData(arrayBuffer)
}

export const trimAudioBuffer = (buffer: AudioBuffer, startTime: number, endTime: number): AudioBuffer => {
  const ctx = getAudioContext()
  const sampleRate = buffer.sampleRate
  const startSample = Math.floor(startTime * sampleRate)
  const endSample = Math.floor(endTime * sampleRate)
  const duration = endSample - startSample

  const trimmedBuffer = ctx.createBuffer(
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

export const audioBufferToWav = async (buffer: AudioBuffer): Promise<Blob> => {
  const numberOfChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const format = 1 // PCM
  const bitDepth = 16

  const bytesPerSample = bitDepth / 8
  const blockAlign = numberOfChannels * bytesPerSample

  const data: Float32Array[] = []
  for (let channel = 0; channel < numberOfChannels; channel++) {
    data.push(buffer.getChannelData(channel))
  }

  const length = data[0].length
  const arrayBuffer = new ArrayBuffer(44 + length * numberOfChannels * bytesPerSample)
  const view = new DataView(arrayBuffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + length * numberOfChannels * bytesPerSample, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, format, true)
  view.setUint16(22, numberOfChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)

  writeString(36, 'data')
  view.setUint32(40, length * numberOfChannels * bytesPerSample, true)

  let offset = 44
  for (let i = 0; i < length; i++) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, data[channel][i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
      offset += 2
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' })
}

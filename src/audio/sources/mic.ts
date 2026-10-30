import type { AudioSource } from './types'

// Live input. Analysed only, never sent to the speakers (feedback).
export class MicSource implements AudioSource {
  readonly kind = 'mic'
  readonly audible = false
  readonly output: GainNode
  private stream: MediaStream | null = null
  private node: MediaStreamAudioSourceNode | null = null

  constructor(private ctx: AudioContext) {
    this.output = ctx.createGain()
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    this.node = this.ctx.createMediaStreamSource(this.stream)
    this.node.connect(this.output)
  }

  stop() {
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.node = null
    this.stream = null
  }

  dispose() {
    this.stop()
    this.output.disconnect()
  }
}

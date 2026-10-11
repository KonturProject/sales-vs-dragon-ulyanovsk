const STORAGE_KEY = 'sales_vs_dragon_muted';
const MASTER_VOLUME = 0.6;

/**
 * Purely-synthesized sound effects via the raw Web Audio API — there are no
 * audio files to load, so Phaser's Sound manager (built around loaded audio
 * assets) doesn't fit here. Defaults to muted (this is an always-on office
 * display, not something that should make noise unprompted); the mute
 * button's own first click is the user gesture that satisfies the browser's
 * autoplay policy and creates/resumes the AudioContext.
 */
class AudioSystemImpl {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private muted = localStorage.getItem(STORAGE_KEY) !== 'false';

    /** Safe to call repeatedly — a no-op after the first call. Must run inside a user-gesture handler. */
    init() {
        if (this.ctx) return;
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.muted ? 0 : MASTER_VOLUME;
        this.masterGain.connect(this.ctx.destination);
    }

    toggleMute(): boolean {
        this.muted = !this.muted;
        localStorage.setItem(STORAGE_KEY, String(this.muted));
        if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : MASTER_VOLUME;
        return this.muted;
    }

    get isMuted() {
        return this.muted;
    }

    playHitThud() {
        this.tone(110, 'sine', 0.001, 0.12);
        this.noiseBurst(0.05, 0.15);
    }

    /** Low rumbling roar + crash when the dragon loses a head. */
    playHeadLost() {
        this.tone(70, 'sawtooth', 0.01, 0.55);
        this.tone(52, 'square', 0.02, 0.6, 0.05);
        this.noiseBurst(0.5, 0.14, 'lowpass', 500);
    }

    /** A heavy thump — a hero keeling over. */
    playFall() {
        this.tone(85, 'sine', 0.002, 0.22);
        this.noiseBurst(0.12, 0.1, 'lowpass', 380);
    }

    /**
     * The dragon's growl: two detuned low oscillators sliding down, chopped by a fast
     * tremolo for the rasp, through a lowpass that opens and closes, plus rumbling noise.
     */
    playGrowl() {
        if (!this.ctx || !this.masterGain) return;
        const ctx = this.ctx;
        const t0 = ctx.currentTime;
        const duration = 1.6;

        const envelope = ctx.createGain();
        envelope.gain.setValueAtTime(0.0001, t0);
        envelope.gain.linearRampToValueAtTime(0.55, t0 + 0.2);
        envelope.gain.setValueAtTime(0.55, t0 + 0.9);
        envelope.gain.exponentialRampToValueAtTime(0.001, t0 + duration);

        const lowpass = ctx.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.Q.value = 3;
        lowpass.frequency.setValueAtTime(240, t0);
        lowpass.frequency.linearRampToValueAtTime(720, t0 + 0.5);
        lowpass.frequency.linearRampToValueAtTime(200, t0 + duration);

        // Tremolo sits before the envelope, so it dies away with the sound instead of buzzing on after it.
        const tremolo = ctx.createGain();
        tremolo.gain.value = 0.72;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 27;
        const lfoDepth = ctx.createGain();
        lfoDepth.gain.value = 0.28;
        lfo.connect(lfoDepth).connect(tremolo.gain);

        tremolo.connect(lowpass).connect(envelope).connect(this.masterGain);

        const voices: Array<[OscillatorType, number, number]> = [['sawtooth', 92, 46], ['square', 63, 33]];
        for (const [type, from, to] of voices) {
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.setValueAtTime(from, t0);
            osc.frequency.exponentialRampToValueAtTime(to, t0 + duration);
            const level = ctx.createGain();
            level.gain.value = type === 'square' ? 0.35 : 0.6;
            osc.connect(level).connect(tremolo);
            osc.start(t0);
            osc.stop(t0 + duration + 0.05);
        }
        lfo.start(t0);
        lfo.stop(t0 + duration + 0.05);

        this.noiseBurst(1.2, 0.09, 'lowpass', 320);
    }

    playFanfare() {
        [523, 659, 784, 1047].forEach((freq, i) => this.tone(freq, 'triangle', 0.005, 0.25, i * 0.12));
    }

    private tone(freq: number, type: OscillatorType, attack: number, duration: number, delay = 0) {
        if (!this.ctx || !this.masterGain) return;
        const t0 = this.ctx.currentTime + delay;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.5, t0 + attack);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + attack + duration);
        osc.connect(gain).connect(this.masterGain);
        osc.start(t0);
        osc.stop(t0 + attack + duration + 0.02);
    }

    private noiseBurst(duration: number, gainLevel: number, filterType?: BiquadFilterType, freq?: number) {
        if (!this.ctx || !this.masterGain) return;
        const bufferSize = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

        const src = this.ctx.createBufferSource();
        src.buffer = buffer;

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(gainLevel, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

        let node: AudioNode = src;
        if (filterType) {
            const filter = this.ctx.createBiquadFilter();
            filter.type = filterType;
            filter.frequency.value = freq ?? 1000;
            src.connect(filter);
            node = filter;
        }
        node.connect(gain).connect(this.masterGain);
        src.start();
    }
}

export const AudioSystem = new AudioSystemImpl();

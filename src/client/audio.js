        // Web Audio Synthesizer
        const audio = {
            ctx: null,
            muted: false,
            init() {
                if (!this.ctx) {
                    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
                    if (AudioCtxClass) this.ctx = new AudioCtxClass();
                }
                if (this.ctx && this.ctx.state === 'suspended') {
                    this.ctx.resume();
                }
            },
            playTone(freq, type, duration, startVol = 0.1, endVol = 0) {
                if (this.muted) return;
                this.init();
                if (!this.ctx) return;
                try {
                    const osc = this.ctx.createOscillator();
                    const gain = this.ctx.createGain();
                    osc.type = type;
                    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
                    gain.gain.setValueAtTime(startVol, this.ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(Math.max(endVol, 0.0001), this.ctx.currentTime + duration);
                    osc.connect(gain);
                    gain.connect(this.ctx.destination);
                    osc.start();
                    osc.stop(this.ctx.currentTime + duration);
                } catch(e) {}
            },
            playStart() {
                if (this.muted) return;
                this.playTone(440, 'sine', 0.1, 0.15);
                setTimeout(() => this.playTone(554.37, 'sine', 0.1, 0.15), 100);
                setTimeout(() => this.playTone(659.25, 'sine', 0.2, 0.2), 200);
            },
            playJump() {
                if (this.muted) return;
                this.init();
                if (!this.ctx) return;
                try {
                    const osc = this.ctx.createOscillator();
                    const gain = this.ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(160, this.ctx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(420, this.ctx.currentTime + 0.15);
                    gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.15);
                    osc.connect(gain);
                    gain.connect(this.ctx.destination);
                    osc.start();
                    osc.stop(this.ctx.currentTime + 0.15);
                } catch(e) {}
            },
            playCoin() {
                if (this.muted) return;
                this.playTone(987.77, 'triangle', 0.08, 0.15);
                setTimeout(() => this.playTone(1318.51, 'triangle', 0.15, 0.2), 60);
            },
            playBoxHit() {
                if (this.muted) return;
                this.playTone(300, 'square', 0.1, 0.12);
                setTimeout(() => this.playTone(600, 'square', 0.2, 0.18), 80);
            },
            playWheelTick() {
                if (this.muted) return;
                this.playTone(800, 'sine', 0.03, 0.06);
            },
            playReward() {
                if (this.muted) return;
                const notes = [523.25, 659.25, 783.99, 1046.50];
                notes.forEach((freq, idx) => {
                    setTimeout(() => this.playTone(freq, 'sine', 0.2, 0.2), idx * 100);
                });
            }
        };

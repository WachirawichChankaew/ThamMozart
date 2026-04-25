class MicProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 4096; 
        this.floatBuffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input.length) return true;
        
        const channelData = input[0];
        if (!channelData) return true;

        for (let i = 0; i < channelData.length; i++) {
            this.floatBuffer[this.bufferIndex++] = channelData[i];

            if (this.bufferIndex >= this.bufferSize) {
                // บีบอัดเสียงด้วยความเร็วแสง
                const int16Array = new Int16Array(this.bufferSize);
                for (let j = 0; j < this.bufferSize; j++) {
                    let s = this.floatBuffer[j] * 0.8; // ลดเสียงกันแตก
                    if (s > 1) s = 1; else if (s < -1) s = -1;
                    int16Array[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                
                // ส่งข้าม Thread กลับไปให้ client.js 
                this.port.postMessage(int16Array.buffer, [int16Array.buffer]);
                
                this.floatBuffer = new Float32Array(this.bufferSize);
                this.bufferIndex = 0;
            }
        }
        return true; // สั่งให้ทำงานต่อไปเรื่อยๆ
    }
}

registerProcessor('mic-processor', MicProcessor);
/**
 * client.js - ThamMozart Client Logic
 */

// --- 1. ระบบแจ้งเตือน (Notifications) ---
function notify(msg, type = 'info') {
    const container = document.getElementById('notification-area');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span>${type === 'error' ? '⚠️' : (type === 'success' ? '✅' : 'ℹ️')}</span>
        <span>${msg}</span>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// --- 2. ตัวแปรสถานะ (Global States) ---
let ws;
let myName = "", currentInst = "", selectedRoom = "", myId = "";
let micStream = null, scriptProcessor = null, micCtx = null, isMicOn = false;
let isSustain = false, nextAudioTime = 0;
let toneInstruments = {};

// --- 3. การตั้งค่าปุ่มกด (Input Mapping) ---
const KeyMaps = {
    'Piano': {
        'z': 48, 's': 49, 'x': 50, 'd': 51, 'c': 52, 'v': 53, 'g': 54, 'b': 55, 'h': 56, 'n': 57, 'j': 58, 'm': 59,
        'q': 60, '2': 61, 'w': 62, '3': 63, 'e': 64, 'r': 65, '5': 66, 't': 67, '6': 68, 'y': 69, '7': 70, 'u': 71,
        'i': 72, '9': 73, 'o': 74, '0': 75, 'p': 76, '[': 77, '=': 78, ']': 79
    },
    'Drum': {
        '1': 'kick', 'q': 'kick', '2': 'snare', 'w': 'snare', '3': 'closehihat', 'e': 'closehihat',
        '4': 'openhihat', 'r': 'openhihat', '5': 'tom1', 't': 'tom1', '6': 'tom2', 'y': 'tom2',
        '7': 'floor', 'u': 'floor', '8': 'crash', 'i': 'crash', '9': 'ride', 'o': 'ride'
    },
    'Guitar': { '1': 5, '2': 4, '3': 3, '4': 2, '5': 1, '6': 0 },
    'Bass': { '1': 3, '2': 2, '3': 1, '4': 0 }
};

const KeyLabels = {
    48: 'Z', 49: 'S', 50: 'X', 51: 'D', 52: 'C', 53: 'V', 54: 'G', 55: 'B', 56: 'H', 57: 'N', 58: 'J', 59: 'M',
    60: 'Q', 61: '2', 62: 'W', 63: '3', 64: 'E', 65: 'R', 66: '5', 67: 'T', 68: '6', 69: 'Y', 70: '7', 71: 'U',
    72: 'I', 73: '9', 74: 'O', 75: '0', 76: 'P', 77: '[', 78: '=', 79: ']'
};

// --- 4. การจัดการคีย์บอร์ด (Event Listeners) ---
document.addEventListener('keydown', (e) => {
    if (!currentInst || document.getElementById('chatMsg') === document.activeElement) return;
    const key = e.key.toLowerCase();

    if (currentInst === 'Piano' && key === ' ') {
        toggleSustain();
        return;
    }

    const map = KeyMaps[currentInst];
    if (map && map[key] !== undefined) {
        playLocalNote(map[key], currentInst);
        triggerVisual({ instrument: currentInst, note: map[key] });
    }
});

// --- 5. การเชื่อมต่อ WebSocket ---
function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host);
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
        notify("Connected", "success");
        send('LOGIN', { name: myName });
        switchScreen('lobby');
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            playAudioStream(event.data);
        } else {
            try { handleServerMessage(JSON.parse(event.data)); } catch (e) { }
        }
    };

    ws.onclose = () => {
        notify("Disconnected", "error");
        stopMic();
        setTimeout(connect, 3000);
    };
}

function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
}

function handleServerMessage(msg) {
    switch (msg.type) {
        case 'UPDATE_LOBBY': renderLobby(msg.payload); break;
        case 'JOIN_SUCCESS':
            myId = msg.payload.myId; // รับ Unique ID ของตัวเอง
            enterRoom(msg.payload);
            break;
        case 'UPDATE_MEMBERS': renderMembers(msg.payload); break;
        case 'CHAT': renderChat(msg.payload); break;
        case 'NOTE_PLAY': triggerVisual(msg.payload); playRemoteNote(msg.payload); break;
        case 'INSTRUMENT_CHANGED': renderInstrument(msg.payload); break;
        case 'ERROR': notify(msg.payload, "error"); break;
    }
}

// --- 6. ระบบไมโครโฟนและสตรีมเสียง (Mic & Audio) ---
async function toggleMic() {
    if (Tone.context.state !== 'running') await Tone.start();
    const btn = document.getElementById('micBtn');

    if (!isMicOn) {
        try {
            // ✅ 1. สร้าง AudioContext แยกเฉพาะสำหรับไมค์ (ไม่ผ่าน Tone.js)
            // เช็คว่าถ้ายังไม่มีให้สร้างแค่ครั้งเดียว ทิ้งไว้เลย จะช่วยลดอาการเสียงกระตุกได้มาก
            if (!micCtx) {
                micCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (micCtx.state === 'suspended') {
                await micCtx.resume();
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true 
                }
            });
            micStream = stream;
            isMicOn = true;
            btn.classList.add('mic-active');

            const source = micCtx.createMediaStreamSource(stream);

            // ✅ 2. ตอนนี้เบราว์เซอร์จะรู้จักคำสั่งนี้แล้ว (เพราะไม่โดน Tone.js บล็อก)
            scriptProcessor = micCtx.createScriptProcessor(4096, 1, 1);

            scriptProcessor.onaudioprocess = (e) => {
                if (!isMicOn || ws.readyState !== 1) return;
                const input = e.inputBuffer.getChannelData(0);
                
                const buffer = new ArrayBuffer(4 + (input.length * 2));
                const view = new DataView(buffer);
                
                // ฝังค่า Sample Rate ให้ผู้ฟัง
                view.setFloat32(0, micCtx.sampleRate, true); 

                for (let i = 0; i < input.length; i++) {
                    // ✅ 3. ลดความดังลงนิดหน่อย (0.8) กันเสียงแตกเวลาพูดดัง (Clipping)
                    let s = Math.max(-1, Math.min(1, input[i] * 0.8));
                    view.setInt16(4 + (i * 2), s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                }
                ws.send(buffer);
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(micCtx.destination);

            const mute = micCtx.createGain();
            mute.gain.value = 0;
            scriptProcessor.connect(mute);
            mute.connect(micCtx.destination);
        } catch (e) { notify("Mic Error: " + e.message, "error"); }
    } else { stopMic(); }
}

function stopMic() {
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (scriptProcessor) { 
        scriptProcessor.disconnect(); 
        scriptProcessor = null; 
    }

    
    isMicOn = false;
    document.getElementById('micBtn').classList.remove('mic-active');
}

function playAudioStream(buffer) {
    const audioCtx = Tone.context.rawContext; // ส่วนการเล่นเสียง ยังใช้ของ Tone ได้ปกติ
    const view = new DataView(buffer);
    
    const senderSampleRate = view.getFloat32(0, true);
    // เช็คว่า Sample rate สมเหตุสมผลหรือไม่
    if (senderSampleRate < 8000 || senderSampleRate > 96000) return;
    
    const float32 = new Float32Array((buffer.byteLength - 4) / 2);
    for (let i = 0; i < float32.length; i++) {
        const int16 = view.getInt16(4 + (i * 2), true);
        float32[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7FFF;
    }

    const audioBuf = audioCtx.createBuffer(1, float32.length, senderSampleRate);
    audioBuf.getChannelData(0).set(float32);
    
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(audioCtx.destination);

    const currentTime = audioCtx.currentTime;

    // ✅ 4. ระบบรอคิวเสียง (Jitter Buffer): หน่วง 0.25 วิ ให้เน็ตต่อคิวเสียงทัน 
    // ช่วยแก้ปัญหาไมค์ช็อตหรือเสียงขาดหายเหมือนหุ่นยนต์
    if (nextAudioTime < currentTime || nextAudioTime > currentTime + 1.0) {
        nextAudioTime = currentTime + 0.25; 
    }

    src.start(nextAudioTime);
    nextAudioTime += audioBuf.duration;
}

// --- 7. การแสดงผล UI (Lobby & Room) ---
function renderLobby(rooms) {
    const list = document.getElementById('roomList');
    list.innerHTML = rooms.length ? rooms.map(r => `
        <div class="room-cards">
            <div class="left-ticket">
                <strong>Title : ${r.name}</strong><br>
                <small style="opacity:0.5">ID: ${r.id.substring(0, 8)}</small><br>
                <small>Capacity : ${r.count}/${r.max} ${r.locked ? '🔒' : ''}</small>
            </div>
            <div class="right-ticket">
                ${r.count < r.max
            ? `<button onclick="prepareJoin('${r.id}', ${r.locked})" class="button-join">JOIN</button>`
            : `<div class="button-join-red">FULL</div>`
        }
            </div>
        </div>`).join('') : '<div style="grid-column: 1/-1; text-align:center;">No rooms available</div>';
}

function prepareJoin(id, l) {
    selectedRoom = id; // ใช้ ID แทนชื่อห้อง
    document.getElementById('passField').style.display = l ? 'block' : 'none';
    document.getElementById('joinModal').style.display = 'flex';
}

function confirmJoin() {
    send('JOIN_ROOM', {
        roomId: selectedRoom, // ส่งเป็น ID
        password: document.getElementById('joinPass').value,
        instrument: document.getElementById('joinInst').value
    });
    closeModals();
}

// --- 8. ระบบเครื่องดนตรี (Audio Engine) ---
async function initAudio() {
    if (toneInstruments.piano) return;

    // สร้าง Reverb และเพิ่มความดังรวม (Output Gain)
    const reverb = new Tone.Reverb(0.4).toDestination();

    // 1. Piano - ปรับให้ดังขึ้น
    toneInstruments.piano = new Tone.Sampler({
        urls: {
            "A0": "A0.mp3", "B0": "B0.mp3", "C1": "C1.mp3", "D1": "D1.mp3", "E1": "E1.mp3", "F1": "F1.mp3", "G1": "G1.mp3",
            "A1": "A1.mp3", "B1": "B1.mp3", "C2": "C2.mp3", "D2": "D2.mp3", "E2": "E2.mp3", "F2": "F2.mp3", "G2": "G2.mp3",
            "A2": "A2.mp3", "B2": "B2.mp3", "C3": "C3.mp3", "D3": "D3.mp3", "E3": "E3.mp3", "F3": "F3.mp3", "G3": "G3.mp3",
            "A3": "A3.mp3", "B3": "B3.mp3", "C4": "C4.mp3", "D4": "D4.mp3", "E4": "E4.mp3", "F4": "F4.mp3", "G4": "G4.mp3",
            "A4": "A4.mp3", "B4": "B4.mp3", "C5": "C5.mp3", "D5": "D5.mp3", "E5": "E5.mp3", "F5": "F5.mp3", "G5": "G5.mp3",
            "A5": "A5.mp3", "B5": "B5.mp3", "C6": "C6.mp3", "D6": "D6.mp3", "E6": "E6.mp3", "F6": "F6.mp3", "G6": "G6.mp3",
            "A6": "A6.mp3", "B6": "B6.mp3", "C7": "C7.mp3", "D7": "D7.mp3", "E7": "E7.mp3", "F7": "F7.mp3", "G7": "G7.mp3",
            "A7": "A7.mp3", "B7": "B7.mp3", "C8": "C8.mp3",
            "Ab1": "Ab1.mp3", "Bb0": "Bb0.mp3", "Bb1": "Bb1.mp3", "Db1": "Db1.mp3", "Eb1": "Eb1.mp3", "Gb1": "Gb1.mp3",
            "Ab2": "Ab2.mp3", "Bb2": "Bb2.mp3", "Db2": "Db2.mp3", "Eb2": "Eb2.mp3", "Gb2": "Gb2.mp3",
            "Ab3": "Ab3.mp3", "Bb3": "Bb3.mp3", "Db3": "Db3.mp3", "Eb3": "Eb3.mp3", "Gb3": "Gb3.mp3",
            "Ab4": "Ab4.mp3", "Bb4": "Bb4.mp3", "Db4": "Db4.mp3", "Eb4": "Eb4.mp3", "Gb4": "Gb4.mp3",
            "Ab5": "Ab5.mp3", "Bb5": "Bb5.mp3", "Db5": "Db5.mp3", "Eb5": "Eb5.mp3", "Gb5": "Gb5.mp3",
            "Ab6": "Ab6.mp3", "Bb6": "Bb6.mp3", "Db6": "Db6.mp3", "Eb6": "Eb6.mp3", "Gb6": "Gb6.mp3",
            "Ab7": "Ab7.mp3", "Bb7": "Bb7.mp3", "Db7": "Db7.mp3", "Eb7": "Eb7.mp3", "Gb7": "Gb7.mp3", "Db8": "Db8.mp3"
        },
        baseUrl: "/sounds/piano/",

    }).connect(reverb);

    // ตั้งค่าความดังเปียโน (หน่วยเป็น dB)
    toneInstruments.piano.volume.value = 20;

    // 2. Drums - ปรับให้กระแทกกระทั้นขึ้น
    toneInstruments.drums = new Tone.Players({
        "kick": "kick.mp3", "snare": "snare.mp3", "closehihat": "closehihat.mp3",
        "openhihat": "openhihat.mp3", "tom1": "tom1.mp3", "tom2": "tom2.mp3",
        "floor": "floor.mp3", "crash": "crash.mp3", "ride": "ride.mp3"
    }, {
        baseUrl: "/sounds/drum/",

    }).toDestination();

    // ตั้งค่าความดังกลอง
    toneInstruments.drums.volume.value = 5;

    // 3. Guitar - 6 strings using Guitar_E, A, D, G, B, E files
    toneInstruments.guitar = new Tone.Players({
        "E2": "Guitar_E.mp3",
        "A2": "Guitar_A.mp3",
        "D3": "Guitar_D.mp3",
        "G3": "Guitar_G.mp3",
        "B3": "Guitar_B.mp3",
        "E4": "Guitar_C.mp3"  // high E uses Guitar_C (closest available high tone)
    }, { baseUrl: "/sounds/guitar/" }).connect(reverb);
    toneInstruments.guitar.volume.value = 8;

    // 4. Bass - 4 strings using bass1~4 files
    toneInstruments.bass = new Tone.Players({
        "G2": "bass1.mp3",
        "D2": "bass2.mp3",
        "A1": "bass3.mp3",
        "E1": "bass4.mp3"
    }, { baseUrl: "/sounds/bass/" }).toDestination();
    toneInstruments.bass.volume.value = 12;
}

const SoundEngine = {
    playPiano: (note, sus) => {
        if (toneInstruments.piano?.loaded) {
            toneInstruments.piano.triggerAttackRelease(Tone.Frequency(note, "midi").toNote(), sus ? "1n" : "8n");
        }
    },
    playGuitar: (idx) => {
        const keys = ["E2", "A2", "D3", "G3", "B3", "E4"];
        const key = keys[idx];
        if (key && toneInstruments.guitar?.has(key)) {
            toneInstruments.guitar.player(key).start();
        }
    },
    playBass: (idx) => {
        const keys = ["G2", "D2", "A1", "E1"];
        const key = keys[idx];
        if (key && toneInstruments.bass?.has(key)) {
            toneInstruments.bass.player(key).start();
        }
    },
    playDrum: (type) => {
        if (toneInstruments.drums?.has(type)) {
            toneInstruments.drums.player(type).start();
        }
    }
};
function renderInstrument(type) {
    currentInst = type;
    const deck = document.getElementById('instrumentDeck');
    deck.innerHTML = '';
    document.getElementById('sustainBtn').style.display = (type === 'Piano') ? 'flex' : 'none';

    if (type === 'Piano') {
        const p = document.createElement('div');
        p.className = 'piano';

        // ตัวแปรเก็บสถานะนิ้วที่กำลังสัมผัสอยู่ (ป้องกันไม่ให้โน้ตเล่นซ้ำรัวๆ เวลาลากผ่านปุ่มเดิม)
        let activeTouches = {};

        const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        for (let i = 0; i < 36; i++) {
            const midi = i + 48;
            const k = document.createElement('div');
            k.className = `key ${keys[i % 12].includes('#') ? 'black' : 'white'}`;
            k.id = `note-${midi}`;
            if (KeyLabels[midi]) k.setAttribute('data-key', KeyLabels[midi]);

            // สำหรับเมาส์คลิกบน Desktop
            k.onmousedown = () => {
                playLocalNote(midi, 'Piano');
                triggerVisual({ instrument: 'Piano', note: midi });
            };

            // กดครั้งแรก (Touch Start)
            k.addEventListener('touchstart', (e) => {
                e.preventDefault();
                for (let j = 0; j < e.changedTouches.length; j++) {
                    const touch = e.changedTouches[j];
                    activeTouches[touch.identifier] = midi; // บันทึกว่านิ้วนี้กำลังกดโน้ตอะไรอยู่
                    playLocalNote(midi, 'Piano');
                    triggerVisual({ instrument: 'Piano', note: midi });
                }
            }, { passive: false });

            p.appendChild(k);
        }

        // --- ระบบลากนิ้ว (Touch Move) ---
        p.addEventListener('touchmove', (e) => {
            e.preventDefault(); // ป้องกันหน้าจอเลื่อนเวลาลากนิ้ว
            for (let i = 0; i < e.touches.length; i++) {
                const touch = e.touches[i];
                // หาว่าพิกัดที่นิ้วลากผ่านตอนนี้ คือ Element ตัวไหน
                const el = document.elementFromPoint(touch.clientX, touch.clientY);

                if (el && el.classList.contains('key')) {
                    // ดึงเลข Midi จาก ID ของปุ่ม (เช่น "note-48" -> 48)
                    const midi = parseInt(el.id.replace('note-', ''));

                    // ถ้าโน้ตที่นิ้วแตะอยู่ ไม่ใช่โน้ตเดิม ให้เล่นเสียงใหม่
                    if (activeTouches[touch.identifier] !== midi) {
                        activeTouches[touch.identifier] = midi;
                        playLocalNote(midi, 'Piano');
                        triggerVisual({ instrument: 'Piano', note: midi });
                    }
                }
            }
        }, { passive: false });

        // ล้างข้อมูลนิ้วเมื่อยกนิ้วออก หรือโดนขัดจังหวะ
        p.addEventListener('touchend', cleanUpTouches);
        p.addEventListener('touchcancel', cleanUpTouches);

        function cleanUpTouches(e) {
            for (let i = 0; i < e.changedTouches.length; i++) {
                delete activeTouches[e.changedTouches[i].identifier];
            }
        }

        deck.appendChild(p);

    } else if (type === 'Drum') {
        const c = document.createElement('div'); 
        c.className = 'drum-kit-pro'; // ใช้คลาสใหม่เพื่อจัดเลย์เอาต์สมจริง
        
        // รายการกลองตามที่คุณต้องการ พร้อมรูปภาพจาก assets/Drum/
        const drums = [
            { id: 'crash', img: 'crash.png', label: 'Crash' },
            { id: 'tom1', img: 'tom.png', label: 'Tom' },
            { id: 'tom2', img: 'tom.png', label: 'Tom' },
            { id: 'ride', img: 'ride.png', label: 'Ride' },
            { id: 'openhihat', img: 'openhihat.png', label: 'Open HH' },
            { id: 'snare', img: 'snare.png', label: 'Snare' },
            { id: 'floor', img: 'floor.png', label: 'Floor' },
            { id: 'closehihat', img: 'closehihat.png', label: 'Close HH' },
            { id: 'kick1', img: 'kick.png', label: 'Kick', sound: 'kick' },
            { id: 'kick2', img: 'kick.png', label: 'Kick', sound: 'kick' }
        ];

        drums.forEach(d => {
            const b = document.createElement('div'); 
            b.className = `drum-item ${d.id}`; 
            b.id = `drum-${d.id}`;
            
            // ใส่รูปภาพกลอง
            b.innerHTML = `
                <img src="assets/Drum/${d.img}" alt="${d.label}">
                <div class="drum-label">${d.label}</div>
            `;

            const soundKey = d.sound || d.id;

            // ระบบคลิกและทัช
            const playDrum = () => {
                playLocalNote(soundKey, 'Drum');
                triggerVisual({ instrument: 'Drum', note: d.id });
            };

            b.onmousedown = (e) => { e.preventDefault(); playDrum(); };
            b.addEventListener('touchstart', (e) => { e.preventDefault(); playDrum(); }, { passive: false });

            c.appendChild(b);
        });
        deck.appendChild(c);

    // ==========================================
    // --- ส่วนของ กีตาร์ (Guitar) 6 สาย ---
    // ==========================================
    } else if (type === 'Guitar') {
        const labels = ['E(1)', 'A(2)', 'D(3)', 'G(4)', 'B(5)', 'E(6)'];
        
        const board = document.createElement('div');
        board.className = 'instrument-board guitar-board';
        
        labels.forEach((label, i) => {
            const row = document.createElement('div');
            row.className = 'string-row';
            
            const lb = document.createElement('div');
            lb.className = 'string-label';
            lb.innerText = label;
            
            const lineContainer = document.createElement('div');
            lineContainer.className = 'string-line-container';
            
            const line = document.createElement('div');
            line.className = 'string-line';
            line.id = `guitar-string-${i}`; // ID สำหรับเรียกเอฟเฟกต์สั่นของกีตาร์
            
            const play = () => {
                playLocalNote(i, 'Guitar');
                triggerVisual({ instrument: 'Guitar', note: i });
            };
            
            lineContainer.onmousedown = play;
            lineContainer.addEventListener('touchstart', (e) => {
                e.preventDefault();
                play();
            }, { passive: false });
            
            lineContainer.appendChild(line);
            row.appendChild(lb);
            row.appendChild(lineContainer);
            board.appendChild(row);
        });
        
        deck.appendChild(board);

    // ==========================================
    // --- ส่วนของ เบส (Bass) 4 สาย ---
    // ==========================================
    } else if (type === 'Bass') {
        const labels = ['E(1)', 'A(2)', 'D(3)', 'G(4)'];
        
        const board = document.createElement('div');
        board.className = 'instrument-board bass-board';
        
        labels.forEach((label, i) => {
            const row = document.createElement('div');
            row.className = 'string-row';
            
            const lb = document.createElement('div');
            lb.className = 'string-label';
            lb.innerText = label;
            
            const lineContainer = document.createElement('div');
            lineContainer.className = 'string-line-container';
            
            const line = document.createElement('div');
            line.className = 'string-line';
            line.id = `bass-string-${i}`; // ID สำหรับเรียกเอฟเฟกต์สั่นของเบส
            
            const play = () => {
                playLocalNote(i, 'Bass');
                triggerVisual({ instrument: 'Bass', note: i });
            };
            
            lineContainer.onmousedown = play;
            lineContainer.addEventListener('touchstart', (e) => {
                e.preventDefault();
                play();
            }, { passive: false });
            
            lineContainer.appendChild(line);
            row.appendChild(lb);
            row.appendChild(lineContainer);
            board.appendChild(row);
        });
        
        deck.appendChild(board);
    } else if (type === 'Singer') {
        const board = document.createElement('div');
        // ใช้คลาส instrument-board ร่วมกับกีตาร์และเบสเพื่อให้ขนาดกล่องเท่ากัน
        board.className = 'instrument-board singer-board'; 
        
        // หัวข้อ
        const title = document.createElement('h3');
        title.className = 'singer-title';
        title.innerText = 'Lyrics';
        
        // ช่องใส่เนื้อเพลง
        const textArea = document.createElement('textarea');
        textArea.className = 'singer-lyrics-input';
        textArea.placeholder = 'พิมพ์หรือวางเนื้อเพลงที่นี่...';
        
        // ประกอบร่าง
        board.appendChild(title);
        board.appendChild(textArea);
        deck.appendChild(board);
    }
}
// --- 9. ระบบแชทและสมาชิก (Chat & Members) ---
function renderChat(d) {
    const b = document.getElementById('chatHistory');
    const isMe = d.senderId === myId; // เช็คผ่าน ID

    b.innerHTML += `
        <div style="text-align:${isMe ? 'right' : 'left'}; margin-bottom: 10px;">
            ${!isMe ? `<div class="sender-name" style="font-weight:bold; color:var(--main);">${d.senderName}</div>` : ''}
            <div class="chat-msg ${isMe ? 'self' : ''}">${d.text}</div>
        </div>`;
    b.scrollTop = b.scrollHeight;
}

function renderMembers(users) {
    document.getElementById('memberList').innerHTML = users.map(u => `
        <div class="member-card">
            <div class="status-dot online"></div>
            <div><h5>${u.name}</h5><h6>(${u.instrument})</h6></div>
        </div>`).join('');
}

// --- 10. ฟังก์ชันสนับสนุนอื่นๆ (Helper Functions) ---
async function login() {
    myName = document.getElementById('username').value.trim();
    
    if (!myName) {
        notify("Name required", "error");
        return;
    }

    try {
        await Tone.start();
        await initAudio(); 
        connect();
    } catch (e) {
        notify("Audio Error: " + e.message, "error");
    }
}

function sendChat() {
    const t = document.getElementById('chatMsg');
    if (t.value.trim()) { send('CHAT', t.value); t.value = ''; }
}

function handleChat(e) { if (e.key === 'Enter') sendChat(); }

function switchScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function closeModals() {
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
}

function showCreateModal() {
    document.getElementById('createModal').style.display = 'flex';
}

function createRoom() {
    send('CREATE_ROOM', {
        roomName: document.getElementById('newRoomName').value,
        password: document.getElementById('newRoomPass').value,
        capacity: document.getElementById('newRoomCap').value,
        instrument: document.getElementById('createInst').value
    });
    closeModals();
}

function leaveRoom() {
    send('LEAVE_ROOM', {});
    switchScreen('lobby');
    stopMic();

    // 🔥 เพิ่ม 2 บรรทัดนี้เพื่อรีเซ็ตสถานะ
    currentInst = "";
    document.getElementById('instrumentDeck').innerHTML = '';
}

function playLocalNote(note, inst) {
    const sus = (inst === 'Piano') ? isSustain : false;
    send('NOTE_PLAY', { note, instrument: inst, sustain: sus });
    executeSound(note, inst, sus);
}

function playRemoteNote(data) { executeSound(data.note, data.instrument, data.sustain); }

function executeSound(note, inst, sus) {
    if (inst === 'Piano') SoundEngine.playPiano(note, sus);
    else if (inst === 'Drum') SoundEngine.playDrum(note);
    else if (inst === 'Guitar') SoundEngine.playGuitar(note);
    else if (inst === 'Bass') SoundEngine.playBass(note);
}

function triggerVisual(data) {
    let el;
    if (data.instrument === 'Piano') el = document.getElementById(`note-${data.note}`);
    else if (data.instrument === 'Drum') el = document.getElementById(`drum-${data.note}`);
    else if (data.instrument === 'Guitar') {
        const ripple = document.getElementById(`ripple-guitar-${data.note}`);
        const row = document.getElementById(`guitar-string-${data.note}`);
        if (ripple) { ripple.classList.remove('active'); void ripple.offsetWidth; ripple.classList.add('active'); }
        if (row) { const line = row.querySelector('.string-line'); if (line) { line.style.boxShadow = '0 0 12px #fff'; setTimeout(() => line.style.boxShadow = '', 300); } }
        return;
    } else if (data.instrument === 'Bass') {
        const ripple = document.getElementById(`ripple-bass-${data.note}`);
        const row = document.getElementById(`bass-string-${data.note}`);
        if (ripple) { ripple.classList.remove('active'); void ripple.offsetWidth; ripple.classList.add('active'); }
        if (row) { const line = row.querySelector('.string-line'); if (line) { line.style.boxShadow = '0 0 16px #fff'; setTimeout(() => line.style.boxShadow = '', 400); } }
        return;
    }
    if (el) {
        el.classList.add('hit');
        setTimeout(() => el.classList.remove('hit'), 200);
    }
}

function toggleSustain() {
    isSustain = !isSustain;
    document.getElementById('sustainBtn').classList.toggle('sustain-active');

}

function changeInstrument(v) { send('CHANGE_INSTRUMENT', v); }
function leaveLobby() { switchScreen('home'); }

window.addEventListener('beforeunload', () => {
    if (ws && ws.readyState === 1) {
        // ส่ง Event LEAVE_ROOM ไปบอก Server ก่อนปิด
        send('LEAVE_ROOM', {});
        // ปิดการเชื่อมต่อ WebSocket ทันที
        ws.close();
    }
});

document.addEventListener('keydown', (e) => {
    // 1. เพิ่มการเช็กว่าไม่ได้อยู่ที่หน้า 'room' ให้หยุดทำงานทันที
    const currentScreen = document.querySelector('.screen.active');
    if (!currentScreen || currentScreen.id !== 'room') return;

    // 2. เช็กว่าไม่ได้กำลังพิมพ์แชทอยู่ (โค้ดเดิมของคุณ)
    if (!currentInst || document.getElementById('chatMsg') === document.activeElement) return;

    const key = e.key.toLowerCase();

    if (currentInst === 'Piano' && key === ' ') {
        toggleSustain();
        return;
    }

    const map = KeyMaps[currentInst];
    if (map && map[key] !== undefined) {
        playLocalNote(map[key], currentInst);
        triggerVisual({ instrument: currentInst, note: map[key] });
    }
});

// --- ฟังก์ชันสำหรับการคลิกเลือกเครื่องดนตรีแบบรูปภาพ ---
function selectInstrument(inputId, value, element) {
    // 1. อัปเดตค่าไปที่ <input type="hidden">
    document.getElementById(inputId).value = value;

    // 2. ลบคลาส active ออกจากเครื่องดนตรีตัวอื่นในแถวเดียวกัน
    const parent = element.parentElement;
    const options = parent.querySelectorAll('.inst-option');
    options.forEach(opt => opt.classList.remove('active'));

    // 3. เพิ่มคลาส active ให้กับตัวที่ถูกคลิก
    element.classList.add('active');
}

// --- ฟังก์ชันสำหรับการเปลี่ยนเครื่องดนตรีใน Top Bar ของห้อง ---
function selectRoomInstrument(value, element) {
    // 1. อัปเดตค่าลงใน <input type="hidden">
    document.getElementById('roomInstSelect').value = value;
    
    // 2. ลบคลาส active ออกจากตัวอื่น แล้วใส่ให้ตัวที่โดนคลิก
    const parent = element.parentElement;
    const options = parent.querySelectorAll('.inst-option');
    options.forEach(opt => opt.classList.remove('active'));
    element.classList.add('active');
    
    // 3. เรียกใช้ฟังก์ชันเดิมของคุณเพื่อส่งข้อมูลไป Server
    changeInstrument(value);
}

// โค้ดเดิมของคุณ (แก้ไขนิดหน่อยเพื่ออัปเดต UI ให้ตรงกันตอนเข้าห้อง)
function enterRoom(data) { 
    document.getElementById('roomTitle').innerText = data.roomName; 
    
    // อัปเดต UI ตัวเลือกเครื่องดนตรีให้ตรงกับที่เลือกตอน Join/Create
    document.getElementById('roomInstSelect').value = data.instrument; 
    const options = document.querySelectorAll('.room-top-selector .inst-option');
    options.forEach(opt => {
        if (opt.getAttribute('data-inst') === data.instrument) {
            opt.classList.add('active');
        } else {
            opt.classList.remove('active');
        }
    });

    document.getElementById('chatHistory').innerHTML = ''; 
    switchScreen('room'); 
    renderInstrument(data.instrument); 
}
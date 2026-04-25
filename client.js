/**
 * client.js - ThamMozart Client Logic (Ultimate WebRTC & UI Edition)
 */

// --- 1. ระบบแจ้งเตือน (Notifications) ---
function notify(msg, type = 'info') {
    const container = document.getElementById('notification-area');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${type === 'error' ? '⚠️' : (type === 'success' ? '✅' : 'ℹ️')}</span> <span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
}

// --- 2. ตัวแปรสถานะ (Global States) ---
let ws;
let myName = "", currentInst = "", selectedRoom = "", myId = "";
let micStream = null, isMicOn = false;
let isSustain = false, nextAudioTime = 0;
let toneInstruments = {};

// WebRTC Variables (สำหรับระบบไมค์)
let peer = null;
let myPeerId = null;
let activeCalls = {};

// --- Guitar MP3 Audio Cache ---
const guitarAudios = {};
const guitarNotes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const guitarKeyMap = { 'a': 'A', 's': 'B', 'd': 'C', 'f': 'D', 'g': 'E', 'h': 'F', 'j': 'G' };
let guitarVolume = 0.8;

guitarNotes.forEach(n => {
    const audio = new Audio(`sounds/guitar/Guitar_${n}.mp3`);
    audio.preload = 'auto';
    guitarAudios[n] = audio;
});

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
    'Guitar': { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5 },
    'Bass': { '1': 3, '2': 2, '3': 1, '4': 0 }
};

const KeyLabels = {
    48: 'Z', 49: 'S', 50: 'X', 51: 'D', 52: 'C', 53: 'V', 54: 'G', 55: 'B', 56: 'H', 57: 'N', 58: 'J', 59: 'M',
    60: 'Q', 61: '2', 62: 'W', 63: '3', 64: 'E', 65: 'R', 66: '5', 67: 'T', 68: '6', 69: 'Y', 70: '7', 71: 'U',
    72: 'I', 73: '9', 74: 'O', 75: '0', 76: 'P', 77: '[', 78: '=', 79: ']'
};

// --- 4. การจัดการคีย์บอร์ด (Event Listeners) ---
document.addEventListener('keydown', (e) => {
    const currentScreen = document.querySelector('.screen.active');
    if (!currentScreen || currentScreen.id !== 'room') return;
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

    ws.onopen = () => {
        notify("Connected", "success");
        send('LOGIN', { name: myName });
        switchScreen('lobby');
    };

    ws.onmessage = (event) => {
        try { handleServerMessage(JSON.parse(event.data)); } catch (e) { }
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
            myId = msg.payload.myId; 
            enterRoom(msg.payload);
            break;
        case 'UPDATE_MEMBERS': renderMembers(msg.payload); break;
        case 'CHAT': renderChat(msg.payload); break;
        case 'NOTE_PLAY': triggerVisual(msg.payload); playRemoteNote(msg.payload); break;
        case 'INSTRUMENT_CHANGED': renderInstrument(msg.payload); break;
        case 'ERROR': notify(msg.payload, "error"); break;
    }
}

// --- 6. ระบบไมโครโฟน WebRTC (ลื่นไหล ไม่กระตุก) ---
async function login() {
    myName = document.getElementById('username').value.trim();
    if (!myName) { notify("Name required", "error"); return; }

    try {
        await Tone.start();
        await initAudio();

        // ขอสิทธิ์ไมค์ — เชื่อมเข้า Web Audio Graph เดียวกับดนตรี
        try {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            // เชื่อม mic เข้า graph: mic → micGain → mixerDest
            // micGain.gain = 0 อยู่แล้ว (ปิดไว้จนกว่ากดปุ่ม)
            micSourceNode = sharedCtx.createMediaStreamSource(micStream);
            micSourceNode.connect(micGain);
        } catch(micErr) {
            notify("ไม่มีไมค์ — เล่นดนตรีได้อย่างเดียว", "info");
        }

        // PeerJS ส่ง mixedStream (mic + ดนตรี รวมกัน) แทน micStream เปล่าๆ
        peer = new Peer(undefined, {
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            }
        });

        peer.on('open', (id) => {
            myPeerId = id;
            connect();
        });

        peer.on('error', (err) => {
            console.error('PeerJS error:', err);
            notify('Voice error: ' + err.type, 'error');
        });

        // ตอบรับสาย — ส่ง mixedStream กลับ (ทั้งไมค์+ดนตรีของเรา)
        peer.on('call', (call) => {
            call.answer(mixedStream);
            handleCall(call);
        });

    } catch (e) {
        notify("เกิดข้อผิดพลาด: " + e.message, "error");
    }
}

function handleCall(call) {
    console.log("☎️ กำลังเชื่อมต่อสายกับ Peer:", call.peer);
    activeCalls[call.peer] = call;

    call.on('stream', (remoteStream) => {
        console.log("🔊 ได้รับสัญญาณเสียงจาก:", call.peer);
        
        let audio = document.getElementById('audio-' + call.peer);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = 'audio-' + call.peer;
            audio.autoplay = true;
            audio.controls = false;
            // 🔥 1. บังคับปลด Mute และเร่งเสียงให้สุด
            audio.muted = false; 
            audio.volume = 1.0;  
            audio.setAttribute('playsinline', 'true');
            document.body.appendChild(audio);
        }
        
        audio.srcObject = remoteStream;
        
        // 🔥 2. ดักจับ Autoplay
        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.catch(error => {
                console.error("🔇 Autoplay ถูกบล็อก:", error);
                notify("คลิกที่ใดก็ได้บนหน้าจอ 1 ครั้ง เพื่อให้เสียงไมค์ทำงาน", "error");
                
                // ถ้าระบบโดนบล็อก รอให้ผู้ใช้คลิกจอ 1 ครั้งแล้วสั่งเล่นใหม่
                document.body.addEventListener('click', () => {
                    audio.play();
                    audio.muted = false; // ย้ำปลด Mute อีกรอบหลังคลิก
                }, { once: true });
            });
        }
    });

    call.on('close', () => {
        const audio = document.getElementById('audio-' + call.peer);
        if (audio) audio.remove();
        delete activeCalls[call.peer];
    });
}

function toggleMic() {
    const btn = document.getElementById('micBtn');
    isMicOn = !isMicOn;
    // ใช้ GainNode toggle — smooth ไม่มีคลิก และไม่กระทบ WebRTC stream
    if (micGain) {
        micGain.gain.setTargetAtTime(isMicOn ? 1.0 : 0, sharedCtx.currentTime, 0.01);
    }
    btn.classList.toggle('mic-active', isMicOn);
}

function stopMic() {
    isMicOn = false;
    if (micGain) {
        micGain.gain.setTargetAtTime(0, sharedCtx.currentTime, 0.01);
    }
    document.getElementById('micBtn').classList.remove('mic-active');
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
                ${r.count < r.max ? `<button onclick="prepareJoin('${r.id}', ${r.locked})" class="button-join">JOIN</button>` : `<div class="button-join-red">FULL</div>`}
            </div>
        </div>`).join('') : '<div style="grid-column: 1/-1; text-align:center;">No rooms available</div>';
}

function prepareJoin(id, l) {
    selectedRoom = id;
    document.getElementById('passField').style.display = l ? 'block' : 'none';
    document.getElementById('joinModal').style.display = 'flex';
}

function confirmJoin() {
    send('JOIN_ROOM', {
        roomId: selectedRoom,
        password: document.getElementById('joinPass').value,
        instrument: document.getElementById('joinInst').value,
        peerId: myPeerId
    });
    closeModals();
}

function createRoom() {
    send('CREATE_ROOM', {
        roomName: document.getElementById('newRoomName').value,
        password: document.getElementById('newRoomPass').value,
        capacity: document.getElementById('newRoomCap').value,
        instrument: document.getElementById('createInst').value,
        peerId: myPeerId
    });
    closeModals();
}

function leaveRoom() {
    send('LEAVE_ROOM', {});
    switchScreen('lobby');
    stopMic();

    // วางสายทุกคนตอนออกจากห้อง
    Object.values(activeCalls).forEach(call => call.close());
    activeCalls = {};
    document.querySelectorAll('audio').forEach(a => a.remove());

    currentInst = "";
    document.getElementById('instrumentDeck').innerHTML = '';
}

function renderMembers(users) {
    document.getElementById('memberList').innerHTML = users.map(u => `
        <div class="member-card">
            <div class="status-dot online"></div>
            <div><h5>${u.name}</h5><h6>(${u.instrument})</h6></div>
        </div>`).join('');
        
    // โทรหาสมาชิกที่ยังไม่ได้โทร — ส่ง mixedStream (mic+ดนตรีรวมกัน)
    if (!peer || !mixedStream) return;
    users.forEach(u => {
        if (u.id !== myId && u.peerId && !activeCalls[u.peerId]) {
            console.log('📞 โทรออกหา:', u.name, u.peerId);
            const call = peer.call(u.peerId, mixedStream);
            if (call) handleCall(call);
        }
    });
}

function renderChat(d) {
    const b = document.getElementById('chatHistory');
    const isMe = d.senderId === myId; 
    b.innerHTML += `
        <div style="text-align:${isMe ? 'right' : 'left'}; margin-bottom: 10px;">
            ${!isMe ? `<div class="sender-name" style="font-weight:bold; color:var(--main);">${d.senderName}</div>` : ''}
            <div class="chat-msg ${isMe ? 'self' : ''}">${d.text}</div>
        </div>`;
    b.scrollTop = b.scrollHeight;
}

// --- 8. ระบบเครื่องดนตรี (Audio Engine) ---
// --- 8. ระบบเครื่องดนตรี (Audio Engine) ---

// AudioContext ร่วม — ใช้ Tone.js context เพื่อให้ทุกอย่างอยู่ใน graph เดียวกัน
let sharedCtx = null;
let micSourceNode = null;      // MediaStreamSourceNode ของไมค์
let mixerDest = null;          // MediaStreamDestinationNode (output รวม mic+ดนตรี)
let micGain = null;            // GainNode สำหรับ toggle mic
let mixedStream = null;        // stream ที่รวมแล้ว ส่งผ่าน PeerJS

async function initAudio() {
    if (toneInstruments.piano) return;

    // ใช้ AudioContext ของ Tone.js เป็น context กลาง
    sharedCtx = Tone.getContext().rawContext;

    // สร้าง MixerDestination — จุดรวมเสียงทุกอย่างก่อนส่งออก WebRTC
    mixerDest = sharedCtx.createMediaStreamDestination();
    mixedStream = mixerDest.stream;

    // GainNode สำหรับ mic (เปิด/ปิดด้วย gain แทน track.enabled เพื่อ smooth)
    micGain = sharedCtx.createGain();
    micGain.gain.value = 0; // ปิดไว้ก่อน
    micGain.connect(mixerDest);

    // Master gain สำหรับเสียงดนตรีที่จะส่งออก WebRTC ด้วย
    const instMixGain = sharedCtx.createGain();
    instMixGain.gain.value = 0.85;
    instMixGain.connect(mixerDest);

    // เชื่อม Tone.js destination → instMixGain → mixerDest
    // Tone.Destination เป็น AudioNode ดึงได้ผ่าน .input
    Tone.getDestination().connect(instMixGain);

    const reverb = new Tone.Reverb(0.4).toDestination();

    // 1. Piano
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
    toneInstruments.piano.volume.value = 20;

    // 2. Drums
    toneInstruments.drums = new Tone.Players({
        "kick": "kick.mp3", "snare": "snare.mp3", "closehihat": "closehihat.mp3",
        "openhihat": "openhihat.mp3", "tom1": "tom1.mp3", "tom2": "tom2.mp3",
        "floor": "floor.mp3", "crash": "crash.mp3", "ride": "ride.mp3"
    }, { baseUrl: "/sounds/drum/" }).toDestination();
    toneInstruments.drums.volume.value = 5;

    // 3. Guitar
    toneInstruments.guitar = new Tone.Sampler({
        urls: { 
            "A3": "Guitar_A.mp3", "B3": "Guitar_B.mp3", "C4": "Guitar_C.mp3",
            "D4": "Guitar_D.mp3", "E4": "Guitar_E.mp3", "F4": "Guitar_F.mp3", "G4": "Guitar_G.mp3" 
        },
        baseUrl: "/sounds/guitar/"
    }).connect(reverb);
    toneInstruments.guitar.volume.value = 4;

    // 4. Bass
    toneInstruments.bass = new Tone.Sampler({
        urls: { "E1": "bass4.mp3", "A1": "bass3.mp3", "D2": "bass2.mp3", "G2": "bass1.mp3" },
        baseUrl: "/sounds/bass/", release: 0.3
    }).toDestination();
    toneInstruments.bass.volume.value = 3;
}

const SoundEngine = {
    playPiano: (note, sus) => {
        if (toneInstruments.piano?.loaded) {
            toneInstruments.piano.triggerAttackRelease(Tone.Frequency(note, "midi").toNote(), sus ? "1n" : "8n");
        }
    },
   playGuitar: (idx) => {
        // ใช้ Tone.js Sampler — อยู่ใน Web Audio graph เดียวกัน ส่งผ่าน WebRTC ได้
        const noteMap = ['A3', 'B3', 'C4', 'D4', 'E4', 'F4'];
        const note = noteMap[idx];
        if (note && toneInstruments.guitar?.loaded) {
            toneInstruments.guitar.triggerAttackRelease(note, '2n');
        }
    },
    playBass: (idx) => {
        const notes = ["E1", "A1", "D2", "G2"];
        if (toneInstruments.bass?.loaded) {
            toneInstruments.bass.releaseAll();
            toneInstruments.bass.triggerAttack(notes[idx]);
        }
    },
    playDrum: (type) => {
        if (toneInstruments.drums?.has(type)) {
            toneInstruments.drums.player(type).start();
        }
    }
};

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

// --- 9. การวาดเครื่องดนตรีทั้งหมด (Piano, Drum, Guitar, Bass, Singer) ---
function renderInstrument(type) {
    currentInst = type;
    const deck = document.getElementById('instrumentDeck');
    deck.innerHTML = '';
    document.getElementById('sustainBtn').style.display = (type === 'Piano') ? 'flex' : 'none';

    if (type === 'Piano') {
        const p = document.createElement('div');
        p.className = 'piano';
        let activeTouches = {};
        const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        for (let i = 0; i < 36; i++) {
            const midi = i + 48;
            const k = document.createElement('div');
            k.className = `key ${keys[i % 12].includes('#') ? 'black' : 'white'}`;
            k.id = `note-${midi}`;
            if (KeyLabels[midi]) k.setAttribute('data-key', KeyLabels[midi]);

            k.onmousedown = () => { playLocalNote(midi, 'Piano'); triggerVisual({ instrument: 'Piano', note: midi }); };
            k.addEventListener('touchstart', (e) => {
                e.preventDefault();
                for (let j = 0; j < e.changedTouches.length; j++) {
                    const touch = e.changedTouches[j];
                    activeTouches[touch.identifier] = midi; 
                    playLocalNote(midi, 'Piano');
                    triggerVisual({ instrument: 'Piano', note: midi });
                }
            }, { passive: false });
            p.appendChild(k);
        }

        p.addEventListener('touchmove', (e) => {
            e.preventDefault(); 
            for (let i = 0; i < e.touches.length; i++) {
                const touch = e.touches[i];
                const el = document.elementFromPoint(touch.clientX, touch.clientY);
                if (el && el.classList.contains('key')) {
                    const midi = parseInt(el.id.replace('note-', ''));
                    if (activeTouches[touch.identifier] !== midi) {
                        activeTouches[touch.identifier] = midi;
                        playLocalNote(midi, 'Piano');
                        triggerVisual({ instrument: 'Piano', note: midi });
                    }
                }
            }
        }, { passive: false });

        p.addEventListener('touchend', cleanUpTouches);
        p.addEventListener('touchcancel', cleanUpTouches);
        function cleanUpTouches(e) {
            for (let i = 0; i < e.changedTouches.length; i++) { delete activeTouches[e.changedTouches[i].identifier]; }
        }
        deck.appendChild(p);

    } else if (type === 'Drum') {
        const c = document.createElement('div'); 
        c.className = 'drum-kit-pro';
        
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
            b.innerHTML = `<img src="assets/Drum/${d.img}" alt="${d.label}"><div class="drum-label">${d.label}</div>`;

            const soundKey = d.sound || d.id;
            const playDrum = () => { playLocalNote(soundKey, 'Drum'); triggerVisual({ instrument: 'Drum', note: d.id }); };

            b.onmousedown = (e) => { e.preventDefault(); playDrum(); };
            b.addEventListener('touchstart', (e) => { e.preventDefault(); playDrum(); }, { passive: false });
            c.appendChild(b);
        });
        deck.appendChild(c);

    } else if (type === 'Guitar') {
        const labels = ['E(1)', 'A(2)', 'D(3)', 'G(4)', 'B(5)', 'E(6)'];
        const board = document.createElement('div');
        board.className = 'instrument-board guitar-board';
        
        labels.forEach((label, i) => {
            const row = document.createElement('div');
            row.className = 'string-row';
            const lb = document.createElement('div');
            lb.className = 'string-label'; lb.innerText = label;
            
            const lineContainer = document.createElement('div');
            lineContainer.className = 'string-line-container';
            const line = document.createElement('div');
            line.className = 'string-line'; line.id = `guitar-string-${i}`; 
            
            const play = () => { playLocalNote(i, 'Guitar'); triggerVisual({ instrument: 'Guitar', note: i }); };
            
            lineContainer.onmousedown = play;
            lineContainer.addEventListener('touchstart', (e) => { e.preventDefault(); play(); }, { passive: false });
            
            lineContainer.appendChild(line);
            row.appendChild(lb); row.appendChild(lineContainer); board.appendChild(row);
        });
        deck.appendChild(board);

    } else if (type === 'Bass') {
        const labels = ['E(1)', 'A(2)', 'D(3)', 'G(4)'];
        const board = document.createElement('div');
        board.className = 'instrument-board bass-board';
        
        labels.forEach((label, i) => {
            const row = document.createElement('div');
            row.className = 'string-row';
            const lb = document.createElement('div');
            lb.className = 'string-label'; lb.innerText = label;
            
            const lineContainer = document.createElement('div');
            lineContainer.className = 'string-line-container';
            const line = document.createElement('div');
            line.className = 'string-line'; line.id = `bass-string-${i}`; 
            
            const play = () => { playLocalNote(i, 'Bass'); triggerVisual({ instrument: 'Bass', note: i }); };
            
            lineContainer.onmousedown = play;
            lineContainer.addEventListener('touchstart', (e) => { e.preventDefault(); play(); }, { passive: false });
            
            lineContainer.appendChild(line);
            row.appendChild(lb); row.appendChild(lineContainer); board.appendChild(row);
        });
        deck.appendChild(board);

    } else if (type === 'Singer') {
        const board = document.createElement('div');
        board.className = 'instrument-board singer-board'; 
        
        const title = document.createElement('h3');
        title.className = 'singer-title'; title.innerText = 'Lyrics';
        
        const textArea = document.createElement('textarea');
        textArea.className = 'singer-lyrics-input'; textArea.placeholder = 'พิมพ์หรือวางเนื้อเพลงที่นี่...';
        
        board.appendChild(title); board.appendChild(textArea); deck.appendChild(board);
    }
}

function triggerVisual(data) {
    let el;
    if (data.instrument === 'Piano') el = document.getElementById(`note-${data.note}`);
    else if (data.instrument === 'Drum') el = document.getElementById(`drum-${data.note}`);
    else if (data.instrument === 'Guitar') {
        if(typeof data.note === 'number') {
            const ripple = document.getElementById(`ripple-guitar-${data.note}`);
            const row = document.getElementById(`guitar-string-${data.note}`);
            if (ripple) { ripple.classList.remove('active'); void ripple.offsetWidth; ripple.classList.add('active'); }
            if (row) { const line = row.querySelector('.string-line'); if (line) { line.style.boxShadow = '0 0 12px #fff'; setTimeout(() => line.style.boxShadow = '', 300); } }
        }
        return;
    } else if (data.instrument === 'Bass') {
        const ripple = document.getElementById(`ripple-bass-${data.note}`);
        const row = document.getElementById(`bass-string-${data.note}`);
        if (ripple) { ripple.classList.remove('active'); void ripple.offsetWidth; ripple.classList.add('active'); }
        if (row) { const line = row.querySelector('.string-line'); if (line) { line.style.boxShadow = '0 0 16px #fff'; setTimeout(() => line.style.boxShadow = '', 400); } }
        return;
    }
    
    if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 200); }
}

function toggleSustain() {
    isSustain = !isSustain;
    document.getElementById('sustainBtn').classList.toggle('sustain-active');
}

// --- 10. ฟังก์ชันสนับสนุนอื่นๆ (Helper Functions) ---
function sendChat() {
    const t = document.getElementById('chatMsg');
    if (t.value.trim()) { send('CHAT', t.value); t.value = ''; }
}
function handleChat(e) { if (e.key === 'Enter') sendChat(); }
function switchScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); document.getElementById(id).classList.add('active'); }
function closeModals() { document.querySelectorAll('.modal').forEach(m => m.style.display = 'none'); }
function showCreateModal() { document.getElementById('createModal').style.display = 'flex'; }
function changeInstrument(v) { send('CHANGE_INSTRUMENT', v); }
function leaveLobby() { switchScreen('home'); }

window.addEventListener('beforeunload', () => {
    if (ws && ws.readyState === 1) { send('LEAVE_ROOM', {}); ws.close(); }
});

function selectInstrument(inputId, value, element) {
    document.getElementById(inputId).value = value;
    const options = element.parentElement.querySelectorAll('.inst-option');
    options.forEach(opt => opt.classList.remove('active'));
    element.classList.add('active');
}

function selectRoomInstrument(value, element) {
    document.getElementById('roomInstSelect').value = value;
    const options = element.parentElement.querySelectorAll('.inst-option');
    options.forEach(opt => opt.classList.remove('active'));
    element.classList.add('active');
    changeInstrument(value);
}

function enterRoom(data) {
    document.getElementById('roomTitle').innerText = data.roomName;
    document.getElementById('roomInstSelect').value = data.instrument;
    const options = document.querySelectorAll('.room-top-selector .inst-option');
    options.forEach(opt => {
        if (opt.getAttribute('data-inst') === data.instrument) opt.classList.add('active');
        else opt.classList.remove('active');
    });
    document.getElementById('chatHistory').innerHTML = '';
    switchScreen('room');
    renderInstrument(data.instrument);
}
/**
 * client.js — ThamMozart
 * ระบบ Real-time Music Collaboration
 * ใช้ WebSocket สำหรับ sync notes และ WebRTC (PeerJS) สำหรับเสียงไมค์
 *
 * โครงสร้างไฟล์:
 *  1. ระบบแจ้งเตือน (Notifications)
 *  2. ตัวแปรสถานะทั้งหมด (Global State)
 *  3. การ map ปุ่มคีย์บอร์ด (Key Mapping)
 *  4. Event Listener คีย์บอร์ด
 *  5. การเชื่อมต่อ WebSocket
 *  6. ระบบ Login และ WebRTC (Voice)
 *  7. การแสดงผล UI (Lobby, Room, Members, Chat)
 *  8. Audio Engine (Tone.js + Web Audio API)
 *  9. เครื่องดนตรี (Piano, Drum, Guitar, Bass, Singer)
 * 10. ฟังก์ชันช่วยเหลือ (Helpers)
 */

// ============================================================
// 1. ระบบแจ้งเตือน (Toast Notifications)
// ============================================================

/**
 * แสดง toast notification ที่มุมหน้าจอ
 * @param {string} msg  - ข้อความที่จะแสดง
 * @param {string} type - 'info' | 'success' | 'error'
 */
function notify(msg, type = 'info') {
    const container = document.getElementById('notification-area');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
    toast.innerHTML = `<span>${icon}</span> <span>${msg}</span>`;
    container.appendChild(toast);

    // หายไปหลัง 4 วินาที พร้อม fade out
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ============================================================
// 2. ตัวแปรสถานะ (Global State)
// ============================================================

// --- WebSocket ---
let ws;                         // WebSocket connection กับ server
let pingInterval;
let reconnectTimer = null;       //ตัวบล็อกการ Reconnect ทับซ้อน
let isPeerReconnecting = false;  //ตัวบล็อกการสแปมเซิร์ฟเวอร์เสียง
let mySessionId = sessionStorage.getItem('mySessionId');
if (!mySessionId) {
    mySessionId = Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('mySessionId', mySessionId);
}
// --- ข้อมูลผู้ใช้และห้อง ---
let myName = '';                // ชื่อผู้ใช้
let myId = '';                  // ID ที่ server กำหนดให้
let currentInst = '';           // เครื่องดนตรีที่กำลังใช้อยู่
let selectedRoom = '';          // ID ห้องที่กำลังจะเข้า

// --- สถานะเครื่องดนตรี ---
let isSustain = false;          // Piano sustain mode (กดค้างเสียง)
let toneInstruments = {};       // เก็บ Tone.js instrument objects ทั้งหมด

// --- WebRTC (ระบบเสียงพูด) ---
let peer = null;                // PeerJS instance
let myPeerId = null;            // PeerID ของตัวเอง
let activeCalls = {};           // Map: peerId → call object (calls ที่กำลังเชื่อมอยู่)
let remoteAudios = {};          // Map: peerId → <audio> element (สำหรับเล่นเสียงเพื่อน)

// --- Mic State ---
let micStream = null;           // MediaStream ดิบจาก getUserMedia
let isMicOn = false;            // สถานะไมค์ เปิด/ปิด
let isLoggingIn = false;        // ล็อกกันกดปุ่ม Submit ซ้ำ

// --- Web Audio Graph ---
let sharedCtx = null;           // AudioContext (ดึงจาก Tone.js เพื่อให้ใช้ร่วมกัน)
let micSourceNode = null;       // MediaStreamSourceNode ของไมค์
let micGain = null;             // GainNode: toggle เสียงไมค์ขึ้น/ลง (0 = ปิด, 1 = เปิด)
let instDest = null;            // MediaStreamDestination สำหรับ stream เสียงดนตรี
let mixedStream = null;         // MediaStream รวม (mic track + instrument track) ส่งผ่าน WebRTC

// ============================================================
// 3. การ Map ปุ่มคีย์บอร์ด (Key Mapping)
// ============================================================

/**
 * KeyMaps: แปลงปุ่มที่กดเป็น note/action ของแต่ละเครื่องดนตรี
 * - Piano  → MIDI note number (48–79)
 * - Drum   → ชื่อเสียงกลอง เช่น 'kick', 'snare'
 * - Guitar → index สาย 0–5 (E, A, D, G, B, e)
 * - Bass   → index สาย 0–3 (E, A, D, G) กลับทิศ key 1 = สาย E ต่ำสุด
 */
const KeyMaps = {
    'Piano': {
        // แถวล่าง: C4–B4
        'z':48, 's':49, 'x':50, 'd':51, 'c':52,
        'v':53, 'g':54, 'b':55, 'h':56, 'n':57, 'j':58, 'm':59,
        // แถวบน: C5–G6
        'q':60, '2':61, 'w':62, '3':63, 'e':64,
        'r':65, '5':66, 't':67, '6':68, 'y':69, '7':70, 'u':71,
        'i':72, '9':73, 'o':74, '0':75, 'p':76, '[':77, '=':78, ']':79
    },
    'Drum': {
        '1':'kick',       'q':'kick',
        '2':'snare',      'w':'snare',
        '3':'closehihat', 'e':'closehihat',
        '4':'openhihat',  'r':'openhihat',
        '5':'tom1',       't':'tom1',
        '6':'tom2',       'y':'tom2',
        '7':'floor',      'u':'floor',
        '8':'crash',      'i':'crash',
        '9':'ride',       'o':'ride'
    },
    'Guitar': { '1':0, '2':1, '3':2, '4':3, '5':4, '6':5 },
    'Bass':   { '1':3, '2':2, '3':1, '4':0 }
};

/**
 * KeyLabels: hint ตัวอักษรที่แสดงบนปุ่ม Piano
 * key = MIDI note number, value = ตัวอักษรบนคีย์บอร์ด
 */
const KeyLabels = {
    48:'Z', 49:'S', 50:'X', 51:'D', 52:'C', 53:'V', 54:'G', 55:'B',
    56:'H', 57:'N', 58:'J', 59:'M', 60:'Q', 61:'2', 62:'W', 63:'3',
    64:'E', 65:'R', 66:'5', 67:'T', 68:'6', 69:'Y', 70:'7', 71:'U',
    72:'I', 73:'9', 74:'O', 75:'0', 76:'P', 77:'[', 78:'=', 79:']'
};

// ============================================================
// 4. Event Listener คีย์บอร์ด
// ============================================================

document.addEventListener('keydown', (e) => {
    // ทำงานเฉพาะตอนอยู่หน้า room
    const currentScreen = document.querySelector('.screen.active');
    if (!currentScreen || currentScreen.id !== 'room') return;

    // ไม่ดักการพิมพ์ใน chat input
    if (!currentInst || document.getElementById('chatMsg') === document.activeElement) return;

    const key = e.key.toLowerCase();

    // Space bar = toggle sustain สำหรับ Piano
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

// ============================================================
// 5. การเชื่อมต่อ WebSocket
// ============================================================

/** เชื่อมต่อ WebSocket กับ server, auto-reconnect ทุก 3 วินาทีถ้าหลุด */
function connect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return; 
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const currentWs = new WebSocket(`${protocol}//${window.location.host}`);
    ws = currentWs; 

    currentWs.onopen = () => {
        if (ws !== currentWs) return; 

        if (pingInterval) clearInterval(pingInterval);
        notify('Connected', 'success');

        send('LOGIN', { name: myName, peerId: myPeerId, sessionId: mySessionId });
        
        if (selectedRoom && currentInst) {
            setTimeout(() => {
                send('JOIN_ROOM', {
                    roomId: selectedRoom,
                    password: '', 
                    instrument: currentInst,
                    peerId: myPeerId
                });
            }, 500);
        } else {
            switchScreen('lobby'); 
        }
        
        pingInterval = setInterval(() => {
            if (ws === currentWs && ws.readyState === WebSocket.OPEN) {
                send('PING', {});
            }
        }, 3000);
    };

    currentWs.onmessage = (event) => {
        if (ws !== currentWs) return; 
        try { handleServerMessage(JSON.parse(event.data)); } catch (e) {}
    };

    currentWs.onclose = () => {
        if (ws !== currentWs) return; 

        if (pingInterval) clearInterval(pingInterval); 
        notify('สัญญาณเน็ตขาดหาย กำลังเชื่อมต่อใหม่...', 'error');
        stopMic();

        Object.values(activeCalls).forEach(call => { try { call.close(); } catch(e){} });
        activeCalls = {};
        Object.values(remoteAudios).forEach(a => { a.srcObject = null; a.remove(); });
        remoteAudios = {};
        const deck = document.getElementById('instrumentDeck');
        if (deck) deck.innerHTML = '';

        reconnectTimer = setTimeout(connect, 3000);
        if (peer && peer.disconnected && !peer.destroyed && !isPeerReconnecting) {
            isPeerReconnecting = true;
            setTimeout(() => { 
                if (peer.disconnected) peer.reconnect(); 
                isPeerReconnecting = false;
            }, 3000);
        }
    };
}

/** ส่งข้อความไปยัง server */
function send(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, payload }));
    }
}

/** รับข้อความจาก server และ dispatch ตาม type */
function handleServerMessage(msg) {
    switch (msg.type) {
        case 'UPDATE_LOBBY':       renderLobby(msg.payload);            break;
        case 'JOIN_SUCCESS':       myId = msg.payload.myId;
                                   enterRoom(msg.payload);              break;
        case 'UPDATE_MEMBERS':     renderMembers(msg.payload);          break;
        case 'CHAT':               renderChat(msg.payload);             break;
        case 'NOTE_PLAY':          triggerVisual(msg.payload);
                                   playRemoteNote(msg.payload);         break;
        case 'INSTRUMENT_CHANGED': renderInstrument(msg.payload);       break;
        case 'ERROR':              notify(msg.payload, 'error');        break;
    }
}

// ============================================================
// 6. ระบบ Login และ WebRTC (Voice Chat)
// ============================================================

/**
 * login() — เรียกตอนกดปุ่ม Submit หน้าแรก
 *
 * ขั้นตอน:
 *   1. เริ่ม Tone.js AudioContext (ต้องการ user gesture)
 *   2. โหลด instruments และสร้าง Web Audio graph (initAudio)
 *   3. ขอสิทธิ์ไมค์ และเชื่อมเข้า graph
 *   4. สร้าง PeerJS สำหรับ WebRTC voice call
 *   5. เชื่อมต่อ WebSocket (connect)
 */
async function login() {
    if (isLoggingIn) return; // กันกดซ้ำ

    myName = document.getElementById('username').value.trim();
    if (!myName) { notify('Name required', 'error'); return; }

    // ล็อกปุ่มระหว่างโหลด
    isLoggingIn = true;
    const btn = document.querySelector('.card-head-inside .button-outline');
    if (btn) { btn.innerText = 'Loading...'; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }

    try {
        await Tone.start();  // ปลดล็อก AudioContext (browser บังคับให้รอ user gesture)
        await initAudio();   // โหลด instruments และสร้าง audio graph

        // สร้าง PeerJS — ใช้ STUN server ของ Google สำหรับ NAT traversal
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
            connect();               // เชื่อม WebSocket หลังได้ PeerID แล้ว
            resetLoginButton(btn);
        });

        peer.on('disconnected', () => {
            if (peer && !peer.destroyed) {
                peer.reconnect();
            }
        });

        peer.on('error', (err) => {
            console.error('PeerJS error:', err);
            resetLoginButton(btn);
        });

        peer.on('call', (call) => {
            call.answer(mixedStream);
            handleCall(call);
        });

        peer.on('disconnected', () => {
            if (peer && !peer.destroyed && !isPeerReconnecting) {
                isPeerReconnecting = true;
                setTimeout(() => {
                    if (peer.disconnected) peer.reconnect();
                    isPeerReconnecting = false;
                }, 3000); 
            }
        });

    } catch (e) {
        notify('เกิดข้อผิดพลาด: ' + e.message, 'error');
        resetLoginButton(btn);
    }
}

/** คืนสถานะปุ่ม Submit กลับเป็นปกติ */
function resetLoginButton(btn) {
    isLoggingIn = false;
    if (btn) { btn.innerText = 'Submit'; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }
}

/**
 * handleCall() — จัดการ WebRTC call ที่เชื่อมต่อแล้ว
 * รับ remoteStream แล้วเล่นผ่าน <audio> element ที่ append เข้า body
 */
function handleCall(call) {
    console.log('เชื่อมต่อกับ:', call.peer);

    // ถ้ามี call เก่าอยู่ก็ปิดก่อน (ป้องกัน duplicate stream)
    if (activeCalls[call.peer]) {
        activeCalls[call.peer].close();
    }
    activeCalls[call.peer] = call;

    call.on('stream', (remoteStream) => {
        console.log('ได้รับเสียงจาก:', call.peer);

        if (remoteAudios[call.peer]) {
            remoteAudios[call.peer].srcObject = null;
            remoteAudios[call.peer].remove();
        }

        const audio = document.createElement('audio');
        audio.id = `audio-${call.peer}`;
        audio.autoplay = true;
        audio.muted = false;
        audio.volume = 1.0;
        audio.setAttribute('playsinline', ''); // จำเป็นสำหรับ iOS
        audio.srcObject = remoteStream;
        document.body.appendChild(audio);
        remoteAudios[call.peer] = audio;

        // บางครั้ง browser บล็อก autoplay — รอ user gesture แล้วเล่นใหม่
        audio.play().catch(() => {
            const resume = () => audio.play().catch(() => {});
            document.body.addEventListener('click',      resume, { once: true });
            document.body.addEventListener('touchstart', resume, { once: true });
        });
    });

    call.on('error', (err) => console.error('Call error:', err));

    call.on('close', () => {
        console.log('📴 วางสาย:', call.peer);
        if (remoteAudios[call.peer]) {
            remoteAudios[call.peer].srcObject = null;
            remoteAudios[call.peer].remove();
            delete remoteAudios[call.peer];
        }
        delete activeCalls[call.peer];
    });
}

/**
 * toggleMic() — เปิด/ปิดไมค์
 */
async function toggleMic() {
    const btn = document.getElementById('micBtn');

    if (!isMicOn) {
        if (!micStream || !micStream.active || micStream.getTracks()[0].readyState === 'ended') {
            try {
                micStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
                });
        
                if (micSourceNode) micSourceNode.disconnect();
                micSourceNode = sharedCtx.createMediaStreamSource(micStream);
                micSourceNode.connect(micGain);
                
            } catch(e) {
                notify("ไม่สามารถเปิดไมค์ได้ กรุณาอนุญาตการเข้าถึง", "error");
                return; 
            }
        }
        
        isMicOn = true;
        if (micGain && sharedCtx) micGain.gain.setTargetAtTime(1.0, sharedCtx.currentTime, 0.015);
        btn.classList.add('mic-active');
        
    } else {
        isMicOn = false;
        if (micGain && sharedCtx) micGain.gain.setTargetAtTime(0, sharedCtx.currentTime, 0.015);
        btn.classList.remove('mic-active');
    }
}

/** stopMic() — ปิดไมค์ (เรียกตอนออกจากห้อง) */
function stopMic() {
    isMicOn = false;
    
    try {
        if (micGain && sharedCtx) {
            micGain.gain.setTargetAtTime(0, sharedCtx.currentTime, 0.015);
        }
        if (micStream) {
            micStream.getTracks().forEach(track => {
                track.enabled = false;
                track.stop(); 
            });
            micStream = null; 
        }
    } catch(e) { console.log("Mic stop error:", e); }
    
    const btn = document.getElementById('micBtn');
    if (btn) btn.classList.remove('mic-active');
}

// ============================================================
// 7. การแสดงผล UI (Lobby, Room, Members, Chat)
// ============================================================

/** แสดงรายการห้องใน Lobby */
function renderLobby(rooms) {
    const list = document.getElementById('roomList');
    if (!rooms.length) {
        list.innerHTML = '<div style="grid-column:1/-1; text-align:center;">No rooms available</div>';
        return;
    }
    list.innerHTML = rooms.map(r => `
        <div class="room-cards">
            <div class="left-ticket">
                <strong>Title : ${r.name}</strong><br>
                <small style="opacity:0.5">ID: ${r.id.substring(0, 8)}</small><br>
                <small>Capacity : ${r.count}/${r.max} ${r.locked ? '🔒' : ''}</small>
            </div>
            <div class="right-ticket">
                ${r.count < r.max
                    ? `<button onclick="prepareJoin('${r.id}', ${r.locked})" class="button-join">JOIN</button>`
                    : `<div class="button-join-red">FULL</div>`}
            </div>
        </div>`).join('');
}

/** เตรียมเข้าห้อง — เปิด modal ขอ password ถ้าจำเป็น */
function prepareJoin(id, locked) {
    selectedRoom = id;
    document.getElementById('passField').style.display = locked ? 'block' : 'none';
    document.getElementById('joinModal').style.display = 'flex';
}

/** ส่ง JOIN_ROOM ไปยัง server */
function confirmJoin() {
    send('JOIN_ROOM', {
        roomId:     selectedRoom,
        password:   document.getElementById('joinPass').value,
        instrument: document.getElementById('joinInst').value,
        peerId:     myPeerId
    });
    closeModals();
}

/** ส่ง CREATE_ROOM ไปยัง server */
function createRoom() {
    send('CREATE_ROOM', {
        roomName:   document.getElementById('newRoomName').value,
        password:   document.getElementById('newRoomPass').value,
        capacity:   document.getElementById('newRoomCap').value,
        instrument: document.getElementById('createInst').value,
        peerId:     myPeerId
    });
    closeModals();
}

/** ออกจากห้อง — วางสาย WebRTC ทั้งหมด และล้าง UI */
function leaveRoom() {
    send('LEAVE_ROOM', {});
    switchScreen('lobby');
    stopMic();

    // วางสายและลบ audio elements ทั้งหมด
    Object.values(activeCalls).forEach(call => { try { call.close(); } catch (e) {} });
    activeCalls = {};
    Object.values(remoteAudios).forEach(a => { a.srcObject = null; a.remove(); });
    remoteAudios = {};

    currentInst = '';
    document.getElementById('instrumentDeck').innerHTML = '';
}

/**
 * renderMembers() — อัปเดตรายชื่อสมาชิกในห้อง
 * และโทรออกหาสมาชิกที่ยังไม่ได้เชื่อม WebRTC
 */
function renderMembers(users) {
    document.getElementById('memberList').innerHTML = users.map(u => `
        <div class="member-card">
            <div class="status-dot online"></div>
            <div><h5>${u.name}</h5><h6>(${u.instrument})</h6></div>
        </div>`).join('');

    if (!peer || !mixedStream) return;

    //เช็คว่ามีเพื่อนคนไหนหลุด/ปิดแอปไปแล้วบ้าง เพื่อตัดสายไมค์ทิ้ง
    const activePeerIds = users.map(u => u.peerId);
    Object.keys(activeCalls).forEach(peerId => {
        if (!activePeerIds.includes(peerId)) {
            activeCalls[peerId].close();
            delete activeCalls[peerId];
            
            if (remoteAudios[peerId]) {
                remoteAudios[peerId].srcObject = null;
                remoteAudios[peerId].remove();
                delete remoteAudios[peerId];
            }
        }
    });

    users.forEach(u => {
        if (u.id === myId || !u.peerId || activeCalls[u.peerId]) return;
        if (myId < u.id) {
            const call = peer.call(u.peerId, mixedStream);
            if (call) handleCall(call);
        }
    });
}

/** แสดงข้อความ chat — แยก style ตัวเอง vs คนอื่น */
function renderChat(d) {
    const box = document.getElementById('chatHistory');
    const isMe = d.senderId === myId;
    box.innerHTML += `
        <div style="text-align:${isMe ? 'right' : 'left'}; margin-bottom:10px;">
            ${!isMe ? `<div class="sender-name" style="font-weight:bold; color:var(--main);">${d.senderName}</div>` : ''}
            <div class="chat-msg ${isMe ? 'self' : ''}">${d.text}</div>
        </div>`;
    box.scrollTop = box.scrollHeight;
}

// ============================================================
// 8. Audio Engine (Tone.js + Web Audio API)
// ============================================================

async function initAudio() {
    if (toneInstruments.piano) return; // 

    // ดึง AudioContext จาก Tone.js
    sharedCtx = Tone.getContext().rawContext;

    // --- Mic output: สร้างเส้นทางสำหรับไมค์แยกต่างหาก ---
    micGain = sharedCtx.createGain();
    micGain.gain.value = 0; // 

    const micDest = sharedCtx.createMediaStreamDestination();
    micGain.connect(micDest);

    mixedStream = micDest.stream;

    // --- Reverb (effect ร่วมสำหรับ Piano และ Guitar) ---
    const reverb = new Tone.Reverb(0.4).toDestination();

    // --- 1. Piano ---
    toneInstruments.piano = new Tone.Sampler({
        urls: {
            // Natural notes (A0 ถึง C8)
            'A0':'A0.mp3','B0':'B0.mp3','C1':'C1.mp3','D1':'D1.mp3','E1':'E1.mp3','F1':'F1.mp3','G1':'G1.mp3',
            'A1':'A1.mp3','B1':'B1.mp3','C2':'C2.mp3','D2':'D2.mp3','E2':'E2.mp3','F2':'F2.mp3','G2':'G2.mp3',
            'A2':'A2.mp3','B2':'B2.mp3','C3':'C3.mp3','D3':'D3.mp3','E3':'E3.mp3','F3':'F3.mp3','G3':'G3.mp3',
            'A3':'A3.mp3','B3':'B3.mp3','C4':'C4.mp3','D4':'D4.mp3','E4':'E4.mp3','F4':'F4.mp3','G4':'G4.mp3',
            'A4':'A4.mp3','B4':'B4.mp3','C5':'C5.mp3','D5':'D5.mp3','E5':'E5.mp3','F5':'F5.mp3','G5':'G5.mp3',
            'A5':'A5.mp3','B5':'B5.mp3','C6':'C6.mp3','D6':'D6.mp3','E6':'E6.mp3','F6':'F6.mp3','G6':'G6.mp3',
            'A6':'A6.mp3','B6':'B6.mp3','C7':'C7.mp3','D7':'D7.mp3','E7':'E7.mp3','F7':'F7.mp3','G7':'G7.mp3',
            'A7':'A7.mp3','B7':'B7.mp3','C8':'C8.mp3',
            // Accidentals (sharps/flats)
            'Ab1':'Ab1.mp3','Bb0':'Bb0.mp3','Bb1':'Bb1.mp3','Db1':'Db1.mp3','Eb1':'Eb1.mp3','Gb1':'Gb1.mp3',
            'Ab2':'Ab2.mp3','Bb2':'Bb2.mp3','Db2':'Db2.mp3','Eb2':'Eb2.mp3','Gb2':'Gb2.mp3',
            'Ab3':'Ab3.mp3','Bb3':'Bb3.mp3','Db3':'Db3.mp3','Eb3':'Eb3.mp3','Gb3':'Gb3.mp3',
            'Ab4':'Ab4.mp3','Bb4':'Bb4.mp3','Db4':'Db4.mp3','Eb4':'Eb4.mp3','Gb4':'Gb4.mp3',
            'Ab5':'Ab5.mp3','Bb5':'Bb5.mp3','Db5':'Db5.mp3','Eb5':'Eb5.mp3','Gb5':'Gb5.mp3',
            'Ab6':'Ab6.mp3','Bb6':'Bb6.mp3','Db6':'Db6.mp3','Eb6':'Eb6.mp3','Gb6':'Gb6.mp3',
            'Ab7':'Ab7.mp3','Bb7':'Bb7.mp3','Db7':'Db7.mp3','Eb7':'Eb7.mp3','Gb7':'Gb7.mp3','Db8':'Db8.mp3'
        },
        baseUrl: '/sounds/piano/'
    }).connect(reverb);
    toneInstruments.piano.volume.value = 10; // dB

    // --- 2. Drums ---
    toneInstruments.drums = new Tone.Players({
        'kick':      'kick.mp3',
        'snare':     'snare.mp3',
        'closehihat':'closehihat.mp3',
        'openhihat': 'openhihat.mp3',
        'tom1':      'tom1.mp3',
        'tom2':      'tom2.mp3',
        'floor':     'floor.mp3',
        'crash':     'crash.mp3',
        'ride':      'ride.mp3'
    }, { baseUrl: '/sounds/drum/' }).toDestination();
    toneInstruments.drums.volume.value = 1;

    // --- 3. Guitar (6 สาย: E A D G B e) ---
    toneInstruments.guitar = new Tone.Sampler({
        urls: {
            'A3':'Guitar_A.mp3', 'B3':'Guitar_B.mp3', 'C4':'Guitar_C.mp3',
            'D4':'Guitar_D.mp3', 'E4':'Guitar_E.mp3', 'F4':'Guitar_F.mp3', 'G4':'Guitar_G.mp3'
        },
        baseUrl: '/sounds/guitar/'
    }).connect(reverb);
    toneInstruments.guitar.volume.value = 1;

    // --- 4. Bass (4 สาย: E A D G) ---
    toneInstruments.bass = new Tone.Sampler({
        urls: {
            'E1':'bass4.mp3',   // สาย 1 ต่ำสุด
            'A1':'bass3.mp3',   // สาย 2
            'D2':'bass2.mp3',   // สาย 3
            'G2':'bass1.mp3'    // สาย 4 สูงสุด
        },
        baseUrl: '/sounds/bass/',
        release: 0.3
    }).toDestination();
    toneInstruments.bass.volume.value = -6; // ลดเพราะ bass ความถี่ต่ำมีพลังงานสูงมาก
}

/**
 * SoundEngine — เล่นเสียงเครื่องดนตรีผ่าน Tone.js
 */
const SoundEngine = {

    /** Piano: note = MIDI number, sus = sustain (เสียงยาว) */
    playPiano(note, sus) {
        if (toneInstruments.piano?.loaded) {
            const toneName = Tone.Frequency(note, 'midi').toNote();
            toneInstruments.piano.triggerAttackRelease(toneName, sus ? '1n' : '8n');
        }
    },

    /** Guitar: idx = 0–5 ตาม index สาย (E A D G B e) */
    playGuitar(idx) {
        const noteMap = ['A3', 'B3', 'C4', 'D4', 'E4', 'F4'];
        const note = noteMap[idx];
        if (note && toneInstruments.guitar?.loaded) {
            toneInstruments.guitar.triggerAttackRelease(note, '2n');
        }
    },

    /** Bass: idx = 0–3 ตาม KeyMap (key 1 = E ต่ำสุด = idx 3) */
    playBass(idx) {
        const noteMap = ['E1', 'A1', 'D2', 'G2'];
        const note = noteMap[idx];
        if (note && toneInstruments.bass?.loaded) {
            toneInstruments.bass.triggerAttackRelease(note, '4n');
        }
    },

    /** Drum: type = ชื่อเสียงกลอง เช่น 'kick', 'snare', 'crash' */
    playDrum(type) {
        if (toneInstruments.drums?.has(type)) {
            toneInstruments.drums.player(type).start();
        }
    }
};

/** เล่น note ของตัวเอง — ส่งไปยัง server เพื่อ sync กับเพื่อน */
function playLocalNote(note, inst) {
    const sus = (inst === 'Piano') ? isSustain : false;
    send('NOTE_PLAY', { note, instrument: inst, sustain: sus });
    executeSound(note, inst, sus);
}

/** เล่น note ที่รับมาจากเพื่อนผ่าน WebSocket */
function playRemoteNote(data) {
    executeSound(data.note, data.instrument, data.sustain);
}

/** dispatch การเล่นเสียงไปยัง SoundEngine ที่ถูกต้อง */
function executeSound(note, inst, sus) {
    if      (inst === 'Piano')  SoundEngine.playPiano(note, sus);
    else if (inst === 'Drum')   SoundEngine.playDrum(note);
    else if (inst === 'Guitar') SoundEngine.playGuitar(note);
    else if (inst === 'Bass')   SoundEngine.playBass(note);
}

// ============================================================
// 9. การวาดเครื่องดนตรี (Instrument Rendering)
// ============================================================

/**
 * renderInstrument() — สร้าง UI เครื่องดนตรีใน #instrumentDeck
 * เรียกตอนเข้าห้องหรือเปลี่ยนเครื่องดนตรี
 */
function renderInstrument(type) {
    currentInst = type;
    const deck = document.getElementById('instrumentDeck');
    deck.innerHTML = '';

    // ซ่อน/แสดงปุ่ม Sustain เฉพาะ Piano
    document.getElementById('sustainBtn').style.display = (type === 'Piano') ? 'flex' : 'none';

    if      (type === 'Piano')  renderPiano(deck);
    else if (type === 'Drum')   renderDrum(deck);
    else if (type === 'Guitar') renderStringInstrument(deck, 'Guitar', ['E(1)', 'A(2)', 'D(3)', 'G(4)', 'B(5)', 'E(6)']);
    else if (type === 'Bass')   renderStringInstrument(deck, 'Bass',   ['E(1)', 'A(2)', 'D(3)', 'G(4)']);
    else if (type === 'Singer') renderSinger(deck);
}

/** สร้าง Piano keyboard — 36 คีย์ MIDI 48–83 รองรับ multi-touch */
function renderPiano(deck) {
    const piano = document.createElement('div');
    piano.className = 'piano';

    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    let activeTouches = {}; // track touch identifier → midi note (กัน replay เดิม)

    for (let i = 0; i < 36; i++) {
        const midi = i + 48;
        const key = document.createElement('div');
        key.className = `key ${noteNames[i % 12].includes('#') ? 'black' : 'white'}`;
        key.id = `note-${midi}`;
        if (KeyLabels[midi]) key.setAttribute('data-key', KeyLabels[midi]);

        // Mouse
        key.onmousedown = () => {
            playLocalNote(midi, 'Piano');
            triggerVisual({ instrument: 'Piano', note: midi });
        };

        // Touch — รองรับหลายนิ้วพร้อมกัน
        key.addEventListener('touchstart', (e) => {
            e.preventDefault();
            for (const touch of e.changedTouches) {
                activeTouches[touch.identifier] = midi;
                playLocalNote(midi, 'Piano');
                triggerVisual({ instrument: 'Piano', note: midi });
            }
        }, { passive: false });

        piano.appendChild(key);
    }

    // Touch move: เล่น note ใหม่เมื่อนิ้วเลื่อนไปโดนคีย์อื่น
    piano.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const touch of e.touches) {
            const el = document.elementFromPoint(touch.clientX, touch.clientY);
            if (el?.classList.contains('key')) {
                const midi = parseInt(el.id.replace('note-', ''));
                if (activeTouches[touch.identifier] !== midi) {
                    activeTouches[touch.identifier] = midi;
                    playLocalNote(midi, 'Piano');
                    triggerVisual({ instrument: 'Piano', note: midi });
                }
            }
        }
    }, { passive: false });

    const cleanUp = (e) => {
        for (const touch of e.changedTouches) delete activeTouches[touch.identifier];
    };
    piano.addEventListener('touchend',   cleanUp);
    piano.addEventListener('touchcancel', cleanUp);

    deck.appendChild(piano);
}

/** สร้าง Drum kit UI */
function renderDrum(deck) {
    const kit = document.createElement('div');
    kit.className = 'drum-kit-pro';

    const drums = [
        { id: 'crash',      img: 'crash.png',     label: 'Crash'    },
        { id: 'tom1',       img: 'tom.png',        label: 'Tom'      },
        { id: 'tom2',       img: 'tom.png',        label: 'Tom'      },
        { id: 'ride',       img: 'ride.png',       label: 'Ride'     },
        { id: 'openhihat',  img: 'openhihat.png',  label: 'Open HH'  },
        { id: 'snare',      img: 'snare.png',      label: 'Snare'    },
        { id: 'floor',      img: 'floor.png',      label: 'Floor'    },
        { id: 'closehihat', img: 'closehihat.png', label: 'Close HH' },
        { id: 'kick1',      img: 'kick.png',       label: 'Kick',    sound: 'kick' },
        { id: 'kick2',      img: 'kick.png',       label: 'Kick',    sound: 'kick' }
    ];

    drums.forEach(d => {
        const pad = document.createElement('div');
        pad.className = `drum-item ${d.id}`;
        pad.id = `drum-${d.id}`;
        pad.innerHTML = `<img src="assets/Drum/${d.img}" alt="${d.label}">
                         <div class="drum-label">${d.label}</div>`;

        const soundKey = d.sound || d.id;
        const play = () => {
            playLocalNote(soundKey, 'Drum');
            triggerVisual({ instrument: 'Drum', note: d.id });
        };

        pad.onmousedown = (e) => { e.preventDefault(); play(); };
        pad.addEventListener('touchstart', (e) => { e.preventDefault(); play(); }, { passive: false });
        kit.appendChild(pad);
    });

    deck.appendChild(kit);
}

/**
 * renderStringInstrument() — สร้าง UI สายกีตาร์ / เบส
 * @param {HTMLElement} deck   - container
 * @param {string}      type   - 'Guitar' | 'Bass'
 * @param {string[]}    labels - ชื่อสายแต่ละเส้น
 */
function renderStringInstrument(deck, type, labels) {
    const board = document.createElement('div');
    board.className = `instrument-board ${type.toLowerCase()}-board`;

    labels.forEach((label, i) => {
        const row = document.createElement('div');
        row.className = 'string-row';

        const lbl = document.createElement('div');
        lbl.className = 'string-label';
        lbl.innerText = label;

        const lineContainer = document.createElement('div');
        lineContainer.className = 'string-line-container';

        const line = document.createElement('div');
        line.className = 'string-line';
        line.id = `${type.toLowerCase()}-string-${i}`;

        const play = () => {
            playLocalNote(i, type);
            triggerVisual({ instrument: type, note: i });
        };

        lineContainer.onmousedown = play;
        lineContainer.addEventListener('touchstart', (e) => { e.preventDefault(); play(); }, { passive: false });

        lineContainer.appendChild(line);
        row.appendChild(lbl);
        row.appendChild(lineContainer);
        board.appendChild(row);
    });

    deck.appendChild(board);
}

/** สร้าง Singer UI — textarea สำหรับพิมพ์/วางเนื้อเพลง */
function renderSinger(deck) {
    const board = document.createElement('div');
    board.className = 'instrument-board singer-board';

    const title = document.createElement('h3');
    title.className = 'singer-title';
    title.innerText = 'Lyrics';

    const textarea = document.createElement('textarea');
    textarea.className = 'singer-lyrics-input';
    textarea.placeholder = 'พิมพ์หรือวางเนื้อเพลงที่นี่...';

    board.appendChild(title);
    board.appendChild(textarea);
    deck.appendChild(board);
}

/**
 * triggerVisual() — แสดง visual feedback เมื่อมีการเล่น note
 * ทำงานทั้งจาก local และ remote note (เพื่อน)
 */
function triggerVisual(data) {
    if (data.instrument === 'Piano') {
        const el = document.getElementById(`note-${data.note}`);
        if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 200); }

    } else if (data.instrument === 'Drum') {
        const el = document.getElementById(`drum-${data.note}`);
        if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 200); }

    } else if (data.instrument === 'Guitar' || data.instrument === 'Bass') {
        const prefix = data.instrument.toLowerCase();
        const line = document.getElementById(`${prefix}-string-${data.note}`);
        if (line) {
            line.style.boxShadow = '0 0 14px #fff, 0 0 4px var(--main)';
            setTimeout(() => line.style.boxShadow = '', 350);
        }
    }
}

/** Toggle sustain mode ของ Piano */
function toggleSustain() {
    isSustain = !isSustain;
    document.getElementById('sustainBtn').classList.toggle('sustain-active', isSustain);
}

// ============================================================
// 10. ฟังก์ชันช่วยเหลือ (Helpers)
// ============================================================

/** ส่งข้อความ chat */
function sendChat() {
    const input = document.getElementById('chatMsg');
    if (input.value.trim()) {
        send('CHAT', input.value.trim());
        input.value = '';
    }
}

/** กด Enter ใน chat input = ส่งทันที */
function handleChat(e) {
    if (e.key === 'Enter') sendChat();
}

/** สลับ active screen โดย ID */
function switchScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

/** ปิด modal ทั้งหมด */
function closeModals() {
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
}

/** เปิด modal สร้างห้อง */
function showCreateModal() {
    document.getElementById('createModal').style.display = 'flex';
}

/** ออกจาก Lobby กลับหน้าแรก */
function leaveLobby() {
    window.location.reload();
}

/** ส่งคำสั่งเปลี่ยนเครื่องดนตรีไปยัง server */
function changeInstrument(value) {
    send('CHANGE_INSTRUMENT', value);
}

/** เลือกเครื่องดนตรีใน modal (สร้าง/เข้าร่วมห้อง) */
function selectInstrument(inputId, value, element) {
    document.getElementById(inputId).value = value;
    element.parentElement.querySelectorAll('.inst-option').forEach(opt => opt.classList.remove('active'));
    element.classList.add('active');
}

/** เลือกเครื่องดนตรีใน Room (top bar) — อัปเดตทันทีและแจ้ง server */
function selectRoomInstrument(value, element) {
    document.getElementById('roomInstSelect').value = value;
    element.parentElement.querySelectorAll('.inst-option').forEach(opt => opt.classList.remove('active'));
    element.classList.add('active');
    changeInstrument(value);
}

/** ตั้งค่า room UI หลัง JOIN_SUCCESS — แสดงชื่อห้อง, เครื่องดนตรี, เปลี่ยนหน้าจอ */
function enterRoom(data) {
    document.getElementById('roomTitle').innerText = data.roomName;
    document.getElementById('roomInstSelect').value = data.instrument;

    // ไฮไลต์ instrument ที่เลือกไว้ใน top bar
    document.querySelectorAll('.room-top-selector .inst-option').forEach(opt => {
        opt.classList.toggle('active', opt.getAttribute('data-inst') === data.instrument);
    });

    document.getElementById('chatHistory').innerHTML = '';
    switchScreen('room');
    renderInstrument(data.instrument);
}

// ส่ง LEAVE_ROOM ก่อนปิดหน้าต่าง 

function cleanupConnection() {
    stopMic();

    // ปิด WebSocket 
    try {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'LEAVE_ROOM', payload: {} }));
            ws.close(); 
        }
    } catch(e) {}
    
    //ตัดสายโทรศัพท์ WebRTC
    try {
        if (peer && !peer.destroyed) {
            peer.destroy();
        }
    } catch(e) {}
}

window.addEventListener('pagehide', cleanupConnection, false);
window.addEventListener('unload', cleanupConnection, false);
window.addEventListener('beforeunload', cleanupConnection, false);

let disconnectTimer;

// (ตรวจจับการสลับแท็บ หรือพับหน้าจอแอป)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        disconnectTimer = setTimeout(() => {
            cleanupConnection(); 
            window.location.reload(); 
        }, 10000); 
        
    } else if (document.visibilityState === 'visible') {
        clearTimeout(disconnectTimer);
    }
});

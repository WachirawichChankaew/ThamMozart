const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// ==========================================================================
// 1. HTTP SERVER (เซิร์ฟเวอร์สำหรับโหลดหน้าเว็บและไฟล์ต่างๆ)
// ทำหน้าที่ส่งไฟล์ HTML, CSS, JS, รูปภาพ และไฟล์เสียง เมื่อเบราว์เซอร์ร้องขอ
// ==========================================================================
const server = http.createServer((req, res) => {
    const safePath = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(__dirname, safePath === '/' || safePath === '\\' ? 'index.html' : safePath);
    const extname = path.extname(filePath).toLowerCase();

    // ถ้าเข้ามาที่หน้าแรก '/' ให้เปิดไฟล์ 'index.html'
    let contentType = 'text/html';

    // กำหนดประเภทของไฟล์ (MIME Type) ให้เบราว์เซอร์อ่านได้ถูกต้อง
    switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
        case '.json': contentType = 'application/json'; break;
        case '.png': contentType = 'image/png'; break;
        case '.jpg': contentType = 'image/jpg'; break;
        case '.webp': contentType = 'image/webp'; break;
        case '.wav': contentType = 'audio/wav'; break;
        case '.mp3': contentType = 'audio/mpeg'; break;
        case '.ogg': contentType = 'audio/ogg'; break;
        case '.woff2': contentType = 'font/woff2'; break;
    }

    // อ่านไฟล์จากฮาร์ดดิสก์แล้วส่งกลับไปให้เบราว์เซอร์
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(err.code == 'ENOENT' ? 404 : 500);
            res.end(err.code == 'ENOENT' ? '404 Not Found' : 'Server Error');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// ==========================================================================
// 2. GLOBAL STATES (ตัวแปรเก็บข้อมูลสถานะของระบบ)
// ==========================================================================
let rooms = {};
let clients = [];

// ==========================================================================
// 3. WEBSOCKET SERVER (ระบบเชื่อมต่อแบบ Real-time)
// ดักจับเหตุการณ์ 'upgrade' (เมื่อ Client ขอเปลี่ยนจาก HTTP ธรรมดาเป็น WebSocket)
// ==========================================================================

server.on('upgrade', (req, socket, head) => {
    // 3.1 การทำ Handshake (ตอบรับการเชื่อมต่อ WebSocket ตามมาตรฐาน)
    const key = req.headers['sec-websocket-key'];
    const digest = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${digest}\r\n\r\n`);

    // 3.2 สร้างตัวตน (Profile) ให้ผู้ใช้ที่เพิ่งเชื่อมต่อเข้ามาใหม่
    const client = { socket, id: crypto.randomUUID(), room: null, name: null, instrument: null, peerId: null, lastPing: Date.now() };
    clients.push(client);

    // 3.3 เมื่อได้รับข้อมูลจาก Client
    socket.on('data', (buffer) => {
        const parsed = parseFrame(buffer);
        if (!parsed) return;
        const opcode = buffer[0] & 0x0F;
        if (opcode === 1) { // ถ้าเป็นข้อความประเภท Text (Opcode 1)
            try { handleMessage(client, JSON.parse(parsed.toString())); } catch (e) { }
        }
    });
    socket.on('close', () => handleDisconnect(client));
    socket.on('error', () => handleDisconnect(client));
});

function handleMessage(c, m) {
    c.lastPing = Date.now();
    switch (m.type) {
        case 'PING': break;
        case 'LOGIN': 
            c.name = m.payload.name; 
            c.peerId = m.payload.peerId; 
            c.sessionId = m.payload.sessionId; 
            clients.forEach(oldClient => {
                if (oldClient.id !== c.id && oldClient.sessionId === c.sessionId) {
                    handleDisconnect(oldClient); 
                    oldClient.socket.destroy();  
                }
            });
            sendRoomList(c); 
            break;
        case 'CREATE_ROOM':// สร้างห้องใหม่
            const roomId = crypto.randomUUID();
            rooms[roomId] = { id: roomId, name: m.payload.roomName, password: m.payload.password, capacity: m.payload.capacity, users: [] };
            joinRoom(c, roomId, null, m.payload.instrument, m.payload.peerId); break;
        case 'JOIN_ROOM': // กดเข้าร่วมห้อง
            joinRoom(c, m.payload.roomId, m.payload.password, m.payload.instrument, m.payload.peerId); break;
        case 'NOTE_PLAY': // มีคนกดเล่นเครื่องดนตรี ให้กระจายเสียงไปบอกคนอื่นในห้อง
            broadcastToRoom(c.room, { type: 'NOTE_PLAY', payload: { ...m.payload, senderId: c.id } }, c.id); break;
        case 'CHAT': // มีคนพิมพ์แชท
            broadcastToRoom(c.room, { type: 'CHAT', payload: { text: m.payload, senderId: c.id, senderName: c.name } }); break;
        case 'LEAVE_ROOM': // กดย้ายกลับไปหน้า Lobby
            leaveRoom(c); break;
        case 'CHANGE_INSTRUMENT': // เปลี่ยนเครื่องดนตรีระหว่างอยู่ในห้อง
            if (!c.room) return;
            c.instrument = m.payload;
            const r = rooms[c.room];
            if (r) {
                const user = r.users.find(u => u.id === c.id);
                if (user) user.instrument = m.payload;  // อัปเดตข้อมูลเครื่องดนตรีใหม่
                c.socket.write(createFrame({ type: 'INSTRUMENT_CHANGED', payload: m.payload }));
                broadcastToRoom(c.room, { type: 'UPDATE_MEMBERS', payload: r.users }); // อัปเดตรายชื่อให้ทุกคนเห็น
            }
            break;
    }
}

// ==========================================================================
// 5. ROOM MANAGEMENT (ระบบบริหารจัดการห้อง)
// ==========================================================================

// นำผู้ใช้เข้าห้อง และตรวจสอบเงื่อนไขต่างๆ
function joinRoom(c, roomId, p, i, peerId) {
    const r = rooms[roomId];
    if (!r) return sendErr(c, 'No Room');
    if (r.password && r.password !== p && r.users.length > 0) return sendErr(c, 'Wrong Pass');
    if (r.users.length >= r.capacity) return sendErr(c, 'Full');
    if (c.room) leaveRoom(c);

    // อัปเดตข้อมูลให้ Client
    c.room = roomId;
    c.instrument = i;
    c.peerId = peerId;
    r.users.push({ id: c.id, name: c.name, instrument: i, peerId: peerId });

    // แจ้ง Client ว่าเข้าห้องสำเร็จ
    c.socket.write(createFrame({ type: 'JOIN_SUCCESS', payload: { roomId: roomId, roomName: r.name, instrument: i, myId: c.id } }));
    // แจ้งอัปเดตสมาชิกให้คนในห้อง และแจ้งอัปเดตห้องให้คนใน Lobby
    broadcastToRoom(roomId, { type: 'UPDATE_MEMBERS', payload: r.users });
    broadcastGlobal({ type: 'UPDATE_LOBBY', payload: getRoomList() });
}

// นำผู้ใช้ออกจากห้อง
function leaveRoom(c) {
    if (!c.room) return;
    const r = rooms[c.room];
    if (r) {
        r.users = r.users.filter(u => u.id !== c.id);
        if (r.users.length === 0) delete rooms[c.room];
        else broadcastToRoom(c.room, { type: 'UPDATE_MEMBERS', payload: r.users });
    }
    c.room = null;
    broadcastGlobal({ type: 'UPDATE_LOBBY', payload: getRoomList() });
}

// เมื่อผู้ใช้ปิดหน้าเว็บ
function handleDisconnect(c) { leaveRoom(c); clients = clients.filter(x => x.id !== c.id); }

// ดึงข้อมูลรายชื่อห้องทั้งหมดเพื่อส่งไปแสดงที่หน้า Lobby
function getRoomList() {
    return Object.values(rooms).map(r => ({ id: r.id, name: r.name, count: r.users.length, max: r.capacity, locked: !!r.password }));
}

// ==========================================================================
// 6. WEBSOCKET PROTOCOL 
// ==========================================================================
// ถอดรหัสข้อมูล (Unmasking) ที่ส่งมาจาก Client
function parseFrame(buffer) {
    if (buffer.length < 2) return null;
    const len = buffer[1] & 127;
    let maskStart = 2;
    if (len === 126) maskStart = 4; else if (len === 127) return null;
    const mask = buffer.slice(maskStart, maskStart + 4);
    const payloadLength = len === 126 ? buffer.readUInt16BE(2) : len;
    const payload = buffer.slice(maskStart + 4, maskStart + 4 + payloadLength);
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
    return unmasked;
}

// เข้ารหัสข้อมูล (Framing) เพื่อเตรียมส่งกลับไปหา Client
function createFrame(data) {
    const payload = Buffer.from(JSON.stringify(data));
    const len = payload.length;
    const frame = [0x81];
    if (len <= 125) frame.push(len);
    else { frame.push(126); frame.push((len >> 8) & 255); frame.push(len & 255); }
    return Buffer.concat([Buffer.from(frame), payload]);
}
setInterval(() => {
    const now = Date.now();
    clients.forEach(c => {
        // ถ้าเงียบหายไปเกิน 10 วินาที (แปลว่าปัดแอปทิ้ง หรือเน็ตหลุด)
        if (now - c.lastPing > 10000) { 
            handleDisconnect(c);
            c.socket.destroy(); // ตัดการเชื่อมต่อทันที
        }
    });
}, 5000);

// ==========================================================================
// 7. BROADCAST UTILITIES (ตัวช่วยในการส่งข้อความ)
// ==========================================================================
// ส่งข้อความหาทุกคนในห้อง
function broadcastToRoom(r, d, ex = null) { clients.forEach(c => { if (c.room === r && c.id !== ex && c.socket.writable) c.socket.write(createFrame(d)); }); }
// ส่งข้อความหาทุกคนที่ออนไลน์อยู่
function broadcastGlobal(d) { clients.forEach(c => { if (c.socket.writable) c.socket.write(createFrame(d)); }); }
// ส่งอัปเดตรายชื่อห้องให้คนใดคนหนึ่ง
function sendRoomList(c) { if (c.socket.writable) c.socket.write(createFrame({ type: 'UPDATE_LOBBY', payload: getRoomList() })); }
// ส่งข้อความแจ้งเตือน Error
function sendErr(c, m) { if (c.socket.writable) c.socket.write(createFrame({ type: 'ERROR', payload: m })); }
// ==========================================================================
// 8. START SERVER
// ==========================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`ThamMozart Server running on port ${PORT}`); });
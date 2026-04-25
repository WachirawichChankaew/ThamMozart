const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const server = http.createServer((req, res) => {
    const safePath = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(__dirname, safePath === '/' || safePath === '\\' ? 'index.html' : safePath);
    const extname = path.extname(filePath).toLowerCase();
    let contentType = 'text/html';

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

let rooms = {};
let clients = [];

server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const digest = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${digest}\r\n\r\n`);

    const client = { socket, id: crypto.randomUUID(), room: null, name: null, instrument: null, peerId: null };
    clients.push(client);

    socket.on('data', (buffer) => {
        const parsed = parseFrame(buffer);
        if (!parsed) return;
        const opcode = buffer[0] & 0x0F;
        if (opcode === 1) { 
            try { handleMessage(client, JSON.parse(parsed.toString())); } catch (e) {}
        }
    });
    socket.on('close', () => handleDisconnect(client));
    socket.on('error', () => handleDisconnect(client));
});

function handleMessage(c, m) {
    switch (m.type) {
        case 'LOGIN':
            c.name = m.payload.name; sendRoomList(c); break;
        case 'CREATE_ROOM':
            const roomId = crypto.randomUUID();
            rooms[roomId] = { id: roomId, name: m.payload.roomName, password: m.payload.password, capacity: m.payload.capacity, users: [] };
            joinRoom(c, roomId, null, m.payload.instrument, m.payload.peerId); break;
        case 'JOIN_ROOM':
            joinRoom(c, m.payload.roomId, m.payload.password, m.payload.instrument, m.payload.peerId); break;
        case 'NOTE_PLAY':
            broadcastToRoom(c.room, { type: 'NOTE_PLAY', payload: { ...m.payload, senderId: c.id } }, c.id); break;
        case 'CHAT':
            broadcastToRoom(c.room, { type: 'CHAT', payload: { text: m.payload, senderId: c.id, senderName: c.name } }); break;
        case 'LEAVE_ROOM':
            leaveRoom(c); break;
        case 'CHANGE_INSTRUMENT':
            if (!c.room) return;
            c.instrument = m.payload; 
            const r = rooms[c.room];
            if (r) {
                const user = r.users.find(u => u.id === c.id);
                if (user) user.instrument = m.payload; 
                c.socket.write(createFrame({ type: 'INSTRUMENT_CHANGED', payload: m.payload }));
                broadcastToRoom(c.room, { type: 'UPDATE_MEMBERS', payload: r.users });
            }
            break;
    }
}

function joinRoom(c, roomId, p, i, peerId) {
    const r = rooms[roomId];
    if (!r) return sendErr(c, 'No Room');
    if (r.password && r.password !== p && r.users.length > 0) return sendErr(c, 'Wrong Pass');
    if (r.users.length >= r.capacity) return sendErr(c, 'Full');
    if (c.room) leaveRoom(c);

    c.room = roomId;
    c.instrument = i;
    c.peerId = peerId;
    r.users.push({ id: c.id, name: c.name, instrument: i, peerId: peerId });

    c.socket.write(createFrame({ type: 'JOIN_SUCCESS', payload: { roomId: roomId, roomName: r.name, instrument: i, myId: c.id } }));
    broadcastToRoom(roomId, { type: 'UPDATE_MEMBERS', payload: r.users });
    broadcastGlobal({ type: 'UPDATE_LOBBY', payload: getRoomList() });
}

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

function handleDisconnect(c) { leaveRoom(c); clients = clients.filter(x => x.id !== c.id); }

function getRoomList() {
    return Object.values(rooms).map(r => ({ id: r.id, name: r.name, count: r.users.length, max: r.capacity, locked: !!r.password }));
}

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

function createFrame(data) {
    const payload = Buffer.from(JSON.stringify(data));
    const len = payload.length;
    const frame = [0x81];
    if (len <= 125) frame.push(len);
    else { frame.push(126); frame.push((len >> 8) & 255); frame.push(len & 255); }
    return Buffer.concat([Buffer.from(frame), payload]);
}

function broadcastToRoom(r, d, ex = null) { clients.forEach(c => { if (c.room === r && c.id !== ex && c.socket.writable) c.socket.write(createFrame(d)); }); }
function broadcastGlobal(d) { clients.forEach(c => { if (c.socket.writable) c.socket.write(createFrame(d)); }); }
function sendRoomList(c) { if (c.socket.writable) c.socket.write(createFrame({ type: 'UPDATE_LOBBY', payload: getRoomList() })); }
function sendErr(c, m) { if (c.socket.writable) c.socket.write(createFrame({ type: 'ERROR', payload: m })); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`ThamMozart Server running on port ${PORT}`); });
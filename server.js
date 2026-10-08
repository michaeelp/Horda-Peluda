'use strict';
/* Servidor de Horda Peluda: sirve el juego y corre la simulación de cada sala.
   La clase Sim se extrae de public/index.html (entre //#SIM_START y //#SIM_END). */
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const simCode = html.slice(html.indexOf('//#SIM_START'), html.indexOf('//#SIM_END'));
const { Sim, CHARS, STEP } = new Function("'use strict';" + simCode + '\nreturn {Sim,CHARS,STEP};')();

const rooms = new Map();
let uid = 1;
const LET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const newCode = () => { let c; do { c = ''; for (let i = 0; i < 5; i++) c += LET[Math.random() * LET.length | 0]; } while (rooms.has(c)); return c; };
const send = (ws, m) => { if (ws.readyState === 1) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
const bcast = (r, m) => { const s = JSON.stringify(m); for (const p of r.players.values()) send(p.ws, s); };
const lobbyMsg = r => ({ t: 'lobby', players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, ch: p.ch, leader: p.id === r.leader })) });

function tryPick(r, me, ch) {
  if (!CHARS[ch] || [...r.players.values()].some(p => p.ch === ch && p.id !== me.id)) return;
  me.ch = me.ch === ch ? null : ch;
  bcast(r, lobbyMsg(r));
}
function startGame(r) {
  r.inGame = true;
  const seed = Math.random() * 1e9 | 0;
  const plist = [...r.players.values()].map(p => ({ id: p.id, name: p.name, ch: p.ch }));
  r.sim = new Sim(plist, seed); r.acc = 0; r.tick = 0;
  bcast(r, { t: 'start', seed, players: plist });
}
function toLobby(r) {
  r.inGame = false; r.sim = null;
  for (const p of r.players.values()) p.ch = null;
  bcast(r, { t: 'tolobby' }); bcast(r, lobbyMsg(r));
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(html);
  }
  res.writeHead(404); res.end('not found');
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', ws => {
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  let room = null, me = null;
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || typeof d.t !== 'string') return;
    if (!room) {
      if (d.t !== 'create' && d.t !== 'join') return;
      const name = String(d.name || 'Jugador').slice(0, 14);
      let r;
      if (d.t === 'create') {
        if (rooms.size >= 200) return send(ws, { t: 'full', why: 'Servidor lleno, probá más tarde' });
        r = { code: newCode(), players: new Map(), leader: null, inGame: false, sim: null, acc: 0, tick: 0 };
        rooms.set(r.code, r);
      } else {
        r = rooms.get(String(d.code || '').toUpperCase());
        if (!r) return send(ws, { t: 'full', why: 'No existe esa sala' });
        if (r.inGame) return send(ws, { t: 'full', why: 'La partida ya empezó' });
        if (r.players.size >= 3) return send(ws, { t: 'full', why: 'Sala llena' });
      }
      room = r; me = { id: 'p' + uid++, name, ch: null, ws };
      room.players.set(me.id, me);
      if (!room.leader) room.leader = me.id;
      send(ws, { t: 'welcome', id: me.id, code: room.code });
      bcast(room, lobbyMsg(room));
      return;
    }
    switch (d.t) {
      case 'pick': if (!room.inGame) tryPick(room, me, d.ch); break;
      case 'start': if (!room.inGame && me.id === room.leader && [...room.players.values()].every(p => p.ch)) startGame(room); break;
      case 'in': if (room.sim) room.sim.setInput(me.id, d); break;
      case 'card': if (room.sim) room.sim.pick(me.id, d.id); break;
      case 'back': if (room.inGame && me.id === room.leader) toLobby(room); break;
    }
  });
  ws.on('close', () => {
    if (!room || !me) return;
    room.players.delete(me.id);
    if (room.sim) room.sim.removePlayer(me.id);
    if (!room.players.size) { rooms.delete(room.code); return; }
    if (room.leader === me.id) room.leader = room.players.keys().next().value;
    bcast(room, lobbyMsg(room));
  });
});

// Bucle de simulación: 60 ticks/s, snapshot cada 2 ticks (30/s)
let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
  for (const r of rooms.values()) {
    const sim = r.sim; if (!sim) continue;
    r.acc += dt; let n = 0;
    while (r.acc >= STEP && n < 6) {
      sim.step(STEP); r.acc -= STEP; n++;
      if (sim.newOffers) { sim.newOffers = false; bcast(r, { t: 'offers', o: sim.offers }); }
      if (++r.tick % 2 === 0) bcast(r, sim.snapshot());
    }
    if (n >= 6) r.acc = 0;
  }
}, 8);

// Ping para que Render/proxies no corten conexiones inactivas y limpiar sockets muertos
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
}, 25000);

server.listen(PORT, () => console.log('Horda Peluda escuchando en el puerto ' + PORT));

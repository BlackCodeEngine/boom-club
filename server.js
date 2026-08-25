const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Board constants (shared 52-cell ring + 6-cell home stretch per color)
// ---------------------------------------------------------------------------
const RING_LENGTH = 52;
const START_OFFSET = { red: 0, yellow: 26 };
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const COLORS = ['red', 'yellow'];

function otherColor(color) {
  return color === 'red' ? 'yellow' : 'red';
}

function createInitialTokens() {
  return { red: [-1, -1, -1, -1], yellow: [-1, -1, -1, -1] };
}

function computeValidMoves(tokens, diceValue) {
  const moves = [];
  tokens.forEach((d, i) => {
    if (d === -1) {
      if (diceValue === 6) moves.push(i);
      return;
    }
    if (d === 56) return; // already finished
    if (d + diceValue <= 56) moves.push(i);
  });
  return moves;
}

function applyMove(room, color, tokenIndex, diceValue) {
  const tokens = room.tokens[color];
  const d = tokens[tokenIndex];
  const newD = d === -1 ? 0 : d + diceValue;
  tokens[tokenIndex] = newD;

  let captured = false;
  if (newD >= 0 && newD <= 50) {
    const abs = (START_OFFSET[color] + newD) % RING_LENGTH;
    if (!SAFE_CELLS.has(abs)) {
      const opp = otherColor(color);
      const oppTokens = room.tokens[opp];
      for (let i = 0; i < oppTokens.length; i++) {
        if (oppTokens[i] >= 0 && oppTokens[i] <= 50) {
          const oppAbs = (START_OFFSET[opp] + oppTokens[i]) % RING_LENGTH;
          if (oppAbs === abs) {
            oppTokens[i] = -1;
            captured = true;
          }
        }
      }
    }
  }

  const finished = newD === 56;
  return { captured, finished };
}

function checkWin(room, color) {
  return room.tokens[color].every((d) => d === 56);
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------
const rooms = new Map();
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function publicState(room) {
  return {
    code: room.code,
    players: room.players.map((p) => ({ name: p.name, color: p.color, connected: p.connected })),
    tokens: room.tokens,
    turn: room.players[room.turnIndex] ? room.players[room.turnIndex].color : null,
    dice: room.dice,
    validMoves: room.validMoves,
    started: room.started,
    winner: room.winner,
  };
}

function passTurn(room) {
  room.dice = null;
  room.validMoves = [];
  room.sixStreak = 0;
  room.turnIndex = 1 - room.turnIndex;
}

function extraTurn(room) {
  room.dice = null;
  room.validMoves = [];
}

function broadcastState(room, extra) {
  io.to(room.code).emit('state', { ...publicState(room), ...(extra || {}) });
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    const code = generateRoomCode();
    const room = {
      code,
      players: [{ id: socket.id, name: (name || 'Spieler 1').slice(0, 16), color: 'red', connected: true }],
      turnIndex: 0,
      dice: null,
      validMoves: [],
      sixStreak: 0,
      tokens: createInitialTokens(),
      started: false,
      winner: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.color = 'red';
    socket.emit('roomCreated', { code, color: 'red', state: publicState(room) });
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) {
      socket.emit('errorMsg', 'Raum nicht gefunden.');
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('errorMsg', 'Raum ist bereits voll.');
      return;
    }
    room.players.push({ id: socket.id, name: (name || 'Spieler 2').slice(0, 16), color: 'yellow', connected: true });
    room.started = true;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.color = 'yellow';
    socket.emit('roomJoined', { code: room.code, color: 'yellow', state: publicState(room) });
    io.to(room.code).emit('gameStart', publicState(room));
  });

  socket.on('rollDice', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.winner) return;
    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (room.dice !== null) return; // already rolled, waiting for a move

    const value = 1 + Math.floor(Math.random() * 6);
    room.sixStreak = value === 6 ? room.sixStreak + 1 : 0;

    if (room.sixStreak === 3) {
      room.dice = value;
      io.to(room.code).emit('diceRolled', { value, color: currentPlayer.color, validMoves: [] });
      passTurn(room);
      broadcastState(room, { message: '3x Sechs hintereinander – Zug verfällt!' });
      return;
    }

    const validMoves = computeValidMoves(room.tokens[currentPlayer.color], value);
    room.dice = value;
    room.validMoves = validMoves;
    io.to(room.code).emit('diceRolled', { value, color: currentPlayer.color, validMoves });

    if (validMoves.length === 0) {
      passTurn(room);
      broadcastState(room, { message: `Keine gültigen Züge für ${currentPlayer.name}.` });
    } else {
      broadcastState(room);
    }
  });

  socket.on('moveToken', ({ tokenIndex }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.winner) return;
    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (room.dice === null || !room.validMoves.includes(tokenIndex)) return;

    const diceValue = room.dice;
    const { captured, finished } = applyMove(room, currentPlayer.color, tokenIndex, diceValue);

    if (checkWin(room, currentPlayer.color)) {
      room.winner = currentPlayer.color;
      broadcastState(room, { message: `${currentPlayer.name} hat gewonnen!` });
      return;
    }

    let message = null;
    if (captured) message = `${currentPlayer.name} hat einen Spielstein geschlagen!`;
    else if (finished) message = `${currentPlayer.name} hat einen Stein ins Ziel gebracht!`;

    if (diceValue === 6) {
      extraTurn(room);
    } else {
      passTurn(room);
    }
    broadcastState(room, { message });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (player) player.connected = false;

    if (room.started && !room.winner) {
      io.to(room.code).emit('opponentLeft', { name: player ? player.name : 'Der Gegner' });
    }
    rooms.delete(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Boom Club läuft auf http://localhost:${PORT}`);
});

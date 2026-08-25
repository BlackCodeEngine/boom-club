require('dotenv').config();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Supabase (Postgres + Auth) - persistent accounts, profiles and coin balances
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// No session persistence server-side - every auth call is a one-off request
// on behalf of whichever socket happens to be logging in/registering.
const SUPABASE_CLIENT_OPTS = { auth: { persistSession: false, autoRefreshToken: false } };

let supabase = null; // anon key - regular signUp/signInWithPassword calls
let supabaseAdmin = null; // service_role key - bypasses RLS, manages profiles

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_CLIENT_OPTS);
} else {
  console.warn('[Supabase] SUPABASE_URL/SUPABASE_ANON_KEY fehlen - authRegister/authLogin sind deaktiviert.');
}

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_CLIENT_OPTS);
} else {
  console.warn('[Supabase] SUPABASE_SERVICE_ROLE_KEY fehlt - Profile (Username/Coins) werden nicht serverseitig verwaltet.');
}

// ---------------------------------------------------------------------------
// Board constants (shared 52-cell ring + 6-cell home stretch per color)
// ---------------------------------------------------------------------------
const RING_LENGTH = 52;
const COLORS_ALL = ['red', 'blue', 'yellow', 'green'];
const START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const ALLOWED_STAKES = [500, 1000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
const DEFAULT_STAKE = 1000;
const TURN_TIME_LIMIT_MS = 15000;
const RECONNECT_GRACE_MS = 30000;

function createInitialTokens() {
  const tokens = {};
  COLORS_ALL.forEach((c) => { tokens[c] = [-1, -1, -1, -1]; });
  return tokens;
}

function opponentColorOf(room, color) {
  const other = room.players.find((p) => p.color !== color);
  return other ? other.color : null;
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

// Moves the token one step at a time through every intermediate cell so that
// captures on the way ("Boom-Effekt") are detected, not just on the final cell.
function applyMove(room, color, tokenIndex, diceValue) {
  const tokens = room.tokens[color];
  const d = tokens[tokenIndex];
  const newD = d === -1 ? 0 : d + diceValue;
  const firstStep = d === -1 ? 0 : d + 1;

  const opp = opponentColorOf(room, color);
  const oppTokens = opp ? room.tokens[opp] : null;

  let captured = false;
  if (oppTokens) {
    for (let step = firstStep; step <= newD && step <= 50; step++) {
      const abs = (START_OFFSET[color] + step) % RING_LENGTH;
      if (SAFE_CELLS.has(abs)) continue;
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

  tokens[tokenIndex] = newD;
  return { captured, finished: newD === 56 };
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
    stake: room.stake,
    players: room.players.map((p) => ({ name: p.name, color: p.color, connected: p.connected, coins: p.coins })),
    tokens: room.tokens,
    turn: room.players[room.turnIndex] ? room.players[room.turnIndex].color : null,
    dice: room.dice,
    validMoves: room.validMoves,
    started: room.started,
    winner: room.winner,
    turnDeadline: room.turnDeadline || null,
  };
}

// Hard per-turn timer: if the current player doesn't finish rolling/moving in
// time, their turn is force-skipped so the game never stalls on one player.
function resetTurnTimer(room) {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_TIME_LIMIT_MS;
  room.turnTimerHandle = setTimeout(() => handleTurnTimeout(room), TURN_TIME_LIMIT_MS);
}

function clearTurnTimer(room) {
  if (room.turnTimerHandle) clearTimeout(room.turnTimerHandle);
  room.turnTimerHandle = null;
  room.turnDeadline = null;
}

function handleTurnTimeout(room) {
  if (!room.started || room.winner) return;
  const currentPlayer = room.players[room.turnIndex];
  const name = currentPlayer ? currentPlayer.name : 'Spieler';
  passTurn(room);
  broadcastState(room, { message: `⏱️ Zeit abgelaufen – Zug von ${name} übersprungen!` });
}

function passTurn(room) {
  room.dice = null;
  room.validMoves = [];
  room.sixStreak = 0;
  room.turnIndex = 1 - room.turnIndex;
  resetTurnTimer(room);
}

function extraTurn(room) {
  room.dice = null;
  room.validMoves = [];
  resetTurnTimer(room);
}

function broadcastState(room, extra) {
  io.to(room.code).emit('state', { ...publicState(room), ...(extra || {}) });
}

io.on('connection', (socket) => {
  // --- Supabase Auth (email + password) ---------------------------------------
  socket.on('checkUsernameAvailable', async ({ username }) => {
    const trimmed = (username || '').trim();
    const lookupClient = supabase || supabaseAdmin;
    if (!lookupClient) {
      socket.emit('usernameAvailability', { username: trimmed, available: null, error: 'Supabase nicht konfiguriert.' });
      return;
    }
    if (trimmed.length < 3) {
      socket.emit('usernameAvailability', { username: trimmed, available: false, reason: 'Mindestens 3 Zeichen.' });
      return;
    }

    const { data, error } = await lookupClient
      .from('profiles')
      .select('id')
      .eq('username', trimmed)
      .maybeSingle();

    if (error) {
      socket.emit('usernameAvailability', { username: trimmed, available: null, error: error.message });
      return;
    }
    socket.emit('usernameAvailability', { username: trimmed, available: !data });
  });

  socket.on('authRegister', async ({ email, password, username }) => {
    if (!supabase) {
      socket.emit('authError', 'Supabase ist serverseitig nicht konfiguriert.');
      return;
    }
    const trimmedUsername = (username || '').trim();
    if (!email || !password || !trimmedUsername) {
      socket.emit('authError', 'E-Mail, Benutzername und Passwort werden benötigt.');
      return;
    }
    if (trimmedUsername.length < 3) {
      socket.emit('authError', 'Benutzername muss mindestens 3 Zeichen haben.');
      return;
    }

    // Re-check right before creating the account to shrink the race window
    // between the live availability check and the actual registration.
    if (supabase) {
      const { data: existing, error: lookupError } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', trimmedUsername)
        .maybeSingle();
      if (!lookupError && existing) {
        socket.emit('authError', 'Dieser Benutzername ist bereits vergeben.');
        return;
      }
    }

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      socket.emit('authError', error.message);
      return;
    }

    const user = data.user;
    if (user && supabaseAdmin) {
      const { error: profileError } = await supabaseAdmin.from('profiles').insert({
        id: user.id,
        username: trimmedUsername.slice(0, 24),
        coins: 10000,
      });
      if (profileError) {
        if (profileError.code === '23505' && /username/i.test(profileError.message)) {
          socket.emit('authError', 'Dieser Benutzername wurde gerade eben vergeben - bitte einen anderen wählen.');
          return;
        }
        // Otherwise likely the profile-id-already-exists race - harmless, ignore.
        if (profileError.code !== '23505') {
          console.error('[Supabase] Profil konnte nicht angelegt werden:', profileError.message);
        }
      }
    }

    if (user && data.session) {
      socket.data.userId = user.id;
    }

    socket.emit('authRegistered', {
      userId: user ? user.id : null,
      username: trimmedUsername,
      coins: 10000,
      needsEmailConfirmation: !data.session,
    });
  });

  socket.on('authLogin', async ({ email, password }) => {
    if (!supabase) {
      socket.emit('authError', 'Supabase ist serverseitig nicht konfiguriert.');
      return;
    }
    if (!email || !password) {
      socket.emit('authError', 'E-Mail und Passwort werden benötigt.');
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      socket.emit('authError', error.message);
      return;
    }

    const user = data.user;
    socket.data.userId = user.id;

    let profile = null;
    if (supabaseAdmin) {
      const { data: profileData, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('username, coins')
        .eq('id', user.id)
        .single();
      if (profileError) {
        console.error('[Supabase] Profil konnte nicht geladen werden:', profileError.message);
      } else {
        profile = profileData;
      }
    }

    socket.emit('authLoggedIn', {
      userId: user.id,
      email: user.email,
      username: profile ? profile.username : null,
      coins: profile ? profile.coins : null,
    });
  });

  socket.on('createRoom', ({ name, stake, coins }) => {
    const code = generateRoomCode();
    const playerId = crypto.randomUUID();
    const room = {
      code,
      stake: ALLOWED_STAKES.includes(stake) ? stake : DEFAULT_STAKE,
      players: [{
        id: socket.id,
        playerId,
        userId: socket.data.userId || null,
        name: (name || 'Spieler 1').slice(0, 16),
        color: null,
        connected: true,
        coins: typeof coins === 'number' ? coins : null,
        disconnectTimerHandle: null,
      }],
      turnIndex: 0,
      dice: null,
      validMoves: [],
      sixStreak: 0,
      tokens: createInitialTokens(),
      started: false,
      winner: null,
      turnDeadline: null,
      turnTimerHandle: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('roomCreated', { code, playerId, state: publicState(room) });
  });

  socket.on('joinRoom', ({ code, name, coins }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) {
      socket.emit('errorMsg', 'Raum nicht gefunden.');
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('errorMsg', 'Raum ist bereits voll.');
      return;
    }
    const playerId = crypto.randomUUID();
    room.players.push({
      id: socket.id,
      playerId,
      userId: socket.data.userId || null,
      name: (name || 'Spieler 2').slice(0, 16),
      color: null,
      connected: true,
      coins: typeof coins === 'number' ? coins : null,
      disconnectTimerHandle: null,
    });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('roomJoined', { playerId, state: publicState(room) });
    broadcastState(room);
  });

  socket.on('rejoinRoom', ({ code, playerId }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) {
      socket.emit('rejoinFailed', { reason: 'room_not_found' });
      return;
    }
    const player = room.players.find((p) => p.playerId === playerId);
    if (!player) {
      socket.emit('rejoinFailed', { reason: 'player_not_found' });
      return;
    }

    if (player.disconnectTimerHandle) {
      clearTimeout(player.disconnectTimerHandle);
      player.disconnectTimerHandle = null;
    }
    player.id = socket.id;
    player.connected = true;

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;

    socket.emit('rejoined', { state: publicState(room), color: player.color, stake: room.stake });
    broadcastState(room);
  });

  socket.on('selectColor', ({ color }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.started) return;
    if (!COLORS_ALL.includes(color)) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    const takenByOther = room.players.some((p) => p.id !== socket.id && p.color === color);
    if (takenByOther) {
      socket.emit('errorMsg', 'Diese Farbe ist bereits vergeben.');
      return;
    }

    player.color = color;

    const bothChosen = room.players.length === 2 && room.players.every((p) => p.color);
    if (bothChosen) {
      room.started = true;
      room.turnIndex = 0;
      resetTurnTimer(room);
    }

    socket.emit('colorConfirmed', { color, state: publicState(room) });
    broadcastState(room);
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
    const color = currentPlayer.color;
    const moveInfo = { color, tokenIndex, diceValue };
    const { captured, finished } = applyMove(room, color, tokenIndex, diceValue);

    if (checkWin(room, color)) {
      room.winner = color;
      clearTurnTimer(room);
      broadcastState(room, { message: `${currentPlayer.name} hat gewonnen!`, moveInfo });
      return;
    }

    let message = null;
    if (captured) message = `${currentPlayer.name} hat einen Spielstein geschlagen! 💥`;
    else if (finished) message = `${currentPlayer.name} hat einen Stein ins Ziel gebracht!`;

    if (diceValue === 6) {
      extraTurn(room);
    } else {
      passTurn(room);
    }
    broadcastState(room, { message, moveInfo });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    player.connected = false;
    broadcastState(room);

    // Game already over - no point keeping the room alive for a reconnect.
    if (room.winner) {
      clearTurnTimer(room);
      rooms.delete(code);
      return;
    }

    // Grace period: a short network blip (e.g. phone switching Wi-Fi/mobile
    // data) shouldn't end the game immediately. The room stays alive until
    // the timer runs out, giving the player a chance to reconnect via
    // 'rejoinRoom'. The per-turn timer keeps running independently, so the
    // game doesn't stall even if it was the disconnected player's turn.
    if (player.disconnectTimerHandle) clearTimeout(player.disconnectTimerHandle);
    player.disconnectTimerHandle = setTimeout(() => {
      if (!rooms.has(room.code)) return; // already cleaned up
      if (player.connected) return; // reconnected in the meantime
      clearTurnTimer(room);
      io.to(room.code).emit('opponentLeft', { name: player.name });
      rooms.delete(room.code);
    }, RECONNECT_GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Boom Club läuft auf http://localhost:${PORT}`);
});

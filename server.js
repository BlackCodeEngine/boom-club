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

// Strips a Supabase session down to just the two tokens the client needs to
// persist (in localStorage) and later present back via 'authRestoreSession'.
function sessionPayload(session) {
  return session ? { access_token: session.access_token, refresh_token: session.refresh_token } : null;
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
const BOT_TURN_DELAY_MS = [700, 1500]; // [min, max] "thinking time" before a bot acts

// Diagonal color pairs share a "family"/team in 2v2 - matches the board's
// corner-yard geometry (red top-left / yellow bottom-right, green top-right
// / blue bottom-left), the classic Ludo team convention.
const TEAM_COLORS = { A: ['red', 'yellow'], B: ['green', 'blue'] };

// ---------------------------------------------------------------------------
// XP / level progression (persisted to `profiles`, bonus items in `player_items`)
// ---------------------------------------------------------------------------
const XP_PER_LEVEL = 1000; // XP needed per level - adjust freely
const XP_WIN = 200;
const XP_LOSS = 10;
const LEVEL_UP_COINS_REWARD = 10000;
const ITEM_LEVEL_INTERVAL = 5; // every 5th level grants a free dice

function createInitialTokens() {
  const tokens = {};
  COLORS_ALL.forEach((c) => { tokens[c] = [-1, -1, -1, -1]; });
  return tokens;
}

function teamOfColor(room, color) {
  if (room.mode !== 'mp2v2') return null;
  return TEAM_COLORS.A.includes(color) ? 'A' : 'B';
}

// Every active color that may be captured by / may capture `color`: in
// free-for-all modes that's everyone else, in 2v2 it excludes the teammate.
function enemyColorsOf(room, color) {
  if (room.mode !== 'mp2v2') {
    return room.activeColors.filter((c) => c !== color);
  }
  const myTeam = teamOfColor(room, color);
  return room.activeColors.filter((c) => c !== color && teamOfColor(room, c) !== myTeam);
}

// Rotates to the next player whose color hasn't already finished (all tokens
// home) - lets a 2v2 team keep playing after one of its two colors is done,
// waiting on the teammate, without ever handing that finished color a turn.
function advanceTurn(room) {
  const n = room.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (room.turnIndex + step) % n;
    const candidate = room.players[idx];
    if (candidate.color && !checkWin(room, candidate.color)) {
      room.turnIndex = idx;
      return;
    }
  }
  room.turnIndex = (room.turnIndex + 1) % n;
}

// Adds one bot to a specific free color - used when the host fills an empty
// lobby slot on demand (see the 'addBot' handler), never automatically.
function addBotPlayer(room, color) {
  const botNumber = room.players.filter((p) => p.isBot).length + 1;
  room.players.push({
    id: `bot-${crypto.randomUUID()}`,
    playerId: crypto.randomUUID(),
    userId: null,
    name: `Boom-Bot ${botNumber}`,
    color,
    isBot: true,
    connected: true,
    coins: null,
    disconnectTimerHandle: null,
  });
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

  const enemyColors = enemyColorsOf(room, color);

  let captured = false;
  for (let step = firstStep; step <= newD && step <= 50; step++) {
    const abs = (START_OFFSET[color] + step) % RING_LENGTH;
    if (SAFE_CELLS.has(abs)) continue;
    enemyColors.forEach((enemyColor) => {
      const enemyTokens = room.tokens[enemyColor];
      for (let i = 0; i < enemyTokens.length; i++) {
        if (enemyTokens[i] >= 0 && enemyTokens[i] <= 50) {
          const enemyAbs = (START_OFFSET[enemyColor] + enemyTokens[i]) % RING_LENGTH;
          if (enemyAbs === abs) {
            enemyTokens[i] = -1;
            captured = true;
          }
        }
      }
    });
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
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    stake: room.stake,
    activeColors: room.activeColors,
    players: room.players.map((p) => ({
      name: p.name,
      color: p.color,
      connected: p.connected,
      coins: p.coins,
      isBot: p.isBot,
      team: p.color ? teamOfColor(room, p.color) : null,
    })),
    tokens: room.tokens,
    turn: room.players[room.turnIndex] ? room.players[room.turnIndex].color : null,
    dice: room.dice,
    validMoves: room.validMoves,
    started: room.started,
    winner: room.winner,
    winnerTeam: room.winnerTeam || null,
    turnDeadline: room.turnDeadline || null,
  };
}

// Hard per-turn timer: if the current player doesn't finish rolling/moving in
// time, their turn is force-skipped so the game never stalls on one player.
// Also the single choke point for "a new turn has begun" - covers game start
// (selectColor) and every passTurn/extraTurn - so it doubles as the hook that
// kicks off a bot's automatic turn.
function resetTurnTimer(room) {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_TIME_LIMIT_MS;
  room.turnTimerHandle = setTimeout(() => handleTurnTimeout(room), TURN_TIME_LIMIT_MS);
  scheduleBotTurnIfNeeded(room);
}

// Starts the game the moment every seat (human or bot) has a color - shared
// by a human's own pick and the host filling a seat with a bot.
function maybeStartGame(room) {
  const allChosen = room.players.length === room.maxPlayers && room.players.every((p) => p.color);
  if (!allChosen) return;
  room.started = true;
  room.turnIndex = 0;
  room.activeColors = room.players.map((p) => p.color);
  resetTurnTimer(room);
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
  advanceTurn(room);
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

// If it's now a bot's turn, roll for it after a short "thinking" delay - the
// stale-timer guards re-check room/turn state since a human could finish the
// game (or the bot's turn could pass again) before the timeout fires.
function scheduleBotTurnIfNeeded(room) {
  if (!room.started || room.winner) return;
  const player = room.players[room.turnIndex];
  if (!player || !player.isBot) return;
  const [minDelay, maxDelay] = BOT_TURN_DELAY_MS;
  const delay = minDelay + Math.random() * (maxDelay - minDelay);
  setTimeout(() => {
    if (!rooms.has(room.code) || room.winner || !room.started) return;
    if (room.players[room.turnIndex] !== player) return;
    if (room.dice !== null) return; // already rolled (shouldn't happen, but stay safe)
    handleRollDice(room, player);
  }, delay);
}

// Mirrors the client's solo-mode AI heuristic (see aiPickMove in app.js):
// prefer a capturing move, then leaving base on a 6, else the token that's
// furthest along.
function botPickMove(room, player, diceValue) {
  const color = player.color;
  const tokens = room.tokens[color];
  const validMoves = room.validMoves;
  const enemyColors = enemyColorsOf(room, color);

  function wouldCapture(tokenIndex) {
    const d = tokens[tokenIndex];
    const newD = d === -1 ? 0 : d + diceValue;
    if (newD < 0 || newD > 50) return false;
    const abs = (START_OFFSET[color] + newD) % RING_LENGTH;
    if (SAFE_CELLS.has(abs)) return false;
    return enemyColors.some((ec) => room.tokens[ec].some(
      (od) => od >= 0 && od <= 50 && (START_OFFSET[ec] + od) % RING_LENGTH === abs
    ));
  }

  const capturing = validMoves.filter(wouldCapture);
  if (capturing.length) return capturing[0];

  if (diceValue === 6) {
    const enteringBase = validMoves.filter((i) => tokens[i] === -1);
    if (enteringBase.length) return enteringBase[0];
  }

  return [...validMoves].sort((a, b) => tokens[b] - tokens[a])[0];
}

function levelForXp(xp) {
  return Math.floor(xp / XP_PER_LEVEL) + 1;
}

// Credits XP to a logged-in player's profile after an online game, applies
// any level-up coin bonus / free-dice milestone, and tells that player's
// socket about it via 'xpGained'. Guests/bots (no userId) are skipped.
async function awardXp(targetSocketId, userId, xpEarned) {
  if (!supabaseAdmin || !userId) return;

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('xp, level, coins')
    .eq('id', userId)
    .single();
  if (error || !profile) {
    console.error('[Supabase] Profil für XP-Update nicht gefunden:', error && error.message);
    return;
  }

  const oldLevel = profile.level || 1;
  const newXp = (profile.xp || 0) + xpEarned;
  const newLevel = levelForXp(newXp);
  const levelsGained = Math.max(0, newLevel - oldLevel);
  const leveledUp = levelsGained > 0;
  const coinsAwarded = levelsGained * LEVEL_UP_COINS_REWARD;
  const newCoins = (profile.coins || 0) + coinsAwarded;

  const { error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({ xp: newXp, level: newLevel, coins: newCoins })
    .eq('id', userId);
  if (updateError) {
    console.error('[Supabase] XP-Update fehlgeschlagen:', updateError.message);
    return;
  }

  // Grants a free dice for every 5th-level milestone crossed by this XP gain.
  let itemAwarded = null;
  for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
    if (lvl % ITEM_LEVEL_INTERVAL !== 0) continue;
    itemAwarded = `Standard-Würfel Level ${lvl}`;
    const { error: itemError } = await supabaseAdmin.from('player_items').insert({
      user_id: userId,
      item_type: 'dice',
      item_name: itemAwarded,
    });
    if (itemError) {
      console.error('[Supabase] Item konnte nicht vergeben werden:', itemError.message);
    }
  }

  io.to(targetSocketId).emit('xpGained', {
    xpEarned,
    newXp,
    newLevel,
    leveledUp,
    coinsAwarded,
    itemAwarded,
  });
}

// Shared by the 'rollDice' socket handler and the bot turn scheduler so
// bots and humans roll through the exact same rules.
function handleRollDice(room, player) {
  const value = 1 + Math.floor(Math.random() * 6);
  room.sixStreak = value === 6 ? room.sixStreak + 1 : 0;

  if (room.sixStreak === 3) {
    room.dice = value;
    io.to(room.code).emit('diceRolled', { value, color: player.color, validMoves: [] });
    passTurn(room);
    broadcastState(room, { message: '3x Sechs hintereinander – Zug verfällt!' });
    return;
  }

  const validMoves = computeValidMoves(room.tokens[player.color], value);
  room.dice = value;
  room.validMoves = validMoves;
  io.to(room.code).emit('diceRolled', { value, color: player.color, validMoves });

  if (validMoves.length === 0) {
    passTurn(room);
    broadcastState(room, { message: `Keine gültigen Züge für ${player.name}.` });
    return;
  }

  broadcastState(room);

  if (player.isBot) {
    const [minDelay, maxDelay] = BOT_TURN_DELAY_MS;
    const delay = minDelay + Math.random() * (maxDelay - minDelay);
    setTimeout(() => {
      if (!rooms.has(room.code) || room.winner || room.dice !== value) return;
      if (room.players[room.turnIndex] !== player) return;
      handleMoveToken(room, player, botPickMove(room, player, value));
    }, delay);
  }
}

// Shared by the 'moveToken' socket handler and the bot turn scheduler.
function handleMoveToken(room, player, tokenIndex) {
  if (room.dice === null || !room.validMoves.includes(tokenIndex)) return;

  const diceValue = room.dice;
  const color = player.color;
  const moveInfo = { color, tokenIndex, diceValue };
  const { captured, finished } = applyMove(room, color, tokenIndex, diceValue);

  if (checkWin(room, color)) {
    const team = teamOfColor(room, color);
    const teammateColor = team
      ? room.activeColors.find((c) => c !== color && teamOfColor(room, c) === team)
      : null;
    const teamDone = !teammateColor || checkWin(room, teammateColor);

    if (teamDone) {
      room.winner = color;
      room.winnerTeam = team;
      clearTurnTimer(room);
      const winningColors = teammateColor ? [color, teammateColor] : [color];
      broadcastState(room, { message: `${player.name} hat gewonnen!`, moveInfo });

      room.players.forEach((p) => {
        if (!p.userId) return;
        awardXp(p.id, p.userId, winningColors.includes(p.color) ? XP_WIN : XP_LOSS);
      });
      return;
    }
    // This color is finished but the teammate isn't yet - the game keeps
    // going; advanceTurn() will skip this color's future turns automatically.
  }

  let message = null;
  if (captured) message = `${player.name} hat einen Spielstein geschlagen! 💥`;
  else if (finished) message = `${player.name} hat einen Stein ins Ziel gebracht!`;

  if (diceValue === 6) {
    extraTurn(room);
  } else {
    passTurn(room);
  }
  broadcastState(room, { message, moveInfo });
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
      level: 1,
      xp: 0,
      needsEmailConfirmation: !data.session,
      session: sessionPayload(data.session),
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
        .select('username, coins, level, xp')
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
      level: profile ? profile.level : null,
      xp: profile ? profile.xp : null,
      session: sessionPayload(data.session),
    });
  });

  // Restores a login after a page reload: validates the access_token the
  // client saved in localStorage, refreshing it via the refresh_token if it
  // has expired, so the player doesn't get bounced back to the login screen.
  socket.on('authRestoreSession', async ({ access_token, refresh_token } = {}) => {
    if (!supabase) {
      socket.emit('authRestoreFailed', 'Supabase ist serverseitig nicht konfiguriert.');
      return;
    }
    if (!access_token || !refresh_token) {
      socket.emit('authRestoreFailed', 'Keine gültige Sitzung gefunden.');
      return;
    }

    let user = null;
    let session = { access_token, refresh_token };

    const { data: userData } = await supabase.auth.getUser(access_token);
    if (userData && userData.user) {
      user = userData.user;
    } else {
      const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession({ refresh_token });
      if (refreshError || !refreshData.session) {
        socket.emit('authRestoreFailed', 'Sitzung abgelaufen - bitte erneut einloggen.');
        return;
      }
      user = refreshData.user;
      session = sessionPayload(refreshData.session);
    }

    socket.data.userId = user.id;

    let profile = null;
    if (supabaseAdmin) {
      const { data: profileData, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('username, coins, level, xp')
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
      level: profile ? profile.level : null,
      xp: profile ? profile.xp : null,
      session,
    });
  });

  socket.on('createRoom', ({ name, stake, coins, mode }) => {
    const resolvedMode = mode === 'mp2v2' ? 'mp2v2' : 'mp1v1';
    const maxPlayers = resolvedMode === 'mp2v2' ? 4 : 2;

    const code = generateRoomCode();
    const playerId = crypto.randomUUID();
    const room = {
      code,
      mode: resolvedMode,
      maxPlayers,
      stake: ALLOWED_STAKES.includes(stake) ? stake : DEFAULT_STAKE,
      players: [{
        id: socket.id,
        playerId,
        userId: socket.data.userId || null,
        name: (name || 'Spieler 1').slice(0, 16),
        color: null,
        isBot: false,
        connected: true,
        coins: typeof coins === 'number' ? coins : null,
        disconnectTimerHandle: null,
      }],
      turnIndex: 0,
      dice: null,
      validMoves: [],
      sixStreak: 0,
      tokens: createInitialTokens(),
      activeColors: [],
      started: false,
      winner: null,
      winnerTeam: null,
      turnDeadline: null,
      turnTimerHandle: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('roomCreated', { code, playerId, isHost: true, state: publicState(room) });
  });

  socket.on('joinRoom', ({ code, name, coins }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) {
      socket.emit('errorMsg', 'Raum nicht gefunden.');
      return;
    }
    if (room.players.length >= room.maxPlayers) {
      socket.emit('errorMsg', 'Raum ist bereits voll.');
      return;
    }
    const playerId = crypto.randomUUID();
    room.players.push({
      id: socket.id,
      playerId,
      userId: socket.data.userId || null,
      name: (name || `Spieler ${room.players.length + 1}`).slice(0, 16),
      color: null,
      isBot: false,
      connected: true,
      coins: typeof coins === 'number' ? coins : null,
      disconnectTimerHandle: null,
    });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('roomJoined', { playerId, isHost: false, state: publicState(room) });
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

    const isHost = room.players[0] === player;
    socket.emit('rejoined', { state: publicState(room), color: player.color, stake: room.stake, isHost });
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
    maybeStartGame(room);

    socket.emit('colorConfirmed', { color, state: publicState(room) });
    broadcastState(room);
  });

  // Lets the host fill a free color slot with a bot on demand (e.g. not
  // enough friends showed up) - never automatic, and only the room's
  // creator may do it.
  socket.on('addBot', ({ color }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.started) return;
    if (!COLORS_ALL.includes(color)) return;
    const isHost = room.players[0] && room.players[0].id === socket.id;
    if (!isHost) return;
    if (room.players.length >= room.maxPlayers) return;
    const takenByOther = room.players.some((p) => p.color === color);
    if (takenByOther) {
      socket.emit('errorMsg', 'Diese Farbe ist bereits vergeben.');
      return;
    }

    addBotPlayer(room, color);
    maybeStartGame(room);
    broadcastState(room);
  });

  socket.on('rollDice', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.winner) return;
    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (room.dice !== null) return; // already rolled, waiting for a move
    handleRollDice(room, currentPlayer);
  });

  socket.on('moveToken', ({ tokenIndex }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.winner) return;
    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    handleMoveToken(room, currentPlayer, tokenIndex);
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

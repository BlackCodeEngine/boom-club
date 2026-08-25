// ---------------------------------------------------------------------------
// Boom Club - client-side board rendering, socket wiring & solo AI
// ---------------------------------------------------------------------------
const socket = io();

// --- Board geometry (15x15 grid, matches server's ring/home-stretch model) --
const GRID = 15;
const RING_PATH = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
  [0, 7],
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
  [7, 14],
  [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
  [14, 7],
  [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  [7, 0],
  [6, 0],
];
const HOME_PATHS = {
  red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
};
const BASE_SPOTS = {
  red: [[1, 1], [1, 4], [4, 1], [4, 4]],
  yellow: [[10, 10], [10, 13], [13, 10], [13, 13]],
};
const RING_LENGTH = 52;
const START_OFFSET = { red: 0, yellow: 26 };
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const COLOR_HEX = { red: '#ef4444', yellow: '#facc15' };

function otherColor(color) {
  return color === 'red' ? 'yellow' : 'red';
}

// --- Player name (persisted) -------------------------------------------------
const NAME_KEY = 'boomclub_playerName';
function getPlayerName() {
  return (localStorage.getItem(NAME_KEY) || '').trim();
}
function setPlayerName(name) {
  localStorage.setItem(NAME_KEY, name.trim());
}

// --- DOM references ---------------------------------------------------------
const screens = {
  mainMenu: document.getElementById('main-menu'),
  onlineMenu: document.getElementById('online-menu'),
  settings: document.getElementById('settings'),
  waiting: document.getElementById('waiting'),
  game: document.getElementById('game'),
};
const roomCodeInput = document.getElementById('room-code-input');
const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const landingError = document.getElementById('landing-error');
const waitingCode = document.getElementById('waiting-code');
const btnCopyCode = document.getElementById('btn-copy-code');
const btnWaitingCancel = document.getElementById('btn-waiting-cancel');
const gameRoomLabel = document.getElementById('game-room-label');
const gameRoomCode = document.getElementById('game-room-code');
const gameModeLabel = document.getElementById('game-mode-label');
const nameRedEl = document.getElementById('name-red');
const nameYellowEl = document.getElementById('name-yellow');
const turnBanner = document.getElementById('turn-banner');
const canvas = document.getElementById('board-canvas');
const ctx = canvas.getContext('2d');
const btnDice = document.getElementById('btn-dice');
const diceFace = document.getElementById('dice-face');
const messageToast = document.getElementById('message-toast');
const gameoverSection = document.getElementById('gameover');
const gameoverText = document.getElementById('gameover-text');
const btnRestart = document.getElementById('btn-restart');

const btnNavSolo = document.getElementById('btn-nav-solo');
const btnNavOnline = document.getElementById('btn-nav-online');
const btnNavShop = document.getElementById('btn-nav-shop');
const btnNavSettings = document.getElementById('btn-nav-settings');
const btnOnlineBack = document.getElementById('btn-online-back');
const btnSettingsBack = document.getElementById('btn-settings-back');
const settingsNameInput = document.getElementById('settings-name-input');
const btnBackToMenu = document.getElementById('btn-back-to-menu');

const CELL = canvas.width / GRID;

let myColor = null;
let gameMode = null; // 'solo' | 'online'
let currentState = null;
let localState = null; // only used in solo mode
let toastTimer = null;

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

function showToast(msg) {
  if (!msg) return;
  messageToast.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { messageToast.textContent = ''; }, 3500);
}

// --- Main menu navigation -----------------------------------------------------
settingsNameInput.value = getPlayerName();
settingsNameInput.addEventListener('input', () => setPlayerName(settingsNameInput.value));

btnNavSolo.addEventListener('click', () => startSoloGame());
btnNavOnline.addEventListener('click', () => {
  landingError.textContent = '';
  showScreen('onlineMenu');
});
btnNavShop.addEventListener('click', () => {}); // disabled - coming soon
btnNavSettings.addEventListener('click', () => showScreen('settings'));
btnOnlineBack.addEventListener('click', () => showScreen('mainMenu'));
btnSettingsBack.addEventListener('click', () => showScreen('mainMenu'));
btnWaitingCancel.addEventListener('click', () => leaveAndGoToMenu());
btnBackToMenu.addEventListener('click', () => leaveAndGoToMenu());

function leaveAndGoToMenu() {
  if (gameMode === 'online' && socket.connected) {
    socket.disconnect();
  }
  gameMode = null;
  myColor = null;
  currentState = null;
  localState = null;
  gameoverSection.classList.add('hidden');
  messageToast.textContent = '';
  drawBoard(null);
  showScreen('mainMenu');
}

function ensureConnected() {
  if (!socket.connected) socket.connect();
}

// --- Online menu actions --------------------------------------------------------
btnCreate.addEventListener('click', () => {
  landingError.textContent = '';
  ensureConnected();
  gameMode = 'online';
  socket.emit('createRoom', { name: getPlayerName() });
});

btnJoin.addEventListener('click', () => {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) {
    landingError.textContent = 'Bitte einen Raum-Code eingeben.';
    return;
  }
  landingError.textContent = '';
  ensureConnected();
  gameMode = 'online';
  socket.emit('joinRoom', { code, name: getPlayerName() });
});

btnCopyCode.addEventListener('click', () => {
  navigator.clipboard?.writeText(waitingCode.textContent.trim());
  btnCopyCode.textContent = '✅ Kopiert!';
  setTimeout(() => { btnCopyCode.textContent = '📋 Code kopieren'; }, 1500);
});

btnRestart.addEventListener('click', () => window.location.reload());

// --- Socket events (online multiplayer) ---------------------------------------
socket.on('roomCreated', ({ code, color, state }) => {
  myColor = color;
  waitingCode.textContent = code;
  showScreen('waiting');
  applyState(state);
});

socket.on('roomJoined', ({ color, state }) => {
  myColor = color;
  applyState(state);
});

socket.on('gameStart', (state) => {
  showScreen('game');
  applyState(state);
});

socket.on('diceRolled', ({ value }) => {
  animateDiceRoll(value);
});

socket.on('state', (state) => {
  applyState(state);
  if (state.message) showToast(state.message);
});

socket.on('opponentLeft', ({ name }) => {
  gameoverText.textContent = `${name} hat das Spiel verlassen.`;
  gameoverSection.classList.remove('hidden');
});

socket.on('errorMsg', (msg) => {
  landingError.textContent = msg;
});

// --- Shared dice animation -----------------------------------------------------
function animateDiceRoll(finalValue, onDone) {
  diceFace.classList.add('dice-rolling');
  let ticks = 0;
  const spin = setInterval(() => {
    diceFace.textContent = String(1 + Math.floor(Math.random() * 6));
    ticks++;
    if (ticks > 6) {
      clearInterval(spin);
      diceFace.classList.remove('dice-rolling');
      diceFace.textContent = finalValue;
      if (onDone) onDone();
    }
  }, 60);
}

// --- Shared render function (used by both online state & local solo state) ----
function applyState(state) {
  currentState = state;

  if (gameMode === 'solo') {
    gameModeLabel.textContent = 'Solo vs. KI';
    gameRoomLabel.textContent = 'Modus:';
    gameRoomCode.textContent = 'Solo';
  } else {
    gameModeLabel.textContent = 'Online Multiplayer';
    gameRoomLabel.textContent = 'Raum:';
    gameRoomCode.textContent = state.code;
  }

  const redPlayer = state.players.find((p) => p.color === 'red');
  const yellowPlayer = state.players.find((p) => p.color === 'yellow');
  nameRedEl.textContent = redPlayer ? redPlayer.name : 'Rot';
  nameYellowEl.textContent = yellowPlayer ? yellowPlayer.name : 'Gelb';

  if (state.started) {
    showScreen('game');
  }

  const isMyTurn = state.turn === myColor;
  btnDice.disabled = !(isMyTurn && state.dice === null && !state.winner);

  if (state.winner) {
    const winnerName = state.winner === 'red' ? nameRedEl.textContent : nameYellowEl.textContent;
    gameoverText.textContent = `🎉 ${winnerName} (${state.winner === 'red' ? 'Rot' : 'Gelb'}) gewinnt!`;
    gameoverSection.classList.remove('hidden');
  }

  updateTurnBanner(state);
  drawBoard(state);
}

function updateTurnBanner(state) {
  if (state.winner) {
    turnBanner.textContent = 'Spiel beendet';
    turnBanner.className = 'w-full text-center py-2 rounded-xl font-bold text-lg bg-white/10 border border-white/20';
    return;
  }
  const isMyTurn = state.turn === myColor;
  const label = state.turn === 'red' ? 'Rot' : 'Gelb';
  turnBanner.textContent = isMyTurn ? '🎲 Du bist am Zug!' : `Warte auf ${label}...`;
  turnBanner.className = 'w-full text-center py-2 rounded-xl font-bold text-lg border transition-colors ' +
    (isMyTurn
      ? 'bg-gradient-to-r from-emerald-500/80 to-teal-400/80 border-emerald-300'
      : 'bg-white/10 border-white/20');
}

// --- Dice button --------------------------------------------------------------
btnDice.addEventListener('click', () => {
  if (btnDice.disabled) return;
  if (gameMode === 'solo') {
    localRollDice();
  } else {
    socket.emit('rollDice');
  }
});

// ===============================================================================
// SOLO MODE - local game engine + simple AI opponent (mirrors server rules)
// ===============================================================================
function computeValidMoves(tokens, diceValue) {
  const moves = [];
  tokens.forEach((d, i) => {
    if (d === -1) {
      if (diceValue === 6) moves.push(i);
      return;
    }
    if (d === 56) return;
    if (d + diceValue <= 56) moves.push(i);
  });
  return moves;
}

function applyMove(state, color, tokenIndex, diceValue) {
  const tokens = state.tokens[color];
  const d = tokens[tokenIndex];
  const newD = d === -1 ? 0 : d + diceValue;
  tokens[tokenIndex] = newD;

  let captured = false;
  if (newD >= 0 && newD <= 50) {
    const abs = (START_OFFSET[color] + newD) % RING_LENGTH;
    if (!SAFE_CELLS.has(abs)) {
      const opp = otherColor(color);
      const oppTokens = state.tokens[opp];
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

  return { captured, finished: newD === 56 };
}

function checkWin(state, color) {
  return state.tokens[color].every((d) => d === 56);
}

function startSoloGame() {
  gameMode = 'solo';
  myColor = 'red';
  localState = {
    code: 'SOLO',
    players: [
      { name: getPlayerName() || 'Du', color: 'red' },
      { name: 'Boom-Bot', color: 'yellow' },
    ],
    turn: 'red',
    dice: null,
    validMoves: [],
    sixStreak: 0,
    tokens: { red: [-1, -1, -1, -1], yellow: [-1, -1, -1, -1] },
    started: true,
    winner: null,
  };
  gameoverSection.classList.add('hidden');
  messageToast.textContent = '';
  showScreen('game');
  applyState(localState);
}

function localPassTurn() {
  localState.dice = null;
  localState.validMoves = [];
  localState.sixStreak = 0;
  localState.turn = otherColor(localState.turn);
}

function localExtraTurn() {
  localState.dice = null;
  localState.validMoves = [];
}

function playerLabel(color) {
  const p = localState.players.find((pl) => pl.color === color);
  return p ? p.name : (color === 'red' ? 'Rot' : 'Gelb');
}

function localRollDice() {
  if (gameMode !== 'solo' || !localState || localState.winner || localState.dice !== null) return;
  const color = localState.turn;
  const value = 1 + Math.floor(Math.random() * 6);

  animateDiceRoll(value, () => {
    localState.sixStreak = value === 6 ? localState.sixStreak + 1 : 0;

    if (localState.sixStreak === 3) {
      localState.dice = value;
      localPassTurn();
      applyState(localState);
      showToast(`3x Sechs hintereinander – Zug von ${playerLabel(otherColor(localState.turn))} verfällt!`);
      maybeScheduleAiTurn();
      return;
    }

    const validMoves = computeValidMoves(localState.tokens[color], value);
    localState.dice = value;
    localState.validMoves = validMoves;

    if (validMoves.length === 0) {
      applyState(localState);
      const name = playerLabel(color);
      localPassTurn();
      applyState(localState);
      showToast(`Keine gültigen Züge für ${name}.`);
      maybeScheduleAiTurn();
      return;
    }

    applyState(localState);
    if (color === 'yellow') {
      setTimeout(() => aiMakeMove(), 700 + Math.random() * 600);
    }
  });
}

function localMoveToken(tokenIndex) {
  if (gameMode !== 'solo' || !localState || localState.winner) return;
  const color = localState.turn;
  if (localState.dice === null || !localState.validMoves.includes(tokenIndex)) return;

  const diceValue = localState.dice;
  const { captured, finished } = applyMove(localState, color, tokenIndex, diceValue);

  if (checkWin(localState, color)) {
    localState.winner = color;
    localState.dice = null;
    localState.validMoves = [];
    applyState(localState);
    showToast(`${playerLabel(color)} hat gewonnen!`);
    return;
  }

  let message = null;
  if (captured) message = `${playerLabel(color)} hat einen Spielstein geschlagen!`;
  else if (finished) message = `${playerLabel(color)} hat einen Stein ins Ziel gebracht!`;

  if (diceValue === 6) {
    localExtraTurn();
  } else {
    localPassTurn();
  }

  applyState(localState);
  if (message) showToast(message);
  maybeScheduleAiTurn();
}

function maybeScheduleAiTurn() {
  if (gameMode !== 'solo' || !localState || localState.winner) return;
  if (localState.turn !== 'yellow' || localState.dice !== null) return;
  setTimeout(() => {
    if (gameMode === 'solo' && localState && !localState.winner && localState.turn === 'yellow' && localState.dice === null) {
      localRollDice();
    }
  }, 1000 + Math.random() * 1000);
}

function aiPickMove(validMoves, tokens, oppTokens, diceValue, color) {
  const opp = otherColor(color);

  function wouldCapture(tokenIndex) {
    const d = tokens[tokenIndex];
    const newD = d === -1 ? 0 : d + diceValue;
    if (newD < 0 || newD > 50) return false;
    const abs = (START_OFFSET[color] + newD) % RING_LENGTH;
    if (SAFE_CELLS.has(abs)) return false;
    return oppTokens.some((od) => od >= 0 && od <= 50 && (START_OFFSET[opp] + od) % RING_LENGTH === abs);
  }

  const capturing = validMoves.filter(wouldCapture);
  if (capturing.length) return capturing[0];

  if (diceValue === 6) {
    const enteringBase = validMoves.filter((i) => tokens[i] === -1);
    if (enteringBase.length) return enteringBase[0];
  }

  const sorted = [...validMoves].sort((a, b) => tokens[b] - tokens[a]);
  return sorted[0];
}

function aiMakeMove() {
  if (gameMode !== 'solo' || !localState || localState.winner) return;
  if (localState.turn !== 'yellow' || localState.dice === null) return;
  const idx = aiPickMove(localState.validMoves, localState.tokens.yellow, localState.tokens.red, localState.dice, 'yellow');
  localMoveToken(idx);
}

// --- Board drawing --------------------------------------------------------------
function cellRect(row, col) {
  return { x: col * CELL, y: row * CELL, w: CELL, h: CELL };
}

function drawCell(row, col, fill, opts = {}) {
  const { x, y, w, h } = cellRect(row, col);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = opts.border || 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function drawBoard(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  ctx.fillStyle = '#1e1b4b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Corner yards (6x6) - red top-left, yellow bottom-right active; others decorative
  drawYard(0, 0, '#7f1d1d', '#fecaca');       // red yard
  drawYard(0, 9, '#334155', '#94a3b8');       // unused (top-right)
  drawYard(9, 9, '#78350f', '#fde68a');       // yellow yard
  drawYard(9, 0, '#334155', '#94a3b8');       // unused (bottom-left)

  // Ring path cells
  RING_PATH.forEach(([r, c], idx) => {
    const isSafe = SAFE_CELLS.has(idx);
    const isRedStart = idx === START_OFFSET.red;
    const isYellowStart = idx === START_OFFSET.yellow;
    let fill = '#f8fafc';
    if (isRedStart) fill = '#fca5a5';
    if (isYellowStart) fill = '#fde047';
    drawCell(r, c, fill);
    if (isSafe) {
      const { x, y, w, h } = cellRect(r, c);
      ctx.fillStyle = 'rgba(99,102,241,0.55)';
      ctx.font = `${w * 0.55}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('★', x + w / 2, y + h / 2 + 1);
    }
  });

  // Home stretch cells
  HOME_PATHS.red.forEach(([r, c]) => drawCell(r, c, '#fca5a5', { border: 'rgba(127,29,29,0.4)' }));
  HOME_PATHS.yellow.forEach(([r, c]) => drawCell(r, c, '#fde047', { border: 'rgba(120,53,15,0.4)' }));

  // Center home triangle
  drawCenter();

  // Base slots (dashed circles) for waiting tokens
  COLORS().forEach((color) => {
    BASE_SPOTS[color].forEach(([r, c]) => {
      const { x, y, w, h } = cellRect(r, c);
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 2;
      ctx.arc(x + w / 2, y + h / 2, w * 0.32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  });

  if (state) drawTokens(state);
}

function COLORS() { return ['red', 'yellow']; }

function drawYard(rowStart, colStart, bg, accent) {
  const { x, y } = cellRect(rowStart, colStart);
  const size = CELL * 6;
  const grad = ctx.createLinearGradient(x, y, x + size, y + size);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, accent);
  ctx.fillStyle = grad;
  roundRect(ctx, x + 4, y + 4, size - 8, size - 8, 18);
  ctx.fill();
}

function roundRect(context, x, y, w, h, r) {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

function drawCenter() {
  const cx = 7.5 * CELL;
  const cy = 7.5 * CELL;
  const half = 1.5 * CELL;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy - half);
  ctx.lineTo(cx + half, cy);
  ctx.lineTo(cx, cy + half);
  ctx.lineTo(cx - half, cy);
  ctx.closePath();
  const grad = ctx.createLinearGradient(cx - half, cy - half, cx + half, cy + half);
  grad.addColorStop(0, COLOR_HEX.red);
  grad.addColorStop(1, COLOR_HEX.yellow);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = `${CELL * 1.4}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🏆', cx, cy + 2);
  ctx.restore();
}

// --- Token positioning & drawing -----------------------------------------------
function tokenCell(color, dist) {
  if (dist === -1) return null; // handled separately via base slot
  if (dist <= 50) {
    const ringIdx = (START_OFFSET[color] + dist) % 52;
    return RING_PATH[ringIdx];
  }
  const homeIdx = Math.min(dist - 51, 5);
  return HOME_PATHS[color][homeIdx];
}

function drawTokens(state) {
  // group tokens by pixel cell so we can offset overlapping ones
  const groups = new Map();

  COLORS().forEach((color) => {
    (state.tokens[color] || []).forEach((dist, idx) => {
      let row, col;
      if (dist === -1) {
        [row, col] = BASE_SPOTS[color][idx];
      } else {
        [row, col] = tokenCell(color, dist);
      }
      const key = `${row}-${col}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ color, idx, dist });
    });
  });

  const isMyTurn = state.turn === myColor;
  const canMove = isMyTurn && state.dice !== null && state.validMoves.length > 0;

  groups.forEach((tokens, key) => {
    const [row, col] = key.split('-').map(Number);
    const { x, y, w, h } = cellRect(row, col);
    const n = tokens.length;
    tokens.forEach((t, i) => {
      let ox = 0, oy = 0;
      if (n > 1) {
        const spread = w * 0.22;
        const positions = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        const [px, py] = positions[i % 4];
        ox = px * spread * 0.5;
        oy = py * spread * 0.5;
      }
      const cx = x + w / 2 + ox;
      const cy = y + h / 2 + oy;
      const radius = n > 1 ? w * 0.2 : w * 0.32;

      const highlight = canMove && t.color === myColor && state.validMoves.includes(t.idx);

      if (highlight) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fill();
        ctx.restore();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = COLOR_HEX[t.color];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = t.color === 'red' ? '#7f1d1d' : '#854d0e';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx - radius * 0.3, cy - radius * 0.3, radius * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fill();
    });
  });

  // store hitboxes for click detection (rebuilt each draw)
  buildHitboxes(groups);
}

let hitboxes = [];
function buildHitboxes(groups) {
  hitboxes = [];
  groups.forEach((tokens, key) => {
    const [row, col] = key.split('-').map(Number);
    const { x, y, w, h } = cellRect(row, col);
    const n = tokens.length;
    tokens.forEach((t, i) => {
      let ox = 0, oy = 0;
      if (n > 1) {
        const spread = w * 0.22;
        const positions = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        const [px, py] = positions[i % 4];
        ox = px * spread * 0.5;
        oy = py * spread * 0.5;
      }
      const cx = x + w / 2 + ox;
      const cy = y + h / 2 + oy;
      const radius = n > 1 ? w * 0.2 : w * 0.32;
      hitboxes.push({ cx, cy, radius: radius + 6, color: t.color, idx: t.idx });
    });
  });
}

canvas.addEventListener('click', (evt) => {
  if (!currentState || currentState.winner) return;
  if (currentState.turn !== myColor || currentState.dice === null) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const mx = (evt.clientX - rect.left) * scaleX;
  const my = (evt.clientY - rect.top) * scaleY;

  let best = null;
  let bestDist = Infinity;
  hitboxes.forEach((hb) => {
    if (hb.color !== myColor) return;
    if (!currentState.validMoves.includes(hb.idx)) return;
    const d = Math.hypot(mx - hb.cx, my - hb.cy);
    if (d <= hb.radius && d < bestDist) {
      bestDist = d;
      best = hb;
    }
  });

  if (!best) return;

  if (gameMode === 'solo') {
    localMoveToken(best.idx);
  } else {
    socket.emit('moveToken', { tokenIndex: best.idx });
  }
});

// initial empty draw
drawBoard(null);
showScreen('mainMenu');

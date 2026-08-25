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
  green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
  yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
  blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
};
const BASE_SPOTS = {
  red: [[1, 1], [1, 4], [4, 1], [4, 4]],
  green: [[1, 10], [1, 13], [4, 10], [4, 13]],
  yellow: [[10, 10], [10, 13], [13, 10], [13, 13]],
  blue: [[10, 1], [10, 4], [13, 1], [13, 4]],
};
const RING_LENGTH = 52;
const START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const COLOR_HEX = { red: '#ef4444', blue: '#3b82f6', yellow: '#facc15', green: '#22c55e' };
const COLOR_DARK = { red: '#7f1d1d', blue: '#1e3a8a', yellow: '#854d0e', green: '#14532d' };
const COLOR_LABELS = { red: 'Rot', blue: 'Blau', yellow: 'Gelb', green: 'Grün' };
const ALL_COLORS = ['red', 'blue', 'yellow', 'green'];

function COLORS() { return ALL_COLORS; }

function opponentColorOf(state, color) {
  const other = state.players.find((p) => p.color !== color);
  return other ? other.color : null;
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
  colorSelect: document.getElementById('color-select'),
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
const namePlayer1El = document.getElementById('name-player1');
const namePlayer2El = document.getElementById('name-player2');
const dotPlayer1El = document.getElementById('dot-player1');
const dotPlayer2El = document.getElementById('dot-player2');
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

const btnColorSelectBack = document.getElementById('btn-colorselect-back');
const colorSelectSubtitle = document.getElementById('color-select-subtitle');
const colorCardsEl = document.getElementById('color-cards');
const colorSelectError = document.getElementById('color-select-error');

const CELL = canvas.width / GRID;

let myColor = null;
let gameMode = null; // 'solo' | 'solo-pending' | 'online'
let colorSelectContext = null; // 'solo' | 'online'
let currentState = null;
let localState = null; // only used in solo mode
let toastTimer = null;
let isAnimating = false;
let animatingTokenInfo = null; // { color, idx, cell: [row, col] }

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

btnNavSolo.addEventListener('click', () => {
  gameMode = 'solo-pending';
  colorSelectSubtitle.textContent = 'Der Boom-Bot bekommt automatisch eine der übrigen Farben.';
  openColorSelect('solo', []);
});
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
btnColorSelectBack.addEventListener('click', () => leaveAndGoToMenu());

function leaveAndGoToMenu() {
  if (gameMode === 'online' && socket.connected) {
    socket.disconnect();
  }
  gameMode = null;
  myColor = null;
  currentState = null;
  localState = null;
  isAnimating = false;
  animatingTokenInfo = null;
  gameoverSection.classList.add('hidden');
  messageToast.textContent = '';
  drawBoard(null);
  showScreen('mainMenu');
}

function ensureConnected() {
  if (!socket.connected) socket.connect();
}

// --- Color selection screen ----------------------------------------------------
function openColorSelect(context, takenColors) {
  colorSelectContext = context;
  colorSelectError.textContent = '';
  if (context === 'online') {
    colorSelectSubtitle.textContent = 'Bereits vergebene Farben sind ausgegraut.';
  }
  renderColorSelect(takenColors || []);
  showScreen('colorSelect');
}

function renderColorSelect(takenColors) {
  colorCardsEl.innerHTML = '';
  ALL_COLORS.forEach((color) => {
    const taken = takenColors.includes(color);
    const card = document.createElement('button');
    card.className = 'color-card';
    card.disabled = taken;
    card.style.setProperty('--card-color', COLOR_HEX[color]);
    card.innerHTML = `<span class="color-swatch"></span><span>${COLOR_LABELS[color]}</span>` +
      (taken ? '<span class="taken-label">vergeben</span>' : '');
    card.addEventListener('click', () => handleColorPick(color));
    colorCardsEl.appendChild(card);
  });
}

function handleColorPick(color) {
  if (colorSelectContext === 'solo') {
    startSoloGame(color);
  } else if (colorSelectContext === 'online') {
    colorSelectError.textContent = '';
    socket.emit('selectColor', { color });
  }
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
socket.on('roomCreated', ({ state }) => {
  const taken = state.players.filter((p) => p.color).map((p) => p.color);
  openColorSelect('online', taken);
});

socket.on('roomJoined', ({ state }) => {
  const taken = state.players.filter((p) => p.color).map((p) => p.color);
  openColorSelect('online', taken);
});

socket.on('colorConfirmed', ({ color, state }) => {
  myColor = color;
  if (state.started) {
    showScreen('game');
    applyState(state);
  } else {
    waitingCode.textContent = state.code;
    showScreen('waiting');
  }
});

socket.on('diceRolled', ({ value }) => {
  animateDiceRoll(value);
});

socket.on('state', (state) => {
  if (!state.started) {
    // lobby-phase update (e.g. opponent joined or picked a color while we wait)
    if (!screens.colorSelect.classList.contains('hidden')) {
      const taken = state.players.filter((p) => p.color && p.color !== myColor).map((p) => p.color);
      renderColorSelect(taken);
    }
    return;
  }
  if (state.moveInfo) {
    animateIncomingMove(state);
  } else {
    applyState(state);
    if (state.message) showToast(state.message);
  }
});

socket.on('opponentLeft', ({ name }) => {
  gameoverText.textContent = `${name} hat das Spiel verlassen.`;
  gameoverSection.classList.remove('hidden');
});

socket.on('errorMsg', (msg) => {
  landingError.textContent = msg;
  colorSelectError.textContent = msg;
});

function animateIncomingMove(state) {
  const { color, tokenIndex, diceValue } = state.moveInfo;
  const bgState = currentState;
  if (!bgState) {
    applyState(state);
    if (state.message) showToast(state.message);
    return;
  }
  const fromD = bgState.tokens[color][tokenIndex];
  const path = computeStepPath(color, fromD, diceValue);
  isAnimating = true;
  animateTokenMove(color, tokenIndex, path, bgState, () => {
    isAnimating = false;
    applyState(state);
    if (state.message) showToast(state.message);
  });
}

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

  const p1 = state.players[0];
  const p2 = state.players[1];
  namePlayer1El.textContent = p1 ? p1.name : 'Spieler 1';
  namePlayer2El.textContent = p2 ? p2.name : 'Spieler 2';
  dotPlayer1El.style.background = p1 && p1.color ? COLOR_HEX[p1.color] : 'transparent';
  dotPlayer2El.style.background = p2 && p2.color ? COLOR_HEX[p2.color] : 'transparent';

  if (state.started) {
    showScreen('game');
  }

  const isMyTurn = state.turn === myColor;
  btnDice.disabled = !(isMyTurn && state.dice === null && !state.winner);

  if (state.winner) {
    const winnerPlayer = state.players.find((p) => p.color === state.winner);
    const winnerName = winnerPlayer ? winnerPlayer.name : COLOR_LABELS[state.winner];
    gameoverText.textContent = `🎉 ${winnerName} (${COLOR_LABELS[state.winner]}) gewinnt!`;
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
  const label = COLOR_LABELS[state.turn] || '';
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
// Shared movement math (distance model: -1 base, 0-50 ring, 51-56 home stretch)
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

// Steps one cell at a time, checking every intermediate cell for captures
// ("Boom-Effekt") instead of jumping straight to the landing square.
function applyMove(state, color, tokenIndex, diceValue) {
  const tokens = state.tokens[color];
  const d = tokens[tokenIndex];
  const newD = d === -1 ? 0 : d + diceValue;
  const firstStep = d === -1 ? 0 : d + 1;

  const opp = opponentColorOf(state, color);
  const oppTokens = opp ? state.tokens[opp] : null;

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

function checkWin(state, color) {
  return state.tokens[color].every((d) => d === 56);
}

// Builds the list of board cells a token passes through for one move, so the
// UI can animate it step-by-step instead of teleporting to the target cell.
function computeStepPath(color, fromD, diceValue) {
  if (fromD === -1) return [tokenCell(color, 0)];
  const path = [];
  for (let d = fromD + 1; d <= fromD + diceValue; d++) {
    path.push(tokenCell(color, Math.min(d, 56)));
  }
  return path;
}

function animateTokenMove(color, tokenIndex, path, bgState, onComplete) {
  let i = 0;
  const stepMs = 180;
  function tick() {
    animatingTokenInfo = { color, idx: tokenIndex, cell: path[i] };
    drawBoard(bgState);
    i++;
    if (i < path.length) {
      setTimeout(tick, stepMs);
    } else {
      animatingTokenInfo = null;
      onComplete();
    }
  }
  tick();
}

// ===============================================================================
// SOLO MODE - local game engine + simple AI opponent (mirrors server rules)
// ===============================================================================
function startSoloGame(chosenColor) {
  gameMode = 'solo';
  myColor = chosenColor;
  const remaining = ALL_COLORS.filter((c) => c !== chosenColor);
  const botColor = remaining[Math.floor(Math.random() * remaining.length)];
  const tokens = {};
  ALL_COLORS.forEach((c) => { tokens[c] = [-1, -1, -1, -1]; });

  localState = {
    code: 'SOLO',
    players: [
      { name: getPlayerName() || 'Du', color: chosenColor },
      { name: 'Boom-Bot', color: botColor },
    ],
    turn: chosenColor,
    dice: null,
    validMoves: [],
    sixStreak: 0,
    tokens,
    started: true,
    winner: null,
  };
  gameoverSection.classList.add('hidden');
  messageToast.textContent = '';
  showScreen('game');
  applyState(localState);
}

function botColorOf() {
  return localState.players[1].color;
}

function localPassTurn() {
  localState.dice = null;
  localState.validMoves = [];
  localState.sixStreak = 0;
  localState.turn = opponentColorOf(localState, localState.turn);
}

function localExtraTurn() {
  localState.dice = null;
  localState.validMoves = [];
}

function playerLabel(color) {
  const p = localState.players.find((pl) => pl.color === color);
  return p ? p.name : COLOR_LABELS[color];
}

function localRollDice() {
  if (gameMode !== 'solo' || !localState || localState.winner || localState.dice !== null) return;
  const color = localState.turn;
  const value = 1 + Math.floor(Math.random() * 6);

  animateDiceRoll(value, () => {
    localState.sixStreak = value === 6 ? localState.sixStreak + 1 : 0;

    if (localState.sixStreak === 3) {
      const forfeitedName = playerLabel(localState.turn);
      localState.dice = value;
      localPassTurn();
      applyState(localState);
      showToast(`3x Sechs hintereinander – Zug von ${forfeitedName} verfällt!`);
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
    if (color === botColorOf()) {
      setTimeout(() => aiMakeMove(), 700 + Math.random() * 600);
    }
  });
}

function localMoveToken(tokenIndex) {
  if (gameMode !== 'solo' || !localState || localState.winner) return;
  const color = localState.turn;
  if (localState.dice === null || !localState.validMoves.includes(tokenIndex)) return;

  const diceValue = localState.dice;
  const fromD = localState.tokens[color][tokenIndex];
  const path = computeStepPath(color, fromD, diceValue);

  isAnimating = true;
  animateTokenMove(color, tokenIndex, path, localState, () => {
    isAnimating = false;
    const { captured, finished } = applyMove(localState, color, tokenIndex, diceValue);
    finalizeLocalMove(color, diceValue, captured, finished);
  });
}

function finalizeLocalMove(color, diceValue, captured, finished) {
  if (checkWin(localState, color)) {
    localState.winner = color;
    localState.dice = null;
    localState.validMoves = [];
    applyState(localState);
    showToast(`${playerLabel(color)} hat gewonnen!`);
    return;
  }

  let message = null;
  if (captured) message = `${playerLabel(color)} hat einen Spielstein geschlagen! 💥`;
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
  if (localState.turn !== botColorOf() || localState.dice !== null) return;
  setTimeout(() => {
    if (gameMode === 'solo' && localState && !localState.winner && localState.turn === botColorOf() && localState.dice === null) {
      localRollDice();
    }
  }, 1000 + Math.random() * 1000);
}

function aiPickMove(validMoves, tokens, oppTokens, diceValue, color, opp) {
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
  const color = botColorOf();
  if (localState.turn !== color || localState.dice === null) return;
  const opp = opponentColorOf(localState, color);
  const idx = aiPickMove(localState.validMoves, localState.tokens[color], localState.tokens[opp], localState.dice, color, opp);
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

const LIGHT_TINT = { red: '#fca5a5', blue: '#93c5fd', yellow: '#fde047', green: '#86efac' };

function drawBoard(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  ctx.fillStyle = '#1e1b4b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Corner yards (6x6), one per color
  drawYard(0, 0, COLOR_DARK.red, LIGHT_TINT.red);       // red yard (top-left)
  drawYard(0, 9, COLOR_DARK.green, LIGHT_TINT.green);   // green yard (top-right)
  drawYard(9, 9, COLOR_DARK.yellow, LIGHT_TINT.yellow); // yellow yard (bottom-right)
  drawYard(9, 0, COLOR_DARK.blue, LIGHT_TINT.blue);     // blue yard (bottom-left)

  // Ring path cells
  RING_PATH.forEach(([r, c], idx) => {
    const isSafe = SAFE_CELLS.has(idx);
    const startColor = ALL_COLORS.find((color) => START_OFFSET[color] === idx);
    const fill = startColor ? LIGHT_TINT[startColor] : '#f8fafc';
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
  ALL_COLORS.forEach((color) => {
    HOME_PATHS[color].forEach(([r, c]) => drawCell(r, c, LIGHT_TINT[color], { border: 'rgba(0,0,0,0.35)' }));
  });

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
  grad.addColorStop(0.33, COLOR_HEX.green);
  grad.addColorStop(0.66, COLOR_HEX.yellow);
  grad.addColorStop(1, COLOR_HEX.blue);
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
    const ringIdx = (START_OFFSET[color] + dist) % RING_LENGTH;
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
      if (animatingTokenInfo && animatingTokenInfo.color === color && animatingTokenInfo.idx === idx) {
        [row, col] = animatingTokenInfo.cell;
      } else if (dist === -1) {
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
  const canMove = isMyTurn && state.dice !== null && state.validMoves.length > 0 && !isAnimating;

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
      ctx.strokeStyle = COLOR_DARK[t.color];
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
  if (isAnimating) return;
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
    // localMoveToken() animates the step-by-step movement itself.
    localMoveToken(best.idx);
  } else {
    // The server broadcasts the authoritative move; the resulting 'state'
    // event (with moveInfo) drives the step-by-step animation for everyone,
    // including the player who clicked.
    socket.emit('moveToken', { tokenIndex: best.idx });
  }
});

// initial empty draw
drawBoard(null);
showScreen('mainMenu');

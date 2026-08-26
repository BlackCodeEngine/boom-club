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

// Every active color that may capture / be captured by `color` - used by the
// solo local engine (no teams there, so it's simply "everyone else active").
function enemyColorsOf(state, color) {
  const active = state.activeColors || ALL_COLORS;
  return active.filter((c) => c !== color);
}

// --- Player name (persisted) -------------------------------------------------
const NAME_KEY = 'boomclub_playerName';
function getPlayerName() {
  return (localStorage.getItem(NAME_KEY) || '').trim();
}
function setPlayerName(name) {
  localStorage.setItem(NAME_KEY, name.trim());
}

// --- Reconnect info (persisted) -----------------------------------------------
// Lets the client rejoin an in-progress online room (same code + playerId)
// after a page reload or a dropped connection, instead of losing the game.
const RECONNECT_KEY = 'boomclub_reconnect';
function saveReconnectInfo(code, playerId) {
  localStorage.setItem(RECONNECT_KEY, JSON.stringify({ code, playerId }));
}
function getReconnectInfo() {
  try {
    const raw = localStorage.getItem(RECONNECT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function clearReconnectInfo() {
  localStorage.removeItem(RECONNECT_KEY);
}

// --- Auth session (persisted) -------------------------------------------------
// Keeps a logged-in player logged in across page reloads (e.g. the in-app
// refresh button) instead of dropping them back to the login screen.
const SESSION_KEY = 'boomclub_session';
function saveSession(session) {
  if (!session) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// --- BoomCoins wallet (persisted) ---------------------------------------------
const COINS_KEY = 'boomclub_coins';
const DEFAULT_COINS = 10000;
const ALLOWED_STAKES = [500, 1000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];

function getCoins() {
  const raw = localStorage.getItem(COINS_KEY);
  if (raw === null) {
    localStorage.setItem(COINS_KEY, String(DEFAULT_COINS));
    return DEFAULT_COINS;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_COINS;
}
function setCoins(amount) {
  localStorage.setItem(COINS_KEY, String(Math.max(0, Math.round(amount))));
  renderCoins();
}
function addCoins(delta) {
  setCoins(getCoins() + delta);
}
function formatBC(n) {
  return n.toLocaleString('de-DE');
}
function renderCoins() {
  coinsDisplayEl.textContent = formatBC(getCoins());
}

// --- Level / XP progress (persisted, synced from the server on login) --------
// XP_PER_LEVEL only drives the local progress bar - the server (server.js)
// is authoritative and must use the same value for the bar to line up.
const LEVEL_KEY = 'boomclub_level';
const XP_KEY = 'boomclub_xp';
const XP_PER_LEVEL = 1000;

function getLevel() {
  const n = parseInt(localStorage.getItem(LEVEL_KEY), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function getXp() {
  const n = parseInt(localStorage.getItem(XP_KEY), 10);
  return Number.isFinite(n) ? n : 0;
}
function setLevelAndXp(level, xp) {
  localStorage.setItem(LEVEL_KEY, String(Math.max(1, Math.round(level))));
  localStorage.setItem(XP_KEY, String(Math.max(0, Math.round(xp))));
  renderLevel();
}
function renderLevel() {
  levelBarEl.classList.toggle('hidden', !loggedInUserId);
  const xpIntoLevel = getXp() % XP_PER_LEVEL;
  levelValueEl.textContent = String(getLevel());
  xpValueEl.textContent = `${formatBC(xpIntoLevel)}/${formatBC(XP_PER_LEVEL)} XP`;
  xpBarFillEl.style.width = `${(xpIntoLevel / XP_PER_LEVEL) * 100}%`;
}

// --- DOM references ---------------------------------------------------------
const screens = {
  account: document.getElementById('account'),
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
const hudMeEl = document.getElementById('hud-me');
const hudOpponentsEl = document.getElementById('hud-opponents');
const avatarMeEl = document.getElementById('avatar-me');
const hudMeNameEl = document.getElementById('hud-me-name');
const hudMeCoinsEl = document.getElementById('hud-me-coins');
const hudMeTeamEl = document.getElementById('hud-me-team');
const diceSlotMeEl = document.getElementById('dice-slot-me');
const diceWidgetEl = document.getElementById('dice-widget');
const turnTimerEl = document.getElementById('turn-timer');
const btnRefreshApp = document.getElementById('btn-refresh-app');
const turnBanner = document.getElementById('turn-banner');
const boardLabelEls = {
  red: document.getElementById('board-label-red'),
  green: document.getElementById('board-label-green'),
  blue: document.getElementById('board-label-blue'),
  yellow: document.getElementById('board-label-yellow'),
};
const canvas = document.getElementById('board-canvas');
const ctx = canvas.getContext('2d');
const btnDice = document.getElementById('btn-dice');
const diceFace = document.getElementById('dice-face');
const messageToast = document.getElementById('message-toast');
const gameoverSection = document.getElementById('gameover');
const gameoverText = document.getElementById('gameover-text');
const gameoverXpEl = document.getElementById('gameover-xp');
const btnRestart = document.getElementById('btn-restart');

const btnNavSolo1v1 = document.getElementById('btn-nav-solo-1v1');
const btnNavSolo1v3 = document.getElementById('btn-nav-solo-1v3');
const btnNavOnline = document.getElementById('btn-nav-online');
const btnNavShop = document.getElementById('btn-nav-shop');
const btnNavSettings = document.getElementById('btn-nav-settings');
const btnOnlineBack = document.getElementById('btn-online-back');
const btnSettingsBack = document.getElementById('btn-settings-back');
const settingsNameInput = document.getElementById('settings-name-input');
const btnLogout = document.getElementById('btn-logout');
const btnBackToMenu = document.getElementById('btn-back-to-menu');

const btnColorSelectBack = document.getElementById('btn-colorselect-back');
const colorSelectSubtitle = document.getElementById('color-select-subtitle');
const colorCardsEl = document.getElementById('color-cards');
const colorSelectError = document.getElementById('color-select-error');

// --- Account screen (register / login / guest) DOM refs ------------------------
const tabRegisterEl = document.getElementById('tab-register');
const tabLoginEl = document.getElementById('tab-login');
const formRegisterEl = document.getElementById('form-register');
const formLoginEl = document.getElementById('form-login');
const registerEmailInput = document.getElementById('register-email');
const registerEmailError = document.getElementById('register-email-error');
const registerUsernameInput = document.getElementById('register-username');
const registerUsernameError = document.getElementById('register-username-error');
const registerUsernameStatus = document.getElementById('register-username-status');
const registerPasswordInput = document.getElementById('register-password');
const registerPasswordError = document.getElementById('register-password-error');
const btnRegisterSubmit = document.getElementById('btn-register-submit');
const registerGeneralError = document.getElementById('register-general-error');
const registerSuccessEl = document.getElementById('register-success');
const loginEmailInput = document.getElementById('login-email');
const loginEmailError = document.getElementById('login-email-error');
const loginPasswordInput = document.getElementById('login-password');
const loginPasswordError = document.getElementById('login-password-error');
const btnLoginSubmit = document.getElementById('btn-login-submit');
const loginGeneralError = document.getElementById('login-general-error');
const loginSuccessEl = document.getElementById('login-success');
const btnPlayGuest = document.getElementById('btn-play-guest');

const coinsDisplayEl = document.getElementById('coins-display');
const levelBarEl = document.getElementById('level-bar');
const levelValueEl = document.getElementById('level-value');
const xpBarFillEl = document.getElementById('xp-bar-fill');
const xpValueEl = document.getElementById('xp-value');
const modeTab1v1El = document.getElementById('mode-tab-1v1');
const modeTab2v2El = document.getElementById('mode-tab-2v2');
const stakeSelectEl = document.getElementById('stake-select');
const waitingSlotsEl = document.getElementById('waiting-slots');
const waitingStakeEl = document.getElementById('waiting-stake');
const reconnectBannerEl = document.getElementById('reconnect-banner');

const CELL = canvas.width / GRID;

let myColor = null;
let gameMode = null; // 'solo' | 'solo-pending' | 'online'
let colorSelectContext = null; // 'solo' | 'online'
let pendingBotCount = 0; // bots to fill in for the game about to be started
let onlineMode = 'mp1v1'; // 'mp1v1' | 'mp2v2', selected in the online menu
let amIHost = false; // only the room creator may add bots from the waiting room
let currentState = null;
let localState = null; // only used in solo mode
let toastTimer = null;
let isAnimating = false;
let animatingTokenInfo = null; // { color, idx, pixel: {x, y} }

let currentStake = null;
let stakeDeducted = false;
let payoutSettled = false;

const TURN_TIME_LIMIT_MS = 15000;
let countdownIntervalHandle = null;
let localTurnTimeoutHandle = null;
let botWatchdogHandle = null; // safety net in case a bot's own turn ever gets stuck
let wasMyTurnPrev = null; // null = unknown/not yet in a game
let audioCtx = null;

let hasConnectedOnce = false;
let loggedInUserId = null;

renderCoins();
renderLevel();

btnRefreshApp.addEventListener('click', () => location.reload());

// --- Reconnect banner -----------------------------------------------------------
function showReconnectBanner(text) {
  reconnectBannerEl.textContent = text || '🔌 Verbindung unterbrochen – versuche wiederzuverbinden...';
  reconnectBannerEl.classList.remove('hidden');
}
function hideReconnectBanner() {
  reconnectBannerEl.classList.add('hidden');
}

// A dropped connection during an online game should try to recover, not dump
// the player back into the main menu. socket.io reconnects the transport on
// its own; we just have to re-associate it with our room via 'rejoinRoom'
// once it's back (a fresh socket.id is no longer known to the server).
socket.on('connect', () => {
  if (hasConnectedOnce && gameMode === 'online') {
    const info = getReconnectInfo();
    if (info) {
      showReconnectBanner('✅ Verbindung wiederhergestellt – synchronisiere...');
      socket.emit('rejoinRoom', info);
    } else {
      hideReconnectBanner();
    }
  }
  hasConnectedOnce = true;
});

socket.on('disconnect', (reason) => {
  if (reason === 'io client disconnect') return; // we disconnected on purpose
  if (gameMode === 'online') {
    showReconnectBanner();
  }
});

socket.on('rejoined', ({ state, color, stake, isHost }) => {
  hideReconnectBanner();
  gameMode = 'online';
  myColor = color;
  currentStake = stake;
  amIHost = !!isHost;

  if (state.started) {
    commitOnlineState(state);
    showScreen('game');
  } else if (color) {
    waitingCode.textContent = state.code;
    waitingStakeEl.textContent = stake ? `Einsatz: ${formatBC(stake)} BC` : '';
    renderWaitingRoom(state);
    showScreen('waiting');
  } else {
    const taken = state.players.filter((p) => p.color).map((p) => p.color);
    openColorSelect('online', taken);
  }
});

socket.on('rejoinFailed', () => {
  hideReconnectBanner();
  clearReconnectInfo();
});

// Returning to the page (e.g. after the in-app refresh, or reopening the
// iPhone homescreen app) with a saved room to rejoin.
const initialReconnectInfo = getReconnectInfo();
if (initialReconnectInfo) {
  gameMode = 'online';
  showReconnectBanner('🔌 Verbindung wird wiederhergestellt...');
  ensureConnected();
  socket.emit('rejoinRoom', initialReconnectInfo);
}

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

// ===============================================================================
// ACCOUNT SCREEN - register / login (Supabase Auth) or play as guest
// ===============================================================================
function setAccountTab(tab) {
  const isRegister = tab === 'register';
  tabRegisterEl.classList.toggle('active', isRegister);
  tabLoginEl.classList.toggle('active', !isRegister);
  formRegisterEl.classList.toggle('hidden', !isRegister);
  formLoginEl.classList.toggle('hidden', isRegister);
}
tabRegisterEl.addEventListener('click', () => setAccountTab('register'));
tabLoginEl.addEventListener('click', () => setAccountTab('login'));

function clearRegisterErrors() {
  registerEmailError.textContent = '';
  registerUsernameError.textContent = '';
  registerPasswordError.textContent = '';
  registerGeneralError.textContent = '';
}
function clearLoginErrors() {
  loginEmailError.textContent = '';
  loginPasswordError.textContent = '';
  loginGeneralError.textContent = '';
}

const AUTH_ERROR_MESSAGES = {
  'User already registered': 'Diese E-Mail-Adresse ist bereits registriert.',
  'Password should be at least 6 characters': 'Passwort muss mindestens 6 Zeichen haben.',
  'Invalid login credentials': 'E-Mail oder Passwort ist falsch.',
  'Email not confirmed': 'Bitte bestätige zuerst deine E-Mail-Adresse.',
  'Unable to validate email address: invalid format': 'Bitte gib eine gültige E-Mail-Adresse ein.',
};
function translateAuthError(msg) {
  return AUTH_ERROR_MESSAGES[msg] || msg;
}

// --- Live username availability check (debounced) -------------------------------
let usernameCheckTimer = null;
function setUsernameStatus(status) {
  // status: null | 'checking' | 'available' | 'taken'
  registerUsernameStatus.textContent =
    status === 'checking' ? '⏳' : status === 'available' ? '✅' : status === 'taken' ? '❌' : '';
}
registerUsernameInput.addEventListener('input', () => {
  const value = registerUsernameInput.value.trim();
  registerUsernameError.textContent = '';
  clearTimeout(usernameCheckTimer);

  if (!value) {
    setUsernameStatus(null);
    return;
  }
  if (value.length < 3) {
    setUsernameStatus(null);
    return;
  }
  setUsernameStatus('checking');
  usernameCheckTimer = setTimeout(() => {
    ensureConnected();
    socket.emit('checkUsernameAvailable', { username: value });
  }, 500);
});

socket.on('usernameAvailability', ({ username, available }) => {
  if (registerUsernameInput.value.trim() !== username) return; // stale response
  if (available === true) {
    setUsernameStatus('available');
  } else if (available === false) {
    setUsernameStatus('taken');
    registerUsernameError.textContent = 'Dieser Benutzername ist bereits vergeben.';
  } else {
    setUsernameStatus(null);
  }
});

// --- Register / Login form submission -------------------------------------------
formRegisterEl.addEventListener('submit', (evt) => {
  evt.preventDefault();
  clearRegisterErrors();
  registerSuccessEl.classList.add('hidden');

  const email = registerEmailInput.value.trim();
  const username = registerUsernameInput.value.trim();
  const password = registerPasswordInput.value;

  let hasError = false;
  if (!email) { registerEmailError.textContent = 'E-Mail wird benötigt.'; hasError = true; }
  if (!username || username.length < 3) { registerUsernameError.textContent = 'Mindestens 3 Zeichen.'; hasError = true; }
  if (!password || password.length < 6) { registerPasswordError.textContent = 'Mindestens 6 Zeichen.'; hasError = true; }
  if (hasError) return;

  ensureConnected();
  btnRegisterSubmit.disabled = true;
  socket.emit('authRegister', { email, password, username });
});

formLoginEl.addEventListener('submit', (evt) => {
  evt.preventDefault();
  clearLoginErrors();
  loginSuccessEl.classList.add('hidden');

  const email = loginEmailInput.value.trim();
  const password = loginPasswordInput.value;

  let hasError = false;
  if (!email) { loginEmailError.textContent = 'E-Mail wird benötigt.'; hasError = true; }
  if (!password) { loginPasswordError.textContent = 'Passwort wird benötigt.'; hasError = true; }
  if (hasError) return;

  ensureConnected();
  btnLoginSubmit.disabled = true;
  socket.emit('authLogin', { email, password });
});

socket.on('authRegistered', ({ username, coins, needsEmailConfirmation, session, level, xp }) => {
  btnRegisterSubmit.disabled = false;

  if (needsEmailConfirmation) {
    registerSuccessEl.textContent = '🎉 Konto erstellt! Bitte bestätige deine E-Mail-Adresse und logge dich danach ein.';
    registerSuccessEl.classList.remove('hidden');
    setTimeout(() => {
      loginEmailInput.value = registerEmailInput.value;
      setAccountTab('login');
    }, 2200);
    return;
  }

  if (username) setPlayerName(username);
  if (typeof coins === 'number') setCoins(coins);
  if (session) saveSession(session);
  setLevelAndXp(level || 1, xp || 0);

  registerSuccessEl.textContent = `🎉 Willkommen, ${username || 'Spieler'}! Dein Konto wurde erstellt.`;
  registerSuccessEl.classList.remove('hidden');
  setTimeout(() => showScreen('mainMenu'), 1200);
});

socket.on('authLoggedIn', ({ userId, username, coins, session, level, xp }) => {
  hideReconnectBanner();
  btnLoginSubmit.disabled = false;
  loggedInUserId = userId;

  if (username) setPlayerName(username);
  if (typeof coins === 'number') setCoins(coins);
  if (session) saveSession(session);
  setLevelAndXp(level || 1, xp || 0);

  loginSuccessEl.textContent = `🎉 Willkommen zurück${username ? ', ' + username : ''}!`;
  loginSuccessEl.classList.remove('hidden');
  setTimeout(() => showScreen('mainMenu'), 1000);
});

// Server-authoritative XP/level update after an online game (see 'moveToken'
// win handling in server.js) - reflects the same values it just persisted to
// the `profiles` table in Supabase.
socket.on('xpGained', ({ xpEarned, newXp, newLevel, leveledUp, coinsAwarded, itemAwarded }) => {
  setLevelAndXp(newLevel, newXp);
  if (typeof coinsAwarded === 'number' && coinsAwarded > 0) addCoins(coinsAwarded);

  let text = `+${formatBC(xpEarned)} XP`;
  if (leveledUp) {
    text += ` · 🎉 Level ${newLevel} erreicht! +${formatBC(coinsAwarded)} BC`;
    if (itemAwarded) text += ` · + Gratis-Würfel!`;
  }
  gameoverXpEl.textContent = text;
  gameoverXpEl.classList.remove('hidden');
});

// Session restore (silent, on page load) failed or expired - go back to a
// clean login screen instead of leaving the player stuck on a blank state.
socket.on('authRestoreFailed', () => {
  hideReconnectBanner();
  clearSession();
  showScreen('account');
});

socket.on('authError', (msg) => {
  btnRegisterSubmit.disabled = false;
  btnLoginSubmit.disabled = false;
  const friendly = translateAuthError(msg);
  if (!formRegisterEl.classList.contains('hidden')) {
    registerGeneralError.textContent = friendly;
  } else {
    loginGeneralError.textContent = friendly;
  }
});

btnPlayGuest.addEventListener('click', () => showScreen('mainMenu'));

// --- Main menu navigation -----------------------------------------------------
settingsNameInput.value = getPlayerName();
settingsNameInput.addEventListener('input', () => setPlayerName(settingsNameInput.value));

btnNavSolo1v1.addEventListener('click', () => {
  gameMode = 'solo-pending';
  pendingBotCount = 1;
  colorSelectSubtitle.textContent = 'Der Boom-Bot bekommt automatisch eine der übrigen Farben.';
  openColorSelect('solo', []);
});
btnNavSolo1v3.addEventListener('click', () => {
  gameMode = 'solo-pending';
  pendingBotCount = 3;
  colorSelectSubtitle.textContent = 'Die drei übrigen Farben werden automatisch von Boom-Bots übernommen.';
  openColorSelect('solo', []);
});
btnNavOnline.addEventListener('click', () => {
  landingError.textContent = '';
  showScreen('onlineMenu');
});

// --- Online menu: mode selection -----------------------------------------------
// Bots are never added automatically - the host fills specific free color
// slots with a bot from the waiting room instead (see renderWaitingRoom).
function setOnlineMode(mode) {
  onlineMode = mode;
  modeTab1v1El.classList.toggle('active', mode === 'mp1v1');
  modeTab2v2El.classList.toggle('active', mode === 'mp2v2');
}
modeTab1v1El.addEventListener('click', () => setOnlineMode('mp1v1'));
modeTab2v2El.addEventListener('click', () => setOnlineMode('mp2v2'));
btnNavShop.addEventListener('click', () => {}); // disabled - coming soon
btnNavSettings.addEventListener('click', () => showScreen('settings'));
btnOnlineBack.addEventListener('click', () => showScreen('mainMenu'));
btnSettingsBack.addEventListener('click', () => showScreen('mainMenu'));
btnLogout.addEventListener('click', () => {
  clearSession();
  loggedInUserId = null;
  showScreen('account');
});
btnWaitingCancel.addEventListener('click', () => leaveAndGoToMenu());
btnBackToMenu.addEventListener('click', () => leaveAndGoToMenu());
btnColorSelectBack.addEventListener('click', () => leaveAndGoToMenu());

function leaveAndGoToMenu() {
  if (gameMode === 'online' && socket.connected) {
    socket.disconnect();
  }
  clearReconnectInfo();
  hideReconnectBanner();
  gameMode = null;
  myColor = null;
  currentState = null;
  localState = null;
  currentStake = null;
  stakeDeducted = false;
  payoutSettled = false;
  isAnimating = false;
  animatingTokenInfo = null;
  wasMyTurnPrev = null;
  stopCountdownDisplay();
  if (localTurnTimeoutHandle) clearTimeout(localTurnTimeoutHandle);
  localTurnTimeoutHandle = null;
  gameoverSection.classList.add('hidden');
  gameoverXpEl.classList.add('hidden');
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
    const stakeInfo = currentStake ? `Einsatz: ${formatBC(currentStake)} BC · ` : '';
    const teamInfo = onlineMode === 'mp2v2' ? 'Team A: Rot+Gelb, Team B: Grün+Blau · ' : '';
    colorSelectSubtitle.textContent = `${stakeInfo}${teamInfo}Bereits vergebene Farben sind ausgegraut.`;
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
    startSoloGame(color, pendingBotCount);
  } else if (colorSelectContext === 'online') {
    colorSelectError.textContent = '';
    socket.emit('selectColor', { color });
  }
}

// --- Online menu actions --------------------------------------------------------
btnCreate.addEventListener('click', () => {
  landingError.textContent = '';
  const stake = parseInt(stakeSelectEl.value, 10);
  if (!ALLOWED_STAKES.includes(stake)) return;
  if (getCoins() < stake) {
    landingError.textContent = `Nicht genug BoomCoins für diesen Einsatz (benötigt: ${formatBC(stake)} BC).`;
    return;
  }
  ensureConnected();
  gameMode = 'online';
  stakeDeducted = false;
  payoutSettled = false;
  socket.emit('createRoom', { name: getPlayerName(), stake, coins: getCoins(), mode: onlineMode });
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
  stakeDeducted = false;
  payoutSettled = false;
  socket.emit('joinRoom', { code, name: getPlayerName(), coins: getCoins() });
});

btnCopyCode.addEventListener('click', () => {
  navigator.clipboard?.writeText(waitingCode.textContent.trim());
  btnCopyCode.textContent = '✅ Kopiert!';
  setTimeout(() => { btnCopyCode.textContent = '📋 Code kopieren'; }, 1500);
});

btnRestart.addEventListener('click', () => window.location.reload());

// --- Socket events (online multiplayer) ---------------------------------------
socket.on('roomCreated', ({ code, playerId, isHost, state }) => {
  saveReconnectInfo(code, playerId);
  currentStake = state.stake;
  amIHost = !!isHost;
  const taken = state.players.filter((p) => p.color).map((p) => p.color);
  openColorSelect('online', taken);
});

socket.on('roomJoined', ({ playerId, isHost, state }) => {
  if (getCoins() < state.stake) {
    landingError.textContent = `Nicht genug BoomCoins für den Einsatz von ${formatBC(state.stake)} BC in diesem Raum.`;
    socket.disconnect();
    gameMode = null;
    showScreen('onlineMenu');
    return;
  }
  saveReconnectInfo(state.code, playerId);
  currentStake = state.stake;
  amIHost = !!isHost;
  const taken = state.players.filter((p) => p.color).map((p) => p.color);
  openColorSelect('online', taken);
});

socket.on('colorConfirmed', ({ color, state }) => {
  myColor = color;
  if (state.started) {
    commitOnlineState(state);
  } else {
    waitingCode.textContent = state.code;
    waitingStakeEl.textContent = currentStake ? `Einsatz: ${formatBC(currentStake)} BC` : '';
    renderWaitingRoom(state);
    showScreen('waiting');
  }
});

// Shows every color slot (taken by a human, taken by a bot, or free) in the
// waiting room, with host-only buttons to fill any free slot with a bot.
function renderWaitingRoom(state) {
  waitingSlotsEl.innerHTML = '';
  const roomFull = state.players.length >= state.maxPlayers;

  ALL_COLORS.forEach((color) => {
    const player = state.players.find((p) => p.color === color);
    const row = document.createElement('div');
    row.className = 'waiting-slot';

    const swatch = document.createElement('span');
    swatch.className = 'waiting-slot-swatch';
    swatch.style.background = COLOR_HEX[color];
    row.appendChild(swatch);

    const label = document.createElement('span');
    label.className = 'waiting-slot-label';
    if (player) {
      const who = player.isBot ? `🤖 ${player.name}` : player.name + (color === myColor ? ' (Du)' : '');
      label.textContent = `${COLOR_LABELS[color]}: ${who}`;
    } else {
      label.textContent = `${COLOR_LABELS[color]}: frei`;
    }
    row.appendChild(label);

    if (!player && amIHost && !roomFull) {
      const btn = document.createElement('button');
      btn.className = 'waiting-slot-add-bot';
      btn.textContent = '🤖 Bot hinzufügen';
      btn.addEventListener('click', () => socket.emit('addBot', { color }));
      row.appendChild(btn);
    }

    waitingSlotsEl.appendChild(row);
  });
}

socket.on('diceRolled', ({ value }) => {
  animateDiceRoll(value);
});

socket.on('state', (state) => {
  if (!state.started) {
    // lobby-phase update (e.g. opponent joined, picked a color, or the host
    // added a bot while we wait)
    if (!screens.colorSelect.classList.contains('hidden')) {
      const taken = state.players.filter((p) => p.color && p.color !== myColor).map((p) => p.color);
      renderColorSelect(taken);
    }
    if (!screens.waiting.classList.contains('hidden')) {
      renderWaitingRoom(state);
    }
    return;
  }
  if (state.moveInfo) {
    animateIncomingMove(state);
  } else {
    commitOnlineState(state);
  }
});

socket.on('opponentLeft', ({ name }) => {
  hideReconnectBanner();
  clearReconnectInfo();
  let text = `${name} hat das Spiel verlassen.`;
  if (gameMode === 'online' && stakeDeducted && !payoutSettled && currentStake) {
    payoutSettled = true;
    addCoins(currentStake);
    text += ` Dein Einsatz von ${formatBC(currentStake)} BC wurde zurückerstattet.`;
  }
  gameoverText.textContent = text;
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
    commitOnlineState(state);
    return;
  }
  const fromD = bgState.tokens[color][tokenIndex];
  const path = computeStepPath(color, fromD, diceValue);
  const willFinish = (fromD === -1 ? 0 : fromD + diceValue) === 56;
  isAnimating = true;
  animateTokenMove(color, tokenIndex, path, bgState, willFinish, () => {
    isAnimating = false;
    commitOnlineState(state);
  });
}

// Applies an authoritative online state update and settles the BoomCoins
// stake exactly once per game (deducted on start, paid out to the winner).
function commitOnlineState(state) {
  let extra = '';
  if (gameMode === 'online' && currentStake) {
    if (!stakeDeducted && state.started) {
      stakeDeducted = true;
      addCoins(-currentStake);
    }
    if (!payoutSettled && state.winner) {
      payoutSettled = true;
      const pot = currentStake * 2;
      const me = state.players.find((p) => p.color === myColor);
      const iWon = state.winner === myColor || (state.winnerTeam && me && me.team === state.winnerTeam);
      if (iWon) {
        addCoins(pot);
        extra = ` Du gewinnst den Pot: +${formatBC(pot)} BC! 🪙`;
      } else {
        extra = ` Du verlierst deinen Einsatz von ${formatBC(currentStake)} BC.`;
      }
    }
  }

  if (gameMode === 'online' && state.winner) {
    clearReconnectInfo();
  }

  applyState(state);

  const msg = `${state.message || ''}${extra}`.trim();
  if (msg) showToast(msg);
}

// --- Shared dice animation -----------------------------------------------------
// Classic 3x3 pip layout (grid positions numbered 1-9, left-to-right,
// top-to-bottom) - which pips are lit for each face value.
const DICE_PIPS = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};
const dicePipEls = Array.from(diceFace.querySelectorAll('.pip'));

function setDiceFace(value) {
  const lit = new Set(DICE_PIPS[value] || []);
  dicePipEls.forEach((pip) => {
    pip.classList.toggle('on', lit.has(Number(pip.dataset.pip)));
  });
}

function animateDiceRoll(finalValue, onDone) {
  diceFace.classList.add('dice-rolling');
  let ticks = 0;
  const spin = setInterval(() => {
    setDiceFace(1 + Math.floor(Math.random() * 6));
    ticks++;
    if (ticks > 6) {
      clearInterval(spin);
      diceFace.classList.remove('dice-rolling');
      setDiceFace(finalValue);
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
    gameModeLabel.textContent = currentStake ? `Online · Einsatz ${formatBC(currentStake)} BC` : 'Online Multiplayer';
    gameRoomLabel.textContent = 'Raum:';
    gameRoomCode.textContent = state.code;
  }

  updateHud(state);
  updateDiceSlot(state);

  if (state.started) {
    showScreen('game');
  }

  const isMyTurn = state.turn === myColor;
  btnDice.disabled = !(isMyTurn && state.dice === null && !state.rolling && !state.winner);

  if (state.winner) {
    const winnerPlayer = state.players.find((p) => p.color === state.winner);
    const winnerName = winnerPlayer ? winnerPlayer.name : COLOR_LABELS[state.winner];
    const teamSuffix = state.winnerTeam ? ` – Team ${state.winnerTeam}` : '';
    gameoverText.textContent = `🎉 ${winnerName} (${COLOR_LABELS[state.winner]}${teamSuffix}) gewinnt!`;
    gameoverSection.classList.remove('hidden');
  }

  if (state.started && !state.winner) {
    startCountdownDisplay();
  } else {
    stopCountdownDisplay();
  }

  updateTurnBanner(state);
  updateBoardLabels(state);
  drawBoard(state);
}

// Small name chips above/below the board, one per active color, positioned
// to match that color's corner (Rot/Grün top, Blau/Gelb bottom).
function updateBoardLabels(state) {
  const active = new Set(activeColorsOf(state));
  ALL_COLORS.forEach((color) => {
    const el = boardLabelEls[color];
    const player = state.players.find((p) => p.color === color);
    if (!active.has(color) || !player) {
      el.classList.add('hidden');
      return;
    }
    el.textContent = player.isBot ? `🤖 ${player.name}` : player.name;
    el.style.color = COLOR_HEX[color];
    el.classList.remove('hidden');
  });
}

// --- Opponent HUD cards (built dynamically - 1 to 3, one per active color) ----
// Rebuilt only when the set of opponent colors changes (i.e. once per game),
// so the persistent #dice-widget DOM node never gets destroyed mid-animation.
let oppCardRefs = {};
let hudBuiltKey = null;

function ensureHudCards(state) {
  const oppColors = state.players.map((p) => p.color).filter((c) => c && c !== myColor);
  const key = oppColors.join(',');
  if (key === hudBuiltKey) return;
  hudBuiltKey = key;

  if (hudOpponentsEl.contains(diceWidgetEl)) {
    diceSlotMeEl.appendChild(diceWidgetEl);
  }
  hudOpponentsEl.innerHTML = '';
  oppCardRefs = {};

  oppColors.forEach((color) => {
    const card = document.createElement('div');
    card.className = 'hud-card';
    card.innerHTML =
      '<div class="hud-info">' +
        `<div class="hud-avatar" style="background:${COLOR_HEX[color]};border-color:${COLOR_DARK[color]}">?</div>` +
        '<div>' +
          '<div class="hud-name">Gegner</div>' +
          '<div class="hud-coins"></div>' +
          '<span class="team-badge hidden"></span>' +
        '</div>' +
      '</div>' +
      '<div class="dice-slot"></div>';
    hudOpponentsEl.appendChild(card);
    oppCardRefs[color] = {
      el: card,
      avatarEl: card.querySelector('.hud-avatar'),
      nameEl: card.querySelector('.hud-name'),
      coinsEl: card.querySelector('.hud-coins'),
      teamBadgeEl: card.querySelector('.team-badge'),
      diceSlotEl: card.querySelector('.dice-slot'),
    };
  });
}

// Shows/hides the "Team A/B" ring + badge (2v2 only) on a HUD card.
function updateTeamBadge(cardEl, badgeEl, team) {
  cardEl.classList.remove('team-a', 'team-b');
  if (!team) {
    badgeEl.classList.add('hidden');
    return;
  }
  const cls = team === 'A' ? 'team-a' : 'team-b';
  cardEl.classList.add(cls);
  badgeEl.classList.remove('hidden', 'team-a', 'team-b');
  badgeEl.classList.add(cls);
  badgeEl.textContent = `Team ${team}`;
}

// --- Player HUD cards (avatar, name, BoomCoins) --------------------------------
function updateHud(state) {
  ensureHudCards(state);
  const isTeamMode = state.mode === 'mp2v2';

  const me = state.players.find((p) => p.color === myColor) || {};
  avatarMeEl.textContent = (me.name || '?').charAt(0).toUpperCase();
  avatarMeEl.style.background = myColor ? COLOR_HEX[myColor] : '#555';
  avatarMeEl.style.borderColor = myColor ? COLOR_DARK[myColor] : 'rgba(255,255,255,0.4)';
  hudMeNameEl.textContent = me.name || 'Du';
  hudMeCoinsEl.textContent = `🪙 ${formatBC(getCoins())}`;
  updateTeamBadge(hudMeEl, hudMeTeamEl, isTeamMode ? me.team : null);
  hudMeEl.classList.toggle('hud-active', state.turn === myColor && !state.winner);

  state.players.forEach((p) => {
    if (!p.color || p.color === myColor) return;
    const ref = oppCardRefs[p.color];
    if (!ref) return;

    const isBotPlayer = gameMode === 'solo' ? isBotColor(p.color) : !!p.isBot;
    ref.avatarEl.textContent = isBotPlayer ? '🤖' : (p.name || '?').charAt(0).toUpperCase();
    ref.nameEl.textContent = p.name || (isBotPlayer ? 'Boom-Bot' : 'Gegner');
    if (gameMode === 'solo') {
      ref.coinsEl.textContent = '🤖 KI-Gegner';
    } else {
      ref.coinsEl.textContent = isBotPlayer ? '🤖 KI-Gegner' : (typeof p.coins === 'number' ? `🪙 ${formatBC(p.coins)}` : '');
    }
    updateTeamBadge(ref.el, ref.teamBadgeEl, isTeamMode ? p.team : null);
    ref.el.classList.toggle('hud-active', state.turn === p.color && !state.winner);
  });
}

// Moves the single dice widget over to whichever HUD card belongs to the
// player who is currently on turn ("wandert" between the cards).
function updateDiceSlot(state) {
  const targetSlot = state.turn === myColor
    ? diceSlotMeEl
    : (oppCardRefs[state.turn] ? oppCardRefs[state.turn].diceSlotEl : null);
  if (!targetSlot) return;
  if (diceWidgetEl.parentElement !== targetSlot) {
    targetSlot.appendChild(diceWidgetEl);
    diceWidgetEl.classList.remove('dice-widget-move');
    void diceWidgetEl.offsetWidth; // restart animation
    diceWidgetEl.classList.add('dice-widget-move');
  }
}

function updateTurnBanner(state) {
  checkTurnTransition(state);

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
  turnBanner.appendChild(turnTimerEl);
}

// --- Turn countdown display (server/solo-provided deadline, display only) -----
function startCountdownDisplay() {
  stopCountdownDisplay();
  countdownIntervalHandle = setInterval(updateCountdownDisplay, 250);
  updateCountdownDisplay();
}
function stopCountdownDisplay() {
  if (countdownIntervalHandle) clearInterval(countdownIntervalHandle);
  countdownIntervalHandle = null;
  turnTimerEl.textContent = '';
}
function updateCountdownDisplay() {
  if (!currentState || currentState.winner || !currentState.turnDeadline) {
    turnTimerEl.textContent = '';
    return;
  }
  const seconds = Math.max(0, Math.ceil((currentState.turnDeadline - Date.now()) / 1000));
  turnTimerEl.textContent = `⏱ ${seconds}s`;
  turnTimerEl.classList.toggle('text-rose-300', seconds <= 5);
}

// --- "Your turn!" signal (visual flash + short audio chime) --------------------
function checkTurnTransition(state) {
  const isMyTurn = state.turn === myColor && !state.winner;
  if (isMyTurn && wasMyTurnPrev === false) {
    flashTurnSignal();
    playTurnChime();
  }
  wasMyTurnPrev = isMyTurn;
}

function flashTurnSignal() {
  turnBanner.classList.remove('turn-flash');
  void turnBanner.offsetWidth; // restart animation
  turnBanner.classList.add('turn-flash');
}

function playTurnChime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  } catch (e) {
    // Audio not available/blocked - the visual signal alone is enough.
  }
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

  const enemyColors = enemyColorsOf(state, color);

  let captured = false;
  for (let step = firstStep; step <= newD && step <= 50; step++) {
    const abs = (START_OFFSET[color] + step) % RING_LENGTH;
    if (SAFE_CELLS.has(abs)) continue;
    enemyColors.forEach((enemyColor) => {
      const enemyTokens = state.tokens[enemyColor];
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

function cellCenterPx(cell) {
  const { x, y, w, h } = cellRect(cell[0], cell[1]);
  return { x: x + w / 2, y: y + h / 2 };
}

// Glides the token smoothly through every cell in `path` (instead of jumping
// cell-to-cell) via requestAnimationFrame pixel interpolation, with a glow
// trailing it. The starting pixel is the token's current spot (base slot or
// ring/home cell) so even a single-cell hop (e.g. leaving base) still glides.
// `willFinish` triggers a "💥 Boom" particle burst right as it lands.
function animateTokenMove(color, tokenIndex, path, bgState, willFinish, onComplete) {
  const fromD = bgState.tokens[color][tokenIndex];
  const fromCell = fromD === -1 ? BASE_SPOTS[color][tokenIndex] : tokenCell(color, fromD);
  const points = [fromCell, ...path].map(cellCenterPx);
  const stepMs = 140;
  const totalMs = stepMs * (points.length - 1);
  const startTime = performance.now();

  function frame(now) {
    const t = totalMs === 0 ? 1 : Math.min(1, (now - startTime) / totalMs);
    const rawIndex = t * (points.length - 1);
    const segIndex = Math.min(points.length - 2, Math.floor(rawIndex));
    const segT = rawIndex - segIndex;
    const a = points[segIndex];
    const b = points[segIndex + 1];
    animatingTokenInfo = {
      color,
      idx: tokenIndex,
      pixel: { x: a.x + (b.x - a.x) * segT, y: a.y + (b.y - a.y) * segT },
    };
    drawBoard(bgState);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      animatingTokenInfo = null;
      if (willFinish) spawnBoomParticles(points[points.length - 1], color);
      onComplete();
    }
  }
  requestAnimationFrame(frame);
}

// ===============================================================================
// SOLO MODE - local game engine + simple AI opponent (mirrors server rules)
// ===============================================================================
function startSoloGame(chosenColor, botCount) {
  gameMode = 'solo';
  myColor = chosenColor;

  // Shuffle the remaining colors and take `botCount` of them for the bots -
  // 1 for "1 vs 1", all 3 for "1 vs 3".
  const remaining = ALL_COLORS.filter((c) => c !== chosenColor);
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }
  const botColors = remaining.slice(0, botCount);

  const tokens = {};
  ALL_COLORS.forEach((c) => { tokens[c] = [-1, -1, -1, -1]; });

  localState = {
    code: 'SOLO',
    activeColors: [chosenColor, ...botColors],
    players: [
      { name: getPlayerName() || 'Du', color: chosenColor, isBot: false },
      ...botColors.map((c, i) => ({ name: `Boom-Bot ${i + 1}`, color: c, isBot: true })),
    ],
    turn: chosenColor,
    dice: null,
    rolling: false,
    validMoves: [],
    sixStreak: 0,
    tokens,
    started: true,
    winner: null,
    turnDeadline: null,
  };
  wasMyTurnPrev = null;
  gameoverSection.classList.add('hidden');
  gameoverXpEl.classList.add('hidden');
  messageToast.textContent = '';
  showScreen('game');
  startLocalTurnWindow();
  applyState(localState);
}

function isBotColor(color) {
  const p = localState.players.find((pl) => pl.color === color);
  return p ? !!p.isBot : false;
}

// Round-robins to the next player in seat order. Solo games always end the
// instant any color finishes (see finalizeLocalMove), so - unlike the
// server's team-aware advanceTurn - there's never an already-finished color
// left to skip past here.
function localAdvanceTurn() {
  const colors = localState.players.map((p) => p.color);
  const idx = colors.indexOf(localState.turn);
  localState.turn = colors[(idx + 1) % colors.length];
}

// Mirrors the server's hard per-turn timer for solo mode: gives the human a
// fresh window on every turn start and force-skips them if it runs out.
function startLocalTurnWindow() {
  if (localTurnTimeoutHandle) clearTimeout(localTurnTimeoutHandle);
  localTurnTimeoutHandle = null;
  if (botWatchdogHandle) clearTimeout(botWatchdogHandle);
  botWatchdogHandle = null;

  if (localState.turn === myColor) {
    localState.turnDeadline = Date.now() + TURN_TIME_LIMIT_MS;
    localTurnTimeoutHandle = setTimeout(handleLocalTurnTimeout, TURN_TIME_LIMIT_MS);
    return;
  }

  localState.turnDeadline = null;
  // maybeScheduleAiTurn() is what normally rolls for a bot within 1-2s, but
  // as a safety net - matching the server's own handleTurnTimeout fallback
  // for online bots - force a roll if this exact turn is ever still waiting
  // after the same hard limit a human gets.
  const turnAtSchedule = localState.turn;
  botWatchdogHandle = setTimeout(() => {
    if (gameMode === 'solo' && localState && !localState.winner &&
        localState.turn === turnAtSchedule && localState.dice === null && !localState.rolling) {
      localRollDice();
    }
  }, TURN_TIME_LIMIT_MS);
}

function handleLocalTurnTimeout() {
  if (gameMode !== 'solo' || !localState || localState.winner) return;
  if (localState.turn !== myColor) return;
  const name = playerLabel(localState.turn);
  localPassTurn();
  applyState(localState);
  showToast(`⏱️ Zeit abgelaufen – Zug von ${name} übersprungen!`);
  maybeScheduleAiTurn();
}

function localPassTurn() {
  localState.dice = null;
  localState.validMoves = [];
  localState.sixStreak = 0;
  localAdvanceTurn();
  startLocalTurnWindow();
}

function localExtraTurn() {
  localState.dice = null;
  localState.validMoves = [];
  startLocalTurnWindow();
}

function playerLabel(color) {
  const p = localState.players.find((pl) => pl.color === color);
  return p ? p.name : COLOR_LABELS[color];
}

function localRollDice() {
  // `rolling` closes the window between clicking/scheduling a roll and the
  // dice animation actually resolving (~400ms) - localState.dice itself only
  // gets set at the end of that window, so without this a second trigger
  // (e.g. the bot watchdog firing right as maybeScheduleAiTurn's own timer
  // also fires) could sneak in, double-roll, and leave the turn stuck.
  if (gameMode !== 'solo' || !localState || localState.winner || localState.dice !== null || localState.rolling) return;
  localState.rolling = true;
  const color = localState.turn;
  const value = 1 + Math.floor(Math.random() * 6);

  animateDiceRoll(value, () => {
    localState.rolling = false;
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
    if (isBotColor(color)) {
      setTimeout(() => aiMakeMove(), 700 + Math.random() * 600);
    }
  });
}

function localMoveToken(tokenIndex) {
  // isAnimating guards against a second move (e.g. a re-triggered aiMakeMove)
  // landing while the previous one is still gliding to its cell.
  if (gameMode !== 'solo' || !localState || localState.winner || isAnimating) return;
  const color = localState.turn;
  if (localState.dice === null || !localState.validMoves.includes(tokenIndex)) return;

  const diceValue = localState.dice;
  const fromD = localState.tokens[color][tokenIndex];
  const path = computeStepPath(color, fromD, diceValue);
  const willFinish = (fromD === -1 ? 0 : fromD + diceValue) === 56;

  isAnimating = true;
  animateTokenMove(color, tokenIndex, path, localState, willFinish, () => {
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
    if (color === myColor) {
      addCoins(1000);
    }
    applyState(localState);
    if (color === myColor) {
      showToast(`${playerLabel(color)} hat gewonnen! +1.000 BC 🪙`);
    } else {
      showToast(`${playerLabel(color)} hat gewonnen!`);
    }
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
  if (!isBotColor(localState.turn) || localState.dice !== null) return;
  setTimeout(() => {
    if (gameMode === 'solo' && localState && !localState.winner && isBotColor(localState.turn) && localState.dice === null) {
      localRollDice();
    }
  }, 1000 + Math.random() * 1000);
}

// Mirrors the server's bot heuristic (see botPickMove in server.js): prefer
// a capturing move, then leaving base on a 6, else the token furthest along.
function aiPickMove(state, color, diceValue) {
  const tokens = state.tokens[color];
  const validMoves = state.validMoves;
  const enemyColors = enemyColorsOf(state, color);

  function wouldCapture(tokenIndex) {
    const d = tokens[tokenIndex];
    const newD = d === -1 ? 0 : d + diceValue;
    if (newD < 0 || newD > 50) return false;
    const abs = (START_OFFSET[color] + newD) % RING_LENGTH;
    if (SAFE_CELLS.has(abs)) return false;
    return enemyColors.some((ec) => state.tokens[ec].some(
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

function aiMakeMove() {
  if (gameMode !== 'solo' || !localState || localState.winner) return;
  const color = localState.turn;
  if (!isBotColor(color) || localState.dice === null) return;
  const idx = aiPickMove(localState, color, localState.dice);
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
  ctx.strokeStyle = opts.border || 'rgba(0,0,0,0.3)';
  ctx.lineWidth = opts.borderWidth || 1.5;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

const LIGHT_TINT = { red: '#fca5a5', blue: '#93c5fd', yellow: '#fde047', green: '#86efac' };

// Which colors actually have a player - only these get a yard, home stretch,
// base slots and tokens drawn (a 1v1 game shows just 2 corners, not all 4).
function activeColorsOf(state) {
  return (state && state.activeColors && state.activeColors.length) ? state.activeColors : ALL_COLORS;
}

function drawBoard(state) {
  const activeColors = activeColorsOf(state);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  ctx.fillStyle = '#1e1b4b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Corner yards (6x6), one per active color - bold solid color with a
  // classic white "tray" inset holding the 4 base slots.
  if (activeColors.includes('red')) drawYard(0, 0, 'red');       // top-left
  if (activeColors.includes('green')) drawYard(0, 9, 'green');   // top-right
  if (activeColors.includes('yellow')) drawYard(9, 9, 'yellow'); // bottom-right
  if (activeColors.includes('blue')) drawYard(9, 0, 'blue');     // bottom-left

  // Ring path cells
  RING_PATH.forEach(([r, c], idx) => {
    const isSafe = SAFE_CELLS.has(idx);
    const startColor = activeColors.find((color) => START_OFFSET[color] === idx);
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
  activeColors.forEach((color) => {
    HOME_PATHS[color].forEach(([r, c]) => drawCell(r, c, LIGHT_TINT[color], { border: 'rgba(0,0,0,0.35)' }));
  });

  // Center home triangle
  drawCenter();

  // Base slots: solid colored "sockets" set into the yard's white tray,
  // classic Ludo-board look (replaces the previous plain dashed circles).
  activeColors.forEach((color) => {
    BASE_SPOTS[color].forEach(([r, c]) => {
      const { x, y, w, h } = cellRect(r, c);
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, w * 0.34, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, w * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = LIGHT_TINT[color];
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = COLOR_DARK[color];
      ctx.stroke();
    });
  });

  if (state) drawTokens(state);
  drawParticles();
}

function drawYard(rowStart, colStart, color) {
  const { x, y } = cellRect(rowStart, colStart);
  const size = CELL * 6;

  // Bold solid-color outer panel with a darker rim, instead of the previous
  // muted dark-to-light gradient - a clearer, more "classic board" look.
  roundRect(ctx, x + 3, y + 3, size - 6, size - 6, 20);
  ctx.fillStyle = COLOR_HEX[color];
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = COLOR_DARK[color];
  ctx.stroke();

  // White inner "tray" that holds the base slots, like a real board.
  const inset = size * 0.16;
  roundRect(ctx, x + inset, y + inset, size - inset * 2, size - inset * 2, 14);
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
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

// --- Glow + "Boom" finish particles --------------------------------------------
function drawGlow(cx, cy, radius, colorHex) {
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0, `${colorHex}aa`);
  grad.addColorStop(1, `${colorHex}00`);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
}

let particles = [];
let particleAnimHandle = null;

// Short "💥 Boom" burst when a token reaches home - runs its own rAF loop
// (independent of game-state redraws) since nothing else keeps painting the
// canvas once the move animation itself has finished.
function spawnBoomParticles(pixel, color) {
  const hex = COLOR_HEX[color] || '#ffffff';
  for (let i = 0; i < 18; i++) {
    const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.3;
    const speed = 2 + Math.random() * 3;
    particles.push({
      x: pixel.x,
      y: pixel.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      color: hex,
      size: 2 + Math.random() * 2.5,
    });
  }
  startParticleLoop();
}

function startParticleLoop() {
  if (particleAnimHandle) return; // already running - new particles just join in
  let lastTime = performance.now();
  function tick(now) {
    const dt = Math.min(48, now - lastTime) / 16.6;
    lastTime = now;
    particles.forEach((p) => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.15 * dt; // gravity
      p.life -= 0.035 * dt;
    });
    particles = particles.filter((p) => p.life > 0);
    drawBoard(gameMode === 'solo' ? localState : currentState);
    particleAnimHandle = particles.length > 0 ? requestAnimationFrame(tick) : null;
  }
  particleAnimHandle = requestAnimationFrame(tick);
}

function drawParticles() {
  particles.forEach((p) => {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

// --- Pawn rendering ("Mensch ärgere dich nicht" style: round head + cone body) --
function drawPawn(cx, cy, radius, color) {
  const bodyHalfBottom = radius * 0.95;
  const bodyHalfTop = radius * 0.42;
  const bodyBottomY = cy + radius * 0.9;
  const bodyTopY = cy - radius * 0.12;
  const collarHalfWidth = radius * 0.52;
  const headCy = cy - radius * 0.78;
  const headR = radius * 0.55;

  // ground shadow
  ctx.beginPath();
  ctx.ellipse(cx, bodyBottomY + radius * 0.05, bodyHalfBottom * 1.1, radius * 0.24, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fill();

  // Body: curved (not straight) taper for a turned-wood peg silhouette,
  // with a left-to-right gradient that reads as a lit cylinder.
  ctx.beginPath();
  ctx.moveTo(cx - bodyHalfBottom, bodyBottomY);
  ctx.quadraticCurveTo(cx - bodyHalfBottom * 0.85, cy + radius * 0.15, cx - bodyHalfTop, bodyTopY);
  ctx.lineTo(cx + bodyHalfTop, bodyTopY);
  ctx.quadraticCurveTo(cx + bodyHalfBottom * 0.85, cy + radius * 0.15, cx + bodyHalfBottom, bodyBottomY);
  ctx.closePath();
  const bodyGrad = ctx.createLinearGradient(cx - bodyHalfBottom, 0, cx + bodyHalfBottom, 0);
  bodyGrad.addColorStop(0, COLOR_DARK[color]);
  bodyGrad.addColorStop(0.32, COLOR_HEX[color]);
  bodyGrad.addColorStop(0.52, LIGHT_TINT[color]);
  bodyGrad.addColorStop(0.72, COLOR_HEX[color]);
  bodyGrad.addColorStop(1, COLOR_DARK[color]);
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.lineWidth = Math.max(1, radius * 0.1);
  ctx.strokeStyle = COLOR_DARK[color];
  ctx.stroke();

  // Collar ring where body meets head - the "turned wood peg" detail line.
  ctx.beginPath();
  ctx.ellipse(cx, bodyTopY, collarHalfWidth, radius * 0.12, 0, 0, Math.PI * 2);
  ctx.fillStyle = COLOR_DARK[color];
  ctx.fill();

  // Glossy round head
  ctx.beginPath();
  ctx.arc(cx, headCy, headR, 0, Math.PI * 2);
  const headGrad = ctx.createRadialGradient(cx - headR * 0.35, headCy - headR * 0.35, headR * 0.08, cx, headCy, headR * 1.05);
  headGrad.addColorStop(0, '#ffffff');
  headGrad.addColorStop(0.25, LIGHT_TINT[color]);
  headGrad.addColorStop(0.75, COLOR_HEX[color]);
  headGrad.addColorStop(1, COLOR_DARK[color]);
  ctx.fillStyle = headGrad;
  ctx.fill();
  ctx.lineWidth = Math.max(1, radius * 0.1);
  ctx.strokeStyle = COLOR_DARK[color];
  ctx.stroke();

  // Shine highlight (elongated, glossier than a plain circle)
  ctx.save();
  ctx.translate(cx - headR * 0.3, headCy - headR * 0.35);
  ctx.rotate(-0.5);
  ctx.beginPath();
  ctx.ellipse(0, 0, headR * 0.32, headR * 0.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fill();
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

  activeColorsOf(state).forEach((color) => {
    (state.tokens[color] || []).forEach((dist, idx) => {
      // The animating token is drawn separately below at its exact
      // interpolated pixel position, not snapped to a cell/group.
      if (animatingTokenInfo && animatingTokenInfo.color === color && animatingTokenInfo.idx === idx) return;
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
        ctx.arc(cx, cy, radius + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fill();
        ctx.restore();
      }

      drawPawn(cx, cy, radius, t.color);
    });
  });

  // The moving token: drawn at its interpolated pixel position with a glow.
  if (animatingTokenInfo) {
    const { color, pixel } = animatingTokenInfo;
    const radius = CELL * 0.32;
    drawGlow(pixel.x, pixel.y, radius * 1.8, COLOR_HEX[color]);
    drawPawn(pixel.x, pixel.y, radius, color);
  }

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
      hitboxes.push({ cx, cy, radius: radius + 8, color: t.color, idx: t.idx });
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

// Returning to the page with a saved login: try to restore it silently
// instead of forcing the player through the login form again.
const savedSession = getSession();
if (savedSession) {
  ensureConnected();
  showReconnectBanner('🔐 Sitzung wird wiederhergestellt...');
  socket.emit('authRestoreSession', savedSession);
}

// initial empty draw
drawBoard(null);
showScreen('account');

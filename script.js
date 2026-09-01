(function () {
  const AVATARS = ['🦊', '🐸', '🦁', '🐵', '🐼', '🐰', '🐨', '🐯'];
  const MAX_PLAYERS = 8;
  const TAP_AMOUNT = 6;
  const TRACK_GOAL = 100;
  const COUNTDOWN_MS = 3000;
  const LANE_COUNT = 3;
  const ROAD_SCROLL_SPEED = 2.2;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CONTROL_BONUSES = {
    tap: TAP_AMOUNT,
    left: 5,
    up: 10,
    right: 7
  };

  const firebaseConfig = {
    apiKey: "AIzaSyBUdcVQPzV7ThowDE3-N2u35tnGRcooSiE",
    authDomain: "taptap-ec46c.firebaseapp.com",
    databaseURL: "https://taptap-ec46c-default-rtdb.asia-southeast1.firebasedatabase.app/",
    projectId: "taptap-ec46c",
    storageBucket: "taptap-ec46c.firebasestorage.app",
    messagingSenderId: "58480959375",
    appId: "1:58480959375:web:7ec0f6f084d80f6c8275fa",
    measurementId: "G-6R71MV4GXC"
  };

  function firebaseIsConfigured() {
    return !Object.values(firebaseConfig).some((value) => typeof value === 'string' && value.includes('YOUR_'));
  }

  const firebaseReady = !!window.firebase && firebaseIsConfigured();

  if (window.firebase && !firebase.apps.length && firebaseReady) {
    firebase.initializeApp(firebaseConfig);
  }
  const db = firebaseReady && window.firebase ? firebase.database() : null;

  let playerId = 'p_' + Math.random().toString(36).slice(2, 10);
  let playerName = localStorage.getItem('tapRaceName') || '';
  let avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  let roomCode = '';
  let roomRef = null;
  let roomListener = null;
  let screen = 'mode';
  let gameMode = null;
  let errorMsg = '';
  let joinCodeDraft = '';
  let roomData = null;
  let lastTapTime = 0;
  let tapCombo = 0;
  let audioCtx = null;
  let firebaseStatus = {
    connected: false,
    message: 'Checking Firebase connection…'
  };

  const root = document.getElementById('trRoot');

  function setupFirebaseStatus() {
    if (!db || !db.ref) return;
    db.ref('.info/connected').on('value', (snapshot) => {
      firebaseStatus.connected = !!snapshot.val();
      firebaseStatus.message = firebaseStatus.connected
        ? 'Connected to Firebase ✅'
        : 'Firebase not connected yet';
      if (screen === 'join' || screen === 'lobby' || screen === 'race' || screen === 'final') {
        render();
      }
    });
  }

  function playTapSound() {
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      if (!audioCtx) audioCtx = new AudioCtor();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const now = audioCtx.currentTime;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(540 + tapCombo * 24, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.06, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.13);
    } catch (e) {
      // ignore audio failures silently
    }
  }

  function resetTapMomentum() {
    lastTapTime = 0;
    tapCombo = 0;
  }

  function isTouchDevice() {
    return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  function getBoostValue(action = 'tap') {
    const base = CONTROL_BONUSES[action] || TAP_AMOUNT;
    const now = Date.now();
    const timeSinceLastTap = lastTapTime ? now - lastTapTime : Infinity;
    const rhythmBonus = timeSinceLastTap < 260 ? 3 : 0;
    tapCombo = timeSinceLastTap < 260 ? tapCombo + 1 : 1;
    const streakBonus = tapCombo >= 3 ? 4 : 0;
    return base + rhythmBonus + streakBonus;
  }

  function genCode() {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c;
  }

  function roomPath(code) { return `rooms/${code}`; }
  function roomPlayers(room) { return room && room.players ? Object.values(room.players) : []; }

  function isHost() {
    return !!roomData && roomData.hostId === playerId;
  }

  function attachRoomListener(code) {
    if (roomRef) { roomRef.off('value', roomListener); }
    roomRef = db.ref(roomPath(code));
    roomListener = roomRef.on('value', (snapshot) => {
      const data = snapshot.val();
      roomData = data || null;
      if (!roomData) {
        roomCode = '';
        screen = 'join';
        render();
        return;
      }

      if (roomData.phase === 'countdown' && roomData.startedAt && Date.now() >= roomData.startedAt) {
        roomRef.update({ phase: 'racing' }).catch(() => { });
      }

      if (roomData.phase === 'racing') {
        const winner = Object.values(roomData.players || {}).find((p) => (p.progress || 0) >= TRACK_GOAL);
        if (winner && winner.id && roomData.winnerId !== winner.id) {
          const updatedScores = { ...(roomData.scores || {}) };
          updatedScores[winner.id] = (updatedScores[winner.id] || 0) + 1;
          roomRef.update({
            phase: 'finished',
            winnerId: winner.id,
            scores: updatedScores
          }).catch(() => { });
        }
      }

      if (screen === 'lobby' && roomData.phase === 'countdown') screen = 'race';
      if (screen === 'lobby' && roomData.phase === 'racing') screen = 'race';
      if (screen === 'lobby' && roomData.phase === 'finished') screen = 'final';
      if (screen === 'race' && roomData.phase === 'finished') screen = 'final';
      if (screen === 'final' && roomData.phase === 'lobby') screen = 'lobby';
      render();
    });
  }

  async function createRoom() {
    if (!db) {
      errorMsg = 'Multiplayer needs Firebase set up in this project first.';
      render();
      return;
    }

    errorMsg = '';
    if (!playerName.trim()) { errorMsg = 'Type a name first!'; render(); return; }
    playerName = playerName.trim();
    localStorage.setItem('tapRaceName', playerName);

    roomCode = genCode();
    const player = { id: playerId, name: playerName, avatar, progress: 0, finished: false, joinedAt: Date.now() };
    const room = {
      code: roomCode,
      hostId: playerId,
      phase: 'lobby',
      startedAt: null,
      winnerId: null,
      createdAt: Date.now(),
      scores: {},
      players: { [playerId]: player },
      maxProgress: TRACK_GOAL
    };

    await db.ref(roomPath(roomCode)).set(room);
    roomData = room;
    attachRoomListener(roomCode);
    screen = 'lobby';
    render();
  }

  async function joinRoom() {
    if (!db) {
      errorMsg = 'Multiplayer needs Firebase set up in this project first.';
      render();
      return;
    }

    errorMsg = '';
    if (!playerName.trim()) { errorMsg = 'Type a name first!'; render(); return; }
    playerName = playerName.trim();
    localStorage.setItem('tapRaceName', playerName);

    const code = joinCodeDraft.trim().toUpperCase();
    if (code.length < 4) { errorMsg = 'Enter the 4-letter race code.'; render(); return; }

    const snap = await db.ref(roomPath(code)).once('value');
    if (!snap.exists()) { errorMsg = "Can't find that race. Check the code!"; render(); return; }

    const room = snap.val();
    if (!room || !room.players) { errorMsg = "This room is invalid."; render(); return; }
    if (Object.keys(room.players).length >= MAX_PLAYERS) { errorMsg = 'This room is full.'; render(); return; }

    const usedAvatars = new Set(Object.values(room.players).map((p) => p.avatar));
    avatar = AVATARS.find((a) => !usedAvatars.has(a)) || avatar;

    const player = { id: playerId, name: playerName, avatar, progress: 0, finished: false, joinedAt: Date.now() };
    const players = { ...room.players };
    if (!players[playerId]) {
      players[playerId] = player;
      await db.ref(roomPath(code)).update({ players });
    }

    roomCode = code;
    roomData = { ...room, players };
    attachRoomListener(code);
    screen = roomData.phase === 'finished' ? 'final' : 'lobby';
    render();
  }

  async function startRace() {
    if (!db) {
      errorMsg = 'Multiplayer needs Firebase set up in this project first.';
      render();
      return;
    }

    if (!roomData || !isHost()) return;
    resetTapMomentum();

    const players = {};
    Object.values(roomData.players || {}).forEach((player) => {
      players[player.id] = { ...player, progress: 0, finished: false };
    });

    const nextRoom = {
      ...roomData,
      phase: 'countdown',
      startedAt: Date.now() + COUNTDOWN_MS,
      winnerId: null,
      players
    };

    await db.ref(roomPath(roomCode)).set(nextRoom);
  }

  function updatePlayerProgressFromAction(action = 'tap') {
    if (!roomData || roomData.phase !== 'racing') return;

    if (gameMode === 'solo') {
      if (action === 'left') {
        roomData.playerLane = Math.max(0, (roomData.playerLane || 1) - 1);
      } else if (action === 'right') {
        roomData.playerLane = Math.min(LANE_COUNT - 1, (roomData.playerLane || 1) + 1);
      } else if (action === 'up' || action === 'tap') {
        const boostValue = getBoostValue(action);
        const playerEntry = roomData.players && roomData.players[playerId];
        if (!playerEntry) return;

        const nextProgress = Math.min(TRACK_GOAL, (playerEntry.progress || 0) + boostValue + 4);
        lastTapTime = Date.now();
        playTapSound();

        const players = { ...roomData.players };
        players[playerId] = { ...playerEntry, progress: nextProgress, finished: nextProgress >= TRACK_GOAL };
        roomData = { ...roomData, players };

        if (nextProgress >= TRACK_GOAL) {
          const scores = { ...(roomData.scores || {}) };
          scores[playerId] = (scores[playerId] || 0) + 1;
          roomData.phase = 'finished';
          roomData.winnerId = playerId;
          roomData.scores = scores;
          resetTapMomentum();
          screen = 'final';
          render();
          return;
        }
      }
      render();
      return;
    }

    const playerEntry = roomData.players && roomData.players[playerId];
    if (!playerEntry) return;

    const boostValue = getBoostValue(action);
    const nextProgress = Math.min(TRACK_GOAL, (playerEntry.progress || 0) + boostValue);
    lastTapTime = Date.now();
    playTapSound();

    const players = { ...roomData.players };
    players[playerId] = { ...playerEntry, progress: nextProgress, finished: nextProgress >= TRACK_GOAL };

    const updatedRoom = { ...roomData, players };

    if (nextProgress >= TRACK_GOAL) {
      const scores = { ...(roomData.scores || {}) };
      scores[playerId] = (scores[playerId] || 0) + 1;
      updatedRoom.phase = 'finished';
      updatedRoom.winnerId = playerId;
      updatedRoom.scores = scores;
      resetTapMomentum();
      roomData = updatedRoom;
      screen = 'final';
      render();
      return;
    }

    roomData = updatedRoom;
    render();
  }

  async function handleTap() {
    updatePlayerProgressFromAction('tap');

    if (gameMode !== 'solo' && roomCode && db && roomData && roomData.phase === 'racing') {
      await db.ref(roomPath(roomCode)).update(roomData);
    }
  }

  async function handleControlAction(action) {
    if (!roomData || roomData.phase !== 'racing') return;

    updatePlayerProgressFromAction(action);

    if (gameMode !== 'solo' && roomCode && db && roomData && roomData.phase === 'racing') {
      await db.ref(roomPath(roomCode)).update(roomData);
    }
  }

  async function rematch() {
    resetTapMomentum();

    if (gameMode === 'solo') {
      roomData = createSoloRoomState();
      screen = 'race';
      render();
      return;
    }

    if (!roomData || !isHost()) return;

    const players = {};
    Object.values(roomData.players || {}).forEach((player) => {
      players[player.id] = { ...player, progress: 0, finished: false };
    });

    await db.ref(roomPath(roomCode)).update({
      phase: 'lobby',
      startedAt: null,
      winnerId: null,
      players
    });
  }

  async function leaveCurrentRoom() {
    if (!roomCode || !roomData || !roomData.players || !roomData.players[playerId]) return;

    const players = { ...roomData.players };
    delete players[playerId];

    if (Object.keys(players).length === 0) {
      await db.ref(roomPath(roomCode)).remove();
      roomCode = '';
      roomData = null;
      screen = 'join';
      render();
      return;
    }

    const nextHostId = roomData.hostId === playerId ? Object.keys(players)[0] : roomData.hostId;
    const nextRoom = {
      ...roomData,
      hostId: nextHostId,
      players,
      phase: 'lobby',
      startedAt: null,
      winnerId: null
    };

    await db.ref(roomPath(roomCode)).update(nextRoom);
    roomCode = '';
    roomData = null;
    screen = 'join';
    render();
  }

  function renderClouds() {
    const el = document.getElementById('trClouds');
    if (!el || el.childElementCount) return;
    const specs = [
      { w: 120, h: 40, t: '8%', l: '-10%' },
      { w: 80, h: 30, t: '20%', l: '70%' },
      { w: 100, h: 34, t: '55%', l: '-15%' },
    ];
    el.innerHTML = specs.map((s) => `<div class="tr-cloud" style="width:${s.w}px;height:${s.h}px;top:${s.t};left:${s.l};"></div>`).join('');
  }

  function createSoloRoomState() {
    const aiPlayers = [
      { id: 'ai_1', name: 'Blaze', avatar: '🐺', progress: 0, finished: false },
      { id: 'ai_2', name: 'Nova', avatar: '🦊', progress: 0, finished: false },
      { id: 'ai_3', name: 'Vex', avatar: '🐯', progress: 0, finished: false }
    ];

    const players = {
      [playerId]: { id: playerId, name: playerName, avatar, progress: 0, finished: false },
      ...Object.fromEntries(aiPlayers.map((p) => [p.id, p]))
    };

    const scores = Object.fromEntries(Object.keys(players).map((id) => [id, 0]));

    return {
      code: 'SOLO',
      hostId: playerId,
      phase: 'racing',
      startedAt: Date.now(),
      winnerId: null,
      scores,
      players,
      playerLane: 1,
      obstacles: [],
      rivalCars: [
        { id: 'rival_1', lane: 0, y: 18, speed: 2.2 },
        { id: 'rival_2', lane: 2, y: 34, speed: 2.7 },
        { id: 'rival_3', lane: 1, y: 50, speed: 2.5 }
      ],
      lives: 3,
      crashFlash: false,
      speed: 0,
      maxProgress: TRACK_GOAL
    };
  }

  function getLanePosition(laneIndex) {
    const laneProportions = [18, 50, 82];
    return laneProportions[Math.min(Math.max(laneIndex, 0), LANE_COUNT - 1)] + '%';
  }

  function spawnObstacle() {
    if (!roomData || gameMode !== 'solo' || roomData.phase !== 'racing') return;
    const lane = Math.floor(Math.random() * LANE_COUNT);
    const obstacle = {
      id: `obs_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      lane,
      y: -12,
      speed: 3 + Math.random() * 2.8
    };
    roomData.obstacles = [...(roomData.obstacles || []), obstacle];
  }

  function updateSoloRaceLoop() {
    if (!roomData || gameMode !== 'solo' || roomData.phase !== 'racing') return;

    const now = Date.now();
    if (!roomData.lastSpawnAt || now - roomData.lastSpawnAt > 900) {
      spawnObstacle();
      roomData.lastSpawnAt = now;
    }

    roomData.speed = Math.min(220, (roomData.speed || 60) + 4);

    const activeObstacles = (roomData.obstacles || []).map((obstacle) => ({
      ...obstacle,
      y: obstacle.y + obstacle.speed
    })).filter((obstacle) => obstacle.y < 110);

    let lives = roomData.lives || 3;
    const remainingObstacles = [];
    activeObstacles.forEach((obstacle) => {
      const collided = obstacle.lane === (roomData.playerLane ?? 1) && obstacle.y >= 70 && obstacle.y <= 92;
      if (collided) {
        lives -= 1;
        roomData.crashFlash = true;
        setTimeout(() => {
          if (roomData && roomData.crashFlash) roomData.crashFlash = false;
        }, 180);
        return;
      }
      remainingObstacles.push(obstacle);
    });

    roomData.obstacles = remainingObstacles;
    roomData.lives = Math.max(0, lives);

    roomData.rivalCars = (roomData.rivalCars || []).map((car) => ({
      ...car,
      y: car.y + car.speed + ROAD_SCROLL_SPEED
    })).filter((car) => car.y < 120);

    if (!roomData.rivalCars.length || roomData.rivalCars[roomData.rivalCars.length - 1].y > 44) {
      roomData.rivalCars.push({
        id: `rival_${Date.now()}`,
        lane: Math.floor(Math.random() * LANE_COUNT),
        y: -16,
        speed: 2.2 + Math.random() * 1.6
      });
    }

    if (roomData.rivalCars.some((car) => car.lane === (roomData.playerLane ?? 1) && car.y >= 70 && car.y <= 94)) {
      roomData.lives = Math.max(0, (roomData.lives || 1) - 1);
      roomData.crashFlash = true;
      setTimeout(() => {
        if (roomData && roomData.crashFlash) roomData.crashFlash = false;
      }, 180);
      roomData.rivalCars = roomData.rivalCars.filter((car) => !(car.lane === (roomData.playerLane ?? 1) && car.y >= 70 && car.y <= 94));
    }

    if (roomData.lives <= 0) {
      roomData.phase = 'finished';
      roomData.winnerId = 'crash';
      roomData.scores = {
        ...roomData.scores,
        [playerId]: Math.max(0, (roomData.scores && roomData.scores[playerId]) || 0)
      };
      screen = 'final';
      return;
    }

    if (roomData.players && roomData.players[playerId]) {
      const playerEntry = roomData.players[playerId];
      const progressBoost = 0.8;
      roomData.players[playerId] = {
        ...playerEntry,
        progress: Math.min(TRACK_GOAL, (playerEntry.progress || 0) + progressBoost),
        finished: (playerEntry.progress || 0) + progressBoost >= TRACK_GOAL
      };
      if ((roomData.players[playerId].progress || 0) >= TRACK_GOAL) {
        roomData.phase = 'finished';
        roomData.winnerId = playerId;
        roomData.scores[playerId] = (roomData.scores[playerId] || 0) + 1;
        screen = 'final';
      }
    }
  }

  function beginSoloRace() {
    if (!playerName.trim()) {
      errorMsg = 'Type a name first!';
      render();
      return;
    }

    playerName = playerName.trim();
    localStorage.setItem('tapRaceName', playerName);
    errorMsg = '';
    gameMode = 'solo';
    roomCode = 'SOLO';
    roomData = createSoloRoomState();
    screen = 'race';
    render();
  }

  function screenModeSelect() {
    const multiplayerLabel = firebaseReady ? '🌐 Multiplayer' : '🌐 Multiplayer unavailable';

    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span> ⚡</div>
        <div class="tr-sub">Pick your mode before you race.</div>
        <div class="tr-status ${firebaseReady ? 'ok' : 'warn'}">${firebaseReady ? 'Firebase ready for multiplayer' : 'Solo mode is available without Firebase'}</div>
        <button class="tr-btn tr-btn-primary" id="soloModeBtn">🏁 Solo Race</button>
        <button class="tr-btn tr-btn-secondary" id="multiModeBtn" ${firebaseReady ? '' : 'disabled'}>${multiplayerLabel}</button>
      </div>
    `;
  }

  function screenSoloSetup() {
    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span> ⚡</div>
        <div class="tr-sub">Solo mode: race the AI.</div>
        <div class="tr-error">${errorMsg}</div>
        <input class="tr-field" id="nameInput" maxlength="12" placeholder="Your name" value="${playerName}" style="text-transform:none" />
        <button class="tr-btn tr-btn-primary" id="soloStartBtn">Start Solo Race</button>
        <button class="tr-btn tr-btn-secondary" id="backToModeBtn">Back</button>
      </div>
    `;
  }

  function faceHTML(name, avatarEmoji, size) {
    const sizeClass = size === 'md' ? 'tr-face-md' : 'tr-face-sm';
    const slug = (name || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!slug) return `<span class="emoji">${avatarEmoji}</span>`;

    const candidateSources = [
      `assets/images/${slug}.png`,
      `assets/images/${slug}.svg`,
      'assets/images/default-player.svg'
    ];

    const fallbackMarkup = `<span class="emoji">${avatarEmoji}</span>`;
    return `<img class="tr-face ${sizeClass}" src="${candidateSources[0]}" alt="${name}" onerror="this.onerror=null; const next = this.getAttribute('data-next'); if (next) { this.src = next; this.setAttribute('data-next', ''); } else { this.outerHTML='${fallbackMarkup.replace(/'/g, "\\'")}'; }" data-next="${candidateSources[1]}" />`;
  }

  function playerBadge(name, avatarEmoji, extraClass = '') {
    return `<div class="tr-player-badge ${extraClass}">${faceHTML(name, avatarEmoji, 'sm')}</div>`;
  }

  function screenJoin() {
    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span> ⚡</div>
        <div class="tr-sub">Tap to win the track!</div>
        <div class="tr-status ${firebaseStatus.connected ? 'ok' : 'warn'}">${firebaseStatus.message}</div>
        <div class="tr-error">${errorMsg}</div>
        <input class="tr-field" id="nameInput" maxlength="12" placeholder="Your name" value="${playerName}" style="text-transform:none" />
        <button class="tr-btn tr-btn-primary" id="createBtn">🏁 Start a New Race</button>
        <div class="tr-divider">— or —</div>
        <input class="tr-field" id="codeInput" maxlength="4" placeholder="Race code" value="${joinCodeDraft}" />
        <button class="tr-btn tr-btn-secondary" id="joinBtn">Join a Race</button>
        <button class="tr-btn tr-btn-secondary" id="backToModeBtn" style="background:#7B8BA6; box-shadow:0 6px 0 #5D6D8A;">Back</button>
      </div>
    `;
  }

  function screenLobby() {
    const roster = roomPlayers(roomData);
    const hostName = roomData && roomData.hostId ? (roomData.players && roomData.players[roomData.hostId] ? roomData.players[roomData.hostId].name : 'the host') : 'the host';
    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span></div>
        <div class="tr-sub">Get everyone in!</div>
        <div class="tr-code-badge">${roomCode}</div>
        <div class="tr-roster">
          ${roster.map((p) => `<div class="tr-chip ${p.id === roomData?.hostId ? 'host' : ''}">${faceHTML(p.name, p.avatar, 'md')}${p.name}${p.id === roomData?.hostId ? ' 👑' : ''}</div>`).join('')}
        </div>
        ${isHost() ? `<button class="tr-btn tr-btn-grass" id="startBtn" ${roster.length < 2 ? 'disabled' : ''}>${roster.length < 2 ? 'Waiting for a friend…' : '🏁 Start Race!'}</button>`
        : `<div class="tr-waiting">Waiting for ${hostName} to start…</div>`}
      </div>
    `;
  }

  function screenRace() {
    if (!roomData) return '<div class="tr-card">Loading…</div>';

    const countdownText = roomData.phase === 'countdown' && roomData.startedAt ? `Starts in ${Math.max(1, Math.ceil((roomData.startedAt - Date.now()) / 1000))}` : '';
    const myPlayer = roomData.players && roomData.players[playerId];
    const myProgress = Math.min(100, Math.max(0, Math.round((myPlayer?.progress || 0))));
    const roadTrees = Array.from({ length: 18 }, (_, i) => `<span class="tr-tree" style="top:${(i * 12) % 100}%; left:${(i % 2 === 0 ? 8 : 82)}%; animation-delay:${(i * 0.12).toFixed(2)}s"></span>`).join('');

    const speedValue = Math.min(220, Math.max(0, Math.round(roomData.speed || 75)));
    let raceCars = '';
    let obstacleMarkup = '';

    if (gameMode === 'solo') {
      const safeLane = Math.min(Math.max(roomData.playerLane ?? 1, 0), 2);
      const playerCarLeft = getLanePosition(safeLane);

      obstacleMarkup = (roomData.obstacles || []).map((obstacle) => `
        <div class="tr-obstacle" style="left:${getLanePosition(obstacle.lane)}; top:${obstacle.y}%;"></div>
      `).join('');

      raceCars = `
        <div class="tr-rival-car" style="left:${getLanePosition((roomData.rivalCars || [])[0]?.lane ?? 0)}; top:${(roomData.rivalCars || [])[0]?.y ?? 20}%"></div>
        <div class="tr-rival-car alt" style="left:${getLanePosition((roomData.rivalCars || [])[1]?.lane ?? 1)}; top:${(roomData.rivalCars || [])[1]?.y ?? 40}%"></div>
        <div class="tr-rival-car" style="left:${getLanePosition((roomData.rivalCars || [])[2]?.lane ?? 2)}; top:${(roomData.rivalCars || [])[2]?.y ?? 60}%"></div>
        <div class="tr-car player" style="left:${playerCarLeft}; bottom:12%;">
          <div class="tr-car-avatar">${faceHTML(playerName || 'You', avatar, 'sm')}</div>
          <span class="tr-car-body"></span>
          <span class="tr-wheel wheel-1"></span>
          <span class="tr-wheel wheel-2"></span>
        </div>
        ${obstacleMarkup}
      `;
    } else {
      const players = roomPlayers(roomData);
      raceCars = players.map((player, index) => {
        const progress = Math.min(100, Math.max(0, player.progress || 0));
        const laneSide = index % 2 === 0 ? 'left' : 'right';
        const bottom = Math.min(18, Math.max(8, 18 - progress * 0.12));
        const isMe = player.id === playerId;
        return `
          <div class="tr-car ${laneSide} ${isMe ? 'player' : 'enemy'}" style="bottom:${bottom}%; left:${laneSide === 'left' ? '27%' : '63%'}; transform: translateX(${Math.min(0, 56 - progress * 0.45)}px)">
            <div class="tr-car-avatar">${faceHTML(player.name, player.avatar, 'sm')}</div>
            <span class="tr-car-body"></span>
            <span class="tr-wheel wheel-1"></span>
            <span class="tr-wheel wheel-2"></span>
          </div>
        `;
      }).join('');
    }

    const virtualController = isTouchDevice() ? `
      <div class="tr-virtual-controller" aria-label="Race controls">
        <button class="tr-control-btn" data-control="left" aria-label="Left">◀</button>
        <button class="tr-control-btn tr-control-up" data-control="up" aria-label="Up">▲</button>
        <button class="tr-control-btn" data-control="right" aria-label="Right">▶</button>
      </div>
    ` : '';

    const raceButton = roomData.phase === 'racing' ? `<button class="tr-tap-btn" id="trTapButton">${gameMode === 'solo' ? 'BOOST' : 'TAP'}</button>` : '';

    return `
      <div class="tr-race-scene">
        <div class="tr-distance">DISTANCE: ${myProgress}M</div>
        <div class="tr-speed-meter"><span>SPEED</span><strong>${speedValue}</strong></div>
        <div class="tr-road-wrap">
          <div class="tr-road ${roomData.crashFlash ? 'tr-road-crash' : ''}">
            <div class="tr-road-line line-1"></div>
            <div class="tr-road-line line-2"></div>
            <div class="tr-road-line line-3"></div>
            <div class="tr-road-line line-4"></div>
            ${roadTrees}
            ${raceCars}
          </div>
        </div>
        ${gameMode === 'solo' && roomData.lives !== undefined ? `<div class="tr-lives">LIVES: ${roomData.lives}</div>` : ''}
        ${roomData.phase === 'countdown' ? `<div class="tr-race-overlay">${countdownText || 'RACE START!'}</div>` : ''}
        ${roomData.crashFlash ? '<div class="tr-crash-flash"></div>' : ''}
        ${raceButton}
        ${roomData.phase === 'racing' ? virtualController : ''}
        ${roomData.phase !== 'racing' && isHost() ? `<button class="tr-btn tr-btn-grass" id="startBtn" style="margin: 12px auto 0; max-width: 260px;">${countdownText ? 'Starting…' : 'Start Race'}</button>` : ''}
      </div>
    `;
  }

  function screenFinal() {
    const players = roomData ? roomData.players || {} : {};
    const scoreMap = { ...(roomData?.scores || {}) };
    Object.keys(players).forEach((id) => {
      if (scoreMap[id] === undefined) scoreMap[id] = 0;
    });

    const entries = Object.entries(scoreMap).map(([id, wins]) => ({
      id,
      wins,
      name: players[id]?.name || 'Player',
      avatar: players[id]?.avatar || '🏁'
    }));
    entries.sort((a, b) => b.wins - a.wins);

    const winner = roomData && roomData.winnerId ? players[roomData.winnerId] : null;
    const confettiColors = ['#FF5252', '#FFC93C', '#3EC070', '#4FC3E8', '#fff'];
    const confetti = Array.from({ length: 40 }).map((_, i) => {
      const left = Math.random() * 100;
      const delay = Math.random() * 0.6;
      const size = 6 + Math.random() * 6;
      const color = confettiColors[i % confettiColors.length];
      return `<span style="left:${left}%; width:${size}px; height:${size * 0.4}px; background:${color}; animation-delay:${delay}s;"></span>`;
    }).join('');

    const rematchControl = gameMode === 'solo'
      ? '<button class="tr-btn tr-btn-primary" id="rematchBtn" style="margin-top:14px;">🔁 Race Again</button>'
      : (isHost() ? '<button class="tr-btn tr-btn-primary" id="rematchBtn" style="margin-top:14px;">🔁 Race Again</button>' : '<div class="tr-waiting" style="margin-top:14px;">Waiting for a rematch…</div>');

    return `
      <div class="tr-confetti">${confetti}</div>
      <div class="tr-card">
        <div class="tr-crown">🏆</div>
        <h2>${winner ? `${winner.name} wins!` : 'Race finished!'}</h2>
        <div class="tr-sub">${winner ? `${winner.avatar} took the finish line` : 'The next race is ready.'}</div>
        <div class="tr-score-list">
          ${entries.length ? entries.map((entry, index) => `
            <div class="tr-score-row ${index === 0 ? 'winner' : ''}">
              <span>${index === 0 ? '🥇' : `#${index + 1}`} ${playerBadge(entry.name, players[entry.id]?.avatar || '🏁')}</span>
              <span>${entry.wins} pts</span>
            </div>
          `).join('') : '<div class="tr-waiting">No scores yet.</div>'}
        </div>
        ${rematchControl}
      </div>
    `;
  }

  function render() {
    renderClouds();
    let html = '';
    if (screen === 'mode') html = screenModeSelect();
    else if (screen === 'solo') html = screenSoloSetup();
    else if (screen === 'join') html = screenJoin();
    else if (screen === 'lobby') html = screenLobby();
    else if (screen === 'race') html = screenRace();
    else if (screen === 'final') html = screenFinal();
    root.innerHTML = html;
    wireEvents();
  }

  function wireEvents() {
    const soloModeBtn = document.getElementById('soloModeBtn');
    if (soloModeBtn) soloModeBtn.onclick = () => { screen = 'solo'; errorMsg = ''; render(); };

    const multiModeBtn = document.getElementById('multiModeBtn');
    if (multiModeBtn) multiModeBtn.onclick = () => {
      if (!firebaseReady || !db) {
        errorMsg = 'Multiplayer needs Firebase set up in this project first.';
        render();
        return;
      }
      gameMode = 'multiplayer'; screen = 'join'; errorMsg = ''; render();
    };

    const backToModeBtn = document.getElementById('backToModeBtn');
    if (backToModeBtn) backToModeBtn.onclick = () => { gameMode = null; screen = 'mode'; errorMsg = ''; render(); };

    const soloStartBtn = document.getElementById('soloStartBtn');
    if (soloStartBtn) soloStartBtn.onclick = beginSoloRace;

    const nameInput = document.getElementById('nameInput');
    if (nameInput) {
      nameInput.oninput = (e) => { playerName = e.target.value; localStorage.setItem('tapRaceName', playerName); };
    }
    const codeInput = document.getElementById('codeInput');
    if (codeInput) {
      codeInput.oninput = (e) => { joinCodeDraft = e.target.value.toUpperCase(); e.target.value = joinCodeDraft; };
    }
    const createBtn = document.getElementById('createBtn');
    if (createBtn) createBtn.onclick = createRoom;
    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) joinBtn.onclick = joinRoom;
    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.onclick = startRace;
    const tapBtn = document.getElementById('trTapButton');
    if (tapBtn) tapBtn.onclick = handleTap;
    const controllerButtons = document.querySelectorAll('[data-control]');
    controllerButtons.forEach((button) => {
      button.onclick = () => handleControlAction(button.dataset.control);
    });
    const rematchBtn = document.getElementById('rematchBtn');
    if (rematchBtn) rematchBtn.onclick = rematch;
  }

  window.addEventListener('keydown', (event) => {
    const mapped = {
      ArrowLeft: 'left',
      a: 'left',
      ArrowUp: 'up',
      w: 'up',
      ArrowRight: 'right',
      d: 'right'
    };

    const action = mapped[event.key] || mapped[event.key.toLowerCase()];
    if (!action) return;

    if ((event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'ArrowRight') && event.preventDefault) {
      event.preventDefault();
    }

    if (screen === 'race' && roomData && roomData.phase === 'racing') {
      handleControlAction(action);
    }
  });

  window.addEventListener('beforeunload', () => {
    if (roomCode && roomData && roomData.players && roomData.players[playerId]) {
      leaveCurrentRoom();
    }
  });

  setupFirebaseStatus();

  setInterval(() => {
    if (gameMode === 'solo' && roomData && roomData.phase === 'racing') {
      updateSoloRaceLoop();
      if (screen === 'race') render();
      return;
    }

    if (gameMode !== 'solo' && screen === 'race' && roomData && roomData.phase === 'countdown' && roomData.startedAt && Date.now() >= roomData.startedAt) {
      const update = { phase: 'racing' };
      if (db) db.ref(roomPath(roomCode)).update(update).catch(() => { });
    }
  }, 200);

  render();
})();

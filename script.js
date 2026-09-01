(function () {
  const AVATARS = ['🦊', '🐸', '🦁', '🐵', '🐼', '🐰', '🐨', '🐯'];
  const TRACK_GOAL = 1000;
  const LANE_COUNT = 3;
  const PLAYER_LIVES = 3;
  const COUNTDOWN_MS = 3000;

  const firebaseConfig = {
    apiKey: 'AIzaSyBUdcVQPzV7ThowDE3-N2u35tnGRcooSiE',
    authDomain: 'taptap-ec46c.firebaseapp.com',
    databaseURL: 'https://taptap-ec46c-default-rtdb.asia-southeast1.firebasedatabase.app/',
    projectId: 'taptap-ec46c',
    storageBucket: 'taptap-ec46c.firebasestorage.app',
    messagingSenderId: '58480959375',
    appId: '1:58480959375:web:7ec0f6f084d80f6c8275fa',
    measurementId: 'G-6R71MV4GXC'
  };

  const state = {
    playerId: 'p_' + Math.random().toString(36).slice(2, 10),
    playerName: localStorage.getItem('tapRaceName') || '',
    avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
    screen: 'mode',
    mode: null,
    roomCode: '',
    roomData: null,
    roomRef: null,
    roomListener: null,
    joinCodeDraft: '',
    errorMsg: '',
    db: null,
    firebaseReady: false,
    firebaseStatus: { connected: false, message: 'Checking Firebase…' },
    leaderboard: []
  };

  const root = document.getElementById('trRoot');

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  function firebaseIsConfigured() {
    return Object.values(firebaseConfig).every((value) => typeof value === 'string' && value && !value.includes('YOUR_'));
  }

  function setupFirebase() {
    state.firebaseReady = Boolean(window.firebase) && firebaseIsConfigured();
    if (!state.firebaseReady) return;
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    state.db = firebase.database();
    setupFirebaseStatus();
  }

  function setupFirebaseStatus() {
    if (!state.db || !state.db.ref) return;
    state.db.ref('.info/connected').on('value', (snapshot) => {
      state.firebaseStatus.connected = !!snapshot.val();
      state.firebaseStatus.message = snapshot.val() ? 'Firebase connected ✅' : 'Firebase reconnecting…';
      if (['join', 'lobby', 'race', 'final'].includes(state.screen)) {
        render();
      }
    });
  }

  function roomPath(code) {
    return `rooms/${code}`;
  }

  function roomPlayers(room) {
    return room && room.players ? Object.values(room.players) : [];
  }

  function getLanePercent(laneIndex) {
    const laneTargets = [18, 50, 82];
    return laneTargets[clamp(laneIndex, 0, LANE_COUNT - 1)] + '%';
  }

  function faceHTML(name, avatarEmoji, size = 'sm') {
    const sizeClass = size === 'md' ? 'tr-face-md' : 'tr-face-sm';
    return `<span class="tr-face ${sizeClass} tr-face-emoji" aria-label="${name || 'Player'} avatar">${avatarEmoji || '🏁'}</span>`;
  }

  function playerBadge(name, avatarEmoji = '🏁') {
    return `<div class="tr-player-badge">${faceHTML(name, avatarEmoji, 'sm')}</div>`;
  }

  function createSoloRaceState() {
    const player = {
      id: state.playerId,
      name: state.playerName.trim() || 'Driver',
      avatar: state.avatar,
      distance: 0,
      lane: 1,
      finished: false
    };

    return {
      phase: 'countdown',
      startedAt: Date.now() + COUNTDOWN_MS,
      winnerId: null,
      playerLane: 1,
      speed: 0,
      distance: 0,
      lives: PLAYER_LIVES,
      obstacles: [],
      rivalCars: [
        { id: 'rival_1', lane: 0, y: 18, speed: 1.2 },
        { id: 'rival_2', lane: 2, y: 42, speed: 1.5 },
        { id: 'rival_3', lane: 1, y: 68, speed: 1.9 }
      ],
      lastInputAt: 0,
      crashFlash: false,
      players: { [state.playerId]: player }
    };
  }

  function startSoloRace() {
    state.mode = 'solo';
    state.roomData = createSoloRaceState();
    state.screen = 'race';
    state.errorMsg = '';
    render();
  }

  function createPlayerEntry() {
    return {
      id: state.playerId,
      name: state.playerName.trim() || 'Driver',
      avatar: state.avatar,
      distance: 0,
      lane: 1,
      finished: false
    };
  }

  function spawnObstacle() {
    if (!state.roomData || state.mode !== 'solo' || state.roomData.phase !== 'racing') return;
    const lane = Math.floor(Math.random() * LANE_COUNT);
    state.roomData.obstacles.push({
      id: 'obs_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6),
      lane,
      y: -16,
      speed: 1.6 + Math.random() * 2.0
    });
  }

  function completeRace(winnerType) {
    if (!state.roomData) return;
    state.roomData.phase = 'finished';
    state.roomData.winnerId = winnerType === 'crash' ? 'crash' : state.playerId;
    state.screen = 'final';
    persistRaceResult();
    render();
  }

  function updateSoloRaceLoop() {
    if (!state.roomData || state.mode !== 'solo' || state.roomData.phase !== 'racing') return;

    const race = state.roomData;
    const now = Date.now();
    const hasInputRecently = now - (race.lastInputAt || 0) < 500;

    if (!hasInputRecently) {
      race.speed = 0;
      race.players[state.playerId] = {
        ...race.players[state.playerId],
        distance: race.distance,
        lane: race.playerLane ?? 1,
        finished: race.distance >= TRACK_GOAL
      };
      return;
    }

    race.speed = clamp((race.speed || 0) * 0.97 + 7, 0, 100);
    race.distance = Math.min(TRACK_GOAL, (race.distance || 0) + race.speed * 0.28);

    race.obstacles = (race.obstacles || [])
      .map((obstacle) => ({ ...obstacle, y: obstacle.y + 1.3 + (race.speed * 0.04) + obstacle.speed }))
      .filter((obstacle) => obstacle.y < 118);

    if (race.obstacles.length < 4 && Math.random() < 0.2) {
      spawnObstacle();
    }

    const playerLane = race.playerLane ?? 1;
    for (let i = race.obstacles.length - 1; i >= 0; i -= 1) {
      const obstacle = race.obstacles[i];
      const hit = obstacle.lane === playerLane && obstacle.y >= 66 && obstacle.y <= 92;
      if (hit) {
        race.lives = Math.max(0, (race.lives || 0) - 1);
        race.crashFlash = true;
        race.obstacles.splice(i, 1);
        setTimeout(() => {
          if (state.roomData) state.roomData.crashFlash = false;
        }, 180);
      }
    }

    if (race.lives <= 0) {
      completeRace('crash');
      return;
    }

    race.rivalCars = (race.rivalCars || [])
      .map((car) => ({ ...car, y: car.y + car.speed + 0.7 }))
      .filter((car) => car.y < 118);

    if (race.rivalCars.length < 3 || race.rivalCars[race.rivalCars.length - 1].y > 40) {
      race.rivalCars.push({
        id: 'rival_' + Date.now(),
        lane: Math.floor(Math.random() * LANE_COUNT),
        y: -16,
        speed: 1.2 + Math.random() * 1.5
      });
    }

    for (const rival of race.rivalCars) {
      if (rival.lane === playerLane && rival.y >= 66 && rival.y <= 92) {
        race.lives = Math.max(0, (race.lives || 0) - 1);
        race.crashFlash = true;
        setTimeout(() => {
          if (state.roomData) state.roomData.crashFlash = false;
        }, 180);
        race.rivalCars = race.rivalCars.filter((item) => item.id !== rival.id);
        break;
      }
    }

    if (race.lives <= 0) {
      completeRace('crash');
      return;
    }

    race.players[state.playerId] = {
      ...race.players[state.playerId],
      distance: race.distance,
      lane: playerLane,
      finished: race.distance >= TRACK_GOAL
    };

    if (race.distance >= TRACK_GOAL) {
      completeRace('finish');
      return;
    }
  }

  function handleControlAction(action) {
    if (!state.roomData) return;

    if (state.mode === 'solo' && state.screen === 'race') {
      if (action === 'left') {
        state.roomData.playerLane = clamp((state.roomData.playerLane ?? 1) - 1, 0, 2);
        state.roomData.lastInputAt = Date.now();
        render();
        return;
      }

      if (action === 'right') {
        state.roomData.playerLane = clamp((state.roomData.playerLane ?? 1) + 1, 0, 2);
        state.roomData.lastInputAt = Date.now();
        render();
        return;
      }

      if (action === 'up' || action === 'tap') {
        if (state.roomData.phase === 'countdown') {
          state.roomData.phase = 'racing';
        }
        state.roomData.lastInputAt = Date.now();
        state.roomData.speed = clamp((state.roomData.speed || 0) + 25, 0, 100);
        state.roomData.distance = Math.min(TRACK_GOAL, (state.roomData.distance || 0) + 24);
        state.roomData.players[state.playerId] = {
          ...state.roomData.players[state.playerId],
          distance: state.roomData.distance,
          lane: state.roomData.playerLane ?? 1,
          finished: state.roomData.distance >= TRACK_GOAL
        };
        if (state.roomData.distance >= TRACK_GOAL) {
          completeRace('finish');
          return;
        }
        render();
      }
      return;
    }

    if (state.mode === 'multiplayer' && state.roomData && state.roomData.phase === 'racing' && state.roomData.players && state.roomData.players[state.playerId]) {
      if (action === 'left') {
        state.roomData.players[state.playerId].lane = clamp((state.roomData.players[state.playerId].lane ?? 1) - 1, 0, 2);
        syncMultiplayerPlayer();
        render();
      }

      if (action === 'right') {
        state.roomData.players[state.playerId].lane = clamp((state.roomData.players[state.playerId].lane ?? 1) + 1, 0, 2);
        syncMultiplayerPlayer();
        render();
      }

      if (action === 'up' || action === 'tap') {
        state.roomData.players[state.playerId].distance = Math.min(TRACK_GOAL, (state.roomData.players[state.playerId].distance || 0) + 26);
        syncMultiplayerPlayer();
        render();
      }
    }
  }

  function syncMultiplayerPlayer() {
    if (!state.db || !state.roomCode || !state.roomData || !state.roomData.players || !state.roomData.players[state.playerId]) return;
    state.db.ref(roomPath(state.roomCode)).update({
      players: state.roomData.players,
      updatedAt: Date.now()
    }).catch(() => { });
  }

  async function saveHighScore(score, mode = state.mode || 'solo') {
    if (!state.db || !state.playerName.trim()) return;
    const safeName = state.playerName.trim().slice(0, 12);
    const ref = state.db.ref(`leaderboard/${mode}/${safeName}`);
    const current = await ref.once('value');
    const currentScore = Number(current.val()?.score || 0);
    if (currentScore >= Number(score) || !Number(score)) {
      return;
    }
    await ref.set({
      playerId: state.playerId,
      name: safeName,
      score: Number(score) || 0,
      mode,
      updatedAt: Date.now()
    });
  }

  async function loadLeaderboard(mode = state.mode || 'solo') {
    if (!state.db) {
      state.leaderboard = [];
      return [];
    }
    const snapshot = await state.db.ref(`leaderboard/${mode}`).once('value');
    const data = snapshot.val() || {};
    state.leaderboard = Object.values(data)
      .filter(Boolean)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 5);
    return state.leaderboard;
  }

  async function persistRaceResult() {
    if (!state.playerName.trim() || !state.roomData) return;
    const mode = state.mode || 'solo';
    const score = Math.round(state.mode === 'solo' ? (state.roomData.distance || 0) : (state.roomData.players?.[state.playerId]?.distance || 0));
    await saveHighScore(score, mode);
    await loadLeaderboard(mode);
  }

  function attachRoomListener(code) {
    if (state.roomRef && state.roomListener) {
      state.roomRef.off('value', state.roomListener);
    }

    state.roomRef = state.db.ref(roomPath(code));
    state.roomListener = state.roomRef.on('value', (snapshot) => {
      const data = snapshot.val();
      state.roomData = data || null;
      if (!state.roomData) {
        state.roomCode = '';
        state.screen = 'join';
        render();
        return;
      }

      if (state.roomData.phase === 'countdown' && state.roomData.startedAt && Date.now() >= state.roomData.startedAt) {
        state.roomRef.update({ phase: 'racing' }).catch(() => { });
      }

      if (state.roomData.phase === 'finished' && state.screen !== 'final') {
        state.screen = 'final';
      }

      if (state.screen === 'lobby' && state.roomData.phase === 'racing') {
        state.screen = 'race';
      }
      if (state.screen === 'race' && state.roomData.phase === 'finished') {
        state.screen = 'final';
      }
      render();
    });
  }

  async function createRoom() {
    if (!state.db) {
      state.errorMsg = 'Firebase is required for multiplayer.';
      render();
      return;
    }
    if (!state.playerName.trim()) {
      state.errorMsg = 'Type a name first.';
      render();
      return;
    }

    state.playerName = state.playerName.trim();
    localStorage.setItem('tapRaceName', state.playerName);
    state.errorMsg = '';
    state.roomCode = genCode();
    const player = createPlayerEntry();
    const room = {
      code: state.roomCode,
      hostId: state.playerId,
      phase: 'lobby',
      startedAt: null,
      winnerId: null,
      players: { [state.playerId]: { ...player, distance: 0, lane: 1, finished: false } },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await state.db.ref(roomPath(state.roomCode)).set(room);
    state.roomData = room;
    state.mode = 'multiplayer';
    state.screen = 'lobby';
    attachRoomListener(state.roomCode);
    render();
  }

  async function joinRoom() {
    if (!state.db) {
      state.errorMsg = 'Firebase is required for multiplayer.';
      render();
      return;
    }
    if (!state.playerName.trim()) {
      state.errorMsg = 'Type a name first.';
      render();
      return;
    }

    const code = state.joinCodeDraft.trim().toUpperCase();
    if (code.length < 4) {
      state.errorMsg = 'Enter the 4-letter room code.';
      render();
      return;
    }

    const snapshot = await state.db.ref(roomPath(code)).once('value');
    if (!snapshot.exists()) {
      state.errorMsg = 'Room not found.';
      render();
      return;
    }

    const room = snapshot.val();
    const player = createPlayerEntry();
    const players = { ...(room.players || {}), [state.playerId]: { ...player, distance: 0, lane: 1, finished: false } };
    await state.db.ref(roomPath(code)).update({ players, updatedAt: Date.now() });

    state.playerName = state.playerName.trim();
    localStorage.setItem('tapRaceName', state.playerName);
    state.roomCode = code;
    state.mode = 'multiplayer';
    state.screen = 'lobby';
    state.roomData = { ...room, players };
    attachRoomListener(code);
    render();
  }

  async function startRace() {
    if (!state.db || !state.roomData || !state.roomData.hostId || state.roomData.hostId !== state.playerId) return;
    const players = {};
    Object.values(state.roomData.players || {}).forEach((player) => {
      players[player.id] = { ...player, distance: 0, lane: 1, finished: false };
    });

    await state.db.ref(roomPath(state.roomCode)).set({
      ...state.roomData,
      phase: 'countdown',
      startedAt: Date.now() + COUNTDOWN_MS,
      winnerId: null,
      players,
      updatedAt: Date.now()
    });
  }

  async function rematch() {
    if (state.mode === 'solo') {
      startSoloRace();
      return;
    }

    if (!state.db || !state.roomData || !state.roomData.hostId || state.roomData.hostId !== state.playerId) return;
    const players = {};
    Object.values(state.roomData.players || {}).forEach((player) => {
      players[player.id] = { ...player, distance: 0, lane: 1, finished: false };
    });
    await state.db.ref(roomPath(state.roomCode)).update({
      phase: 'lobby',
      startedAt: null,
      winnerId: null,
      players,
      updatedAt: Date.now()
    });
  }

  function screenModeSelect() {
    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span> ⚡</div>
        <div class="tr-sub">Choose your way to race.</div>
        <div class="tr-status ${state.firebaseReady ? 'ok' : 'warn'}">${state.firebaseReady ? 'Firebase ready for multiplayer.' : 'Solo mode available without Firebase.'}</div>
        <button class="tr-btn tr-btn-primary" id="soloModeBtn">🏁 Solo Race</button>
        <button class="tr-btn tr-btn-secondary" id="multiModeBtn" ${state.firebaseReady ? '' : 'disabled'}>🌐 Multiplayer</button>
      </div>
    `;
  }

  function screenSoloSetup() {
    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span> ⚡</div>
        <div class="tr-sub">Enter your driver name.</div>
        <div class="tr-error">${state.errorMsg}</div>
        <input class="tr-field" id="nameInput" maxlength="12" placeholder="Your name" value="${state.playerName}" />
        <button class="tr-btn tr-btn-primary" id="soloStartBtn">Start Solo Race</button>
        <button class="tr-btn tr-btn-secondary" id="backToModeBtn">Back</button>
      </div>
    `;
  }

  function screenJoin() {
    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span> ⚡</div>
        <div class="tr-sub">Create or join a room.</div>
        <div class="tr-status ${state.firebaseStatus.connected ? 'ok' : 'warn'}">${state.firebaseStatus.message}</div>
        <div class="tr-error">${state.errorMsg}</div>
        <input class="tr-field" id="nameInput" maxlength="12" placeholder="Your name" value="${state.playerName}" />
        <button class="tr-btn tr-btn-primary" id="createBtn">🏁 Create Room</button>
        <div class="tr-divider">— or —</div>
        <input class="tr-field" id="codeInput" maxlength="4" placeholder="Room code" value="${state.joinCodeDraft}" />
        <button class="tr-btn tr-btn-secondary" id="joinBtn">Join Room</button>
        <button class="tr-btn tr-btn-secondary" id="backToModeBtn">Back</button>
      </div>
    `;
  }

  function screenLobby() {
    const roster = roomPlayers(state.roomData);
    const hostName = state.roomData?.hostId && state.roomData.players && state.roomData.players[state.roomData.hostId]
      ? state.roomData.players[state.roomData.hostId].name
      : 'Host';

    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span></div>
        <div class="tr-sub">Room code: ${state.roomCode}</div>
        <div class="tr-code-badge">${state.roomCode}</div>
        <div class="tr-roster">
          ${roster.map((player) => `
            <div class="tr-chip ${player.id === state.roomData?.hostId ? 'host' : ''}">
              ${faceHTML(player.name, player.avatar, 'md')}${player.name}${player.id === state.roomData?.hostId ? ' 👑' : ''}
            </div>
          `).join('')}
        </div>
        ${state.roomData && state.roomData.hostId === state.playerId
        ? `<button class="tr-btn tr-btn-grass" id="startBtn" ${roster.length < 2 ? 'disabled' : ''}>${roster.length < 2 ? 'Waiting for a friend…' : '🏁 Start Race!'}</button>`
        : `<div class="tr-waiting">Waiting for ${hostName} to start…</div>`}
      </div>
    `;
  }

  function screenRace() {
    if (!state.roomData) return '<div class="tr-card">Loading…</div>';

    const distance = state.mode === 'solo'
      ? Math.round(state.roomData.distance || 0)
      : Math.round((state.roomData.players?.[state.playerId]?.distance || 0));

    const speed = Math.round(state.mode === 'solo' ? (state.roomData.speed || 0) : 0);
    const countdownText = state.roomData.phase === 'countdown' && state.roomData.startedAt ? `Starts in ${Math.max(1, Math.ceil((state.roomData.startedAt - Date.now()) / 1000))}` : '';
    const roadTrees = Array.from({ length: 18 }, (_, i) => `<span class="tr-tree" style="top:${(i * 12) % 100}%; left:${(i % 2 === 0 ? 8 : 82)}%; animation-delay:${(i * 0.12).toFixed(2)}s"></span>`).join('');

    let raceCars = '';
    if (state.mode === 'solo') {
      const playerLane = state.roomData.playerLane ?? 1;
      const obstacleMarkup = (state.roomData.obstacles || []).map((obstacle) => `
        <div class="tr-obstacle" style="left:${getLanePercent(obstacle.lane)}; top:${obstacle.y}%;"></div>
      `).join('');

      const rivalMarkup = (state.roomData.rivalCars || []).map((car) => `
        <div class="tr-rival-car" style="left:${getLanePercent(car.lane)}; top:${car.y}%"></div>
      `).join('');

      raceCars = `
        ${rivalMarkup}
        <div class="tr-car player" style="left:${getLanePercent(playerLane)}; bottom:12%;">
          <div class="tr-car-avatar">${faceHTML(state.playerName || 'You', state.avatar, 'sm')}</div>
          <span class="tr-car-body"></span>
          <span class="tr-wheel wheel-1"></span>
          <span class="tr-wheel wheel-2"></span>
        </div>
        ${obstacleMarkup}
      `;
    } else {
      raceCars = roomPlayers(state.roomData).map((player) => {
        const left = getLanePercent(player.lane ?? 1);
        const isMe = player.id === state.playerId;
        const offset = isMe ? 0 : 0;
        return `
          <div class="tr-car ${isMe ? 'player' : 'enemy'}" style="left:${left}; bottom:${isMe ? 12 : 18}%; transform: translateX(${offset}px)">
            <div class="tr-car-avatar">${faceHTML(player.name, player.avatar, 'sm')}</div>
            <span class="tr-car-body"></span>
            <span class="tr-wheel wheel-1"></span>
            <span class="tr-wheel wheel-2"></span>
          </div>
        `;
      }).join('');
    }

    const virtualController = window.matchMedia('(pointer: coarse)').matches ? `
      <div class="tr-virtual-controller" aria-label="Race controls">
        <button class="tr-control-btn" data-control="left" aria-label="Left">◀</button>
        <button class="tr-control-btn tr-control-up" data-control="up" aria-label="Up">▲</button>
        <button class="tr-control-btn" data-control="right" aria-label="Right">▶</button>
      </div>
    ` : '';

    const raceButton = state.roomData.phase === 'racing' ? `<button class="tr-tap-btn" id="trTapButton">${state.mode === 'solo' ? 'BOOST' : 'TAP'}</button>` : '';

    return `
      <div class="tr-race-scene">
        <div class="tr-distance">DISTANCE: ${Math.min(100, Math.round(distance / 10))}M</div>
        <div class="tr-speed-meter"><span>SPEED</span><strong>${speed}</strong></div>
        <div class="tr-road-wrap">
          ${roadTrees}
          <div class="tr-road ${state.roomData.crashFlash ? 'tr-road-crash' : ''}">
            <div class="tr-road-line line-1"></div>
            <div class="tr-road-line line-2"></div>
            <div class="tr-road-line line-3"></div>
            <div class="tr-road-line line-4"></div>
            ${raceCars}
          </div>
        </div>
        ${state.mode === 'solo' ? `<div class="tr-lives">LIVES: ${state.roomData.lives}</div>` : ''}
        ${state.roomData.phase === 'countdown' ? `<div class="tr-race-overlay">${countdownText || 'RACE START!'}</div>` : ''}
        ${state.roomData.crashFlash ? '<div class="tr-crash-flash"></div>' : ''}
        ${raceButton}
        ${state.roomData.phase === 'racing' ? virtualController : ''}
      </div>
    `;
  }

  function screenFinal() {
    const players = state.roomData ? state.roomData.players || {} : {};
    const roomWins = Object.entries(state.roomData?.players || {}).map(([id, player]) => ({
      id,
      wins: state.roomData?.winnerId === id ? 1 : 0,
      name: player.name,
      avatar: player.avatar
    }));

    const leaderboard = state.leaderboard.length
      ? state.leaderboard.map((entry, index) => `
          <div class="tr-score-row ${index === 0 ? 'winner' : ''}">
            <span>${index === 0 ? '🥇' : `#${index + 1}`} ${playerBadge(entry.name || 'Player', entry.avatar || '🏁')}</span>
            <span>${entry.score || 0} pts</span>
          </div>
        `).join('')
      : '<div class="tr-waiting">No leaderboard yet.</div>';

    const winner = state.roomData && state.roomData.winnerId ? players[state.roomData.winnerId] : null;
    const rematchControl = state.mode === 'solo' || (state.roomData && state.roomData.hostId === state.playerId)
      ? '<button class="tr-btn tr-btn-primary" id="rematchBtn" style="margin-top:14px;">🔁 Race Again</button>'
      : '<div class="tr-waiting" style="margin-top:14px;">Waiting for the host…</div>';

    return `
      <div class="tr-card">
        <div class="tr-crown">🏆</div>
        <h2>${winner ? `${winner.name} wins!` : 'Race finished!'}</h2>
        <div class="tr-sub">${winner ? `${winner.avatar} reached the finish line.` : 'The next race is ready.'}</div>
        <div class="tr-score-list">
          ${roomWins.length ? roomWins.map((entry, index) => `
            <div class="tr-score-row ${index === 0 ? 'winner' : ''}">
              <span>${index === 0 ? '🥇' : `#${index + 1}`} ${playerBadge(entry.name, entry.avatar)}</span>
              <span>${entry.wins} win</span>
            </div>
          `).join('') : '<div class="tr-waiting">No scores.</div>'}
        </div>
        <div class="tr-divider">High scores</div>
        <div class="tr-score-list">${leaderboard}</div>
        ${rematchControl}
      </div>
    `;
  }

  function render() {
    renderClouds();
    let content = '';
    if (state.screen === 'mode') content = screenModeSelect();
    else if (state.screen === 'solo') content = screenSoloSetup();
    else if (state.screen === 'join') content = screenJoin();
    else if (state.screen === 'lobby') content = screenLobby();
    else if (state.screen === 'race') content = screenRace();
    else if (state.screen === 'final') content = screenFinal();
    root.innerHTML = content;
    wireEvents();
  }

  function renderClouds() {
    const clouds = document.getElementById('trClouds');
    if (!clouds || clouds.childElementCount) return;
    const specs = [
      { w: 120, h: 40, t: '8%', l: '-10%' },
      { w: 80, h: 30, t: '20%', l: '70%' },
      { w: 100, h: 34, t: '55%', l: '-15%' }
    ];
    clouds.innerHTML = specs.map((spec) => `<div class="tr-cloud" style="width:${spec.w}px;height:${spec.h}px;top:${spec.t};left:${spec.l};"></div>`).join('');
  }

  function wireEvents() {
    const soloModeBtn = document.getElementById('soloModeBtn');
    if (soloModeBtn) soloModeBtn.onclick = () => {
      state.screen = 'solo';
      state.errorMsg = '';
      render();
    };

    const multiModeBtn = document.getElementById('multiModeBtn');
    if (multiModeBtn) multiModeBtn.onclick = () => {
      state.screen = 'join';
      state.errorMsg = '';
      render();
    };

    const backToModeBtn = document.getElementById('backToModeBtn');
    if (backToModeBtn) backToModeBtn.onclick = () => {
      state.mode = null;
      state.roomData = null;
      state.roomCode = '';
      state.screen = 'mode';
      state.errorMsg = '';
      render();
    };

    const soloStartBtn = document.getElementById('soloStartBtn');
    if (soloStartBtn) soloStartBtn.onclick = () => {
      if (!state.playerName.trim()) {
        state.errorMsg = 'Type a name first.';
        render();
        return;
      }
      state.playerName = state.playerName.trim();
      localStorage.setItem('tapRaceName', state.playerName);
      startSoloRace();
    };

    const nameInput = document.getElementById('nameInput');
    if (nameInput) {
      nameInput.oninput = (event) => {
        state.playerName = event.target.value;
        localStorage.setItem('tapRaceName', state.playerName);
      };
    }

    const createBtn = document.getElementById('createBtn');
    if (createBtn) createBtn.onclick = createRoom;

    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) joinBtn.onclick = joinRoom;

    const codeInput = document.getElementById('codeInput');
    if (codeInput) {
      codeInput.oninput = (event) => {
        state.joinCodeDraft = event.target.value.toUpperCase();
        event.target.value = state.joinCodeDraft;
      };
    }

    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.onclick = startRace;

    const tapBtn = document.getElementById('trTapButton');
    if (tapBtn) tapBtn.onclick = () => handleControlAction('up');

    document.querySelectorAll('[data-control]').forEach((button) => {
      button.onclick = () => handleControlAction(button.dataset.control);
    });

    const rematchBtn = document.getElementById('rematchBtn');
    if (rematchBtn) rematchBtn.onclick = rematch;
  }

  window.addEventListener('keydown', (event) => {
    const map = {
      ArrowLeft: 'left',
      a: 'left',
      ArrowUp: 'up',
      w: 'up',
      ArrowRight: 'right',
      d: 'right'
    };
    const action = map[event.key] || map[event.key.toLowerCase()];
    if (!action) return;
    if (['ArrowLeft', 'ArrowUp', 'ArrowRight'].includes(event.key) && event.preventDefault) event.preventDefault();
    if (state.screen === 'race') handleControlAction(action);
  });

  window.addEventListener('beforeunload', () => {
    if (state.roomCode && state.roomData && state.roomData.players && state.roomData.players[state.playerId]) {
      const players = { ...state.roomData.players };
      delete players[state.playerId];
      if (state.db && Object.keys(players).length === 0) {
        state.db.ref(roomPath(state.roomCode)).remove().catch(() => { });
      }
    }
  });

  setupFirebase();

  setInterval(() => {
    if (state.mode === 'solo' && state.roomData && state.roomData.phase === 'countdown' && state.roomData.startedAt && Date.now() >= state.roomData.startedAt) {
      state.roomData.phase = 'racing';
    }

    if (state.mode === 'solo' && state.roomData && state.roomData.phase === 'racing') {
      updateSoloRaceLoop();
      render();
    }

    if (state.mode === 'multiplayer' && state.roomData && state.roomData.phase === 'countdown' && state.roomData.startedAt && Date.now() >= state.roomData.startedAt && state.db) {
      state.db.ref(roomPath(state.roomCode)).update({ phase: 'racing', updatedAt: Date.now() }).catch(() => { });
    }
  }, 160);

  (async function () {
    if (state.db) {
      await loadLeaderboard('solo');
      await loadLeaderboard('multiplayer');
    }
    render();
  })();
})();

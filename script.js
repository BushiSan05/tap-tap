(function () {
  'use strict';

  const AVATARS = ['🦊', '🐸', '🦁', '🐵', '🐼', '🐰', '🐨', '🐯'];
  const TEST_APP_GUEST_MODE = true;
  const TRACK_GOAL = 10000;
  const LANE_COUNT = 3;
  const PLAYER_LIVES = 3;
  const COUNTDOWN_MS = 3000;
  const MULTI_SYNC_INTERVAL_MS = 120;
  const STALE_ROOM_MS = 2 * 60 * 60 * 1000;

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

  const FB = {
    app: null,
    auth: null,
    db: null,
    firestore: null,
    storage: null,
    ready: false
  };

  const state = {
    user: null,
    userDoc: null,
    playerId: 'p_' + Math.random().toString(36).slice(2, 10),
    playerName: localStorage.getItem('tapRaceName') || '',
    avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
    screen: 'auth',
    mode: null,
    roomCode: '',
    roomData: null,
    roomRef: null,
    roomListener: null,
    joinCodeDraft: '',
    authEmailDraft: '',
    authPasswordDraft: '',
    authErrorMsg: '',
    errorMsg: '',
    firebaseStatus: { connected: false, message: 'Initializing…' },
    leaderboard: { solo: [], multiplayer: [] },
    _pendingMultiSync: null,
    _lastMultiSyncAt: 0,
    _activeHoldAction: null,
    _raceFinishedPersisted: false,
    _cloudSaveDirty: false,
    _toastTimer: null,
    _offlineMode: false,
    _roomCleanupSent: false
  };

  const root = document.getElementById('trRoot');
  const toastEl = document.getElementById('trToast');

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function distanceToScore(distance) {
    return Math.round((Number(distance) || 0) / 100);
  }

  function distancePercent(distance) {
    return Math.min(100, Math.round(((Number(distance) || 0) / TRACK_GOAL) * 100));
  }

  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  function uid() {
    return (state.user && state.user.uid) || state.playerId;
  }

  function normalizePlayerName(value = state.playerName) {
    const next = String(value || '').trim();
    state.playerName = next || 'Driver';
    localStorage.setItem('tapRaceName', state.playerName);
    return state.playerName;
  }

  function isAuthenticated() {
    return !!(state.user && !state.user.isAnonymous) || !!state.user;
  }

  function showToast(message, type = 'info') {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = `tr-toast tr-toast-${type}`;
    if (state._toastTimer) clearTimeout(state._toastTimer);
    state._toastTimer = setTimeout(() => {
      toastEl.className = 'tr-toast';
    }, 2800);
  }

  function safeLog(label, err) {
    const msg = err && err.message ? err.message : String(err || 'Unknown error');
    console.warn(`[TapRace:${label}]`, msg);
    return msg;
  }

  function firebaseIsConfigured() {
    return Object.values(firebaseConfig).every(
      (value) => typeof value === 'string' && value && !value.includes('YOUR_')
    );
  }

  function setupFirebase() {
    const hasSDK = !!(window.firebase && window.firebase.app);
    FB.ready = hasSDK && firebaseIsConfigured();
    if (!FB.ready) {
      state._offlineMode = true;
      state.firebaseStatus = { connected: false, message: 'Offline mode: local play only.' };
      state.screen = 'mode';
      render();
      return;
    }
    try {
      if (!window.firebase.apps.length) {
        FB.app = window.firebase.initializeApp(firebaseConfig);
      } else {
        FB.app = window.firebase.app();
      }
      FB.auth = window.firebase.auth();
      FB.db = window.firebase.database();
      FB.firestore = window.firebase.firestore();
      FB.storage = window.firebase.storage();

      setupRTDBStatus();
      setupAuthListener();
    } catch (err) {
      safeLog('firebaseInit', err);
      state.firebaseStatus = { connected: false, message: 'Firebase failed to start.' };
    }
  }

  function setupRTDBStatus() {
    if (!FB.db || !FB.db.ref) return;
    try {
      FB.db.ref('.info/connected').on('value', (snapshot) => {
        const connected = !!snapshot.val();
        state.firebaseStatus.connected = connected;
        state.firebaseStatus.message = connected ? 'Firebase connected ✅' : 'Firebase reconnecting…';
        if (['join', 'lobby', 'race', 'final'].includes(state.screen)) render();
      });
    } catch (err) {
      safeLog('rtdbStatus', err);
    }
  }

  function setupAuthListener() {
    if (!FB.auth) return;
    FB.auth.onAuthStateChanged(async (user) => {
      state.user = user;
      if (user) {
        state.playerId = user.uid.startsWith('p_') ? user.uid : 'p_' + user.uid.slice(0, 8);
        try {
          const doc = await FB.firestore.collection('users').doc(user.uid).get();
          if (doc.exists) {
            state.userDoc = doc.data();
            if (state.userDoc.displayName) {
              state.playerName = state.userDoc.displayName;
              localStorage.setItem('tapRaceName', state.playerName);
            }
            if (state.userDoc.avatar && AVATARS.includes(state.userDoc.avatar)) {
              state.avatar = state.userDoc.avatar;
            }
          } else {
            await upsertUserProfile();
          }
          await hydrateCloudSave();
        } catch (err) {
          safeLog('authHydrate', err);
        }
      } else {
        state.userDoc = null;
      }
      routeAfterAuth();
      render();
    });
  }

  function routeAfterAuth() {
    if (TEST_APP_GUEST_MODE) {
      if (!state.user) {
        state.user = { uid: uid(), isAnonymous: true };
      }
      if (state.screen === 'auth') {
        state.screen = 'mode';
      }
      return;
    }
    if (!FB.ready) {
      if (state.screen === 'auth') state.screen = 'mode';
      return;
    }
    if (state.screen === 'auth' && state.user) {
      state.screen = 'mode';
    } else if (!state.user && state.screen !== 'auth') {
      state.screen = 'auth';
    }
  }

  async function signInAnonymously() {
    if (!FB.auth) {
      state.authErrorMsg = 'Firebase unavailable. Try using offline mode.';
      state.screen = 'mode';
      render();
      return;
    }
    try {
      state.authErrorMsg = '';
      await FB.auth.signInAnonymously();
      showToast('Signed in as guest.', 'success');
    } catch (err) {
      state.authErrorMsg = safeLog('anonSignIn', err);
      state.screen = 'mode';
      showToast(state.authErrorMsg, 'error');
      render();
    }
  }

  async function signUpWithEmail() {
    if (!FB.auth) return;
    const email = state.authEmailDraft.trim();
    const password = state.authPasswordDraft;
    if (!email || !password) {
      state.authErrorMsg = 'Enter both email and password.';
      render();
      return;
    }
    if (password.length < 6) {
      state.authErrorMsg = 'Password must be at least 6 characters.';
      render();
      return;
    }
    try {
      state.authErrorMsg = '';
      const credential = await FB.auth.createUserWithEmailAndPassword(email, password);
      if (credential && credential.user && state.playerName.trim()) {
        try { await credential.user.updateProfile({ displayName: state.playerName.trim() }); } catch (_) { }
      }
      await upsertUserProfile();
      showToast('Account created! Welcome.', 'success');
    } catch (err) {
      state.authErrorMsg = safeLog('emailSignUp', err);
      render();
    }
  }

  async function signInWithEmail() {
    if (!FB.auth) return;
    const email = state.authEmailDraft.trim();
    const password = state.authPasswordDraft;
    if (!email || !password) {
      state.authErrorMsg = 'Enter both email and password.';
      render();
      return;
    }
    try {
      state.authErrorMsg = '';
      await FB.auth.signInWithEmailAndPassword(email, password);
      showToast('Welcome back!', 'success');
    } catch (err) {
      state.authErrorMsg = safeLog('emailSignIn', err);
      render();
    }
  }

  async function signOut() {
    if (!FB.auth) {
      state.screen = 'auth';
      state.user = null;
      state.userDoc = null;
      render();
      return;
    }
    try {
      if (state._cloudSaveDirty) await flushCloudSave();
      await FB.auth.signOut();
      showToast('Signed out.', 'info');
    } catch (err) {
      safeLog('signOut', err);
    }
  }

  async function upsertUserProfile() {
    if (!FB.firestore || !state.user) return;
    const payload = {
      displayName: state.playerName.trim() || (state.user && state.user.displayName) || 'Driver',
      avatar: state.avatar,
      createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
      lastSeenAt: window.firebase.firestore.FieldValue.serverTimestamp(),
      highScore: { solo: 0, multiplayer: 0 },
      totalRaces: 0,
      wins: 0
    };
    try {
      const ref = FB.firestore.collection('users').doc(state.user.uid);
      const existing = await ref.get();
      if (!existing.exists) {
        await ref.set(payload);
        state.userDoc = payload;
      } else {
        await ref.update({ lastSeenAt: window.firebase.firestore.FieldValue.serverTimestamp() });
        state.userDoc = existing.data();
      }
    } catch (err) {
      safeLog('upsertProfile', err);
    }
  }

  async function hydrateCloudSave() {
    if (!FB.firestore || !state.user) return;
    try {
      const snapshot = await FB.firestore
        .collection('users')
        .doc(state.user.uid)
        .collection('saves')
        .doc('latest')
        .get();
      if (snapshot.exists) {
        const save = snapshot.data();
        if (save && save.displayName) {
          state.playerName = save.displayName;
          localStorage.setItem('tapRaceName', state.playerName);
        }
        if (save && save.avatar && AVATARS.includes(save.avatar)) {
          state.avatar = save.avatar;
        }
      }
    } catch (err) {
      safeLog('hydrateSave', err);
    }
  }

  async function markCloudSaveDirty() {
    state._cloudSaveDirty = true;
  }

  async function flushCloudSave() {
    if (!FB.firestore || !state.user || !state._cloudSaveDirty) return;
    try {
      state._cloudSaveDirty = false;
      await FB.firestore
        .collection('users')
        .doc(state.user.uid)
        .collection('saves')
        .doc('latest')
        .set({
          displayName: state.playerName.trim() || 'Driver',
          avatar: state.avatar,
          updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (err) {
      safeLog('flushSave', err);
      state._cloudSaveDirty = true;
    }
  }

  setInterval(() => {
    if (state._cloudSaveDirty) flushCloudSave();
  }, 8000);

  function roomPath(code) {
    if (!code) return 'rooms/invalid';
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
      uid: uid(),
      name: state.playerName.trim() || 'Driver',
      avatar: state.avatar,
      distance: 0,
      lane: 1,
      finished: false,
      finishedAt: null
    };

    return {
      phase: 'countdown',
      startedAt: Date.now() + COUNTDOWN_MS,
      winnerId: null,
      finishedRanked: [],
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
      createdAt: Date.now(),
      players: { [state.playerId]: player }
    };
  }

  function startSoloRace() {
    normalizePlayerName();
    state.mode = 'solo';
    state.roomCode = '';
    state.roomData = createSoloRaceState();
    state.screen = 'race';
    state.errorMsg = '';
    state._raceFinishedPersisted = false;
    state._roomCleanupSent = false;
    render();
  }

  function createPlayerEntry() {
    return {
      id: state.playerId,
      uid: uid(),
      name: state.playerName.trim() || 'Driver',
      avatar: state.avatar,
      distance: 0,
      lane: 1,
      finished: false,
      finishedAt: null
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

  function multiSpawnObstacles(race) {
    if (!race) return;
    if (!Array.isArray(race.obstacles)) race.obstacles = [];
    if (!Array.isArray(race.rivalCars)) race.rivalCars = [];
    if (race.obstacles && race.obstacles.length < 4 && Math.random() < 0.2) {
      const lane = Math.floor(Math.random() * LANE_COUNT);
      race.obstacles.push({
        id: 'mobs_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6),
        lane,
        y: -16,
        speed: 1.6 + Math.random() * 2.0
      });
    }
    if (race.rivalCars.length < 3 || (race.rivalCars.length && race.rivalCars[race.rivalCars.length - 1]?.y > 40)) {
      race.rivalCars.push({
        id: 'mrival_' + Date.now(),
        lane: Math.floor(Math.random() * LANE_COUNT),
        y: -16,
        speed: 1.2 + Math.random() * 1.5
      });
    }
  }

  async function completeRace(winnerType) {
    if (!state.roomData) return;
    const race = state.roomData;
    race.phase = 'finished';
    if (!Array.isArray(race.finishedRanked)) race.finishedRanked = [];
    if (state.mode === 'solo') {
      race.winnerId = winnerType === 'crash' ? 'crash' : state.playerId;
      if (winnerType !== 'crash' && !race.finishedRanked.includes(state.playerId)) {
        race.finishedRanked = [state.playerId];
      }
    }
    state.screen = 'final';
    if (!state._raceFinishedPersisted) {
      state._raceFinishedPersisted = true;
      await persistRaceResult(winnerType === 'crash');
    }
    render();
  }

  function detectMultiplayerFinishers(race) {
    if (!race || !race.players) return;
    if (!Array.isArray(race.finishedRanked)) race.finishedRanked = [];
    for (const player of Object.values(race.players)) {
      if (!player || player.finished) continue;
      if ((player.distance || 0) >= TRACK_GOAL) {
        player.finished = true;
        player.finishedAt = player.finishedAt || Date.now();
        if (!race.finishedRanked.includes(player.id)) {
          race.finishedRanked.push(player.id);
        }
      }
    }
    if (race.finishedRanked.length && !race.winnerId) {
      race.winnerId = race.finishedRanked[0];
    }
    const allPlayers = Object.values(race.players);
    const allFinished = allPlayers.length && allPlayers.every((p) => p.finished || (p.distance || 0) >= TRACK_GOAL);
    if (allFinished && race.phase !== 'finished') {
      race.phase = 'finished';
    }
  }

  function updateSoloRaceLoop() {
    if (!state.roomData || state.mode !== 'solo' || state.roomData.phase !== 'racing') return;

    const race = state.roomData;
    const now = Date.now();
    const isAccelerating = state._activeHoldAction === 'up';
    const hasInputRecently = now - (race.lastInputAt || 0) < 500;

    if (isAccelerating) {
      race.lastInputAt = now;
      race.speed = clamp((race.speed || 0) + 3.4, 0, 150);
    } else {
      race.speed = clamp((race.speed || 0) * 0.88 - (hasInputRecently ? 0.5 : 2.5), 0, 150);
      if (race.speed < 0.4) race.speed = 0;
    }

    race.distance = Math.min(TRACK_GOAL, (race.distance || 0) + Math.max(0, race.speed) * 0.24);

    if (race.players && race.players[state.playerId]) {
      race.players[state.playerId] = {
        ...race.players[state.playerId],
        distance: race.distance,
        lane: race.playerLane ?? 1,
        finished: race.distance >= TRACK_GOAL,
        finishedAt: race.distance >= TRACK_GOAL ? (race.players[state.playerId].finishedAt || now) : null
      };
    }

    race.obstacles = (race.obstacles || [])
      .map((obstacle) => ({ ...obstacle, y: obstacle.y + 1.3 + (race.speed * 0.04) + obstacle.speed }))
      .filter((obstacle) => obstacle.y < 118);

    if (race.obstacles && race.obstacles.length < 4 && Math.random() < 0.2) {
      spawnObstacle();
    }

    const playerLane = race.playerLane ?? 1;
    if (race.obstacles && Array.isArray(race.obstacles)) {
      for (let i = race.obstacles.length - 1; i >= 0; i -= 1) {
        const obstacle = race.obstacles[i];
        const hit = obstacle.lane === playerLane && obstacle.y >= 66 && obstacle.y <= 92;
        if (hit) {
          race.lives = Math.max(0, (race.lives || 0) - 1);
          race.crashFlash = true;
          race.obstacles.splice(i, 1);
          setTimeout(() => { if (state.roomData) state.roomData.crashFlash = false; }, 180);
        }
      }
    }

    if (race.lives <= 0) {
      completeRace('crash');
      return;
    }

    race.rivalCars = (race.rivalCars || [])
      .map((car) => ({ ...car, y: car.y + car.speed + 0.7 }))
      .filter((car) => car.y < 118);

    if (race.rivalCars.length < 3 || race.rivalCars[race.rivalCars.length - 1]?.y > 40) {
      race.rivalCars.push({
        id: 'rival_' + Date.now(),
        lane: Math.floor(Math.random() * LANE_COUNT),
        y: -16,
        speed: 1.2 + Math.random() * 1.5
      });
    }

    if (race.rivalCars && Array.isArray(race.rivalCars)) {
      for (let i = race.rivalCars.length - 1; i >= 0; i -= 1) {
        const rival = race.rivalCars[i];
        if (rival.lane === playerLane && rival.y >= 66 && rival.y <= 92) {
          race.lives = Math.max(0, (race.lives || 0) - 1);
          race.crashFlash = true;
          race.rivalCars.splice(i, 1);
          setTimeout(() => { if (state.roomData) state.roomData.crashFlash = false; }, 180);
          break;
        }
      }
    }

    if (race.lives <= 0) {
      completeRace('crash');
      return;
    }

    if (race.players && race.players[state.playerId]) {
      race.players[state.playerId] = {
        ...race.players[state.playerId],
        distance: race.distance,
        lane: playerLane,
        finished: race.distance >= TRACK_GOAL,
        finishedAt: race.distance >= TRACK_GOAL ? (race.players[state.playerId].finishedAt || now) : null
      };
    }

    if (race.distance >= TRACK_GOAL) {
      completeRace('finish');
      return;
    }
  }

  function updateMultiplayerLocalSim() {
    if (!state.roomData || state.mode !== 'multiplayer' || state.roomData.phase !== 'racing') return;
    const race = state.roomData;
    const isAccelerating = state._activeHoldAction === 'up';
    const me = race.players && race.players[state.playerId];

    multiSpawnObstacles(race);
    race.obstacles = (race.obstacles || [])
      .map((o) => ({ ...o, y: o.y + 1.4 + o.speed }))
      .filter((o) => o.y < 118);
    race.rivalCars = (race.rivalCars || [])
      .map((c) => ({ ...c, y: c.y + c.speed + 0.7 }))
      .filter((c) => c.y < 118);

    if (me) {
      if (isAccelerating) {
        me.distance = Math.min(TRACK_GOAL, (me.distance || 0) + 10);
        me.finished = me.distance >= TRACK_GOAL;
        if (me.finished) me.finishedAt = me.finishedAt || Date.now();
      } else {
        me.distance = Math.max(0, (me.distance || 0) - 1.6);
      }
      if (me.distance >= TRACK_GOAL) {
        me.finished = true;
        me.finishedAt = me.finishedAt || Date.now();
      }
    }

    if (me && race.obstacles && Array.isArray(race.obstacles)) {
      for (let i = race.obstacles.length - 1; i >= 0; i -= 1) {
        const obstacle = race.obstacles[i];
        const hit = obstacle.lane === (me.lane ?? 1) && obstacle.y >= 66 && obstacle.y <= 92;
        if (hit) {
          me.distance = Math.max(0, (me.distance || 0) - 40);
          race.obstacles.splice(i, 1);
          race.crashFlash = true;
          setTimeout(() => { if (state.roomData) state.roomData.crashFlash = false; }, 180);
        }
      }
    }
    detectMultiplayerFinishers(race);
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
        if (state.roomData.phase === 'countdown') state.roomData.phase = 'racing';
        state.roomData.lastInputAt = Date.now();
        if (action === 'tap') {
          state.roomData.speed = clamp((state.roomData.speed || 0) + 14, 0, 150);
          state.roomData.distance = Math.min(TRACK_GOAL, (state.roomData.distance || 0) + 8);
        }
        const me = state.roomData.players && state.roomData.players[state.playerId];
        if (me) {
          me.distance = state.roomData.distance;
          me.lane = state.roomData.playerLane ?? 1;
          me.finished = state.roomData.distance >= TRACK_GOAL;
          if (me.finished) me.finishedAt = me.finishedAt || Date.now();
        }
        if (state.roomData.distance >= TRACK_GOAL) {
          completeRace('finish');
          return;
        }
        render();
      }
      return;
    }

    if (state.mode === 'multiplayer' && state.roomData && state.roomData.phase === 'racing' && state.roomData.players && state.roomData.players[state.playerId]) {
      const me = state.roomData.players[state.playerId];
      if (action === 'left') {
        me.lane = clamp((me.lane ?? 1) - 1, 0, 2);
        scheduleMultiplayerSync();
        render();
        return;
      }
      if (action === 'right') {
        me.lane = clamp((me.lane ?? 1) + 1, 0, 2);
        scheduleMultiplayerSync();
        render();
        return;
      }
      if (action === 'up' || action === 'tap') {
        if (state.roomData.phase === 'countdown') {
          state.roomData.phase = 'racing';
          scheduleMultiplayerSync();
        }
        if (action === 'tap') {
          me.distance = Math.min(TRACK_GOAL, (me.distance || 0) + 8);
        }
        if (me.distance >= TRACK_GOAL) {
          me.finished = true;
          me.finishedAt = me.finishedAt || Date.now();
          detectMultiplayerFinishers(state.roomData);
        }
        scheduleMultiplayerSync();
        render();
      }
    }
  }

  function scheduleMultiplayerSync() {
    if (!FB.db) return;
    const now = Date.now();
    if (state._pendingMultiSync) return;
    const elapsed = now - state._lastMultiSyncAt;
    const wait = clamp(MULTI_SYNC_INTERVAL_MS - elapsed, 0, MULTI_SYNC_INTERVAL_MS);
    state._pendingMultiSync = setTimeout(() => {
      state._pendingMultiSync = null;
      syncMultiplayerPlayer();
    }, wait);
  }

  function syncMultiplayerPlayer() {
    if (!FB.db || !state.roomCode || !state.roomData || !state.roomData.players || !state.roomData.players[state.playerId]) return;
    state._lastMultiSyncAt = Date.now();
    const me = state.roomData.players[state.playerId];
    const ranked = state.roomData.finishedRanked || [];
    const updates = {
      [`players/${state.playerId}`]: {
        id: me.id,
        uid: me.uid || uid(),
        name: me.name,
        avatar: me.avatar,
        distance: me.distance || 0,
        lane: me.lane ?? 1,
        finished: !!me.finished,
        finishedAt: me.finishedAt || null
      },
      updatedAt: Date.now()
    };
    if (ranked.length) updates.finishedRanked = ranked;
    if (state.roomData.winnerId) updates.winnerId = state.roomData.winnerId;
    if (state.roomData.phase === 'finished') updates.phase = 'finished';
    try {
      const path = roomPath(state.roomCode);
      if (path && path !== 'rooms/invalid') {
        FB.db.ref(path).update(updates).catch((err) => safeLog('multiSync', err));
      }
    } catch (err) {
      safeLog('multiSyncSync', err);
    }
  }

  async function saveHighScore(score, mode = state.mode || 'solo') {
    if (!FB.firestore && !FB.db) return;
    const safeName = state.playerName.trim().slice(0, 12);
    const id = uid();
    if (!id || !safeName || !Number(score)) return;

    if (FB.firestore && state.user) {
      try {
        const ref = FB.firestore.collection('leaderboard').doc(mode).collection('entries').doc(id);
        const snap = await ref.get();
        const currentScore = Number((snap.data() && snap.data().score) || 0);
        if (currentScore < Number(score)) {
          await ref.set({
            playerId: state.playerId,
            uid: id,
            name: safeName,
            avatar: state.avatar,
            score: Number(score) || 0,
            mode,
            updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      } catch (err) {
        safeLog('saveHighScoreFs', err);
      }
    }
    if (FB.db) {
      try {
        const ref = FB.db.ref(`leaderboard/${mode}/${id}`);
        if (ref) {
          const current = await ref.once('value');
          const currentScore = Number(current.val()?.score || 0);
          if (currentScore < Number(score) && Number(score)) {
            await ref.set({
              playerId: state.playerId,
              uid: id,
              name: safeName,
              avatar: state.avatar,
              score: Number(score) || 0,
              mode,
              updatedAt: Date.now()
            });
          }
        }
      } catch (err) {
        safeLog('saveHighScoreRtdb', err);
      }
    }
  }

  async function loadLeaderboard(mode = state.mode || 'solo') {
    const result = [];
    if (FB.firestore && state.user) {
      try {
        const snap = await FB.firestore
          .collection('leaderboard')
          .doc(mode)
          .collection('entries')
          .orderBy('score', 'desc')
          .limit(5)
          .get();
        snap.forEach((doc) => result.push(doc.data()));
      } catch (err) {
        safeLog('lbFs', err);
      }
    }
    if (!result.length && FB.db) {
      try {
        const ref = FB.db.ref(`leaderboard/${mode}`);
        if (ref) {
          const snapshot = await ref.once('value');
          const data = snapshot.val() || {};
          return Object.values(data)
            .filter(Boolean)
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, 5);
        }
      } catch (err) {
        safeLog('lbRtdb', err);
      }
    }
    state.leaderboard[mode] = result;
    return result;
  }

  async function persistRaceResult(crashed = false) {
    if (!state.roomData) return;
    const mode = state.mode || 'solo';
    let score = 0;
    let won = false;
    if (mode === 'solo') {
      score = crashed ? 0 : distanceToScore(state.roomData.distance || 0);
      won = state.roomData.winnerId === state.playerId;
    } else {
      score = distanceToScore(state.roomData.players?.[state.playerId]?.distance || 0);
      won = state.roomData.winnerId === state.playerId;
    }
    await saveHighScore(score, mode);
    await loadLeaderboard(mode);

    if (FB.firestore && state.user) {
      try {
        await FB.firestore
          .collection('users')
          .doc(state.user.uid)
          .collection('races')
          .add({
            mode,
            score,
            won,
            crashed,
            roomCode: state.roomCode || null,
            finishedAt: window.firebase.firestore.FieldValue.serverTimestamp()
          });
        const userRef = FB.firestore.collection('users').doc(state.user.uid);
        const increment = window.firebase.firestore.FieldValue.increment(1);
        const winIncrement = window.firebase.firestore.FieldValue.increment(won ? 1 : 0);
        await userRef.set({
          totalRaces: increment,
          wins: winIncrement,
          lastSeenAt: window.firebase.firestore.FieldValue.serverTimestamp(),
          highScore: {
            [mode]: window.firebase.firestore.FieldValue.increment(0)
          }
        }, { merge: true });
        try {
          const snap = await userRef.get();
          const current = (snap.data() && snap.data().highScore) || {};
          if (!current[mode] || Number(current[mode]) < score) {
            await userRef.set({
              highScore: { ...current, [mode]: score }
            }, { merge: true });
          }
        } catch (_) { }
      } catch (err) {
        safeLog('persistRaceResult', err);
      }
    }
  }

  function attachRoomListener(code) {
    if (state.roomRef && state.roomListener) {
      try { state.roomRef.off('value', state.roomListener); } catch (_) { }
    }
    if (!FB.db || !code) return;
    state._roomCleanupSent = false;
    const path = roomPath(code);
    if (path === 'rooms/invalid') return;
    state.roomRef = FB.db.ref(path);
    state.roomListener = state.roomRef.on('value', (snapshot) => {
      const data = snapshot.val();
      state.roomData = data || null;
      if (!state.roomData) {
        state.roomCode = '';
        state.screen = 'join';
        render();
        return;
      }
      if (!Array.isArray(state.roomData.finishedRanked)) state.roomData.finishedRanked = [];

      if (state.roomData.phase === 'countdown' && state.roomData.startedAt && Date.now() >= state.roomData.startedAt) {
        if (state.roomData.hostId === state.playerId) {
          state.roomRef.update({ phase: 'racing', updatedAt: Date.now() }).catch((err) => safeLog('cdGo', err));
        }
      }

      if (state.roomData.phase === 'racing' && state.mode === 'multiplayer') {
        detectMultiplayerFinishers(state.roomData);
        if (state.roomData.phase === 'finished' && state.roomData.hostId === state.playerId) {
          state.roomRef.update({
            phase: 'finished',
            winnerId: state.roomData.winnerId,
            finishedRanked: state.roomData.finishedRanked,
            updatedAt: Date.now()
          }).catch((err) => safeLog('autoFinish', err));
        }
      }

      if (state.roomData.phase === 'finished' && state.screen !== 'final') {
        state.screen = 'final';
        if (!state._raceFinishedPersisted) {
          state._raceFinishedPersisted = true;
          const crashed = false;
          persistRaceResult(crashed);
        }
      }
      if (state.screen === 'lobby' && state.roomData.phase === 'racing') state.screen = 'race';
      if (state.screen === 'race' && state.roomData.phase === 'finished') {
        state.screen = 'final';
        if (!state._raceFinishedPersisted) {
          state._raceFinishedPersisted = true;
          persistRaceResult(false);
        }
      }
      render();
    });
  }

  async function createRoom() {
    if (!FB.db) {
      state.errorMsg = 'Firebase is required for multiplayer.';
      render();
      return;
    }
    const name = normalizePlayerName();
    if (!name || name === 'Driver' && !state.playerName.trim()) {
      state.errorMsg = 'Type a name first.';
      render();
      return;
    }
    state.playerName = name;
    localStorage.setItem('tapRaceName', state.playerName);
    await markCloudSaveDirty();
    state.errorMsg = '';
    state.roomCode = genCode();
    state._roomCleanupSent = false;
    const player = createPlayerEntry();
    const room = {
      code: state.roomCode,
      hostId: state.playerId,
      phase: 'lobby',
      startedAt: null,
      winnerId: null,
      finishedRanked: [],
      obstacles: [],
      rivalCars: [],
      players: { [state.playerId]: { ...player, distance: 0, lane: 1, finished: false, finishedAt: null } },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    try {
      const path = roomPath(state.roomCode);
      if (path && path !== 'rooms/invalid') {
        await FB.db.ref(path).set(room);
      }
      state.roomData = room;
      state.mode = 'multiplayer';
      state.screen = 'lobby';
      state._raceFinishedPersisted = false;
      attachRoomListener(state.roomCode);
      showToast('Room created. Share the code!', 'success');
    } catch (err) {
      state.errorMsg = safeLog('createRoom', err);
      showToast('Could not create room: ' + state.errorMsg, 'error');
    }
    render();
  }

  async function joinRoom() {
    if (!FB.db) {
      state.errorMsg = 'Firebase is required for multiplayer.';
      render();
      return;
    }
    const name = normalizePlayerName();
    if (!name || name === 'Driver' && !state.playerName.trim()) {
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
    try {
      const path = roomPath(code);
      if (path === 'rooms/invalid') {
        state.errorMsg = 'Invalid room code.';
        render();
        return;
      }
      const snapshot = await FB.db.ref(path).once('value');
      if (!snapshot.exists()) {
        state.errorMsg = 'Room not found.';
        render();
        return;
      }
      const room = snapshot.val();
      if (room.phase && room.phase !== 'lobby') {
        state.errorMsg = 'Race already started.';
        render();
        return;
      }
      const player = createPlayerEntry();
      const players = {
        ...(room.players || {}),
        [state.playerId]: { ...player, distance: 0, lane: 1, finished: false, finishedAt: null }
      };
      await FB.db.ref(path).update({ players, updatedAt: Date.now() });
      state.playerName = state.playerName.trim();
      localStorage.setItem('tapRaceName', state.playerName);
      await markCloudSaveDirty();
      state.roomCode = code;
      state.mode = 'multiplayer';
      state.screen = 'lobby';
      state._raceFinishedPersisted = false;
      state._roomCleanupSent = false;
      state.roomData = { ...room, players };
      attachRoomListener(code);
      showToast('Joined room!', 'success');
    } catch (err) {
      state.errorMsg = safeLog('joinRoom', err);
      showToast('Could not join room: ' + state.errorMsg, 'error');
    }
    render();
  }

  async function startRace() {
    if (!FB.db || !state.roomData || !state.roomData.hostId || state.roomData.hostId !== state.playerId) return;
    const players = {};
    Object.values(state.roomData.players || {}).forEach((player) => {
      players[player.id] = { ...player, distance: 0, lane: 1, finished: false, finishedAt: null };
    });
    try {
      const path = roomPath(state.roomCode);
      if (path && path !== 'rooms/invalid') {
        await FB.db.ref(path).set({
          ...state.roomData,
          phase: 'countdown',
          startedAt: Date.now() + COUNTDOWN_MS,
          winnerId: null,
          finishedRanked: [],
          obstacles: [],
          rivalCars: [],
          players,
          updatedAt: Date.now()
        });
      }
      state._raceFinishedPersisted = false;
    } catch (err) {
      safeLog('startRace', err);
      showToast('Could not start race.', 'error');
    }
  }

  async function rematch() {
    if (state.mode === 'solo') {
      startSoloRace();
      return;
    }
    if (!FB.db || !state.roomData || !state.roomData.hostId || state.roomData.hostId !== state.playerId) return;
    const players = {};
    Object.values(state.roomData.players || {}).forEach((player) => {
      players[player.id] = { ...player, distance: 0, lane: 1, finished: false, finishedAt: null };
    });
    try {
      const path = roomPath(state.roomCode);
      if (path && path !== 'rooms/invalid') {
        await FB.db.ref(path).update({
          phase: 'lobby',
          startedAt: null,
          winnerId: null,
          finishedRanked: [],
          obstacles: [],
          rivalCars: [],
          players,
          updatedAt: Date.now()
        });
      }
      state._raceFinishedPersisted = false;
    } catch (err) {
      safeLog('rematch', err);
      showToast('Could not restart room.', 'error');
    }
  }

  function screenAuth() {
    const status = state.user ? `Signed in: ${state.user.isAnonymous ? 'Guest' : state.playerName || state.user.email || 'User'}` : 'Sign in to save your progress.';
    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span> ⚡</div>
        <div class="tr-sub">Race friends, beat the clock.</div>
        <div class="tr-status ok">${status}</div>
        <div class="tr-error">${state.authErrorMsg}</div>
        <input class="tr-field" id="nameInputAuth" maxlength="12" placeholder="Driver name" value="${state.playerName}" />
        <input class="tr-field" id="authEmail" type="email" placeholder="Email (optional)" value="${state.authEmailDraft}" />
        <input class="tr-field" id="authPassword" type="password" placeholder="Password (6+ chars)" value="${state.authPasswordDraft}" />
        <button class="tr-btn tr-btn-primary" id="signUpBtn">Create Account</button>
        <button class="tr-btn tr-btn-secondary" id="signInBtn">Sign In</button>
        <div class="tr-divider">— or —</div>
        <button class="tr-btn tr-btn-grass" id="anonBtn">Play as Guest</button>
        ${state.user ? `<button class="tr-btn tr-btn-secondary" id="continueBtn">Continue to Game</button>` : ''}
      </div>
    `;
  }

  function screenModeSelect() {
    const userName = state.playerName || 'Driver';
    const userInfo = state.user ? (state.user.isAnonymous ? `Guest · ${userName}` : userName) : userName;
    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span> ⚡</div>
        <div class="tr-sub">Choose your way to race.</div>
        <div class="tr-status ${FB.ready ? 'ok' : 'warn'}">${FB.ready ? 'Firebase ready for multiplayer.' : 'Solo mode available offline.'}</div>
        <div class="tr-status ${state.user && !state.user.isAnonymous ? 'ok' : 'warn'}">Profile: ${userInfo}</div>
        <button class="tr-btn tr-btn-primary" id="soloModeBtn">🏁 Solo Race</button>
        <button class="tr-btn tr-btn-secondary" id="multiModeBtn" ${FB.ready ? '' : 'disabled'}>🌐 Multiplayer</button>
        <div class="tr-row-buttons">
          <button class="tr-btn tr-btn-ghost" id="profileBtn">👤 Profile</button>
          <button class="tr-btn tr-btn-ghost" id="signOutBtn" ${state.user ? '' : 'disabled'}>🚪 Sign Out</button>
        </div>
      </div>
    `;
  }

  function screenProfile() {
    const stats = state.userDoc || {};
    const hs = stats.highScore || { solo: 0, multiplayer: 0 };
    return `
      <div class="tr-card">
        <div class="tr-logo">PROFILE</div>
        <div class="tr-face-profile">${faceHTML(state.playerName, state.avatar, 'md')}</div>
        <div class="tr-sub">Tune your driver card.</div>
        <input class="tr-field" id="nameInput" maxlength="12" placeholder="Your name" value="${state.playerName}" />
        <div class="tr-avatar-row">
          ${AVATARS.map((a) => `<button class="tr-avatar-pick ${a === state.avatar ? 'selected' : ''}" data-avatar="${a}">${a}</button>`).join('')}
        </div>
        <div class="tr-stats-grid">
          <div class="tr-stat-card"><span>Total Races</span><strong>${stats.totalRaces || 0}</strong></div>
          <div class="tr-stat-card"><span>Wins</span><strong>${stats.wins || 0}</strong></div>
          <div class="tr-stat-card"><span>Solo Best</span><strong>${hs.solo || 0}</strong></div>
          <div class="tr-stat-card"><span>Multi Best</span><strong>${hs.multiplayer || 0}</strong></div>
        </div>
        <button class="tr-btn tr-btn-primary" id="saveProfileBtn">Save & Sync</button>
        <button class="tr-btn tr-btn-secondary" id="backToModeBtn">Back</button>
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
        <div class="tr-avatar-row">
          ${AVATARS.map((a) => `<button class="tr-avatar-pick ${a === state.avatar ? 'selected' : ''}" data-avatar="${a}">${a}</button>`).join('')}
        </div>
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
      ? state.roomData.players[state.roomData.hostId]?.name
      : 'Host';
    return `
      <div class="tr-card">
        <div class="tr-logo">TAP <span>RACE</span></div>
        <div class="tr-sub">Room code: ${state.roomCode}</div>
        <div class="tr-code-badge">${state.roomCode}</div>
        <div class="tr-roster">
          ${roster.map((player) => `
            <div class="tr-chip ${player.id === state.roomData?.hostId ? 'host' : ''}">
              ${faceHTML(player.name || 'Player', player.avatar || '🏁', 'md')}${player.name || 'Player'}${player.id === state.roomData?.hostId ? ' 👑' : ''}
            </div>
          `).join('')}
        </div>
        ${state.roomData && state.roomData.hostId === state.playerId
        ? `<button class="tr-btn tr-btn-grass" id="startBtn" ${roster.length < 2 ? 'disabled' : ''}>${roster.length < 2 ? 'Waiting for a friend…' : '🏁 Start Race!'}</button>`
        : `<div class="tr-waiting">Waiting for ${hostName} to start…</div>`}
        <button class="tr-btn tr-btn-secondary" id="backToModeBtn">Leave Room</button>
      </div>
    `;
  }

  function screenRace() {
    if (!state.roomData) return '<div class="tr-card">Loading…</div>';
    const distance = state.mode === 'solo'
      ? Math.round(state.roomData.distance || 0)
      : Math.round((state.roomData.players?.[state.playerId]?.distance || 0));
    const distanceDisplay = Math.min(TRACK_GOAL, distance);
    const speed = Math.round(state.mode === 'solo' ? (state.roomData.speed || 0) : 0);
    const countdownText = state.roomData.phase === 'countdown' && state.roomData.startedAt
      ? `Starts in ${Math.max(1, Math.ceil((state.roomData.startedAt - Date.now()) / 1000))}` : '';
    const roadTrees = Array.from({ length: 18 }, (_, i) => `<span class="tr-tree" style="top:${(i * 12) % 100}%; left:${(i % 2 === 0 ? 8 : 82)}%; animation-delay:${(i * 0.12).toFixed(2)}s"></span>`).join('');
    const isAccelerating = state._activeHoldAction === 'up';
    const sceneStateClass = isAccelerating ? 'tr-scene-moving' : 'tr-scene-idle';

    let raceCars = '';
    const obstacles = state.roomData.obstacles || [];
    const rivalCars = state.roomData.rivalCars || [];
    const obstacleMarkup = obstacles.map((obstacle) => `
      <div class="tr-obstacle" style="left:${getLanePercent(obstacle.lane)}; top:${obstacle.y}%;"></div>
    `).join('');
    const rivalMarkup = rivalCars.map((car) => `
      <div class="tr-rival-car" style="left:${getLanePercent(car.lane)}; top:${car.y}%"></div>
    `).join('');

    if (state.mode === 'solo') {
      const playerLane = state.roomData.playerLane ?? 1;
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
      const roster = roomPlayers(state.roomData);
      const laneSlots = {};
      roster.forEach((p, idx) => {
        laneSlots[p.id] = idx % LANE_COUNT;
      });
      const myLane = state.roomData.players?.[state.playerId]?.lane ?? 1;
      const playerCars = roster.map((player) => {
        const isMe = player.id === state.playerId;
        const lane = isMe ? myLane : (player.lane ?? laneSlots[player.id] ?? 1);
        const progress = clamp((player.distance || 0) / TRACK_GOAL, 0, 1);
        const bottom = isMe ? 12 : clamp(12 + progress * 70, 10, 82);
        return `
          <div class="tr-car ${isMe ? 'player' : 'enemy'}" style="left:${getLanePercent(lane)}; bottom:${bottom}%;">
            <div class="tr-car-avatar">${faceHTML(player.name, player.avatar, 'sm')}</div>
            <span class="tr-car-body"></span>
            <span class="tr-wheel wheel-1"></span>
            <span class="tr-wheel wheel-2"></span>
          </div>
        `;
      }).join('');
      raceCars = rivalMarkup + playerCars + obstacleMarkup;
    }

    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    const virtualController = isTouch ? `
      <div class="tr-virtual-controller" aria-label="Race controls">
        <div class="tr-steer-cluster">
          <button class="tr-control-btn" data-control="left" aria-label="Left">◀</button>
          <button class="tr-control-btn" data-control="right" aria-label="Right">▶</button>
        </div>
        <button class="tr-control-btn tr-control-up tr-control-boost" data-control="up" aria-label="Up">▲</button>
      </div>
    ` : '';

    const raceButton = state.roomData.phase === 'racing' && !isTouch
      ? `<button class="tr-tap-btn" id="trTapButton">${state.mode === 'solo' ? 'BOOST' : 'TAP'}</button>` : '';

    const ranked = state.roomData.finishedRanked || [];
    const roster = roomPlayers(state.roomData).sort((a, b) => {
      const aRank = ranked.indexOf(a.id);
      const bRank = ranked.indexOf(b.id);
      if (aRank !== -1 && bRank === -1) return -1;
      if (bRank !== -1 && aRank === -1) return 1;
      if (aRank !== -1 && bRank !== -1) return aRank - bRank;
      return (b.distance || 0) - (a.distance || 0);
    });
    const standingsMarkup = state.mode === 'multiplayer'
      ? `<div class="tr-standings">${roster.slice(0, 4).map((p, i) => `
          <div class="tr-standing-row ${p.id === state.playerId ? 'me' : ''}">
            <span class="rank">#${i + 1}</span>
            <span class="name">${faceHTML(p.name, p.avatar, 'sm')} ${p.name}</span>
            <span class="pct">${distancePercent(p.distance || 0)}%</span>
          </div>
        `).join('')}</div>` : '';

    return `
      <div class="tr-race-scene ${sceneStateClass}">
        <div class="tr-distance">DISTANCE: ${distanceDisplay}M</div>
        <div class="tr-speed-meter"><span>SPEED</span><strong>${speed}</strong></div>
        <div class="tr-road-wrap ${sceneStateClass}">
          ${roadTrees}
          <div class="tr-road ${state.roomData.crashFlash ? 'tr-road-crash' : ''}">
            <div class="tr-road-line line-1"></div>
            <div class="tr-road-line line-2"></div>
            <div class="tr-road-line line-3"></div>
            <div class="tr-road-line line-4"></div>
            ${raceCars}
          </div>
        </div>
        ${state.mode === 'solo' ? `<div class="tr-lives">LIVES: ${'❤️'.repeat(Math.max(0, state.roomData.lives)) || '—'}</div>` : ''}
        ${state.roomData.phase === 'countdown' ? `<div class="tr-race-overlay">${countdownText || 'RACE START!'}</div>` : ''}
        ${state.roomData.crashFlash ? '<div class="tr-crash-flash"></div>' : ''}
        ${standingsMarkup}
        ${raceButton}
        ${state.roomData.phase === 'racing' ? virtualController : ''}
      </div>
    `;
  }

  function screenFinal() {
    const players = state.roomData ? state.roomData.players || {} : {};
    const ranked = state.roomData?.finishedRanked || [];
    const rankedList = Object.values(players).sort((a, b) => {
      const aRank = ranked.indexOf(a.id);
      const bRank = ranked.indexOf(b.id);
      if (aRank !== -1 && bRank === -1) return -1;
      if (bRank !== -1 && aRank === -1) return 1;
      if (aRank !== -1 && bRank !== -1) return aRank - bRank;
      return (b.distance || 0) - (a.distance || 0);
    });

    const mode = state.mode || 'solo';
    const lb = state.leaderboard[mode] || [];
    const leaderboard = lb.length
      ? lb.map((entry, index) => `
          <div class="tr-score-row ${index === 0 ? 'winner' : ''}">
            <span>${index === 0 ? '🥇' : `#${index + 1}`} ${playerBadge(entry.name || 'Player', entry.avatar || '🏁')}</span>
            <span>${entry.score || 0} pts</span>
          </div>
        `).join('')
      : '<div class="tr-waiting">No leaderboard yet.</div>';

    const winner = state.roomData && state.roomData.winnerId && state.roomData.winnerId !== 'crash'
      ? players[state.roomData.winnerId]
      : null;
    const isCrashed = state.roomData && state.roomData.winnerId === 'crash';
    const rematchControl = state.mode === 'solo' || (state.roomData && state.roomData.hostId === state.playerId)
      ? '<button class="tr-btn tr-btn-primary" id="rematchBtn" style="margin-top:14px;">🔁 Race Again</button>'
      : '<div class="tr-waiting" style="margin-top:14px;">Waiting for the host…</div>';

    return `
      <div class="tr-card">
        <div class="tr-crown">${isCrashed ? '💥' : '🏆'}</div>
        <h2>${isCrashed ? 'You crashed out!' : winner ? `${winner.name} wins!` : 'Race finished!'}</h2>
        <div class="tr-sub">${isCrashed ? 'Drive more carefully next time.' : winner ? `${winner.avatar} reached the finish line first.` : 'The next race is ready.'}</div>
        <div class="tr-score-list">
          ${rankedList.length ? rankedList.map((entry, index) => `
            <div class="tr-score-row ${index === 0 ? 'winner' : ''}">
              <span>${index === 0 ? '🥇' : `#${index + 1}`} ${playerBadge(entry.name || 'Player', entry.avatar || '🏁')}</span>
              <span>${distanceToScore(Math.min(TRACK_GOAL, entry.distance || 0))} pts</span>
            </div>
          `).join('') : '<div class="tr-waiting">No scores.</div>'}
        </div>
        <div class="tr-divider">High scores (${mode})</div>
        <div class="tr-score-list">${leaderboard}</div>
        ${rematchControl}
        <button class="tr-btn tr-btn-secondary" id="backToModeBtn" style="margin-top:10px;">Main Menu</button>
      </div>
    `;
  }

  function render() {
    renderClouds();
    let content = '';
    if (state.screen === 'auth') content = screenAuth();
    else if (state.screen === 'profile') content = screenProfile();
    else if (state.screen === 'mode') content = screenModeSelect();
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

  let _globalEventListenersAttached = false;

  function wireEvents() {
    // Attach global event listeners only once
    if (!_globalEventListenersAttached) {
      const stopHoldAction = () => {
        state._activeHoldAction = null;
      };

      document.addEventListener('pointerup', stopHoldAction, { passive: true });
      document.addEventListener('pointercancel', stopHoldAction, { passive: true });
      document.addEventListener('pointerleave', stopHoldAction, { passive: true });

      window.addEventListener('keydown', (event) => {
        const map = {
          ArrowLeft: 'left',
          a: 'left',
          A: 'left',
          ArrowUp: 'up',
          w: 'up',
          W: 'up',
          ArrowRight: 'right',
          d: 'right',
          D: 'right',
          ' ': 'up'
        };
        const action = map[event.key];
        if (!action) return;
        if (['ArrowLeft', 'ArrowUp', 'ArrowRight', ' '].includes(event.key) && event.preventDefault) event.preventDefault();
        if (state.screen === 'race') handleControlAction(action);
      });

      window.addEventListener('beforeunload', () => {
        flushCloudSave();
        sendRoomCleanup();
      });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          flushCloudSave();
          sendRoomCleanup();
        }
      });

      _globalEventListenersAttached = true;
    }

    const anonBtn = document.getElementById('anonBtn');
    if (anonBtn) anonBtn.onclick = signInAnonymously;

    const signUpBtn = document.getElementById('signUpBtn');
    if (signUpBtn) signUpBtn.onclick = signUpWithEmail;

    const signInBtn = document.getElementById('signInBtn');
    if (signInBtn) signInBtn.onclick = signInWithEmail;

    const contBtn = document.getElementById('continueBtn');
    if (contBtn) contBtn.onclick = () => { state.screen = 'mode'; render(); };

    const authEmail = document.getElementById('authEmail');
    if (authEmail) authEmail.oninput = (e) => { state.authEmailDraft = e.target.value; };
    const authPassword = document.getElementById('authPassword');
    if (authPassword) authPassword.oninput = (e) => { state.authPasswordDraft = e.target.value; };
    const nameInputAuth = document.getElementById('nameInputAuth');
    if (nameInputAuth) nameInputAuth.oninput = (e) => {
      state.playerName = e.target.value;
      localStorage.setItem('tapRaceName', state.playerName);
      markCloudSaveDirty();
    };

    const soloModeBtn = document.getElementById('soloModeBtn');
    if (soloModeBtn) soloModeBtn.onclick = () => { state.screen = 'solo'; state.errorMsg = ''; render(); };

    const multiModeBtn = document.getElementById('multiModeBtn');
    if (multiModeBtn) multiModeBtn.onclick = () => { state.screen = 'join'; state.errorMsg = ''; render(); };

    const profileBtn = document.getElementById('profileBtn');
    if (profileBtn) profileBtn.onclick = () => { state.screen = 'profile'; render(); };

    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) signOutBtn.onclick = signOut;

    const saveProfileBtn = document.getElementById('saveProfileBtn');
    if (saveProfileBtn) saveProfileBtn.onclick = async () => {
      if (state.playerName.trim()) {
        state.playerName = state.playerName.trim();
        localStorage.setItem('tapRaceName', state.playerName);
        await markCloudSaveDirty();
        await flushCloudSave();
      }
      showToast('Profile synced.', 'success');
      render();
    };

    const backToModeBtn = document.getElementById('backToModeBtn');
    if (backToModeBtn) backToModeBtn.onclick = async () => {
      if (state.roomRef && state.roomListener) {
        try { state.roomRef.off('value', state.roomListener); } catch (_) { }
        state.roomRef = null;
        state.roomListener = null;
        if (FB.db && state.roomCode && state.roomData && state.roomData.hostId === state.playerId) {
          const path = roomPath(state.roomCode);
          if (path && path !== 'rooms/invalid') {
            try { await FB.db.ref(path).remove().catch((err) => safeLog('roomRemove', err)); } catch (err) { safeLog('roomRemoveErr', err); }
          }
        } else if (FB.db && state.roomCode && state.roomData && state.roomData.players && state.roomData.players[state.playerId]) {
          try {
            const players = { ...state.roomData.players };
            delete players[state.playerId];
            const path = roomPath(state.roomCode);
            if (path && path !== 'rooms/invalid') {
              await FB.db.ref(path).update({ players, updatedAt: Date.now() }).catch((err) => safeLog('roomLeave', err));
            }
          } catch (err) { safeLog('roomLeaveErr', err); }
        }
      }
      state.mode = null;
      state.roomData = null;
      state.roomCode = '';
      state._roomCleanupSent = false;
      state.screen = 'mode';
      state.errorMsg = '';
      render();
    };

    const soloStartBtn = document.getElementById('soloStartBtn');
    if (soloStartBtn) soloStartBtn.onclick = () => {
      const name = normalizePlayerName();
      if (!name || !state.playerName.trim()) {
        state.errorMsg = 'Type a name first.';
        render();
        return;
      }
      state.playerName = name;
      localStorage.setItem('tapRaceName', state.playerName);
      markCloudSaveDirty();
      startSoloRace();
    };

    const nameInput = document.getElementById('nameInput');
    if (nameInput) {
      nameInput.oninput = (event) => {
        state.playerName = event.target.value;
        localStorage.setItem('tapRaceName', state.playerName);
        markCloudSaveDirty();
      };
    }

    document.querySelectorAll('.tr-avatar-pick').forEach((btn) => {
      btn.onclick = () => {
        const a = btn.getAttribute('data-avatar');
        if (a && AVATARS.includes(a)) {
          state.avatar = a;
          markCloudSaveDirty();
          render();
        }
      };
    });

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

    const stopHoldAction = () => {
      state._activeHoldAction = null;
    };

    const beginHoldAction = (action) => {
      if (!state.roomData || state.screen !== 'race') return;
      state._activeHoldAction = action;
      handleControlAction(action);
    };

    const bindControlButton = (button, action) => {
      if (!button) return;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        beginHoldAction(action);
      });
      button.addEventListener('pointerup', stopHoldAction);
      button.addEventListener('pointerleave', stopHoldAction);
      button.addEventListener('pointercancel', stopHoldAction);
      button.addEventListener('click', (event) => {
        event.preventDefault();
      });
    };

    const tapBtn = document.getElementById('trTapButton');
    if (tapBtn) bindControlButton(tapBtn, 'up');

    document.querySelectorAll('[data-control]').forEach((button) => {
      bindControlButton(button, button.dataset.control);
    });

    const rematchBtn = document.getElementById('rematchBtn');
    if (rematchBtn) rematchBtn.onclick = rematch;
  }

  function sendRoomCleanup() {
    if (state._roomCleanupSent) return;
    if (!(FB.db && state.roomCode && state.roomData && state.roomData.players && state.roomData.players[state.playerId])) return;
    state._roomCleanupSent = true;
    try {
      const path = roomPath(state.roomCode);
      if (!path || path === 'rooms/invalid') return;

      const players = { ...state.roomData.players };
      delete players[state.playerId];
      if (Object.keys(players).length === 0) {
        FB.db.ref(path).remove().catch((err) => safeLog('cleanupRemove', err));
      } else {
        FB.db.ref(path).update({
          players,
          updatedAt: Date.now(),
          hostId: state.roomData.hostId === state.playerId
            ? (Object.keys(players)[0] || state.roomData.hostId)
            : state.roomData.hostId
        }).catch((err) => safeLog('cleanupUpdate', err));
      }
    } catch (err) { safeLog('cleanupErr', err); }
  }

  setupFirebase();

  if (!FB.ready) {
    setTimeout(() => {
      state.screen = state.user ? 'mode' : 'auth';
      render();
    }, 50);
  }

  setInterval(() => {
    if (state._activeHoldAction && state.mode === 'solo' && state.screen === 'race' && state.roomData && state.roomData.phase === 'racing') {
      handleControlAction(state._activeHoldAction);
    }
    if (state.mode === 'solo' && state.roomData && state.roomData.phase === 'countdown' && state.roomData.startedAt && Date.now() >= state.roomData.startedAt) {
      state.roomData.phase = 'racing';
    }
    if (state.mode === 'solo' && state.roomData && state.roomData.phase === 'racing') {
      updateSoloRaceLoop();
      render();
    }
    if (state.mode === 'multiplayer' && state.roomData && state.roomData.phase === 'racing') {
      updateMultiplayerLocalSim();
      render();
    }
    if (state.mode === 'multiplayer' && state.roomData && state.roomData.phase === 'countdown' && state.roomData.startedAt && Date.now() >= state.roomData.startedAt && FB.db && state.roomData.hostId === state.playerId && state.roomCode) {
      const path = roomPath(state.roomCode);
      if (path && path !== 'rooms/invalid') {
        FB.db.ref(path).update({ phase: 'racing', updatedAt: Date.now() }).catch((err) => safeLog('cdGoTimer', err));
      }
    }
  }, 160);

  (async function bootstrap() {
    if (TEST_APP_GUEST_MODE) {
      state.user = { uid: state.playerId, isAnonymous: true };
      state.screen = 'mode';
      render();
      return;
    }
    if (!FB.ready) {
      state._offlineMode = true;
      state.screen = 'mode';
      render();
      return;
    }
    if (FB.db && state.user) {
      await loadLeaderboard('solo');
      await loadLeaderboard('multiplayer');
    }
    if (!state.user) {
      state.screen = 'auth';
    } else {
      state.screen = 'mode';
    }
    render();
  })();
})();

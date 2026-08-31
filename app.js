import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getDocsFromCache, collection, doc, getDocs, setDoc, updateDoc, deleteDoc, getDoc, query, where, serverTimestamp, increment, writeBatch } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { getAuth, signInAnonymously, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBz29gbHkaiCcH1X58qxtOffQD-0XHORKg",
  authDomain: "examprepper-92b01.firebaseapp.com",
  projectId: "examprepper-92b01",
  storageBucket: "examprepper-92b01.firebasestorage.app",
  messagingSenderId: "369876844569",
  appId: "1:369876844569:web:5982a7972b84677f23ea88",
  measurementId: "G-49LWCDNL6N"
};

const firebaseApp = initializeApp(firebaseConfig);
// Persistent local cache lets a repeat visit paint profiles straight from IndexedDB
// instead of waiting on ~4-6 sequential network round trips (sign-in, token lookup,
// channel setup, query). Multi-tab manager so two open tabs do not fight over it.
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
const auth = getAuth(firebaseApp);

const state = {
  profiles: [],
  currentProfile: null,
  quizzes: [],
  currentQuiz: null,
  selectedSubtopics: new Set(),
  queue: [],
  currentIndex: 0,
  answers: [],
  sessionStartedAt: null,
  timerId: null,
  secondsLeft: 0,
  editingProfileId: null,
  deletingProfileId: null,
  deletingTopicId: null,
  deletingTopicOwnerId: null,
  isAdmin: false,
  settings: {}
};

const $ = id => document.getElementById(id);

window.showScreen = showScreen;
window.handleAddProfileClick = handleAddProfileClick;
window.handleManageProfilesClick = handleManageProfilesClick;
window.closeProfileModal = closeProfileModal;
window.closeManageModal = closeManageModal;
window.closeConfirmModal = closeConfirmModal;
window.closeAdminModal = closeAdminModal;
window.goToDashboard = goToDashboard;

// The admin address is not a secret -- it is only an identifier. The password is
// never in this file: it lives in Firebase Auth, and the Firestore rules grant
// delete permission by checking this email on the verified auth token.
const ADMIN_EMAIL = "the4techies@gmail.com";

// Owner recorded on a published test whose author was deleted. Matches no real profile,
// so the test stays visible only through the shared query -- which is the intent.
const ADMIN_OWNER_ID = "__admin__";

// Returning to the dashboard must re-read progress, not just unhide the screen.
// The back links used to call showScreen directly, which left stale percentages
// and times on the cards until a manual page reload.
async function goToDashboard() {
  showScreen("dashboard-screen");
  await renderDashboard();
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
  window.scrollTo(0, 0);
}

function profileDoc(profileId) { return doc(db, "profiles", profileId); }
function progressDoc(profileId, topicId) {
  return doc(db, "profiles", profileId, "progress", topicId);
}
// A quiz belongs to the profile that imported it. The owner is part of the document
// id so two profiles can each own a test whose name slugifies the same way -- with a
// bare topicId as the id, the second import silently overwrote the first, and because
// progress is keyed on topicId it also misattributed the first profile's history.
function quizDocId(ownerProfileId, topicId) { return `${ownerProfileId}__${topicId}`; }
function quizDoc(ownerProfileId, topicId) {
  return doc(db, "quizzes", quizDocId(ownerProfileId, topicId));
}

// Resolves once the active profile's quizzes have been fetched. Reassigned on every
// profile selection, since quizzes cannot be read before we know whose they are.
let quizzesReady = Promise.resolve();
// Incremented per profile selection. A read for a previous profile that resolves after
// a switch must not paint its list, so renders compare against the epoch they started in.
let quizEpoch = 0;

function resetQuizState() {
  state.quizzes = [];
  state.currentQuiz = null;
  state.quizLoadFailed = false;
  state._progressCache = null;
  state._progressCacheTopicId = null;
}

async function init() {
  // Paint something before the first network call so an empty row never looks broken.
  renderProfilesLoading();

  // Reading the local cache needs no auth and no network, so on a repeat visit the
  // profiles appear immediately and the server read below just refreshes them.
  let paintedFromCache = false;
  try {
    const cached = await getDocsFromCache(collection(db, "profiles"));
    if (!cached.empty) {
      applyProfileSnapshot(cached);
      renderProfiles();
      paintedFromCache = true;
    }
  } catch (cacheErr) {
    // No cache yet on a first visit. Fall through to the network read.
  }

  try {
    // Firestore rules require an authenticated caller. Anonymous sign-in keeps the
    // no-password, pick-a-profile flow while closing the database to the open internet.
    // Profiles stay shared across sessions on purpose, so the anonymous uid is not used
    // to scope data -- it only proves the request came through the app.
    try {
      await signInAnonymously(auth);
    } catch (authErr) {
      console.error("Anonymous sign-in failed. Enable Anonymous auth in the Firebase console (Authentication -> Sign-in method). All Firestore reads and writes will be denied until then.", authErr);
    }

    // Quizzes are per-profile now, so there is nothing to prefetch here: the read
    // needs a profile id and none is chosen yet. selectProfile() starts it instead.

    // Profiles are optional at first launch. The profile screen is always usable.
    try {
      await loadProfiles();
    } catch (profileErr) {
      console.warn("Could not load profiles:", profileErr);
      // Keep whatever the cache gave us rather than blanking the screen on a
      // transient network failure.
      if (!paintedFromCache) state.profiles = [];
    }

    renderProfiles();
  } catch (err) {
    console.error(err);
    renderProfiles();
  }
}

function applyProfileSnapshot(snap) {
  state.profiles = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  state.profiles.sort((a,b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
}

async function loadProfiles() {
  applyProfileSnapshot(await getDocs(collection(db, "profiles")));
}

async function loadQuizzes(profileId) {
  // Two single-field equality filters, both automatically indexed -- no composite
  // index to configure. Also means a profile downloads only its own tests plus
  // shared ones rather than every question of every topic in the database.
  const [own, shared] = await Promise.all([
    getDocs(query(collection(db, "quizzes"), where("ownerProfileId", "==", profileId))),
    getDocs(query(collection(db, "quizzes"), where("shared", "==", true)))
  ]);
  // A profile's own published test appears in both results; key by id to dedupe.
  const byId = new Map();
  for (const d of [...own.docs, ...shared.docs]) byId.set(d.id, { id: d.id, ...d.data() });
  state.quizzes = [...byId.values()];
  state.quizLoadFailed = false;
}

// Admin needs every test regardless of owner, which is the one legitimate unscoped read.
async function loadAllQuizzes() {
  const snap = await getDocs(collection(db, "quizzes"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function renderProfilesLoading() {
  $("profiles-row").innerHTML = `<div class="profiles-loading">Loading profiles…</div>`;
}

function renderProfiles() {
  const row = $("profiles-row");
  row.innerHTML = "";

  state.profiles.forEach(profile => {
    const card = document.createElement("div");
    card.className = "profile-card";
    card.innerHTML = `
      <div class="avatar-box">${escapeHtml(profile.emoji || "🌸")}</div>
      <span class="profile-name">${escapeHtml(profile.name)}</span>`;
    card.addEventListener("click", () => selectProfile(profile.id));
    row.appendChild(card);
  });

  const addButton = $("add-profile-btn");
  if (addButton) {
    addButton.style.display = state.profiles.length >= 4 ? "none" : "inline-flex";
  }

  const manageButton = $("manage-profiles-btn");
  if (manageButton) {
    manageButton.style.display = state.profiles.length ? "inline-flex" : "inline-flex";
  }
}

async function selectProfile(id) {
  state.currentProfile = state.profiles.find(p => p.id === id);
  if (!state.currentProfile) return;

  // Drop the previous profile's quizzes before loading this one's, so the dashboard
  // cannot show someone else's list during the read.
  const epoch = ++quizEpoch;
  resetQuizState();
  quizzesReady = loadQuizzes(state.currentProfile.id).catch(err => {
    console.warn("Could not load this profile's quizzes:", err);
    state.quizLoadFailed = true;
    state.quizzes = [];
  });

  $("dashboard-title").textContent = `${state.currentProfile.name}'s Dashboard`;
  showScreen("dashboard-screen");
  await renderDashboard(epoch);
}

async function renderDashboard(epoch = quizEpoch) {
  const list = $("topic-list");

  // The read is started by selectProfile, so reaching the dashboard first is normal.
  list.innerHTML = `<div class="topic-card"><h2>Loading topics…</h2></div>`;
  await quizzesReady;

  // A switch happened while we were waiting; the newer render owns the screen.
  if (epoch !== quizEpoch) return;

  list.innerHTML = "";

  if (state.quizLoadFailed) {
    // Distinct from owning nothing -- an empty dashboard should not be the symptom
    // of both "no tests yet" and "the read failed".
    list.innerHTML = `<div class="topic-card"><h2>Could not load your tests</h2><p>Check your connection and switch back into this profile to retry.</p></div>`;
    return;
  }

  if (!state.quizzes.length) {
    list.innerHTML = `<div class="topic-card"><h2>No tests yet</h2><p>Import a quiz JSON file below. Tests you import are yours alone — other profiles will not see them.</p></div>`;
    return;
  }

  for (const quiz of state.quizzes) {
    const progress = await calculateTopicProgress(quiz);
    const card = document.createElement("div");
    card.className = "topic-card";
    const topicLabel = quiz.topicName || quiz.title || quiz.id;
    // Deleting is an admin-only action, so ordinary profiles get no control at all.
    card.innerHTML = `
      ${state.isAdmin ? `<button class="topic-delete-btn" type="button" title="Delete this test" aria-label="Delete ${escapeHtml(topicLabel)}">🗑</button>` : ""}
      <h2>${escapeHtml(topicLabel)}</h2>
      <div class="progress-bar-container"><div class="progress-bar" style="width:${progress.percent}%"></div></div>
      <div class="topic-meta">
        <p class="stats">${progress.percent}% covered</p>
        <p class="stats">Time spent: ${formatDuration(progress.timeSpent)}</p>
      </div>
      <p class="stats">${progress.mastered}/${progress.total} questions mastered</p>
      <button class="action-btn">Configure Session →</button>`;
    // Select by class: the card now holds two buttons, so querySelector("button")
    // would pick up the delete control instead.
    card.querySelector(".action-btn").onclick = () => openConfig(quiz);
    const cardDelete = card.querySelector(".topic-delete-btn");
    if (cardDelete) cardDelete.onclick = () => openQuizDeleteConfirm(quiz);
    list.appendChild(card);
  }
}

async function calculateTopicProgress(quiz) {
  if (!state.currentProfile) return {percent:0, mastered:0, total:quiz.questions?.length || 0, timeSpent:0};
  const snap = await getDoc(progressDoc(state.currentProfile.id, quiz.topicId || quiz.id));
  const data = snap.exists() ? snap.data() : {};
  const questions = data.questions || {};
  const total = (quiz.questions || []).length;
  const mastered = (quiz.questions || []).filter(q => questions[q.id]?.state === "MASTERED").length;
  const percent = total ? Math.round(mastered / total * 100) : 0;
  return { percent, mastered, total, timeSpent: data.timeSpent || 0 };
}

/* ------------------------------------------- remembered session settings ---- */
// Kept in localStorage rather than Firestore: these are per-device preferences, and
// reading them is synchronous, so the config screen restores with no extra round
// trip. Keyed by profile and topic so each person keeps their own choices.
function configKey(profileId, topicId) {
  return `examprepper:config:${profileId}:${topicId}`;
}

function loadSavedConfig(profileId, topicId) {
  try {
    const raw = localStorage.getItem(configKey(profileId, topicId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function saveConfig() {
  if (!state.currentProfile || !state.currentQuiz) return;
  const topicId = state.currentQuiz.topicId || state.currentQuiz.id;
  try {
    localStorage.setItem(configKey(state.currentProfile.id, topicId), JSON.stringify({
      subtopics: [...state.selectedSubtopics],
      mode: $("study-mode").value,
      time: $("time-per-question").value,
      count: $("question-count").value,
      strict: $("strict-mode").checked
    }));
  } catch (err) {
    // Private browsing or a full quota. Losing the preference is not worth an error.
  }
}

// Weighted (adaptive) is now the default mode. Configs saved while "quiz" was the
// default would keep overriding it on every topic already configured, so switch those
// over once. A saved "flashcards" is a deliberate choice and is left alone.
function applyWeightedDefaultOnce() {
  const FLAG = "examprepper:weightedDefaultApplied";
  try {
    if (localStorage.getItem(FLAG)) return;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("examprepper:config:")) continue;
      try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (saved && saved.mode === "quiz") {
          saved.mode = "weighted";
          localStorage.setItem(key, JSON.stringify(saved));
        }
      } catch (entryErr) {
        // One malformed entry should not stop the rest from being migrated.
      }
    }
    localStorage.setItem(FLAG, "1");
  } catch (err) {
    // Private browsing or a full quota: the HTML default still applies to new topics.
  }
}
applyWeightedDefaultOnce();

async function openConfig(quiz) {
  state.currentQuiz = quiz;
  const topicId = quiz.topicId || quiz.id;

  // The per-topic progress cache is what the subtopic percentages read from. Drop it
  // when the topic changes so a previous topic's numbers can never be shown here.
  if (state._progressCacheTopicId !== topicId) state._progressCache = null;

  const available = (quiz.subtopics || []).map(s => s.id);
  const saved = state.currentProfile ? loadSavedConfig(state.currentProfile.id, topicId) : null;

  // Only restore subtopics that still exist, in case the test was re-imported with
  // different portions. Fall back to selecting everything.
  const restored = (saved?.subtopics || []).filter(subId => available.includes(subId));
  state.selectedSubtopics = new Set(restored.length ? restored : available);

  if (saved) {
    if (saved.mode) $("study-mode").value = saved.mode;
    if (saved.time != null) $("time-per-question").value = saved.time;
    if (saved.count) $("question-count").value = saved.count;
    $("strict-mode").checked = !!saved.strict;
  }

  $("config-title").textContent = "Configure Session";
  $("config-topic-name").textContent = quiz.topicName || quiz.title || quiz.id;
  renderSubtopics();
  updateQuestionLimit();
  showScreen("config-screen");

  // Show the screen first, then fetch progress and re-render. cacheProgress() used to
  // run only when a session started, so the percentages here read an empty cache on
  // first visit and every subtopic showed 0% until you had taken a quiz and come back.
  // Awaiting before showScreen would instead stall the screen transition.
  try {
    await cacheProgress();
  } catch (err) {
    // The screen is already usable without percentages, and openConfig is called from
    // onclick handlers that do not await it, so swallow rather than reject unhandled.
    console.warn("Could not load subtopic progress:", err);
    return;
  }
  renderSubtopics();
  updateQuestionLimit();
}

function renderSubtopics() {
  const list = $("subtopic-list");
  list.innerHTML = "";
  const quiz = state.currentQuiz;
  (quiz.subtopics || []).forEach(sub => {
    const progress = getSubtopicProgress(sub.id);
    const item = document.createElement("div");
    item.className = "subtopic-item";
    item.innerHTML = `
      <div class="subtopic-top">
        <input type="checkbox" ${state.selectedSubtopics.has(sub.id) ? "checked" : ""}>
        <span class="subtopic-name">${escapeHtml(sub.name)}</span>
        <span class="stats">${progress}%</span>
      </div>
      <div class="subtopic-progress">
        <div class="progress-bar-container"><div class="progress-bar" style="width:${progress}%"></div></div>
        <span class="muted">${progress >= 80 ? "Covered" : progress ? "In Progress" : "Uncovered"}</span>
      </div>`;
    item.querySelector("input").onchange = e => {
      e.target.checked ? state.selectedSubtopics.add(sub.id) : state.selectedSubtopics.delete(sub.id);
      updateQuestionLimit();
      saveConfig();
    };
    list.appendChild(item);
  });
  updateSelectedCount();
}

function getProgressDataSync() {
  return state._progressCache || {};
}
async function cacheProgress() {
  if (!state.currentProfile || !state.currentQuiz) return;
  const topicId = state.currentQuiz.topicId || state.currentQuiz.id;
  const snap = await getDoc(progressDoc(state.currentProfile.id, topicId));
  state._progressCache = snap.exists() ? snap.data() : {};
  // Recorded so openConfig can tell whether the cache belongs to the topic being opened.
  state._progressCacheTopicId = topicId;
}
function getSubtopicProgress(subtopicId) {
  const qs = (state.currentQuiz?.questions || []).filter(q => q.subtopicId === subtopicId);
  const progress = getProgressDataSync().questions || {};
  if (!qs.length) return 0;
  const mastered = qs.filter(q => progress[q.id]?.state === "MASTERED").length;
  return Math.round(mastered / qs.length * 100);
}

$("select-all-btn").onclick = async () => {
  (state.currentQuiz.subtopics || []).forEach(s => state.selectedSubtopics.add(s.id));
  renderSubtopics();
  saveConfig();
};
$("deselect-all-btn").onclick = () => {
  state.selectedSubtopics.clear();
  renderSubtopics();
  saveConfig();
};
// Save on change, not only on start, so backing out of the screen still remembers.
$("study-mode").onchange = () => { updateQuestionLimit(); saveConfig(); };
$("question-count").oninput = () => { updateQuestionLimit(); saveConfig(); };
$("time-per-question").onchange = saveConfig;
$("strict-mode").onchange = saveConfig;

async function updateQuestionLimit() {
  const quiz = state.currentQuiz;
  if (!quiz) return;
  const n = (quiz.questions || []).filter(q => state.selectedSubtopics.has(q.subtopicId)).length;
  $("question-count").max = Math.max(1, n);
  if (Number($("question-count").value) > n) $("question-count").value = n || 1;
  updateSelectedCount();
}
function updateSelectedCount() {
  $("selected-count").textContent = `${state.selectedSubtopics.size} selected`;
}

$("start-session-btn").onclick = async () => {
  if (!state.currentQuiz) return;
  if (!state.selectedSubtopics.size) return alert("Please select at least one subtopic.");
  await cacheProgress();

  const available = state.currentQuiz.questions.filter(q => state.selectedSubtopics.has(q.subtopicId));
  if (!available.length) return alert("There are no questions in the selected portions.");

  state.settings = {
    mode: $("study-mode").value,
    time: Number($("time-per-question").value),
    strict: $("strict-mode").checked,
    count: Math.min(Number($("question-count").value) || 30, available.length)
  };
  saveConfig();

  state.queue = buildQueue(available, state.settings.count, state.settings.mode);
  state.currentIndex = 0;
  state.answers = new Array(state.queue.length).fill(null);
  state.sessionStartedAt = Date.now();

  showScreen("study-screen");
  renderQuestion();
};

function buildQueue(available, count, mode) {
  if (mode === "flashcards") return shuffle([...available]);
  if (mode === "quiz") return shuffle([...available]).slice(0, count);

  const progress = state._progressCache?.questions || {};
  const weak = available.filter(q => {
    const p = progress[q.id];
    return p?.flagged === true || p?.state === "LEARNING";
  });
  const unseen = available.filter(q => !progress[q.id] || progress[q.id].state === "UNSEEN");
  const mastered = available.filter(q => progress[q.id]?.state === "MASTERED");

  const targets = [Math.round(count*.5), Math.round(count*.3), 0];
  targets[2] = count - targets[0] - targets[1];

  const selected = [];
  const used = new Set();

  const take = (pool, n) => {
    for (const q of shuffle(pool)) {
      if (selected.length >= count || n <= 0) break;
      if (!used.has(q.id)) { selected.push(q); used.add(q.id); n--; }
    }
    return n;
  };

  let remaining = take(weak, targets[0]);
  remaining += take(unseen, targets[1]);
  remaining += take(mastered, targets[2]);

  if (selected.length < count) {
    const fallback = shuffle(available.filter(q => !used.has(q.id)));
    for (const q of fallback) {
      if (selected.length >= count) break;
      selected.push(q);
    }
  }
  return shuffle(selected);
}

function renderQuestion() {
  stopTimer();
  const q = state.queue[state.currentIndex];
  if (!q) return finishSession();

  const flash = state.settings.mode === "flashcards";
  $("study-heading").textContent = `${flash ? "Flashcard" : "Question"} ${state.currentIndex + 1} of ${state.queue.length}`;
  const sub = (state.currentQuiz.subtopics || []).find(s => s.id === q.subtopicId);
  $("study-subtopic").textContent = sub?.name || "";
  $("quiz-progress-bar").style.width = `${((state.currentIndex + 1) / state.queue.length) * 100}%`;
  $("question-text").textContent = q.question;
  $("options-container").innerHTML = "";
  $("answer-area").innerHTML = "";
  $("answer-area").classList.add("hidden");
  $("flashcard-label").classList.toggle("hidden", !flash);

  if (flash) {
    const btn = document.createElement("button");
    btn.className = "action-btn";
    btn.textContent = "Show Answer";
    btn.onclick = () => showFlashcardAnswer(q);
    $("options-container").appendChild(btn);
    $("next-btn").textContent = state.currentIndex === state.queue.length - 1 ? "Finish →" : "Next →";
    $("prev-btn").disabled = state.currentIndex === 0;
    $("quiz-timer").textContent = "Review";
    return;
  }

  q.options.forEach((option, index) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.textContent = `${String.fromCharCode(65 + index)}. ${option}`;
    btn.onclick = () => chooseAnswer(index);
    $("options-container").appendChild(btn);
  });

  const existing = state.answers[state.currentIndex];
  if (existing) applyExistingAnswer(q, existing);
  else {
    $("next-btn").textContent = state.currentIndex === state.queue.length - 1 ? "Finish →" : "Next →";
    $("prev-btn").disabled = state.currentIndex === 0 || state.settings.strict;
    if (state.settings.time > 0) startTimer(state.settings.time);
    else $("quiz-timer").textContent = "Unlimited";
  }
}

function chooseAnswer(index) {
  if (state.answers[state.currentIndex]) return;
  const q = state.queue[state.currentIndex];
  const correct = index === q.answer;
  state.answers[state.currentIndex] = { selected:index, correct };
  applyExistingAnswer(q, state.answers[state.currentIndex]);
}
function applyExistingAnswer(q, result) {
  document.querySelectorAll(".option-btn").forEach((btn, i) => {
    btn.disabled = true;
    if (i === q.answer) btn.classList.add("correct");
    if (i === result.selected && !result.correct) btn.classList.add("incorrect");
  });
  if (q.explanation) {
    $("answer-area").classList.remove("hidden");
    $("answer-area").innerHTML = `<div class="explanation"><strong>Explanation</strong><br>${escapeHtml(q.explanation)}</div>`;
  }
  $("next-btn").textContent = state.currentIndex === state.queue.length - 1 ? "Finish →" : "Next →";
  stopTimer();
}

function showFlashcardAnswer(q) {
  $("answer-area").classList.remove("hidden");
  $("answer-area").innerHTML = `<div class="answer-box"><strong>Answer:</strong> ${escapeHtml(q.options[q.answer] ?? q.answer)}${q.explanation ? `<br><br><strong>Explanation:</strong> ${escapeHtml(q.explanation)}` : ""}</div>`;
  $("options-container").querySelector("button").disabled = true;
}

$("next-btn").onclick = () => {
  if (state.settings.mode !== "flashcards" && !state.answers[state.currentIndex]) {
    return alert("Please select an answer first.");
  }
  if (state.currentIndex === state.queue.length - 1) finishSession();
  else { state.currentIndex++; renderQuestion(); }
};
$("prev-btn").onclick = () => {
  if (state.settings.strict || state.currentIndex === 0) return;
  state.currentIndex--; renderQuestion();
};

function startTimer(seconds) {
  state.secondsLeft = seconds;
  renderTimer();
  state.timerId = setInterval(() => {
    state.secondsLeft--;
    renderTimer();
    if (state.secondsLeft <= 0) {
      stopTimer();
      if (!state.answers[state.currentIndex]) {
        state.answers[state.currentIndex] = { selected:null, correct:false, timedOut:true };
        applyExistingAnswer(state.queue[state.currentIndex], state.answers[state.currentIndex]);
      }
    }
  }, 1000);
}
function renderTimer() {
  const m = Math.floor(state.secondsLeft / 60).toString().padStart(2,"0");
  const s = (state.secondsLeft % 60).toString().padStart(2,"0");
  $("quiz-timer").textContent = `⏱️ ${m}:${s}`;
}
function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
}

// Leaving a session early, from either the quiz or the flashcard view -- they share
// this screen. Whatever was answered is still saved: saveQuizResults skips entries
// with no answer, so an early exit records real work without inventing results for
// questions that were never shown. No score is presented, since the run is partial.
async function exitSession() {
  const isFlashcards = state.settings.mode === "flashcards";
  const answered = state.answers.filter(Boolean).length;
  const detail = isFlashcards
    ? "Your study time will be saved."
    : answered
      ? `Your ${answered} answered question${answered === 1 ? "" : "s"} and study time will be saved. You will not get a score for a partial run.`
      : "Nothing has been answered yet, so only your study time will be saved.";

  if (!confirm(`Exit this ${isFlashcards ? "flashcard review" : "quiz"}?\n\n${detail}`)) return;

  stopTimer();
  const button = $("exit-session-btn");
  button.disabled = true;
  try {
    if (state.currentQuiz && state.currentProfile && state.sessionStartedAt) {
      const elapsed = Math.max(0, Math.round((Date.now() - state.sessionStartedAt) / 1000));
      if (isFlashcards || !answered) await saveStudyTime(elapsed);
      else await saveQuizResults(elapsed);
    }
  } catch (err) {
    console.error("Could not save progress while exiting:", err);
    alert("Could not save your progress for this session. Please check your connection.");
  } finally {
    button.disabled = false;
  }

  // Clear the run so a stale queue cannot leak into the next session.
  state.queue = [];
  state.answers = [];
  state.currentIndex = 0;
  state.sessionStartedAt = null;

  await goToDashboard();
}

async function finishSession() {
  stopTimer();
  if (!state.currentQuiz || !state.currentProfile) return;
  const elapsed = Math.max(0, Math.round((Date.now() - state.sessionStartedAt) / 1000));
  if (state.settings.mode !== "flashcards") await saveQuizResults(elapsed);
  else await saveStudyTime(elapsed);

  if (state.settings.mode !== "flashcards") {
    const correct = state.answers.filter(a => a?.correct).length;
    const total = state.queue.length;
    const pct = total ? Math.round(correct / total * 100) : 0;
    $("score-number").textContent = `${pct}%`;
    $("score-detail").textContent = `${correct} correct out of ${total}`;
    $("score-bar").style.width = `${pct}%`;
    $("results-summary").textContent = `${state.currentQuiz.topicName || state.currentQuiz.id} • ${formatDuration(elapsed)}`;
    renderReview();
    $("restart-session-btn").onclick = () => {
      openConfig(state.currentQuiz);
    };
    showScreen("results-screen");
  } else {
    showScreen("dashboard-screen");
    await renderDashboard();
  }
}

async function saveStudyTime(seconds) {
  const ref = progressDoc(state.currentProfile.id, state.currentQuiz.topicId || state.currentQuiz.id);
  await setDoc(ref, { timeSpent: increment(seconds), updatedAt: serverTimestamp() }, {merge:true});
}

async function saveQuizResults(seconds) {
  const ref = progressDoc(state.currentProfile.id, state.currentQuiz.topicId || state.currentQuiz.id);
  const snap = await getDoc(ref);
  const old = snap.exists() ? snap.data() : {};
  const questions = {...(old.questions || {})};

  state.queue.forEach((q, i) => {
    const result = state.answers[i];
    if (!result) return;
    const prev = questions[q.id] || {state:"UNSEEN", flagged:false, attempts:0, correct:0, incorrect:0, currentStreak:0, bestStreak:0};
    const next = {...prev};
    next.attempts = (prev.attempts || 0) + 1;
    next.correct = (prev.correct || 0) + (result.correct ? 1 : 0);
    next.incorrect = (prev.incorrect || 0) + (result.correct ? 0 : 1);
    next.currentStreak = result.correct ? (prev.currentStreak || 0) + 1 : 0;
    next.bestStreak = Math.max(prev.bestStreak || 0, next.currentStreak);
    next.lastResult = result.correct ? "correct" : "incorrect";
    next.lastAttempt = new Date().toISOString();
    next.flagged = next.incorrect >= 2;
    next.state = next.currentStreak >= 2 ? "MASTERED" : "LEARNING";
    questions[q.id] = next;
  });

  await setDoc(ref, {
    questions,
    timeSpent: (old.timeSpent || 0) + seconds,
    attempts: (old.attempts || 0) + 1,
    lastAttempt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, {merge:true});
}

function renderReview() {
  const list = $("review-list");
  list.innerHTML = "";
  state.queue.forEach((q,i) => {
    const r = state.answers[i];
    const div = document.createElement("div");
    div.className = "review-item";
    const chosen = r?.selected == null ? "No answer / timed out" : q.options[r.selected];
    const correct = q.options[q.answer];
    div.innerHTML = `<strong>${i+1}. ${escapeHtml(q.question)}</strong>
      <span class="${r?.correct ? "review-correct" : "review-wrong"}">${r?.correct ? "✓ Correct" : "✕ Incorrect"}</span>
      <p>Your answer: ${escapeHtml(chosen)}</p>
      <p>Correct answer: <strong>${escapeHtml(correct)}</strong></p>
      ${q.explanation ? `<p>${escapeHtml(q.explanation)}</p>` : ""}`;
    list.appendChild(div);
  });
}

$("jsonUpload").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  $("uploadText").textContent = `Loading: ${file.name}`;
  try {
    if (!state.currentProfile) throw new Error("Pick a profile before importing a test.");
    const quiz = JSON.parse(await file.text());
    validateQuiz(quiz);
    const topicId = quiz.topicId || slugify(quiz.topicName || quiz.title || file.name);
    quiz.topicId = topicId;
    quiz.topicName = quiz.topicName || quiz.title || topicId;
    quiz.subtopics = quiz.subtopics || inferSubtopics(quiz.questions || []);
    quiz.questions = (quiz.questions || []).map((q,i) => ({
      ...q, id:q.id || `${topicId}_q${String(i+1).padStart(3,"0")}`,
      answer: q.answer ?? q.correctAnswer
    }));
    const ownerProfileId = state.currentProfile.id;
    quiz.ownerProfileId = ownerProfileId;
    // Private by default. Only admin can publish, and the rules enforce that.
    quiz.shared = false;

    const docId = quizDocId(ownerProfileId, topicId);
    await setDoc(quizDoc(ownerProfileId, topicId), quiz);
    // Re-importing the same test as the same profile is still an update, not a duplicate.
    const existing = state.quizzes.findIndex(q => q.id === docId);
    if (existing >= 0) state.quizzes[existing] = {id:docId,...quiz};
    else state.quizzes.push({id:docId,...quiz});
    $("uploadText").textContent = `Loaded: ${file.name}`;
    alert("✓ Test added to your library. Only this profile can see it.");
    await renderDashboard();
  } catch(err) {
    console.error(err);
    alert(`✕ Could not import quiz: ${err.message}`);
    $("uploadText").textContent = "+ Choose .json File";
  }
  e.target.value = "";
});

function validateQuiz(quiz) {
  if (!quiz.questions || !Array.isArray(quiz.questions) || !quiz.questions.length) throw new Error("Quiz needs a non-empty questions array.");
  for (const q of quiz.questions) {
    if (!q.subtopicId || !q.question || !Array.isArray(q.options)) throw new Error("Every question needs subtopicId, question, and options.");
    if (q.answer === undefined && q.correctAnswer === undefined) throw new Error(`Question "${q.id || q.question}" has no answer.`);
  }
}
function inferSubtopics(questions) {
  const ids = [...new Set(questions.map(q => q.subtopicId))];
  return ids.map(id => ({id, name:id}));
}
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"") || `quiz_${Date.now()}`;
}
function shuffle(arr) {
  for (let i=arr.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function formatDuration(seconds) {
  seconds = Number(seconds) || 0;
  const h=Math.floor(seconds/3600), m=Math.floor((seconds%3600)/60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

/* Profile management */
function handleAddProfileClick(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (state.profiles.length >= 4) {
    alert("Maximum of 4 profiles reached.");
    return;
  }
  openProfileModal();
}

function handleManageProfilesClick(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  renderManageProfiles();
  $("manage-modal").classList.remove("hidden");
}
$("switch-profile-btn").onclick = () => {
  // Quizzes are per-profile, so leaving the dashboard must drop them along with the
  // cached progress -- otherwise the next profile briefly sees this one's list.
  quizEpoch++;
  resetQuizState();
  renderProfiles();
  showScreen("profile-screen");
};

function openProfileModal(editId=null) {
  if (!editId && state.profiles.length >= 4) return alert("Maximum of 4 profiles reached.");
  state.editingProfileId = editId;
  const p = editId ? state.profiles.find(x=>x.id===editId) : null;
  $("profile-modal-title").textContent = p ? "Rename Profile" : "Create Profile";
  $("profile-name-input").value = p?.name || "";
  $("profile-emoji-input").value = p?.emoji || "🌸";
  $("profile-modal").classList.remove("hidden");
}
$("save-profile-btn").onclick = async () => {
  const name = $("profile-name-input").value.trim();
  const emoji = $("profile-emoji-input").value.trim() || "🌸";
  if (!name) return alert("Please enter a profile name.");
  try {
    if (state.editingProfileId) {
      await updateDoc(profileDoc(state.editingProfileId), {name, emoji});
      const p = state.profiles.find(x=>x.id===state.editingProfileId);
      p.name=name; p.emoji=emoji;
      if (state.currentProfile?.id===p.id) {
        state.currentProfile=p;
        $("dashboard-title").textContent=`${name}'s Dashboard`;
      }
    } else {
      const id = `profile_${crypto.randomUUID()}`;
      const p = {name, emoji, createdAt:serverTimestamp()};
      try {
        await setDoc(profileDoc(id), p);
      } catch (firestoreErr) {
        console.warn("Profile saved locally because Firestore was unavailable:", firestoreErr);
      }
      state.profiles.push({id,name,emoji,createdAt:{seconds:Date.now()/1000}});
    }
    closeProfileModal();
    renderProfiles();
    if (!$("manage-modal").classList.contains("hidden")) renderManageProfiles();
  } catch(err) {
    console.error(err);
    alert("Could not save the profile.");
  }
};

function renderManageProfiles() {
  const list=$("manage-profile-list");
  list.innerHTML="";
  state.profiles.forEach(p=>{
    const row=document.createElement("div");
    row.className="manage-profile-item";
    // Profile deletion moved to the admin screen, so normal use offers rename only.
    row.innerHTML=`<div class="manage-profile-avatar">${escapeHtml(p.emoji||"🌸")}</div>
      <div class="manage-profile-name">${escapeHtml(p.name)}</div>
      <button class="icon-btn" title="Rename">✏</button>
      ${state.isAdmin ? `<button class="icon-btn" title="Delete">🗑</button>` : ""}`;
    row.children[2].onclick=()=>openProfileModal(p.id);
    if (row.children[3]) row.children[3].onclick=()=>openDeleteConfirm(p.id);
    list.appendChild(row);
  });
  $("manage-modal-hint").textContent = state.isAdmin
    ? "Rename or delete a profile."
    : "Rename a profile. Deleting requires the admin account.";
}
/* ---------------------------------------------------------------- admin ---- */

function openAdminModal() {
  $("admin-password-input").value = "";
  $("admin-login-error").classList.add("hidden");
  $("admin-modal").classList.remove("hidden");
  $("admin-password-input").focus();
}
function closeAdminModal() {
  $("admin-modal").classList.add("hidden");
  $("admin-password-input").value = "";
}

async function adminLogin() {
  const password = $("admin-password-input").value;
  const err = $("admin-login-error");
  const button = $("admin-login-btn");
  if (!password) {
    err.textContent = "Enter the admin password.";
    err.classList.remove("hidden");
    return;
  }
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    await signInWithEmailAndPassword(auth, ADMIN_EMAIL, password);
    state.isAdmin = true;
    closeAdminModal();
    showScreen("admin-screen");
    await renderAdmin();
  } catch (loginErr) {
    // Firebase returns the same code for a wrong password and an unknown user,
    // so do not try to be more specific than this.
    console.warn("Admin sign-in failed:", loginErr?.code);
    err.textContent = loginErr?.code === "auth/too-many-requests"
      ? "Too many attempts. Wait a moment and try again."
      : "Incorrect password.";
    err.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Sign In";
  }
}

async function adminExit() {
  state.isAdmin = false;
  try {
    // Drop the admin credential and go back to an ordinary anonymous session so a
    // shared device is never left holding delete rights.
    await signOut(auth);
    await signInAnonymously(auth);
  } catch (err) {
    console.error("Could not return to an anonymous session:", err);
  }
  // The admin view read every profile's tests; none of them belong to whoever picks
  // a profile next.
  quizEpoch++;
  resetQuizState();
  await loadProfiles().catch(() => {});
  renderProfiles();
  showScreen("profile-screen");
}

// Pulls every profile's progress documents so the admin view can show real numbers
// rather than just names. One read per profile, so it stays cheap at 3-4 profiles.
async function collectProfileStats(profile, allQuizzes) {
  const snap = await getDocs(collection(db, "profiles", profile.id, "progress"));
  const topics = snap.docs.map(d => {
    const data = d.data();
    const questions = data.questions || {};
    const ids = Object.keys(questions);
    const mastered = ids.filter(k => questions[k]?.state === "MASTERED").length;
    // Match on the owning profile first: two profiles can now own a test with the
    // same topicId, and a progress doc belongs to whichever one this profile owns.
    const quiz = allQuizzes.find(q => q.ownerProfileId === profile.id && q.topicId === d.id)
      || allQuizzes.find(q => (q.topicId || q.id) === d.id);
    return {
      topicId: d.id,
      topicName: quiz?.topicName || quiz?.title || d.id,
      seen: ids.length,
      mastered,
      total: (quiz?.questions || []).length,
      timeSpent: data.timeSpent || 0,
      attempts: data.attempts || 0,
      lastAttempt: data.lastAttempt?.toDate ? data.lastAttempt.toDate() : null
    };
  });
  topics.sort((a, b) => a.topicName.localeCompare(b.topicName));
  return topics;
}

async function renderAdmin() {
  const profileWrap = $("admin-profiles");
  const testWrap = $("admin-tests");
  profileWrap.innerHTML = `<div class="topic-card"><h2>Loading…</h2></div>`;
  testWrap.innerHTML = "";

  // Admin wants every test regardless of owner, so it reads the collection directly
  // instead of the profile-scoped state.quizzes.
  let allQuizzes = [];
  try {
    [allQuizzes] = await Promise.all([loadAllQuizzes(), loadProfiles()]);
  } catch (err) {
    console.warn("Admin could not load tests or profiles:", err);
  }

  profileWrap.innerHTML = "";
  if (!state.profiles.length) {
    profileWrap.innerHTML = `<div class="topic-card"><p class="stats">No profiles yet.</p></div>`;
  }

  for (const profile of state.profiles) {
    const topics = await collectProfileStats(profile, allQuizzes).catch(() => []);
    const totalTime = topics.reduce((sum, t) => sum + t.timeSpent, 0);
    const totalMastered = topics.reduce((sum, t) => sum + t.mastered, 0);
    const totalSeen = topics.reduce((sum, t) => sum + t.seen, 0);

    const rows = topics.length
      ? topics.map(t => `
          <tr>
            <td>${escapeHtml(t.topicName)}</td>
            <td>${t.mastered}/${t.total || "?"}</td>
            <td>${t.seen}</td>
            <td>${t.attempts}</td>
            <td>${formatDuration(t.timeSpent)}</td>
            <td>${t.lastAttempt ? t.lastAttempt.toLocaleDateString() : "—"}</td>
          </tr>`).join("")
      : `<tr><td colspan="6" class="muted">No study history yet.</td></tr>`;

    const card = document.createElement("div");
    card.className = "topic-card admin-profile-card";
    card.innerHTML = `
      <button class="topic-delete-btn" type="button" title="Delete this profile" aria-label="Delete profile ${escapeHtml(profile.name)}">🗑</button>
      <h2>${escapeHtml(profile.emoji || "🌸")} ${escapeHtml(profile.name)}</h2>
      <div class="topic-meta">
        <p class="stats">${totalMastered} mastered</p>
        <p class="stats">${totalSeen} questions seen</p>
        <p class="stats">Total time: ${formatDuration(totalTime)}</p>
      </div>
      <div class="admin-table-scroll">
        <table class="admin-table">
          <thead><tr><th>Topic</th><th>Mastered</th><th>Seen</th><th>Attempts</th><th>Time</th><th>Last</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    card.querySelector(".topic-delete-btn").onclick = () => openDeleteConfirm(profile.id);
    profileWrap.appendChild(card);
  }

  if (!allQuizzes.length) {
    testWrap.innerHTML = `<div class="topic-card"><p class="stats">No tests imported yet.</p></div>`;
    return;
  }

  const ownerName = id => {
    if (id === ADMIN_OWNER_ID) return "Published (original profile deleted)";
    return state.profiles.find(p => p.id === id)?.name || "Deleted profile";
  };
  // Group by owner so it is obvious who a test belongs to; unowned pre-migration
  // documents fall into their own bucket rather than disappearing.
  const groups = new Map();
  for (const quiz of allQuizzes) {
    const key = quiz.ownerProfileId || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(quiz);
  }

  for (const [ownerId, quizzes] of groups) {
    const heading = document.createElement("p");
    heading.className = "stats admin-owner-heading";
    heading.textContent = ownerId ? `${ownerName(ownerId)} — ${quizzes.length} test${quizzes.length === 1 ? "" : "s"}` : "No owner (imported before per-profile tests)";
    testWrap.appendChild(heading);

    for (const quiz of quizzes) {
      const label = quiz.topicName || quiz.title || quiz.id;
      const isShared = quiz.shared === true;
      const card = document.createElement("div");
      card.className = "topic-card";
      card.innerHTML = `
        <button class="topic-delete-btn" type="button" title="Delete this test" aria-label="Delete ${escapeHtml(label)}">🗑</button>
        <h2>${escapeHtml(label)}${isShared ? ` <span class="shared-badge">Shared</span>` : ""}</h2>
        <p class="stats">${(quiz.questions || []).length} questions · ${(quiz.subtopics || []).length} subtopics</p>
        <button class="manage-btn small-btn publish-btn">${isShared ? "Unpublish" : "Publish to everyone"}</button>`;
      card.querySelector(".topic-delete-btn").onclick = () => openQuizDeleteConfirm(quiz);
      card.querySelector(".publish-btn").onclick = ev => togglePublish(quiz, !isShared, ev.currentTarget);
      testWrap.appendChild(card);
    }
  }
}

// Publishing is the one per-profile boundary the rules can actually enforce: an
// ordinary client cannot set or change `shared`, only admin can.
async function togglePublish(quiz, makeShared, button) {
  if (!quiz.ownerProfileId) {
    alert("This test has no owner recorded, so it cannot be published. Re-import it first.");
    return;
  }
  const label = quiz.topicName || quiz.title || quiz.id;
  const msg = makeShared
    ? `Publish "${label}" so every profile can see and study it?`
    : `Unpublish "${label}"? Only ${state.profiles.find(p => p.id === quiz.ownerProfileId)?.name || "its owner"} will see it again. Progress already recorded by other profiles is kept.`;
  if (!confirm(msg)) return;

  button.disabled = true;
  button.textContent = makeShared ? "Publishing…" : "Unpublishing…";
  try {
    await updateDoc(quizDoc(quiz.ownerProfileId, quiz.topicId || quiz.id), { shared: makeShared });
    await renderAdmin();
  } catch (err) {
    console.error("Could not change published state:", err);
    alert("Could not change that test's published state. Please try again.");
    button.disabled = false;
    button.textContent = makeShared ? "Publish to everyone" : "Unpublish";
  }
}

// After any delete, refresh whichever view is on screen.
async function refreshAfterDelete() {
  if (!$("admin-screen").classList.contains("hidden")) await renderAdmin();
}

function closeProfileModal() {
  $("profile-modal").classList.add("hidden");
  state.editingProfileId=null;
}
function closeManageModal() { $("manage-modal").classList.add("hidden"); }
function openDeleteConfirm(id) {
  const p=state.profiles.find(x=>x.id===id);
  if (!p) return;
  state.deletingProfileId=id;
  $("delete-message").textContent=`Delete ${p.name}? This will permanently remove this profile and all of its personal quiz statistics.`;
  $("confirm-modal").classList.remove("hidden");
}
// Quizzes are shared by every profile, so deleting one removes it for all users.
// The per-profile progress documents are left in place: they are invisible without
// the quiz, and re-importing the same topicId restores each person's history.
function openQuizDeleteConfirm(quiz) {
  const topicId = quiz.topicId || quiz.id;
  if (!topicId) return;
  state.deletingTopicId = topicId;
  // The owner is half the document id, so it has to survive until the confirm click.
  state.deletingTopicOwnerId = quiz.ownerProfileId || null;
  state.deletingProfileId = null;
  const label = quiz.topicName || quiz.title || topicId;
  const reach = quiz.shared === true
    ? "It is published, so this removes it for every profile."
    : "It belongs to one profile, so only that profile loses it.";
  $("delete-message").textContent =
    `Delete "${label}"? ${reach} Saved progress for it is kept in case it is imported again.`;
  $("confirm-modal").classList.remove("hidden");
}

async function deleteQuizConfirmed() {
  const topicId = state.deletingTopicId;
  const ownerId = state.deletingTopicOwnerId;
  const button = $("confirm-delete-btn");
  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    // Documents imported before per-profile ownership still have a bare topicId as
    // their document id, so fall back to that rather than failing to delete them.
    const ref = ownerId ? quizDoc(ownerId, topicId) : doc(db, "quizzes", topicId);
    await deleteDoc(ref);
    const goneId = ownerId ? quizDocId(ownerId, topicId) : topicId;
    state.quizzes = state.quizzes.filter(q => q.id !== goneId);
    closeConfirmModal();
    if (!$("admin-screen").classList.contains("hidden")) await renderAdmin();
    else await renderDashboard();
  } catch (err) {
    console.error("Could not delete quiz:", err);
    alert("Could not delete that test. Please check your connection and try again.");
  } finally {
    button.disabled = false;
    button.textContent = "Delete";
  }
}

$("confirm-delete-btn").onclick=async()=>{
  // The confirm modal is shared between profile and test deletion.
  if (state.deletingTopicId) return deleteQuizConfirmed();

  const id=state.deletingProfileId;
  if (!id) return;

  const profile = state.profiles.find(p => p.id === id);
  const button = $("confirm-delete-btn");
  button.disabled = true;
  button.textContent = "Deleting…";

  try {
    // Delete this profile's own tests along with its progress. Before per-profile
    // ownership quizzes were shared and deliberately left alone; now an owned test
    // outliving its owner is unreachable -- no dashboard queries it and nothing but
    // this cascade would ever remove it.
    //
    // Published tests are the exception: other profiles may be studying them, so they
    // are handed to admin rather than deleted with their author.
    const ownedSnap = await getDocs(query(collection(db, "quizzes"), where("ownerProfileId", "==", id)));
    for (const quizSnap of ownedSnap.docs) {
      if (quizSnap.data().shared === true) {
        await updateDoc(quizSnap.ref, { ownerProfileId: ADMIN_OWNER_ID, orphanedFrom: id });
      } else {
        await deleteDoc(quizSnap.ref);
      }
    }

    const progressSnap = await getDocs(collection(db, "profiles", id, "progress"));

    if (progressSnap.size) {
      let batch = writeBatch(db);
      let writes = 0;

      for (const progress of progressSnap.docs) {
        batch.delete(progress.ref);
        writes++;

        if (writes === 450) {
          await batch.commit();
          batch = writeBatch(db);
          writes = 0;
        }
      }

      if (writes > 0) await batch.commit();
    }

    await deleteDoc(profileDoc(id));

    state.profiles = state.profiles.filter(p => p.id !== id);

    if (state.currentProfile?.id === id) {
      state.currentProfile = null;
      showScreen("profile-screen");
    }

    closeConfirmModal();
    renderProfiles();
    renderManageProfiles();
    await refreshAfterDelete();

  } catch(err) {
    console.error(err);
    alert(`Could not delete ${profile?.name || "the profile"}. Please check your Firebase Firestore rules.`);
  } finally {
    button.disabled = false;
    button.textContent = "Delete";
  }
};
function closeConfirmModal() {
  $("confirm-modal").classList.add("hidden");
  state.deletingProfileId=null;
  state.deletingTopicId=null;
  state.deletingTopicOwnerId=null;
}

init();

$("profile-modal").addEventListener("click", (e) => {
  if (e.target === $("profile-modal")) closeProfileModal();
});
$("manage-modal").addEventListener("click", (e) => {
  if (e.target === $("manage-modal")) closeManageModal();
});
$("confirm-modal").addEventListener("click", (e) => {
  if (e.target === $("confirm-modal")) closeConfirmModal();
});

// Explicit DOM binding for profile controls.
const addProfileControl = document.getElementById("add-profile-btn");
const manageProfilesControl = document.getElementById("manage-profiles-btn");
if (addProfileControl) addProfileControl.addEventListener("click", handleAddProfileClick);
if (manageProfilesControl) manageProfilesControl.addEventListener("click", handleManageProfilesClick);

$("exit-session-btn").addEventListener("click", exitSession);
$("admin-open-btn").addEventListener("click", openAdminModal);
$("admin-login-btn").addEventListener("click", adminLogin);
$("admin-exit-btn").addEventListener("click", adminExit);
$("admin-password-input").addEventListener("keydown", e => {
  if (e.key === "Enter") adminLogin();
});
$("admin-modal").addEventListener("click", e => {
  if (e.target === $("admin-modal")) closeAdminModal();
});

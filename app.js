import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getDocsFromCache, collection, doc, getDocs, setDoc, updateDoc, deleteDoc, getDoc, serverTimestamp, increment, writeBatch } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
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

// The admin address is not a secret -- it is only an identifier. The password is
// never in this file: it lives in Firebase Auth, and the Firestore rules grant
// delete permission by checking this email on the verified auth token.
const ADMIN_EMAIL = "admin@examprepper.app";

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
  window.scrollTo(0, 0);
}

function profileDoc(profileId) { return doc(db, "profiles", profileId); }
function progressDoc(profileId, topicId) {
  return doc(db, "profiles", profileId, "progress", topicId);
}
function quizDoc(topicId) { return doc(db, "quizzes", topicId); }

// Resolves once the shared quiz documents have been fetched. The profile screen does
// not need them, so the dashboard awaits this instead of blocking first paint.
let quizzesReady = Promise.resolve();

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

    // Kick the quiz read off now but do not await it here -- it is the heaviest read
    // (every question of every topic) and nothing on the profile screen uses it.
    quizzesReady = loadQuizzes().catch(quizErr => {
      console.warn("Could not load quizzes yet:", quizErr);
      state.quizzes = [];
    });

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

async function loadQuizzes() {
  const snap = await getDocs(collection(db, "quizzes"));
  state.quizzes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
  $("dashboard-title").textContent = `${state.currentProfile.name}'s Dashboard`;
  showScreen("dashboard-screen");
  await renderDashboard();
}

async function renderDashboard() {
  const list = $("topic-list");

  // Quizzes load in the background during init so they do not delay the profile
  // screen. If the user reaches the dashboard first, wait for that read here.
  list.innerHTML = `<div class="topic-card"><h2>Loading topics…</h2></div>`;
  await quizzesReady;

  list.innerHTML = "";

  if (!state.quizzes.length) {
    list.innerHTML = `<div class="topic-card"><h2>No quizzes yet</h2><p>Import a quiz JSON file below to add the first shared quiz. Your profile is ready.</p></div>`;
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

function openConfig(quiz) {
  state.currentQuiz = quiz;
  state.selectedSubtopics = new Set((quiz.subtopics || []).map(s => s.id));
  $("config-title").textContent = "Configure Session";
  $("config-topic-name").textContent = quiz.topicName || quiz.title || quiz.id;
  renderSubtopics();
  updateQuestionLimit();
  showScreen("config-screen");
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
  const snap = await getDoc(progressDoc(state.currentProfile.id, state.currentQuiz.topicId || state.currentQuiz.id));
  state._progressCache = snap.exists() ? snap.data() : {};
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
};
$("deselect-all-btn").onclick = () => {
  state.selectedSubtopics.clear();
  renderSubtopics();
};
$("study-mode").onchange = updateQuestionLimit;
$("question-count").oninput = updateQuestionLimit;

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
    await setDoc(quizDoc(topicId), quiz);
    const existing = state.quizzes.findIndex(q => (q.topicId || q.id) === topicId);
    if (existing >= 0) state.quizzes[existing] = {id:topicId,...quiz};
    else state.quizzes.push({id:topicId,...quiz});
    $("uploadText").textContent = `Loaded: ${file.name}`;
    alert("✓ Quiz added to the shared quiz library.");
    if (state.currentProfile) await renderDashboard();
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
  await loadProfiles().catch(() => {});
  renderProfiles();
  showScreen("profile-screen");
}

// Pulls every profile's progress documents so the admin view can show real numbers
// rather than just names. One read per profile, so it stays cheap at 3-4 profiles.
async function collectProfileStats(profile) {
  const snap = await getDocs(collection(db, "profiles", profile.id, "progress"));
  const topics = snap.docs.map(d => {
    const data = d.data();
    const questions = data.questions || {};
    const ids = Object.keys(questions);
    const mastered = ids.filter(k => questions[k]?.state === "MASTERED").length;
    const quiz = state.quizzes.find(q => (q.topicId || q.id) === d.id);
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

  await quizzesReady;
  try {
    await loadProfiles();
  } catch (err) {
    console.warn("Admin could not refresh profiles:", err);
  }

  profileWrap.innerHTML = "";
  if (!state.profiles.length) {
    profileWrap.innerHTML = `<div class="topic-card"><p class="stats">No profiles yet.</p></div>`;
  }

  for (const profile of state.profiles) {
    const topics = await collectProfileStats(profile).catch(() => []);
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

  if (!state.quizzes.length) {
    testWrap.innerHTML = `<div class="topic-card"><p class="stats">No tests imported yet.</p></div>`;
    return;
  }
  for (const quiz of state.quizzes) {
    const label = quiz.topicName || quiz.title || quiz.id;
    const card = document.createElement("div");
    card.className = "topic-card";
    card.innerHTML = `
      <button class="topic-delete-btn" type="button" title="Delete this test" aria-label="Delete ${escapeHtml(label)}">🗑</button>
      <h2>${escapeHtml(label)}</h2>
      <p class="stats">${(quiz.questions || []).length} questions · ${(quiz.subtopics || []).length} subtopics</p>`;
    card.querySelector(".topic-delete-btn").onclick = () => openQuizDeleteConfirm(quiz);
    testWrap.appendChild(card);
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
  state.deletingProfileId = null;
  $("delete-message").textContent =
    `Delete "${quiz.topicName || quiz.title || topicId}"? This removes the test for every profile. Your saved progress for it is kept in case you import it again.`;
  $("confirm-modal").classList.remove("hidden");
}

async function deleteQuizConfirmed() {
  const topicId = state.deletingTopicId;
  const button = $("confirm-delete-btn");
  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    await deleteDoc(quizDoc(topicId));
    state.quizzes = state.quizzes.filter(q => (q.topicId || q.id) !== topicId);
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
    // Delete all topic-progress documents first, then the profile document.
    // Quiz content in /quizzes is never touched.
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

$("admin-open-btn").addEventListener("click", openAdminModal);
$("admin-login-btn").addEventListener("click", adminLogin);
$("admin-exit-btn").addEventListener("click", adminExit);
$("admin-password-input").addEventListener("keydown", e => {
  if (e.key === "Enter") adminLogin();
});
$("admin-modal").addEventListener("click", e => {
  if (e.target === $("admin-modal")) closeAdminModal();
});

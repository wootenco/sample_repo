/* Mil Palabras - session engine and UI.
 *
 * Design decisions worth knowing before you read the code:
 *
 * 1. Words are introduced strictly in frequency order. There is no
 *    "choose a topic" mode, because topic-first ordering is exactly what
 *    makes learners able to name twelve fruits and unable to hold a
 *    conversation.
 *
 * 2. Every card is a RETRIEVAL attempt. Nothing in this app lets you
 *    passively read a list and call it studying. Re-reading feels like
 *    learning and is not; being forced to produce the answer is.
 *
 * 3. Card types unlock in order of difficulty for the same word:
 *    recognise -> produce -> produce inside a sentence -> produce from
 *    audio. Recognition is the cheap half of knowing a word; production
 *    is the half that lets you speak, and it is trained last because it
 *    is only possible once recognition is stable.
 *
 * 4. New words are capped per day. The review load a word generates is
 *    roughly constant, so an uncapped intake turns into a review debt
 *    that arrives two weeks later and ends the habit.
 *
 * 5. Card types for one word are interleaved with other words rather than
 *    blocked together. Blocked practice produces better performance today
 *    and worse retention next month.
 */

const STORE_KEY = "milpalabras.v1";
const DAY_MS = 86400000;

const DEFAULTS = {
  newPerDay: 8,
  sessionSize: 40,
  backlogGuard: 120,     // stop introducing new words above this due count
  audio: true,
  voice: "es-ES",
  typingDirection: "both",
};

let state = null;
let queue = [];
let current = null;
let revealed = false;
let sessionLog = { seen: 0, correct: 0, started: Date.now() };

// ---------- persistence ----------

function todayKey(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
         "-" + String(d.getDate()).padStart(2, "0");
}

function freshState() {
  return {
    v: 1,
    created: Date.now(),
    cards: {},           // "item::type" -> card
    introduced: [],      // lemmas, in the order they were introduced
    chunksIntroduced: [],
    settings: { ...DEFAULTS },
    history: {},         // "YYYY-MM-DD" -> {reviews, correct, newWords}
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return freshState();
    const s = JSON.parse(raw);
    s.settings = { ...DEFAULTS, ...(s.settings || {}) };
    return s;
  } catch (e) {
    console.warn("Could not read saved progress, starting fresh.", e);
    return freshState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Could not save progress.", e);
  }
}

function logToday(field, n) {
  const k = todayKey();
  state.history[k] = state.history[k] || { reviews: 0, correct: 0, newWords: 0 };
  state.history[k][field] += n;
}

// ---------- word access ----------

const rankOf = {};
WORDS.forEach((w, i) => { rankOf[w[0]] = i + 1; });

function word(lemma) {
  const r = rankOf[lemma];
  return r ? { lemma: WORDS[r - 1][0], gloss: WORDS[r - 1][1], pos: WORDS[r - 1][2], note: WORDS[r - 1][3], rank: r } : null;
}

const POS_LABEL = {
  art: "article", det: "determiner", pron: "pronoun", prep: "preposition",
  conj: "conjunction", adv: "adverb", adj: "adjective", n: "noun",
  v: "verb", num: "number", interj: "interjection",
};

function cardId(item, type) { return item + "::" + type; }

function getCard(item, type) { return state.cards[cardId(item, type)]; }

function putCard(c) { state.cards[cardId(c.item, c.type)] = c; }

// ---------- unlocking ----------

function hasAudio() {
  return state.settings.audio && typeof speechSynthesis !== "undefined";
}

/* A listening card on a device with no Spanish voice is an unanswerable
 * card that still eats review time, so they are never created in that case. */
function hasSpanishVoice() {
  return hasAudio() && voices.some(v => v.lang && v.lang.toLowerCase().startsWith("es"));
}

/* Dictation is only worth a card slot where there is something to hear.
 * "el" and "y" teach nothing as audio and would add 150 trivial cards to
 * the daily load. */
function worthHearing(lemma) {
  return lemma.replace(/[^a-záéíóúüñ]/gi, "").length >= 4;
}

/* Adds the card types a word has newly earned. Called after every answer. */
function reconcileUnlocks() {
  for (const lemma of state.introduced) {
    const recog = getCard(lemma, "recog");
    if (!recog) continue;
    if (isLearned(recog) && !getCard(lemma, "prod")) {
      putCard(newCard(lemma, "prod", Date.now()));
    }
    const prod = getCard(lemma, "prod");
    if (prod && isLearned(prod)) {
      if (EXAMPLES[lemma] && !getCard(lemma, "cloze")) {
        putCard(newCard(lemma, "cloze", Date.now()));
      }
      if (hasSpanishVoice() && worthHearing(lemma) && !getCard(lemma, "listen")) {
        putCard(newCard(lemma, "listen", Date.now()));
      }
    }
  }
}

function learnedLemmas() {
  return state.introduced.filter(l => isLearned(getCard(l, "recog")));
}

/* Coverage is claimed only for words that have survived a week-long gap.
 * Answering a word correctly on the day you met it is not comprehension,
 * and a headline number built on same-day wins is a number you cannot
 * cash when you open a newspaper. */
function retainedLemmas() {
  return state.introduced.filter(l => {
    const c = getCard(l, "recog");
    return c && c.state === "review" && c.ivl >= 7;
  });
}

function introduceNext(n) {
  let added = 0;
  for (let i = 0; i < WORDS.length && added < n; i++) {
    const lemma = WORDS[i][0];
    if (getCard(lemma, "recog")) continue;
    putCard(newCard(lemma, "recog", Date.now()));
    state.introduced.push(lemma);
    added++;
  }
  // Chunks open up once there is enough vocabulary to fill the frames.
  if (learnedLemmas().length >= 50) {
    const target = Math.min(CHUNKS.length, Math.floor(learnedLemmas().length / 15));
    while (state.chunksIntroduced.length < target) {
      const idx = state.chunksIntroduced.length;
      state.chunksIntroduced.push(idx);
      putCard(newCard("chunk:" + idx, "chunk", Date.now()));
    }
  }
  if (added) logToday("newWords", added);
  return added;
}

// ---------- queue ----------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Interleave so the same word does not appear twice in a row: answering
 * "casa" four ways back to back tests short-term memory, not recall. */
function spread(cards) {
  const out = [];
  const pool = shuffle(cards.slice());
  while (pool.length) {
    let idx = pool.findIndex(c => !out.length || c.item !== out[out.length - 1].item);
    if (idx === -1) idx = 0;
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function buildQueue() {
  const now = Date.now();
  reconcileUnlocks();

  const due = Object.values(state.cards).filter(c => c.due <= now);
  const backlog = due.filter(c => c.state === "review" || c.state === "relearn").length;

  const newToday = (state.history[todayKey()] || {}).newWords || 0;
  const room = state.settings.newPerDay - newToday;
  if (room > 0 && backlog < state.settings.backlogGuard) {
    introduceNext(room);
  }

  const all = Object.values(state.cards).filter(c => c.due <= Date.now());
  // Due reviews come first; brand-new material is folded in behind them.
  const reviews = all.filter(c => c.state !== "new");
  const fresh = all.filter(c => c.state === "new");
  queue = spread(reviews).concat(spread(fresh)).slice(0, state.settings.sessionSize);
  return queue;
}

// ---------- audio ----------

let voices = [];
function refreshVoices() {
  if (typeof speechSynthesis === "undefined") return;
  voices = speechSynthesis.getVoices() || [];
}
if (typeof speechSynthesis !== "undefined") {
  refreshVoices();
  speechSynthesis.onvoiceschanged = refreshVoices;
}

function speak(text) {
  if (!hasAudio() || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const want = state.settings.voice;
    const v = voices.find(x => x.lang === want) ||
              voices.find(x => x.lang && x.lang.startsWith("es"));
    if (v) u.voice = v;
    u.lang = (v && v.lang) || want;
    u.rate = 0.9;
    speechSynthesis.speak(u);
  } catch (e) { /* audio is a nicety, never a blocker */ }
}

// ---------- card presentation ----------

const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function chunkOf(card) { return CHUNKS[Number(card.item.split(":")[1])]; }

/* What the learner has to produce, and what counts as right. */
function cardSpec(card) {
  if (card.type === "chunk") {
    const ch = chunkOf(card);
    return { mode: "reveal", prompt: esc(ch[1]), sub: "construction", answer: ch[0],
             extra: esc(ch[2]) + '<span class="gloss">' + esc(ch[3]) + "</span>", speakText: ch[2] };
  }
  const w = word(card.item);
  if (card.type === "recog") {
    const fresh = card.state === "new" || card.state === "learning";
    return { mode: fresh ? "choice" : "reveal", prompt: esc(w.lemma),
             sub: POS_LABEL[w.pos] + " · #" + w.rank, answer: w.gloss,
             extra: w.note ? esc(w.note) : "", speakText: w.lemma };
  }
  if (card.type === "prod") {
    return { mode: "type", prompt: esc(w.gloss), sub: POS_LABEL[w.pos] + " · write it in Spanish",
             answer: w.lemma, extra: w.note ? esc(w.note) : "", speakText: w.lemma, lang: "es" };
  }
  if (card.type === "listen") {
    return { mode: "type", prompt: "▶ Listen and write what you hear",
             sub: "audio · " + POS_LABEL[w.pos], answer: w.lemma,
             extra: esc(w.gloss), speakText: w.lemma, lang: "es", autoSpeak: true };
  }
  // cloze
  const ex = EXAMPLES[card.item];
  const blanked = ex[0].replace(ex[2], '<span class="blank">' + "_".repeat(Math.max(3, ex[2].length)) + "</span>");
  return { mode: "type", prompt: blanked,
           sub: "fill the gap · " + esc(ex[3]), answer: ex[2],
           extra: esc(ex[1]), speakText: ex[0], lang: "es",
           // No pre-answer playback here: the audio contains the missing word.
           noPreplay: true };
}

function progressLine() {
  const learned = learnedLemmas();
  const retained = retainedLemmas();
  const cov = earnedCoverage(retained.map(l => rankOf[l]));
  const pipeline = earnedCoverage(state.introduced.map(l => rankOf[l])) - cov;
  return { learned: learned.length, retained: retained.length, cov, pipeline };
}

function renderSessionBar() {
  const now = Date.now();
  const dueLeft = Object.values(state.cards).filter(c => c.due <= now).length;
  const p = progressLine();
  $("#sessionbar").innerHTML =
    '<span><b>' + queue.length + '</b> in queue</span>' +
    '<span><b>' + dueLeft + '</b> due</span>' +
    '<span><b>' + p.learned + '</b> / 1000 words</span>' +
    '<span class="cov"><b>' + p.cov.toFixed(1) + '%</b> text retained</span>';
}

function showCard() {
  revealed = false;
  renderSessionBar();
  const host = $("#card");
  host.innerHTML = "";

  if (!queue.length) return showSessionDone();
  current = queue[0];
  const spec = cardSpec(current);

  const box = el("div", "cardbox");
  box.appendChild(el("div", "sub", spec.sub));
  box.appendChild(el("div", "prompt", spec.prompt));

  if (spec.mode === "choice") {
    const opts = choiceOptions(current);
    const wrap = el("div", "choices");
    opts.forEach(o => {
      const b = el("button", "choice", esc(o));
      b.onclick = () => answerChoice(o, spec.answer);
      wrap.appendChild(b);
    });
    box.appendChild(wrap);
  } else if (spec.mode === "type") {
    const input = el("input", "answer");
    input.type = "text";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.placeholder = spec.lang === "es" ? "escribe en español…" : "type your answer…";
    input.onkeydown = e => {
      if (e.key !== "Enter") return;
      // Stop the keypress here. If it bubbles to the document handler it
      // submits and advances in one stroke, and the learner never sees the
      // answer - which throws away the feedback the whole card exists for.
      e.preventDefault();
      e.stopPropagation();
      submitTyped(input.value, spec);
    };
    box.appendChild(input);
    const hint = el("div", "hintrow");
    const btn = el("button", "ghost", "Check");
    btn.onclick = () => submitTyped(input.value, spec);
    hint.appendChild(btn);
    if (hasAudio() && spec.speakText && !spec.noPreplay) {
      const a = el("button", "ghost", "♪ Play");
      a.onclick = () => speak(spec.speakText);
      hint.appendChild(a);
    }
    box.appendChild(hint);
    host.appendChild(box);
    input.focus();
    if (spec.autoSpeak) setTimeout(() => speak(spec.speakText), 250);
    return;
  } else {
    const b = el("button", "primary", "Show answer <span class=key>space</span>");
    b.onclick = () => reveal(spec);
    box.appendChild(b);
  }

  host.appendChild(box);
}

/* The distinct meanings inside a gloss, ignoring parentheticals:
 * "to be (identity, essence)" -> ["to be"], "the; her, it" -> ["the","her","it"]. */
function senses(gloss) {
  return gloss.toLowerCase().replace(/\([^)]*\)/g, "")
    .split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

/* Distractors are drawn from the same part of speech and a nearby frequency
 * band, so a card cannot be solved by elimination - but never from a word
 * that SHARES a meaning with the answer. "el" and "la" are both "the", and
 * ser and estar are both "to be": offering those side by side asks the
 * learner to pick between two right answers. */
function choiceOptions(card) {
  const w = word(card.item);
  const mine = new Set(senses(w.gloss));
  const clashes = g => senses(g).some(s => mine.has(s));
  const pool = WORDS
    .map((x, i) => ({ gloss: x[1], pos: x[2], rank: i + 1 }))
    .filter(x => x.pos === w.pos && x.rank !== w.rank && !clashes(x.gloss));
  const near = pool.filter(x => Math.abs(x.rank - w.rank) <= 200);
  const src = near.length >= 3 ? near : pool;
  let picks = shuffle(src.slice()).slice(0, 3).map(x => x.gloss);
  if (picks.length < 3) {
    // Tiny word classes (three articles, four interjections) cannot supply
    // three same-class distractors. Fall back to nearby ranks of any class
    // so the card never collapses to a two-way guess.
    const filler = shuffle(WORDS.map((x, i) => ({ gloss: x[1], rank: i + 1 }))
      .filter(x => x.rank !== w.rank && Math.abs(x.rank - w.rank) <= 300 &&
                   !clashes(x.gloss) && !picks.includes(x.gloss)));
    picks = picks.concat(filler.slice(0, 3 - picks.length).map(x => x.gloss));
  }
  return shuffle([w.gloss, ...picks]);
}

function feedback(html, cls) {
  const fb = el("div", "feedback " + (cls || ""), html);
  $(".cardbox").appendChild(fb);
  return fb;
}

function answerBlock(spec, correct) {
  let h = '<div class="answer-line' + (correct ? " ok" : " no") + '">' + esc(spec.answer) + "</div>";
  if (spec.extra) h += '<div class="extra">' + spec.extra + "</div>";
  return h;
}

function answerChoice(picked, answer) {
  const correct = core(picked) === core(answer);
  const spec = cardSpec(current);
  document.querySelectorAll(".choice").forEach(b => {
    b.disabled = true;
    if (core(b.textContent) === core(answer)) b.classList.add("right");
    else if (b.textContent === picked) b.classList.add("wrong");
  });
  feedback(answerBlock(spec, correct), correct ? "ok" : "no");
  if (spec.speakText) speak(spec.speakText);
  continueAfter(correct ? GRADE.GOOD : GRADE.AGAIN, correct);
}

function submitTyped(value, spec) {
  if (revealed) return;
  const res = checkAnswer(value, spec.answer);
  if (res.verdict === "empty") return;
  revealed = true;
  const input = $(".answer");
  if (input) input.disabled = true;

  let grade, cls, note;
  if (res.verdict === "exact") { grade = GRADE.GOOD; cls = "ok"; note = "Correct."; }
  else if (res.verdict === "accent") { grade = GRADE.HARD; cls = "warn"; note = res.note; }
  else if (res.verdict === "typo") { grade = GRADE.HARD; cls = "warn"; note = res.note; }
  else { grade = GRADE.AGAIN; cls = "no"; note = "Not this one."; }

  feedback('<div class="note">' + esc(note) + "</div>" + answerBlock(spec, grade !== GRADE.AGAIN), cls);
  if (spec.speakText) speak(spec.speakText);

  if (grade === GRADE.AGAIN) {
    const row = el("div", "hintrow");
    const ov = el("button", "ghost", "I actually had it → count as hard");
    ov.onclick = () => { advance(GRADE.HARD, true); };
    row.appendChild(ov);
    $(".cardbox").appendChild(row);
  }
  continueAfter(grade, grade !== GRADE.AGAIN);
}

function reveal(spec) {
  if (revealed) return;
  revealed = true;
  const btn = $(".cardbox .primary");
  if (btn) btn.remove();
  feedback(answerBlock(spec, true), "");
  if (spec.speakText) speak(spec.speakText);

  const grades = [
    ["Again", GRADE.AGAIN, "again"],
    ["Hard", GRADE.HARD, "hard"],
    ["Good", GRADE.GOOD, "good"],
    ["Easy", GRADE.EASY, "easy"],
  ];
  const row = el("div", "grades");
  grades.forEach(([label, g, cls], i) => {
    const b = el("button", "grade " + cls,
      esc(label) + '<span class="key">' + (i + 1) + "</span>");
    b.onclick = () => advance(g, g >= GRADE.GOOD);
    row.appendChild(b);
  });
  $(".cardbox").appendChild(row);
}

/* Auto-graded cards still let you bump the rating, but pressing Enter or
 * clicking Continue accepts the automatic one. */
function continueAfter(grade, correct) {
  const row = el("div", "grades");
  const b = el("button", "primary wide", "Continue <span class=key>enter</span>");
  b.onclick = () => advance(grade, correct);
  row.appendChild(b);
  $(".cardbox").appendChild(row);
  pendingAdvance = () => advance(grade, correct);
}

let pendingAdvance = null;

/* Cards still in learning come back inside the SAME session, spaced by a
 * handful of other cards rather than by wall-clock minutes. Expanding
 * retrieval - recall it after 4 cards, then after 12 - is what moves a word
 * out of working memory. Making the learner wait ten real minutes for the
 * second look just ends the session instead. */
function reinsert(card) {
  const soon = card.due - Date.now() < 20 * 60 * 1000;
  if (!soon) return;
  if (card.state !== "learning" && card.state !== "relearn") return;
  const gap = card.step > 0 ? 12 : 4;
  queue.splice(Math.min(queue.length, gap), 0, card);
}

function advance(grade, correct) {
  if (!current) return;
  pendingAdvance = null;
  const updated = schedule(current, grade, Date.now());
  putCard(updated);
  logToday("reviews", 1);
  if (correct) logToday("correct", 1);
  sessionLog.seen++;
  if (correct) sessionLog.correct++;

  queue.shift();
  reinsert(updated);

  reconcileUnlocks();
  saveState();
  showCard();
}

function showSessionDone() {
  current = null;
  pendingAdvance = null;
  const now = Date.now();
  const nextDue = Object.values(state.cards).map(c => c.due).filter(d => d > now).sort((a, b) => a - b)[0];
  const p = progressLine();
  const acc = sessionLog.seen ? Math.round(100 * sessionLog.correct / sessionLog.seen) : 0;
  const when = nextDue
    ? (nextDue - now < DAY_MS
        ? "in " + Math.max(1, Math.round((nextDue - now) / 3600000)) + "h"
        : "in " + Math.round((nextDue - now) / DAY_MS) + " days")
    : "—";
  $("#card").innerHTML =
    '<div class="cardbox done">' +
    "<h2>Queue empty</h2>" +
    '<p class="lead">' + sessionLog.seen + " cards, " + acc + "% first-pass correct.</p>" +
    '<div class="statgrid">' +
      '<div><b>' + p.learned + "</b><span>words learned</span></div>" +
      '<div><b>' + p.cov.toFixed(1) + "%</b><span>text coverage</span></div>" +
      "<div><b>" + when + "</b><span>next card due</span></div>" +
    "</div>" +
    '<p class="small">Coming back tomorrow beats a longer session today. ' +
    "The interval only works if you let it run.</p>" +
    '<button class="primary" onclick="startSession()">Check again</button>' +
    "</div>";
}

function startSession() {
  sessionLog = { seen: 0, correct: 0, started: Date.now() };
  buildQueue();
  saveState();
  showCard();
}

// ---------- progress view ----------

const BANDS = [[1, 100], [101, 250], [251, 500], [501, 750], [751, 1000]];

function renderProgress() {
  const learned = learnedLemmas();
  const learnedSet = new Set(learned);
  const p = progressLine();
  const cov = p.cov;
  const introduced = state.introduced.length;
  const mature = state.introduced.filter(l => isMature(getCard(l, "recog"))).length;

  const bandRows = BANDS.map(([lo, hi]) => {
    const total = hi - lo + 1;
    const got = WORDS.slice(lo - 1, hi).filter(w => learnedSet.has(w[0])).length;
    const worth = coverageFor(hi) - coverageFor(lo - 1);
    return '<tr><td>' + lo + "–" + hi + "</td>" +
      '<td class="num">' + got + " / " + total + "</td>" +
      '<td><div class="bar"><i style="width:' + (100 * got / total).toFixed(1) + '%"></i></div></td>' +
      '<td class="num dim">' + worth.toFixed(1) + "%</td></tr>";
  }).join("");

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const k = todayKey(Date.now() - i * DAY_MS);
    days.push({ k, ...(state.history[k] || { reviews: 0, correct: 0, newWords: 0 }) });
  }
  const maxRev = Math.max(10, ...days.map(d => d.reviews));
  const bars = days.map(d =>
    '<i style="height:' + Math.round(100 * d.reviews / maxRev) + '%" title="' +
    d.k + ": " + d.reviews + ' reviews"></i>').join("");

  const totalRev = Object.values(state.history).reduce((a, b) => a + b.reviews, 0);
  const totalCorrect = Object.values(state.history).reduce((a, b) => a + b.correct, 0);
  const retention = totalRev ? Math.round(100 * totalCorrect / totalRev) : 0;

  let streak = 0;
  for (let i = 0; ; i++) {
    const h = state.history[todayKey(Date.now() - i * DAY_MS)];
    if (h && h.reviews > 0) streak++;
    else if (i > 0) break;
    else if (!h) break;
  }

  const byType = {};
  Object.values(state.cards).forEach(c => {
    byType[c.type] = byType[c.type] || { total: 0, review: 0 };
    byType[c.type].total++;
    if (c.state === "review") byType[c.type].review++;
  });
  const typeRows = Object.entries(byType).map(([t, v]) =>
    "<tr><td>" + ({ recog: "Recognise ES→EN", prod: "Produce EN→ES",
      cloze: "Sentence gap", listen: "Listening", chunk: "Constructions" }[t] || t) +
    '</td><td class="num">' + v.review + " / " + v.total + "</td></tr>").join("");

  $("#progress").innerHTML =
    '<section class="hero">' +
      '<div class="bignum">' + cov.toFixed(1) + "%</div>" +
      '<div class="biglabel">estimated coverage of running text, from words ' +
        'you have held for a week or more</div>' +
      '<div class="track"><i style="width:' + Math.min(100, cov / 0.71).toFixed(1) + '%"></i>' +
        '<u style="width:' + Math.min(100 - cov / 0.71, p.pipeline / 0.71).toFixed(1) + '%"></u></div>' +
      '<p class="small">' + p.retained + " words retained &middot; " + learned.length +
        " past their first day &middot; " + introduced + " introduced &middot; " + mature +
        " mature (21+ day interval)." +
        (p.pipeline > 0.05 ? " A further <b>" + p.pipeline.toFixed(1) +
          "%</b> is in the pipeline, not yet held long enough to count." : "") +
        " All 1000 lands around 71%.</p>" +
    "</section>" +
    '<section class="panel"><h3>Where your coverage comes from</h3>' +
      '<table class="tbl"><thead><tr><th>Frequency band</th><th class="num">Learned</th>' +
      "<th></th><th class=num>Band is worth</th></tr></thead><tbody>" + bandRows +
      "</tbody></table>" +
      '<p class="small">The first hundred words carry more text than the last ' +
      "seven hundred combined. That asymmetry is the entire reason to study in " +
      "frequency order.</p></section>" +
    '<section class="panel"><h3>Last 30 days</h3>' +
      '<div class="spark">' + bars + "</div>" +
      '<div class="statgrid tight">' +
        "<div><b>" + streak + "</b><span>day streak</span></div>" +
        "<div><b>" + totalRev + "</b><span>total reviews</span></div>" +
        "<div><b>" + retention + "%</b><span>first-pass accuracy</span></div>" +
      "</div>" +
      '<p class="small">Accuracy far above 90% means the intervals are too short ' +
      "and you are wasting reps; far below 80% means you are adding new words " +
      "faster than they stick. Adjust new cards per day in Settings.</p></section>" +
    '<section class="panel"><h3>Cards in long-term review</h3>' +
      '<table class="tbl"><tbody>' + (typeRows || '<tr><td class="dim">Nothing yet.</td></tr>') +
      "</tbody></table></section>";
}

// ---------- browse view ----------

function cardStatus(lemma) {
  const c = getCard(lemma, "recog");
  if (!c) return ["locked", "not started"];
  if (isMature(c)) return ["mature", "mature · " + c.ivl + "d"];
  if (isLearned(c)) return ["learned", "learning · " + c.ivl + "d"];
  return ["seen", c.state];
}

function renderBrowse(filter) {
  const q = (filter || "").trim().toLowerCase();
  const rows = WORDS.map((w, i) => ({ lemma: w[0], gloss: w[1], pos: w[2], note: w[3], rank: i + 1 }))
    .filter(w => !q || w.lemma.includes(q) || w.gloss.toLowerCase().includes(q))
    .slice(0, 400)
    .map(w => {
      const [cls, label] = cardStatus(w.lemma);
      return '<tr class="' + cls + '"><td class="num dim">' + w.rank + "</td>" +
        '<td class="lemma">' + esc(w.lemma) + "</td>" +
        "<td>" + esc(w.gloss) + '<span class="pos">' + POS_LABEL[w.pos] + "</span></td>" +
        '<td class="note">' + esc(w.note || "") + "</td>" +
        '<td class="status"><span class="dot"></span>' + esc(label) + "</td></tr>";
    }).join("");

  $("#browse").innerHTML =
    '<section class="panel">' +
      '<div class="browsebar">' +
        '<input id="q" type="search" placeholder="filter by Spanish or English…" value="' + esc(q) + '">' +
        '<span class="small dim">showing up to 400 of 1000</span>' +
      "</div>" +
      '<div class="tablewrap"><table class="tbl browse"><thead><tr><th>#</th><th>Spanish</th>' +
      "<th>English</th><th>Notes</th><th>Status</th></tr></thead><tbody>" + rows +
      "</tbody></table></div>" +
    "</section>";
  const input = $("#q");
  input.oninput = () => { const v = input.value; renderBrowse(v); $("#q").focus(); $("#q").setSelectionRange(v.length, v.length); };
}

// ---------- settings view ----------

function renderSettings() {
  const s = state.settings;
  $("#settings").innerHTML =
    '<section class="panel"><h3>Study load</h3>' +
      '<label>New words per day <input id="s-new" type="number" min="0" max="40" value="' + s.newPerDay + '"></label>' +
      '<p class="small">Each new word eventually generates three to four cards. ' +
      "Eight a day is about 25 minutes of reviews at steady state and finishes " +
      "the list in four months. Twenty a day finishes in seven weeks and most " +
      "people quit in three.</p>" +
      '<label>Cards per session <input id="s-size" type="number" min="5" max="200" value="' + s.sessionSize + '"></label>' +
      '<label>Pause new words when due count exceeds <input id="s-guard" type="number" min="20" max="500" value="' + s.backlogGuard + '"></label>' +
      '<p class="small">The backlog guard is what stops a missed week from ' +
      "turning into a 400-card wall.</p>" +
    "</section>" +
    '<section class="panel"><h3>Audio</h3>' +
      '<label><input id="s-audio" type="checkbox" ' + (s.audio ? "checked" : "") + "> Speak words and sentences</label>" +
      '<label>Voice <select id="s-voice">' +
        ['es-ES', 'es-MX', 'es-AR', 'es-CO', 'es-US'].map(v =>
          '<option value="' + v + '"' + (s.voice === v ? " selected" : "") + ">" + v + "</option>").join("") +
      "</select></label>" +
      '<p class="small">Uses the voices your browser or OS has installed. ' +
      (hasSpanishVoice()
        ? "A Spanish voice is available, so listening cards are in the rotation."
        : "<b>No Spanish voice found on this device</b>, so listening cards are " +
          "switched off. Install a Spanish system voice to enable them.") +
      "</p>" +
    "</section>" +
    '<section class="panel"><h3>Your data</h3>' +
      '<p class="small">Progress lives in this browser’s local storage. ' +
      "Clearing site data deletes it. Export if you care about it.</p>" +
      '<div class="hintrow">' +
        '<button class="ghost" onclick="exportData()">Export JSON</button>' +
        '<button class="ghost" onclick="document.getElementById(\'importfile\').click()">Import JSON</button>' +
        '<button class="ghost danger" onclick="resetAll()">Reset everything</button>' +
      "</div>" +
      '<input type="file" id="importfile" accept="application/json" hidden>' +
      '<div id="exportout"></div>' +
    "</section>";

  $("#s-new").onchange = e => { s.newPerDay = +e.target.value; saveState(); };
  $("#s-size").onchange = e => { s.sessionSize = +e.target.value; saveState(); };
  $("#s-guard").onchange = e => { s.backlogGuard = +e.target.value; saveState(); };
  $("#s-audio").onchange = e => { s.audio = e.target.checked; saveState(); };
  $("#s-voice").onchange = e => { s.voice = e.target.value; saveState(); speak("Hola, qué tal"); };
  $("#importfile").onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(r.result);
        if (!parsed.cards) throw new Error("not a progress file");
        state = { ...freshState(), ...parsed };
        state.settings = { ...DEFAULTS, ...(parsed.settings || {}) };
        saveState();
        alert("Imported. " + Object.keys(state.cards).length + " cards restored.");
        go("study");
      } catch (err) { alert("Could not import: " + err.message); }
    };
    r.readAsText(f);
  };
}

/* Offers the file download, and always shows the JSON as selectable text as
 * well: some embedded contexts block downloads a page starts itself, and a
 * dead Export button is worse than no Export button. */
function exportData() {
  const json = JSON.stringify(state, null, 2);
  try {
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "milpalabras-" + todayKey() + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { /* fall through to the copyable text below */ }

  const host = $("#exportout");
  if (!host) return;
  host.innerHTML =
    '<label for="exportjson">Your progress as JSON — copy this somewhere safe if ' +
    "the download did not start.</label>" +
    '<textarea id="exportjson" class="exportbox" readonly rows="6"></textarea>' +
    '<div class="hintrow"><button class="ghost" id="copyjson">Copy to clipboard</button></div>';
  const box = $("#exportjson");
  box.value = json;
  box.focus();
  box.select();
  $("#copyjson").onclick = async () => {
    const btn = $("#copyjson");
    try {
      await navigator.clipboard.writeText(json);
      btn.textContent = "Copied";
    } catch (e) {
      box.select();
      btn.textContent = "Press Cmd/Ctrl+C to copy";
    }
  };
}

function resetAll() {
  if (!confirm("Delete all progress on this device? This cannot be undone.")) return;
  if (!confirm("Really reset? Export first if you want a copy.")) return;
  state = freshState();
  saveState();
  go("study");
}

// ---------- navigation ----------

function go(view) {
  ["study", "progress", "browse", "settings"].forEach(v => {
    $("#" + v).classList.toggle("hidden", v !== view);
    const tab = document.querySelector('[data-view="' + v + '"]');
    if (tab) tab.classList.toggle("active", v === view);
  });
  $("#sessionbar").classList.toggle("hidden", view !== "study");
  if (view === "progress") renderProgress();
  if (view === "browse") renderBrowse("");
  if (view === "settings") renderSettings();
  if (view === "study") { buildQueue(); showCard(); }
}

document.addEventListener("keydown", e => {
  if ($("#study").classList.contains("hidden")) return;
  const typing = document.activeElement && document.activeElement.tagName === "INPUT";
  if (e.key === "Enter" && pendingAdvance) { e.preventDefault(); pendingAdvance(); return; }
  if (typing) return;
  if (e.key === " " && !revealed) {
    const b = $(".cardbox .primary");
    if (b) { e.preventDefault(); b.click(); }
  }
  if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
    const b = document.querySelectorAll(".grade")[+e.key - 1];
    if (b) b.click();
  }
});

function init() {
  state = loadState();
  document.querySelectorAll("[data-view]").forEach(t => {
    t.onclick = () => go(t.dataset.view);
  });
  startSession();
  go("study");
}

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init);

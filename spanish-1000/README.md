# Mil Palabras

A Spanish vocabulary trainer built around one empirical fact: **word frequency
in natural language is Zipf-distributed**, so a small head of the vocabulary
does almost all of the work. The first hundred Spanish lemmas carry more
running text than the next nine hundred put together. Learning words in
frequency order is therefore not a preference — it is the ordering that
maximises comprehension per hour studied.

Open `index.html` in a browser. No build step, no dependencies, no server.
Progress is stored in `localStorage` and can be exported to JSON.

---

## The learning principles this implements, and why

### 1. Frequency order, lemma-based

The deck is 1000 lemmas ordered by corpus frequency. **Lemmas, not surface
forms** — a list of inflected forms burns four slots on *es, está, están,
estar* and buys you one concept. Verbs are taught as infinitives and the
conjugations are trained through sentence cloze cards instead.

The payoff curve, which the Progress tab shows directly:

| Band | Estimated share of running text |
|---|---|
| 1–100 | ~45% |
| 101–250 | ~9% |
| 251–500 | ~8% |
| 501–750 | ~5% |
| 751–1000 | ~4% |

Diminishing returns are steep and start early. That is the argument for
finishing the head of the list before doing anything else, and also the
argument against studying words 1000–5000 by the same method — past this
point, extensive reading beats flashcards.

**These percentages are estimates.** They are log-interpolated between
published anchor points for lemma coverage of large Spanish corpora
(Davies-style frequency dictionaries). Coverage is register-dependent:
conversation runs meaningfully higher, technical prose lower. The number
is a motivator and a planning tool, not a measurement. Confidence: high on
the shape of the curve, medium on any individual percentage.

### 2. Retrieval practice, never re-reading

Every card is an attempt to produce an answer from memory. There is
deliberately no "browse and absorb" study mode, because re-reading produces
a strong feeling of fluency and very little retention — the fluency comes
from the text being in front of you, and it leaves with the text. The
Words tab exists for reference and progress checking, not for studying.

### 3. Spaced repetition with a per-card ease factor

SM-2 (`js/srs.js`). Intervals expand as long as you keep answering
correctly; a lapse cuts the interval and permanently lowers that card's
ease factor, so genuinely hard words get seen more often forever. A fixed
Leitner ladder cannot do this: *que* and *desafío* are both on the list and
do not deserve the same schedule.

Intervals target roughly 90% recall at review time. Reviewing earlier is
cheap and nearly worthless; reviewing later means relearning from scratch.

### 4. Four card types, unlocked in difficulty order

| Type | Direction | Unlocks when |
|---|---|---|
| Recognise | ES → EN | immediately |
| Produce | EN → ES, typed | recognition survives one day |
| Sentence gap | cloze, typed | production survives one day |
| Listening | audio → typed | production survives one day |

Recognition is the cheap half of knowing a word. Production is the half
that lets you speak, and it is trained second because it is only tractable
once recognition is stable. The cloze cards are where conjugation and
collocation get learned — the hint line tells you *ser, present, él/ella*
and you have to produce `es`.

### 5. Comprehensible input at i+1

Cloze sentences are built almost entirely from words ranked *above* the
target, so a sentence card is one unknown slot inside known material. This
is the condition under which input is acquirable rather than just decodable.

### 6. Chunks, not just words

66 high-frequency constructions (`tener que + infinitivo`, `acabar de +
infinitivo`, `darse cuenta de`) are drilled as single units. Fluent speech
is assembled from prefabricated frames, not from words slotted into rules
one at a time. A learner who knows *tener*, *que* and the infinitive still
stalls before "tengo que salir" unless the whole frame is automatic.

### 7. Interleaving

Card types for one word are mixed in with other words rather than blocked
together. Blocked practice produces better performance *today* and worse
retention next month. Cards still in learning come back within the same
session, spaced by a handful of other cards (expanding retrieval) rather
than by wall-clock minutes.

### 8. A hard cap on new words per day

Default 8. Each new word eventually generates three to four cards, so
review load is a roughly constant multiple of intake. Uncapped intake
creates a review debt that arrives two weeks later and ends the habit.
A backlog guard pauses new words entirely when the due count exceeds a
threshold, so a missed week does not become a 400-card wall.

### 9. Partial credit for near-misses

A missing accent or a single slipped key is a **retrieval success with a
production error**. Marking it wrong destroys the earned interval and
teaches you to fear the keyboard; marking it perfect lets the error
calcify. So it is accepted and downgraded to *hard*, which shortens the
next interval. Answers are also matched against every comma-separated
gloss, and leading articles are stripped.

### 10. Honest progress reporting

The headline coverage figure counts only words held for **seven days or
more**. Answering a word correctly on the day you met it is not
comprehension. Words still in the pipeline are shown separately so the
number stays motivating without being a number you cannot cash.

---

## Layout

```
index.html            app shell
css/styles.css
js/srs.js             SM-2 scheduler, no DOM dependencies
js/coverage.js        coverage model + answer matching (accents, typos)
js/app.js             session engine, card renderers, views
js/data/words.js      1000 lemmas: [lemma, gloss, pos, usage note]
js/data/examples.js   245 cloze sentences: [es, en, surfaceForm, formHint]
js/data/chunks.js     66 constructions
```

`srs.js` and `coverage.js` are pure functions with no browser
dependencies, so they can be unit-tested directly under Node.

## Data notes

Ranks follow published lemma-frequency orderings closely for the first
~200 entries and frequency *bands* beyond that — treat any individual rank
past 200 as approximate. The band is what matters pedagogically, not the
decimal place.

Usage notes flag the things that actually trip learners up: false friends
(`largo` is not *large*, `realizar` is not *to realize*, `actualmente` is
not *actually*), nouns whose gender contradicts their ending (`el día`,
`la mano`, `el problema`), `el agua` and `el hambre`, backwards verbs
(`gustar`, `doler`, `encantar`), and regional splits (`coche`/`carro`,
`ordenador`/`computadora`, `billete`/`boleto`).

## Settings worth touching

- **New words per day** — 8 is ~25 minutes of reviews at steady state and
  finishes the list in about four months. 20 finishes in seven weeks, and
  most people quit in three.
- **First-pass accuracy** (Progress tab) is the tuning signal: well above
  90% means intervals are too short and you are wasting reps; below 80%
  means you are adding words faster than they stick.

## Limitations

- Listening cards require a Spanish system voice; where none is installed
  they are not created, and Settings says so.
- Audio uses the browser's speech synthesis, which is serviceable for
  single words and mediocre for prosody. It is not a substitute for real
  input.
- 245 of the 1000 words have cloze sentences. The rest fall back to
  recognition, production and listening.
- Progress lives in one browser's local storage. Export from Settings if
  you care about it.

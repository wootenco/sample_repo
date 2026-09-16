/* Coverage model and answer matching.
 *
 * The premise of this app in one line: word frequency in natural language
 * follows a Zipf distribution, so a small head of the vocabulary does most
 * of the work. Learning words in frequency order buys comprehension faster
 * per hour than learning them in any other order, including thematically.
 *
 * The numbers below are ESTIMATES interpolated between published anchor
 * points for lemma coverage of running text in large Spanish corpora
 * (Davies-style frequency dictionaries). Coverage is register-dependent:
 * everyday speech sits above these figures, technical prose below. Treat
 * the number in the UI as an order-of-magnitude motivator, not a metric.
 */

const COVERAGE_ANCHORS = [
  [0, 0], [10, 23], [50, 38], [100, 45], [200, 52],
  [300, 56], [500, 62], [750, 67], [1000, 71],
];

/* Log-interpolated coverage for the top N lemmas. */
function coverageFor(n) {
  if (n <= 0) return 0;
  const A = COVERAGE_ANCHORS;
  if (n >= A[A.length - 1][0]) return A[A.length - 1][1];
  for (let i = 1; i < A.length; i++) {
    if (n <= A[i][0]) {
      const [x0, y0] = A[i - 1], [x1, y1] = A[i];
      const lx = Math.log(Math.max(1, x0)), lx1 = Math.log(x1);
      const t = (Math.log(n) - lx) / (lx1 - lx || 1);
      return y0 + t * (y1 - y0);
    }
  }
  return 0;
}

/* Coverage you have actually banked: learned words are credited at their
 * own rank position, so learning word #12 is worth far more than #900. */
function earnedCoverage(learnedRanks) {
  if (!learnedRanks.length) return 0;
  let total = 0;
  for (const r of learnedRanks) total += coverageFor(r) - coverageFor(r - 1);
  return total;
}

// ---------- answer matching ----------

function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalize(s) {
  return s.toLowerCase()
    .replace(/[¿?¡!.,;:"()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* Articles and reflexive tails are noise when checking a vocabulary answer.
 *
 * The reflexive strip is deliberately narrow: only -arse/-erse/-irse, so that
 * llamarse matches llamar without also turning "clase" into "cla", "frase"
 * into "fra" or the pronoun "se" into nothing at all. */
function core(s) {
  const out = normalize(s)
    .replace(/^(el|la|los|las|un|una|unos|unas|to|the|a|an) /, "")
    .replace(/([aei]r)se$/, "$1");
  return out || normalize(s);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/* Grades a typed answer against one or more accepted forms.
 *
 * The distinction that matters pedagogically: a missing accent or a single
 * slipped key is a RETRIEVAL SUCCESS with a production error. Marking it
 * wrong destroys the interval you earned and teaches you to fear the
 * keyboard. Marking it perfect lets the error calcify. So it is accepted
 * and downgraded to "hard", which shortens the next interval.
 */
function checkAnswer(input, accepted) {
  const given = core(input);
  if (!given) return { verdict: "empty" };
  const forms = (Array.isArray(accepted) ? accepted : [accepted])
    .flatMap(a => String(a).split(/\s*[,;/]\s*/))
    .map(a => a.trim())
    .filter(Boolean);

  for (const f of forms) {
    if (given === core(f)) return { verdict: "exact", matched: f };
  }
  for (const f of forms) {
    if (stripAccents(given) === stripAccents(core(f))) {
      return { verdict: "accent", matched: f, note: "Right word, missing or wrong accent." };
    }
  }
  for (const f of forms) {
    const target = stripAccents(core(f));
    const g = stripAccents(given);
    const tolerance = target.length <= 4 ? 0 : 1;
    if (tolerance && levenshtein(g, target) <= tolerance) {
      return { verdict: "typo", matched: f, note: "Counted as a typo." };
    }
  }
  return { verdict: "wrong" };
}

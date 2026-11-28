/**
 * Scoring for the Kira evaluation (see docs/evaluation/README.md).
 *
 * A run is CORRECT only if all four checks pass:
 *   1. origin    - the expected origin service is named in Root cause (and, if
 *                  the Affected-services line marks an "(origin)", it is that one)
 *   2. category  - the **Category:** line equals the expected category
 *                  (a keyword fallback is used only if the line is missing, and
 *                  that is recorded)
 *   3. evidence  - at least one expected piece of evidence appears in the answer
 *   4. blast     - no service outside the allowed set is listed as affected
 */

export const SERVICES = ['frontend', 'gateway', 'auth', 'product', 'order', 'orders', 'user'];

/** Exact service name: `order` never matches inside `orders`. */
const nameRe = (s) => new RegExp(`(?<![A-Za-z0-9_-])${s}(?![A-Za-z0-9_-])`, 'i');
export const servicesIn = (text) => SERVICES.filter((s) => nameRe(s).test(String(text ?? '')));

/** What a correct answer looks like, per scenario. */
export const EXPECTATIONS = {
  HEALTHY: {
    origin: null,
    category: 'none',
    evidence: [/no active incident/i],
    allowed: [],
  },
  F1: {
    origin: 'order',
    category: 'code-bug',
    evidence: [/line1/i, /TypeError/i, /shipping ?address/i, /\b500\b/, /stack trace/i],
    allowed: ['order', 'gateway', 'frontend'],
  },
  F2: {
    origin: 'product',
    category: 'latency',
    evidence: [/\bp(50|95|99)\b/i, /\b\d{3,5}\s?ms\b/i, /latenc/i, /slow/i],
    allowed: ['product', 'order', 'gateway', 'frontend'],
  },
  F3: {
    origin: 'user',
    category: 'crash-loop',
    evidence: [/CrashLoopBackOff/i, /exit(ed|s)? (code )?1\b/i, /restart/i, /SEED_CRASH_ON_START/],
    allowed: ['user'],
  },
  F4: {
    origin: 'auth',
    category: 'out-of-memory',
    evidence: [/OOMKilled/i, /out of memory/i, /memory limit/i, /128\s?Mi/i],
    allowed: ['auth', 'gateway', 'frontend'],
  },
  F5: {
    origin: 'orders',
    category: 'bad-config',
    evidence: [/ENOTFOUND/i, /database/i, /DATABASE_URL/, /readiness/i, /not ready/i, /connect/i],
    allowed: ['orders', 'gateway', 'frontend'],
  },
  F6: {
    origin: 'gateway',
    category: 'bad-deploy',
    evidence: [/ImagePullBackOff/i, /ErrImagePull/i, /image (tag|cannot|could not|not found)/i, /f6-missing-tag/],
    allowed: ['gateway'],
  },
};

/** Fallback keywords, used ONLY when the answer has no **Category:** line. */
const CATEGORY_KEYWORDS = {
  'code-bug': /exception|TypeError|stack trace|\bbug\b/i,
  latency: /latenc|slow|delay/i,
  'crash-loop': /CrashLoopBackOff|crash/i,
  'out-of-memory': /OOM|out of memory|memory limit/i,
  'bad-config': /misconfig|config|DATABASE_URL|ENOTFOUND/i,
  'bad-deploy': /ImagePull|ErrImagePull|image tag/i,
  none: /no active incident/i,
};

/**
 * A heading line, in either style the model actually produces:
 *   "### Blast radius"          (the requested format)
 *   "**Blast radius:**"         (bold pseudo-heading, on a line of its own)
 * Case-insensitive. A bold label WITH content on the same line
 * ("**Category:** code-bug", "- **Affected services:** auth") is not a heading.
 */
const HEADING_LINE = /^[ \t]*(?:#{1,6}[ \t]*(.+?)|\*\*([^*\n]+?):?\*\*:?)[ \t]*$/gm;

function headings(answer) {
  const out = [];
  for (const m of String(answer).matchAll(HEADING_LINE)) {
    out.push({ title: (m[1] ?? m[2]).replace(/[*:`]/g, '').trim().toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Text of a section (until the next heading of either style); '' if the heading is absent. */
export function section(answer, heading) {
  const hs = headings(answer);
  const i = hs.findIndex((h) => h.title === heading.toLowerCase());
  if (i === -1) return '';
  const end = hs[i + 1]?.start ?? String(answer).length;
  return String(answer).slice(hs[i].end, end).trim();
}

/** Text before the first heading - where the model puts the Category line when it skips "### Root cause". */
export function preamble(answer) {
  const hs = headings(answer);
  return String(answer).slice(0, hs[0]?.start ?? String(answer).length).trim();
}

/** "the `order` service, which is the origin" - prose naming an origin, for a non-scoring warning. */
const ORIGIN_CLAIM = /`?([a-z]+)`?(?:\s+service)?,?\s+(?:which|that)?\s*is\s+the\s+origin/gi;

/** The services on the "Affected services:" line, and which one is marked (origin). */
export function affectedServices(answer) {
  const blast = section(answer, 'Blast radius') || answer;
  const line = /affected services?\**\s*[:\-–]\**\s*(.+)/i.exec(blast);
  if (!line) return { listed: servicesIn(blast), markedOrigin: null, fromLine: false };
  const items = line[1].split(/\s*,\s*|\s+and\s+/);
  const origin = items.find((i) => /\(origin\)/i.test(i));
  return {
    listed: servicesIn(line[1]),
    markedOrigin: origin ? servicesIn(origin)[0] ?? null : null,
    fromLine: true,
  };
}

/** Score one answer against a scenario's expectation. */
export function scoreAnswer(scenario, answer) {
  const exp = EXPECTATIONS[scenario];
  if (!exp) throw new Error(`no expectation for scenario ${scenario}`);
  const text = String(answer ?? '');
  // The model does not always emit "### Root cause": it sometimes starts
  // straight with the **Category:** line. Then the text before the first
  // heading is the closest thing to a root-cause statement.
  const rootSection = section(text, 'Root cause');
  const rootMissing = rootSection === '';
  const root = rootMissing ? preamble(text) : rootSection;

  // 2. category ("**Category:** x", also "**Category**: x"; backticks/case tolerated)
  const catLine = /\*\*Category:?\*\*:?\s*`?([a-z-]+)`?/i.exec(root || text);
  const categoryFound = catLine ? catLine[1].toLowerCase() : null;
  const categoryFallback = !catLine;
  const category_ok = catLine
    ? categoryFound === exp.category
    : CATEGORY_KEYWORDS[exp.category].test(root || text);

  // 1. origin
  //    - an explicit "(origin)" marker on the Affected-services line is the
  //      model's origin claim: it must be the expected service, and the Root
  //      cause must not name ONLY other services (a contradiction);
  //    - without a marker, the Root cause must name the expected service.
  //    A Root cause that names no service at all (heading missing, or only the
  //    Category line) does not by itself fail a correctly marked origin.
  const { listed, markedOrigin } = affectedServices(text);
  const rootNames = servicesIn(root.replace(/\*\*Category:?\*\*:?.*$/im, ''));
  let origin_ok;
  let originReason = '';
  if (exp.origin === null) {
    origin_ok = /no active incident/i.test(root || text);
    if (!origin_ok) originReason = 'origin: did not say "no active incident"';
  } else if (markedOrigin) {
    const contradicts = rootNames.length > 0 && !rootNames.includes(exp.origin);
    origin_ok = markedOrigin === exp.origin && !contradicts;
    if (markedOrigin !== exp.origin) originReason = `origin: expected ${exp.origin}, marked ${markedOrigin}`;
    else if (contradicts) originReason = `origin: marked ${markedOrigin} but Root cause names only ${rootNames.join(', ')}`;
  } else {
    origin_ok = rootNames.includes(exp.origin);
    if (!origin_ok) {
      originReason = `origin: expected ${exp.origin} not named in Root cause${rootMissing ? ' (no Root cause section)' : ''} and no (origin) marker`;
    }
  }

  // Non-scoring: prose elsewhere claiming a different origin ("..., which is the origin").
  const warnings = [];
  if (exp.origin) {
    const claims = [...text.matchAll(ORIGIN_CLAIM)].map((m) => m[1].toLowerCase()).filter((s) => SERVICES.includes(s) && s !== exp.origin);
    if (claims.length) warnings.push(`prose also calls ${[...new Set(claims)].join(', ')} the origin`);
  }
  if (rootMissing) warnings.push('no Root cause section (format)');

  // 3. evidence
  const evidence_ok = exp.evidence.some((re) => re.test(text));

  // 4. blast radius
  const wrong = listed.filter((s) => !exp.allowed.includes(s));
  const blast_ok = wrong.length === 0;

  const checks = { origin_ok, category_ok, evidence_ok, blast_ok };
  const score = Object.values(checks).filter(Boolean).length;
  const reasons = [];
  if (!origin_ok) reasons.push(originReason);
  if (!category_ok) reasons.push(`category: expected ${exp.category}, got ${categoryFound ?? '(no Category line)'}`);
  if (!evidence_ok) reasons.push('no expected evidence cited');
  if (!blast_ok) reasons.push(`wrong services in blast radius: ${wrong.join(', ')}`);

  return {
    ...checks,
    score,
    correct: score === 4,
    category_found: categoryFound,
    category_fallback: categoryFallback,
    marked_origin: markedOrigin,
    wrong_services: wrong,
    reasons,
    warnings,
  };
}

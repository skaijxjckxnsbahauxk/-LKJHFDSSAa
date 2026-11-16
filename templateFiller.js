import Papa from 'papaparse';
import ACOUSTIC_TEMPLATE_CSV from './acousticTemplate.js';
import ITERABLE_TEMPLATE_CSV from './iterableTemplate.js';
import VERVE_TEMPLATE_CSV from './verveTemplate.js';

/**
 * Find the best workorder to place in a given segment slot.
 *
 * Strategy — rank-first, capped at `maxUses` placements per workorder per list:
 *
 *   Phase 1: scan workorders in score order; pick the FIRST one that
 *            (a) hasn't been placed in this segment on this list, AND
 *            (b) has fewer than `maxUses` placements on this list so far.
 *
 *   Phase 2: if every workorder is already at the cap (sheet has more slots
 *            than the eligible pool), pick the highest-ranked workorder that
 *            still respects the cap — skipping any (workorder, segment) pair
 *            already used.  With maxUses=1 this leaves a slot empty rather than
 *            repeating a workorder on the same list.
 *
 * The Acoustic filler calls this with maxUses=1 so a workorder appears at most
 * ONCE per list — no repeated creatives on the same list in a single day.
 *
 * @param {string[]} workorders   Ranked workorder codes (highest score first)
 * @param {string}   segmentName  The segment name of the target slot (e.g. "SEND 1")
 * @param {Map}      usedSegPerWO Map of workorder → Set of segment names already used on this list
 */
// maxUses: how many times a workorder may already have been placed on this list
// before it becomes eligible again (1 = first-placements only, 2 = allows second).
function findBestWO(workorders, segmentName, usedSegPerWO, maxUses = 2) {
  // Phase 1: highest-ranked workorder still under maxUses cap
  for (const wo of workorders) {
    const segsUsed = usedSegPerWO.get(wo) || new Set();
    if (!segsUsed.has(segmentName) && segsUsed.size < maxUses) return wo;
  }
  // Phase 2: all workorders at maxUses+ placements — pick highest-ranked avoiding segment repeat
  for (const wo of workorders) {
    const segsUsed = usedSegPerWO.get(wo) || new Set();
    if (!segsUsed.has(segmentName)) return wo;
  }
  return null;
}

function markUsed(usedSegPerWO, wo, segmentName) {
  if (!usedSegPerWO.has(wo)) usedSegPerWO.set(wo, new Set());
  usedSegPerWO.get(wo).add(segmentName);
}

// ─── Even-quality fill order ──────────────────────────────────────────────────
//
// Every filler pulls the highest-ranked still-eligible workorder for whichever
// slot it fills FIRST, then continues down the ranking.  So the ORDER in which
// columns are visited is what decides the time-of-day quality curve.  Visiting
// columns in plain time order front-loads the best creative into the morning and
// lets quality decay through the day.
//
// interleave() / interleaveHalves() split the time-ordered columns down the
// middle and alternate early/late, so consecutive ranks land alternately in the
// early and late halves.  Net effect: each half of the day carries a balanced
// mix of strong and weak creative instead of all the winners clustering early.
// This only reorders *which slot gets filled when* — every gap, segment, maxUses
// and stagger constraint is still enforced at placement time, unchanged.
function interleave(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

function interleaveHalves(cols) {
  if (cols.length <= 2) return [...cols];
  const half = Math.ceil(cols.length / 2);
  return interleave(cols.slice(0, half), cols.slice(half));
}

/**
 * Fills the hardcoded Acoustic deployment template with today's top workorders.
 *
 * Structure per list block:
 *   headerIdx + 0  → list name row, col[8] === "Time (PST)"  (list header)
 *   headerIdx + 1  → TODAY Creative row  ← fill workorders HERE
 *   headerIdx + 2  → Query row           ← read segment column positions from here
 *   headerIdx + 3+ → metadata / tomorrow rows — preserve untouched
 *
 * Filling rules:
 *   - FPDS_SEND columns     → priority slots, get top of the ranked pool first
 *   - Recent_Active columns → waterfall, filled only after FPDS is satisfied
 *   - Any other label       → treated as priority (defensive default)
 *   - Each workorder appears AT MOST ONCE per list (no repeated creatives on a list)
 *   - Continues down the score ranking (TOP_TIER → SECOND_TIER) until all slots are filled
 *
 * @param {string[]} regularWorkorders  Deployable workorder codes, all tiers, ranked by score
 * @returns {{ csvString: string, rows: string[][], headerIndices: number[] }}
 */
// dayMode: 0 = today only, 1 = tomorrow mode (fills headerIdx+7/+8), 2 = 2-day mode (same rows, double rotation)
// tomorrowPool: if provided, use this ordered workorder list for tomorrow rows instead of regularWorkorders
//
// The legacy `slfWorkorders` parameter has been removed: the 5-28 Acoustic
// template no longer has any "SEND ALL" columns, so SLF workorders have no
// dedicated home and are no longer placed by this filler.
export function fillAcousticTemplate(regularWorkorders, { dayMode = 0, tomorrowPool = null } = {}) {
  const tmrWOs = tomorrowPool || regularWorkorders;
  const tomorrowMode = dayMode >= 1;
  const parsed = Papa.parse(ACOUSTIC_TEMPLATE_CSV, {
    header: false,
    skipEmptyLines: false,
  });

  // Deep-copy to avoid mutating the parsed arrays
  const rows = parsed.data.map(row => [...row]);

  // ── Global 1-hour gap enforcement ────────────────────────────────────────────
  // Tracks every (workorder → Set<col>) placement across ALL lists.
  // Any workorder already placed within ±2 columns (±40 min) of target col is
  // skipped; the slot is left empty rather than violating the ≥60-min rule.
  const MIN_COL_GAP = 3; // 3 × 20-min intervals = 60 minutes
  const todayTracker = new Map(); // Map<wo, Set<col>>
  const tmrTracker   = new Map(); // separate tracker for tomorrow rows

  function acNoConflict(wo, col, tracker) {
    const placed = tracker.get(wo);
    if (!placed) return true;
    for (const c of placed) {
      if (Math.abs(c - col) < MIN_COL_GAP) return false;
    }
    return true;
  }

  function acTrack(wo, col, tracker) {
    if (!tracker.has(wo)) tracker.set(wo, new Set());
    tracker.get(wo).add(col);
  }

  // Gap-aware replacement for findBestWO.
  // Pass 1: highest-ranked WO satisfying segment, maxUses, AND the 1-hour gap — ideal case.
  // Pass 2: if every eligible WO has a time conflict, pick the one whose nearest existing
  //         placement is FURTHEST from this column (minimum violation).  An unplaced WO is
  //         returned immediately since it has no conflict at all.  Slot is never left empty.
  function pickWO(workorders, segName, usedSegPerWO, col, tracker, maxUses = 2) {
    // Pass 1 — gap-respecting
    for (const wo of workorders) {
      const segsUsed = usedSegPerWO.get(wo) || new Set();
      if (!segsUsed.has(segName) && segsUsed.size < maxUses && acNoConflict(wo, col, tracker)) return wo;
    }
    // Pass 2 — all WOs conflict; pick the one placed furthest from this column
    let bestWO = null;
    let bestDist = -1;
    for (const wo of workorders) {
      const segsUsed = usedSegPerWO.get(wo) || new Set();
      if (segsUsed.has(segName) || segsUsed.size >= maxUses) continue;
      const placed = tracker.get(wo);
      if (!placed) return wo; // never placed anywhere → use immediately
      let minDist = Infinity;
      for (const c of placed) minDist = Math.min(minDist, Math.abs(c - col));
      if (minDist > bestDist) { bestDist = minDist; bestWO = wo; }
    }
    return bestWO;
  }

  // Locate all list-header rows (col[8] === "Time (PST)")
  const headerIndices = [];
  rows.forEach((row, idx) => {
    if ((row[8] || '').trim() === 'Time (PST)') headerIndices.push(idx);
  });

  for (let listIdx = 0; listIdx < headerIndices.length; listIdx++) {
    const headerIdx = headerIndices[listIdx];
    const creativeRowIdx = headerIdx + 1;
    const queryRowIdx = headerIdx + 2;
    if (queryRowIdx >= rows.length) continue;

    const queryRow = rows[queryRowIdx] || [];
    const timeRow = rows[headerIdx] || [];
    const creativeRow = [...(rows[creativeRowIdx] || [])];

    // Pad creative row so every query column index is addressable
    while (creativeRow.length < queryRow.length) creativeRow.push('');

    // Identify segment column positions from the Query row (col > 8, non-empty).
    // Only real time-slot columns are eligible — this skips the WARMING blocks
    // (Talamore, Kinloch, …) whose Time row holds dates and whose hardcoded
    // creative must be preserved untouched.
    //
    // Priority tiers (filled in this order so top workorders land in FPDS first):
    //   1. FPDS_SEND      → primary slots, get the ranked regular pool
    //   2. Recent_Active  → waterfall slots, filled after FPDS is satisfied
    //   3. anything else  → treated as priority (defensive default)
    const fpdsCols = [];
    const recentActiveCols = [];
    const otherCols = [];

    for (let col = 9; col < queryRow.length; col++) {
      if (!isIterTimeSlot(timeRow[col])) continue;
      const seg = (queryRow[col] || '').trim();
      if (!seg) continue;
      if (/fpds[_ ]?send/i.test(seg)) fpdsCols.push(col);
      else if (/recent[_ ]?active/i.test(seg)) recentActiveCols.push(col);
      else otherCols.push(col);
    }

    // Priority pool: FPDS_SEND + any unclassified segment. Stagger fill runs
    // on this pool first so top workorders saturate it before waterfall.
    const priorityCols = [...fpdsCols, ...otherCols];
    // Waterfall pool: Recent_Active is filled only AFTER priority is done.
    const waterfallCols = recentActiveCols;
    const regularCols = [...priorityCols, ...waterfallCols];

    // Clear existing workorder values at all segment positions
    regularCols.forEach(col => { creativeRow[col] = ''; });

    // Per-workorder segment tracking for this list (reset each list)
    const usedSegPerWO = new Map();

    // ── Regular slots → staggered fill, one placement per workorder per list ──
    //
    // Goal: fill every list with DISTINCT workorders (no repeated creative on a
    // list) while spreading which workorders land early vs. late across lists so
    // the same winners don't all cluster at one time of day.
    //
    // How it works:
    //   - Split regularCols into earlyHalf and lateHalf by absolute column order.
    //   - Rotate the START of each half by listIdx * step (step = half-length)
    //     so alternate lists begin in a different part of the day.
    //   - All passes run with maxUses=1, so once a workorder is placed on a list
    //     it is never picked again for that list — the fill simply continues
    //     down the score ranking to the next unused workorder.
    //   - Any slots an earlier pass left empty are filled last.
    //
    // Stagger operates on priorityCols only — Recent_Active waterfall is a
    // separate sweep at the end. This guarantees no Recent_Active slot fills
    // while a priority slot is still empty.
    const half = Math.ceil(priorityCols.length / 2);
    const earlyHalf = priorityCols.slice(0, half);
    const lateHalf  = priorityCols.slice(half);

    const step = Math.max(1, Math.floor(half / 2));
    const rotE = earlyHalf.length > 0 ? (listIdx * step) % earlyHalf.length : 0;
    const rotL = lateHalf.length  > 0 ? (listIdx * step) % lateHalf.length  : 0;

    const staggeredEarly = [...earlyHalf.slice(rotE), ...earlyHalf.slice(0, rotE)];
    const staggeredLate  = [...lateHalf.slice(rotL),  ...lateHalf.slice(0, rotL)];

    // Pass 1 — interleave the early and late halves so the top of the ranking
    // is dealt alternately into early and late slots (even quality across the
    // day). maxUses=1: one placement per WO per list.
    for (const col of interleave(staggeredEarly, staggeredLate)) {
      if (creativeRow[col]) continue;
      const seg = (queryRow[col] || '').trim();
      const wo = pickWO(regularWorkorders, seg, usedSegPerWO, col, todayTracker, 1);
      if (wo) { creativeRow[col] = wo; markUsed(usedSegPerWO, wo, seg); acTrack(wo, col, todayTracker); }
    }

    // Pass 3 — fill any remaining empty slots (overflow or odd-length lists)
    for (const col of regularCols) {
      if (creativeRow[col]) continue;
      const seg = (queryRow[col] || '').trim();
      const wo = pickWO(regularWorkorders, seg, usedSegPerWO, col, todayTracker, 1);
      if (wo) { creativeRow[col] = wo; markUsed(usedSegPerWO, wo, seg); acTrack(wo, col, todayTracker); }
    }

    // Pass 4 — guarantee fullness: when the deployable pool is smaller than a
    // list's slot count, the one-per-list rule above leaves slots empty.  Fill
    // every remaining slot with any creative (allowing a workorder to repeat on
    // the list), preferring the cross-list 60-min gap, then unconditional so no
    // send slot is ever left blank.
    for (const col of regularCols) {
      if (creativeRow[col]) continue;
      let pick = regularWorkorders.find(wo => acNoConflict(wo, col, todayTracker));
      if (!pick) pick = regularWorkorders[0];
      if (pick) { creativeRow[col] = pick; acTrack(pick, col, todayTracker); }
    }

    rows[creativeRowIdx] = creativeRow;

    // ── Tomorrow Mode: fill the tomorrow row (headerIdx+7 Creative, headerIdx+8 Query) ──
    // Rule: same top workorders, but shifted so no workorder hits the same list+segment
    // combination it already occupies in TODAY's row.
    if (tomorrowMode) {
      const tmrCreativeRowIdx = headerIdx + 7;
      const tmrQueryRowIdx    = headerIdx + 8;
      if (tmrQueryRowIdx < rows.length) {
        const tmrQueryRow = rows[tmrQueryRowIdx] || [];
        const tmrCreativeRow = [...(rows[tmrCreativeRowIdx] || [])];
        while (tmrCreativeRow.length < tmrQueryRow.length) tmrCreativeRow.push('');

        const tmrFpdsCols = [];
        const tmrRecentActiveCols = [];
        const tmrOtherCols = [];
        for (let col = 9; col < tmrQueryRow.length; col++) {
          if (!isIterTimeSlot(timeRow[col])) continue;
          const seg = (tmrQueryRow[col] || '').trim();
          if (!seg) continue;
          if (/fpds[_ ]?send/i.test(seg)) tmrFpdsCols.push(col);
          else if (/recent[_ ]?active/i.test(seg)) tmrRecentActiveCols.push(col);
          else tmrOtherCols.push(col);
        }
        // Same priority order as today: FPDS → other → Recent_Active waterfall
        const tmrRegularCols = [...tmrFpdsCols, ...tmrOtherCols, ...tmrRecentActiveCols];

        tmrRegularCols.forEach(col => { tmrCreativeRow[col] = ''; });

        // Regular slots: use the same stagger but offset by an additional half-step
        // so tomorrow's start point is in the opposite half of today's.
        const tmrUsedSegPerWO = new Map();

        // Build a set of (col, workorder) pairs used in TODAY's row so we can avoid repeats
        const todaySlots = new Set(); // "col:wo"
        for (const col of regularCols) {
          const wo = (creativeRow[col] || '').trim();
          if (wo) todaySlots.add(col + ':' + wo);
        }

        const tmrHalf = Math.ceil(tmrRegularCols.length / 2);
        const tmrEarlyHalf = tmrRegularCols.slice(0, tmrHalf);
        const tmrLateHalf  = tmrRegularCols.slice(tmrHalf);

        // Stagger rotation across lists: each list steps by tmrStep columns.
        // Tomorrow mode (dayMode=1): no extra base shift (starts at col 0 for list 0).
        // 2-Day mode (dayMode=2): shift the base by one extra tmrStep so list 0
        //   starts where list 1 would on Tomorrow mode — genuinely different ordering.
        //   Since dayMode*tmrHalf % tmrHalf === 0 (multiple of cycle), we instead use
        //   tmrStep as the 2-Day extra offset, which is NOT a multiple of halfLength.
        const tmrStep = Math.max(1, Math.floor(tmrHalf / 2));
        const tmrBaseShift = dayMode === 2 ? tmrStep : 0;
        const tmrRotE = tmrEarlyHalf.length > 0 ? ((listIdx * tmrStep) + tmrBaseShift) % tmrEarlyHalf.length : 0;
        const tmrRotL = tmrLateHalf.length  > 0 ? ((listIdx * tmrStep) + tmrBaseShift) % tmrLateHalf.length  : 0;

        const tmrStaggeredEarly = [...tmrEarlyHalf.slice(tmrRotE), ...tmrEarlyHalf.slice(0, tmrRotE)];
        const tmrStaggeredLate  = [...tmrLateHalf.slice(tmrRotL),  ...tmrLateHalf.slice(0, tmrRotL)];

        // Helper: find best WO for tomorrow.
        // Pass 1: gap-respecting, avoids segment/maxUses/today-slot constraints.
        // Pass 2: all WOs conflict — pick the one placed furthest from this column
        //         to minimise the violation.  Slot is never left empty.
        function findBestWOTmr(wos, seg, col, maxUses) {
          // Pass 1 — gap-respecting
          for (const wo of wos) {
            const segsUsed = tmrUsedSegPerWO.get(wo) || new Set();
            if (segsUsed.has(seg)) continue;
            if (segsUsed.size >= maxUses) continue;
            if (todaySlots.has(col + ':' + wo)) continue;
            if (!acNoConflict(wo, col, tmrTracker)) continue;
            return wo;
          }
          // Pass 2 — all conflict; pick the WO placed furthest from this column
          let bestWO = null;
          let bestDist = -1;
          for (const wo of wos) {
            const segsUsed = tmrUsedSegPerWO.get(wo) || new Set();
            if (segsUsed.has(seg) || segsUsed.size >= maxUses) continue;
            const placed = tmrTracker.get(wo);
            if (!placed) return wo; // never placed anywhere → use immediately
            let minDist = Infinity;
            for (const c of placed) minDist = Math.min(minDist, Math.abs(c - col));
            if (minDist > bestDist) { bestDist = minDist; bestWO = wo; }
          }
          return bestWO;
        }

        for (const col of interleave(tmrStaggeredEarly, tmrStaggeredLate)) {
          if (tmrCreativeRow[col]) continue;
          const seg = (tmrQueryRow[col] || '').trim();
          const wo = findBestWOTmr(tmrWOs, seg, col, 1);
          if (wo) { tmrCreativeRow[col] = wo; markUsed(tmrUsedSegPerWO, wo, seg); acTrack(wo, col, tmrTracker); }
        }
        for (const col of tmrRegularCols) {
          if (tmrCreativeRow[col]) continue;
          const seg = (tmrQueryRow[col] || '').trim();
          const wo = pickWO(tmrWOs, seg, tmrUsedSegPerWO, col, tmrTracker, 1);
          if (wo) { tmrCreativeRow[col] = wo; markUsed(tmrUsedSegPerWO, wo, seg); acTrack(wo, col, tmrTracker); }
        }

        // Fallback — guarantee fullness (mirrors today's Pass 4): fill any
        // remaining slot with any creative, gap-respecting first then unconditional.
        for (const col of tmrRegularCols) {
          if (tmrCreativeRow[col]) continue;
          let pick = tmrWOs.find(wo => acNoConflict(wo, col, tmrTracker));
          if (!pick) pick = tmrWOs[0];
          if (pick) { tmrCreativeRow[col] = pick; acTrack(pick, col, tmrTracker); }
        }

        rows[tmrCreativeRowIdx] = tmrCreativeRow;
      }
    }
  }

  // ── Wipe all initials / signature cells across the entire sheet ──
  // The template marks initials rows with "Initals" (misspelled) at col[8].
  // Clear everything in those rows from col 9 onward.
  rows.forEach(row => {
    const marker = (row[8] || '').trim().toLowerCase();
    if (marker === 'initals' || marker === 'initials') {
      for (let col = 9; col < row.length; col++) {
        row[col] = '';
      }
    }
  });

  return {
    csvString: Papa.unparse(rows),
    rows,
    headerIndices,
  };
}

/**
 * Fills the hardcoded Iterable deployment template with today's top workorders.
 *
 * Structure per list block (16 rows):
 *   headerIdx + 0  → list name row, col[8] === "Time (PST)"  (list header)
 *   headerIdx + 1  → main Creative row, col[8] === "Creative", col[0] empty
 *                    ← fill GANGBUSTERS + RISING slots here (skip NL-prefixed values)
 *   headerIdx + 2  → Temp Segment row
 *   headerIdx + 3  → Segment row, col[8] === "Segment"
 *                    ← read which cols have active segment definitions
 *   headerIdx + 4  → Suppression / Completed row
 *   headerIdx + 5  → Domain / Remaining row
 *   headerIdx + 6  → Initials row ← cleared (signatures removed)
 *   headerIdx + 7  → blank
 *   headerIdx + 8  → SOFT ASK Creative row, col[0] === "SOFT ASK" ← LEAVE UNTOUCHED
 *   headerIdx + 9–12 → RISING / GANGBUSTERS / NEW / NEWSLETTER metadata rows
 *   headerIdx + 13–15 → blank / day-header rows
 *
 * Filling rules:
 *   - Identify active columns from the Segment row (col > 8, non-empty segment text)
 *   - NL-prefixed values in the Creative row are newsletter slots → preserve them
 *   - All other active columns → fill with top-ranked non-SLF workorders
 *   - No duplicate workorder within the same Creative row (same list)
 *   - SOFT ASK Creative row is never touched
 *
 * Strength ordering (GANGBUSTERS → RISING) is approximated by assigning the
 * highest-ranked workorders first as columns are encountered left to right.
 *
 * @param {string[]} regularWorkorders  Non-NL, non-SLF TOP+SECOND tier codes, ranked by score
 * @returns {{ csvString: string, rows: string[][], headerIndices: number[] }}
 */
// ─── Module-level segment classifier (used by fillIterableTemplate + fillNewWOsIntoIterableRows) ──
// Keyword-based fallback used only when a list block carries no column-A legend.
function inferIterableSegmentType(segVal) {
  const v = segVal.toLowerCase();
  // ── GANGBUSTERS ─────────────────────────────────────────────────────────
  if (v.includes('a_listers'))                       return 'GANGBUSTERS';
  if (v.includes('donor_category_all'))              return 'GANGBUSTERS';
  if (/^monetary_\d/.test(v))                        return 'GANGBUSTERS';
  if (v.startsWith('demail_openers') ||
      v.includes('email_openers_120'))               return 'GANGBUSTERS';
  if (v.includes('email_clickers_120'))              return 'GANGBUSTERS';
  if (v.includes('warmup_active'))                   return 'GANGBUSTERS';
  if (v.startsWith('affinity_'))                     return 'GANGBUSTERS';
  if (v.includes('donors_alltime') ||
      v.includes('donors_p2p_alltime'))              return 'GANGBUSTERS';
  if (/\b(lead|iron|lazarus)\b/.test(v))             return 'GANGBUSTERS';
  if (v.includes('recent_active 15'))                return 'GANGBUSTERS';
  if (v.includes('email_nonengager_sample'))         return 'GANGBUSTERS';
  // ── RISING ──────────────────────────────────────────────────────────────
  if (v.startsWith('nondonor_'))                     return 'RISING';
  if (/^recency_\d/i.test(v))                        return 'RISING';
  if (/^frequency_\d/.test(v))                       return 'RISING';
  // Plain recent_active segments (no donor/engagement signals above) are
  // treated as "new creative" slots — filled by user-supplied new workorders
  // first, then SECOND_TIER fallback. They must NOT receive top-tier picks.
  if (v.includes('recent_active'))                   return 'NEW';
  return null; // unrecognised → clearOut
}

// ─── Legend-driven Iterable segment classification ────────────────────────────
// The new Iterable sheet labels each list's tiers in column A (GANGBUSTERS /
// RISING / NEW / NEWSLETTER / SOFT ASK) with the matching audience string in
// column B.  We read that legend per block and classify each slot by the tier
// whose audience overlaps it most, so the sheet itself drives priority.
const ITER_TIER_LABELS = new Map([
  ['gangbusters', 'GANGBUSTERS'],
  ['rising / top preformer', 'RISING'],
  ['rising / top performer', 'RISING'],
  ['new', 'NEW'],
  ['newsletter', 'NEWSLETTER'],
  ['soft ask', 'SOFT_ASK'],
]);

function isIterTimeSlot(v) {
  return /^\d{1,2}:\d{2}$/.test(String(v || '').trim());
}

function iterTokenSet(s) {
  return new Set(
    String(s || '').toLowerCase().split(',').map(t => t.trim().replace(/\s+/g, ' ')).filter(Boolean)
  );
}

// Build [{ type, toks }] from a block's column-A legend rows (scan the 16-row block).
function buildIterableLegend(rows, headerIdx) {
  const legend = [];
  for (let r = headerIdx; r < Math.min(headerIdx + 16, rows.length); r++) {
    const label = (rows[r]?.[0] || '').trim().toLowerCase();
    const type = ITER_TIER_LABELS.get(label);
    if (!type) continue;
    const toks = iterTokenSet(rows[r]?.[1]);
    if (toks.size) legend.push({ type, toks });
  }
  return legend;
}

// Classify a slot's segment string against the block legend by best token overlap
// (Jaccard).  Falls back to keyword inference when the block carries no legend.
function classifyIterableSegment(segVal, legend) {
  if (!legend || legend.length === 0) return inferIterableSegmentType(segVal);
  const ts = iterTokenSet(segVal);
  if (ts.size === 0) return null;
  let best = null, bestScore = -1;
  for (const L of legend) {
    let inter = 0;
    for (const t of ts) if (L.toks.has(t)) inter++;
    const score = inter / (ts.size + L.toks.size - inter || 1);
    if (score > bestScore) { bestScore = score; best = L.type; }
  }
  // No overlap at all → treat as new-creative slot rather than a top tier.
  return bestScore > 0 ? best : 'NEW';
}

/**
 * Parse a previously-generated filled Iterable CSV to extract which workorder
 * occupied each column in each creative row. Used to avoid repeating the same
 * workorder in the same time-slot column on consecutive deployment days.
 *
 * @param {string} csvString  Raw CSV text of yesterday's Iterable sheet
 * @returns {Map<string, Set<number>>}  workorder → set of column indices it occupied
 */
export function parsePriorIterableSheet(csvString) {
  if (!csvString) return new Map();
  const parsed = Papa.parse(csvString, { header: false, skipEmptyLines: false });
  const rows = parsed.data;
  const priorCols = new Map(); // wo → Set<col>

  rows.forEach((row, idx) => {
    if ((row[8] || '').trim() !== 'Time (PST)') return;
    // hi+1 = today creative row, hi+8 = tomorrow creative row
    for (const crOff of [1, 8]) {
      const cr = rows[idx + crOff] || [];
      for (let col = 9; col < cr.length; col++) {
        const wo = (cr[col] || '').trim().toUpperCase();
        if (!wo || /^NL/i.test(wo) || wo === 'CREATIVE') continue;
        if (!priorCols.has(wo)) priorCols.set(wo, new Set());
        priorCols.get(wo).add(col);
      }
    }
  });

  return priorCols;
}

// tomorrowPool: if provided, use this ordered workorder list for tomorrow rows instead of regularWorkorders
export function fillIterableTemplate(regularWorkorders, { dayMode = 0, tomorrowPool = null, priorSheet = null } = {}) {
  const tmrWOs = tomorrowPool || regularWorkorders;
  const parsed = Papa.parse(ITERABLE_TEMPLATE_CSV, {
    header: false,
    skipEmptyLines: false,
  });

  const rows = parsed.data.map(row => [...row]);

  // Locate all list-header rows (col[8] === "Time (PST)")
  const headerIndices = [];
  rows.forEach((row, idx) => {
    if ((row[8] || '').trim() === 'Time (PST)') headerIndices.push(idx);
  });

  // ---------------------------------------------------------------------------
  // Each list block is 16 rows:
  //   headerIdx + 0  → Time (PST) header
  //   headerIdx + 1  → TODAY Creative   ← fill workorders here
  //   headerIdx + 2  → Today Temp Segment
  //   headerIdx + 3  → Today Segment    ← read column types from here
  //   headerIdx + 4  → Today Suppression
  //   headerIdx + 5  → Today Domain/Remaining
  //   headerIdx + 6  → Today Initials
  //   headerIdx + 7  → blank
  //   headerIdx + 8  → TOMORROW Creative ← fill when dayMode >= 1
  //   headerIdx + 9  → Tomorrow Temp Segment
  //   headerIdx + 10 → Tomorrow Segment  ← read column types for tomorrow
  //   headerIdx + 11 → Tomorrow Suppression
  //   headerIdx + 12 → Tomorrow Domain/Remaining
  //   headerIdx + 13 → Tomorrow Initials
  //   headerIdx + 14 → blank
  //   headerIdx + 15 → day-of-week labels row
  //
  // TODAY Creative = headerIdx+1, TODAY Segment = headerIdx+3
  // TOMORROW Creative = headerIdx+8, TOMORROW Segment = headerIdx+10
  // ---------------------------------------------------------------------------

  // No protected/hardcoded blocks in the current sheet — every list receives
  // dynamically assigned workorders.  (Kept as an extension point in case a
  // future ListWise block with hardcoded creative needs to be excluded.)
  const LISTWISE_HEADER_INDICES = new Set();

  // Classify columns for a given section (today or tomorrow).
  // segRowOff = offset from headerIdx to segment row (3 for today, 10 for tomorrow)
  // crOff     = offset from headerIdx to creative row (1 for today, 8 for tomorrow)
  //
  // The sheet is self-describing: each list block carries a legend in column A
  // (GANGBUSTERS / RISING / NEW / NEWSLETTER / SOFT ASK) paired with the exact
  // audience-segment string for that tier.  We classify each time-slot by the
  // legend entry its segment string overlaps most (token-set similarity), which
  // tolerates the per-column A/B/C audience splits that don't match the base
  // legend string verbatim.  GANGBUSTERS → top creative, RISING → second;
  // NEW / NEWSLETTER / SOFT ASK are not filled from the ranked pool.
  function classifyCols(headerIdx, segRowOff, crOff, gangOut, riseOut, clearOut) {
    if (LISTWISE_HEADER_INDICES.has(headerIdx)) return;

    const segRowIdx = headerIdx + segRowOff;
    if (segRowIdx >= rows.length) return;
    const segmentRow = rows[segRowIdx] || [];
    const creativeRow = rows[headerIdx + crOff] || [];
    const timeRow = rows[headerIdx] || [];
    const legend = buildIterableLegend(rows, headerIdx);

    for (let col = 9; col < segmentRow.length; col++) {
      // Only real time-slot columns are fillable — bounds out right-edge
      // artifacts (TEMP / SEGMENT labels, the weekday grid) that also carry text.
      if (!isIterTimeSlot(timeRow[col])) continue;

      const segVal = (segmentRow[col] || '').trim();
      if (!segVal) continue;                                  // empty slot → no send
      if (segVal.toLowerCase() === 'segment') continue;       // placeholder label
      if (/^NL/i.test((creativeRow[col] || '').trim())) continue; // newsletter → preserve

      const type = classifyIterableSegment(segVal, legend);
      const entry = { headerIdx, col, crOff };
      if (type === 'GANGBUSTERS') gangOut.push(entry);
      else if (type === 'RISING') riseOut.push(entry);
      else clearOut.push(entry); // NEW / NEWSLETTER / SOFT ASK / unknown
    }
  }

  const todayGang = [], todayRise = [], todayClear = [];
  const tmrGang   = [], tmrRise   = [], tmrClear   = [];

  for (const headerIdx of headerIndices) {
    classifyCols(headerIdx, 3,  1, todayGang, todayRise, todayClear);
    if (dayMode >= 1) classifyCols(headerIdx, 10, 8, tmrGang, tmrRise, tmrClear);
  }

  // Clear NEW / unrecognised columns (both sections)
  for (const { headerIdx, col, crOff } of [...todayClear, ...tmrClear]) {
    const creativeRow = rows[headerIdx + crOff];
    if (creativeRow) creativeRow[col] = '';
  }

  // Group entries by (headerIdx, crOff) pair → list of cols for that list+section
  function groupByList(items) {
    const map = new Map();
    for (const { headerIdx, col, crOff } of items) {
      const key = `${headerIdx}:${crOff}`;
      if (!map.has(key)) map.set(key, { headerIdx, crOff, cols: [] });
      map.get(key).cols.push(col);
    }
    return [...map.values()];
  }

  // usedPerList keyed by "headerIdx:crOff" — seeded with preserved NL values
  const usedPerList = new Map();
  function initUsed(headerIdx, crOff) {
    const key = `${headerIdx}:${crOff}`;
    if (usedPerList.has(key)) return usedPerList.get(key);
    const used = new Set();
    const creativeRow = rows[headerIdx + crOff] || [];
    for (let col = 9; col < creativeRow.length; col++) {
      const v = (creativeRow[col] || '').trim();
      if (/^NL/i.test(v)) used.add(v);
    }
    usedPerList.set(key, used);
    return used;
  }

  // Global 1-hour gap tracker for Iterable today rows.
  // Same workorder must be ≥3 columns apart across ALL lists on this sheet.
  const iterTodayTracker = new Map(); // Map<wo, Set<col>>
  const ITER_MIN_COL_GAP = 3;

  function iterNoConflict(wo, col) {
    const placed = iterTodayTracker.get(wo);
    if (!placed) return true;
    for (const c of placed) {
      if (Math.abs(c - col) < ITER_MIN_COL_GAP) return false;
    }
    return true;
  }

  function iterTrack(wo, col) {
    if (!iterTodayTracker.has(wo)) iterTodayTracker.set(wo, new Set());
    iterTodayTracker.get(wo).add(col);
  }

  // Fill a grouped list set with staggered rotation and strict 1-hour gap enforcement.
  //
  // For each slot on each list, scan the full ranked pool from rank 0 and pick
  // the highest-ranked workorder that:
  //   (a) has not already been placed on this list (per-list dedup), AND
  //   (b) has no existing placement within ±2 columns across ANY list (1-hour gap).
  // When the deployable pool is too small to satisfy both, the gap is relaxed by
  // the smallest amount possible (the WO placed furthest from this column) rather
  // than shipping a blank send slot — mirrors Acoustic's guaranteed-fill pass.
  //
  // Per-list scanning (vs. a shared advancing ptr) is essential: a shared ptr
  // caused different workorders to pile up at the same column across lists,
  // producing gap=0 violations between the same workorder on different lists
  // when the gapWO fallback re-introduced already-tracked workorders.
  function fillGroups(byList, dayOffset) {
    byList.forEach(({ headerIdx, crOff, cols }, listIdx) => {
      const creativeRow = rows[headerIdx + crOff];
      if (!creativeRow || cols.length === 0) return;
      while (creativeRow.length <= Math.max(...cols)) creativeRow.push('');
      const used = initUsed(headerIdx, crOff);

      // Pre-clear every classified column so template artifacts (pre-filled
      // workorders in the CSV) don't survive in slots our algorithm skips.
      // Skipped slots must be blank, not untracked template values.
      for (const col of cols) creativeRow[col] = '';

      const step     = Math.max(1, Math.floor(cols.length / 2));
      const dayShift = dayOffset * Math.ceil(cols.length / 2);
      const rot      = ((listIdx * step) + dayShift) % cols.length;
      const staggeredCols = [...cols.slice(rot), ...cols.slice(0, rot)];

      // Interleave early/late so the top ranks spread evenly across the day
      // instead of front-loading the earliest slots in this group.
      for (const col of interleaveHalves(staggeredCols)) {
        // Two-pass scan from rank 0:
        // Pass 1 — prefer a WO that wasn't in this exact column yesterday
        // Pass 2 — fall back to yesterday's occupant if no fresh alternative exists
        // The time-gap rule (iterNoConflict) is enforced in both passes.
        let placed = false;

        if (priorSheet) {
          for (const wo of regularWorkorders) {
            if (!used.has(wo) && iterNoConflict(wo, col) && !priorSheet.get(wo)?.has(col)) {
              creativeRow[col] = wo;
              used.add(wo);
              iterTrack(wo, col);
              placed = true;
              break;
            }
          }
        }

        if (!placed) {
          // Fallback: pick highest-ranked gap-respecting WO regardless of prior position
          for (const wo of regularWorkorders) {
            if (!used.has(wo) && iterNoConflict(wo, col)) {
              creativeRow[col] = wo;
              used.add(wo);
              iterTrack(wo, col);
              placed = true;
              break;
            }
          }
        }

        if (!placed) {
          // Guaranteed fill: no gap-respecting candidate exists (pool smaller than
          // the list's slot count).  Relax by the smallest amount — the WO whose
          // nearest placement is furthest from this column — dropping the per-list
          // dedup only once every unused candidate has been considered.
          const furthest = allowRepeat => {
            let bestWO = null, bestDist = -1;
            for (const wo of regularWorkorders) {
              if (!allowRepeat && used.has(wo)) continue;
              const prev = iterTodayTracker.get(wo);
              if (!prev) return wo; // never placed anywhere → no conflict at all
              let minDist = Infinity;
              for (const c of prev) minDist = Math.min(minDist, Math.abs(c - col));
              if (minDist > bestDist) { bestDist = minDist; bestWO = wo; }
            }
            return bestWO;
          };
          const pick = furthest(false) || furthest(true);
          if (pick) {
            creativeRow[col] = pick;
            used.add(pick);
            iterTrack(pick, col);
          }
        }
      }
    });
  }

  // TODAY: GANGBUSTERS first (top workorders), RISING fills remaining slots.
  // Both share the same per-list `used` set (same headerIdx:crOff key), so
  // WOs placed in GANG slots are automatically excluded from RISE slots.
  const todayGangByList = groupByList(todayGang);
  const todayRiseByList = groupByList(todayRise);
  fillGroups(todayGangByList, 0);
  fillGroups(todayRiseByList, 0);

  // TOMORROW (dayMode >= 1): mirror Acoustic's per-list approach.
  // Each list resets ptr=0 so it always gets the same top workorders as today,
  // just placed in different time-slot columns (dayMode * half-width rotation).
  // GANGBUSTERS fills first within each list, RISING continues from same ptr.
  if (dayMode >= 1) {
    // Build lookup: headerIdx → { gangCols, riseCols }
    const tmrByHi = new Map();
    for (const { headerIdx, col } of tmrGang) {
      if (!tmrByHi.has(headerIdx)) tmrByHi.set(headerIdx, { gangCols: [], riseCols: [] });
      tmrByHi.get(headerIdx).gangCols.push(col);
    }
    for (const { headerIdx, col } of tmrRise) {
      if (!tmrByHi.has(headerIdx)) tmrByHi.set(headerIdx, { gangCols: [], riseCols: [] });
      tmrByHi.get(headerIdx).riseCols.push(col);
    }

    // ── Global 1-hour time-gap enforcement ───────────────────────────────────
    // Each list resets ptr to 0 (all lists get the same top workorders), so the
    // same workorder would land on the same column across every list if we only
    // use rotation.  The tracker below records every (workorder, column) pair
    // placed across ALL lists and rejects placements within ±2 columns of an
    // existing one (±2 columns = ±40 min → enforces ≥60-min gap).
    const tmrTimeTracker = new Map(); // Map<wo, Set<col>>
    const TMR_MIN_COL_GAP = 3;        // 60 minutes at 20-min intervals

    function tmrNoConflict(wo, col) {
      const placed = tmrTimeTracker.get(wo);
      if (!placed) return true;
      for (const c of placed) {
        if (Math.abs(c - col) < TMR_MIN_COL_GAP) return false;
      }
      return true;
    }

    function tmrTrack(wo, col) {
      if (!tmrTimeTracker.has(wo)) tmrTimeTracker.set(wo, new Set());
      tmrTimeTracker.get(wo).add(col);
    }

    headerIndices.forEach((headerIdx, listIdx) => {
      const entry = tmrByHi.get(headerIdx);
      if (!entry) return;
      const { gangCols, riseCols } = entry;
      const tmrCrRow = rows[headerIdx + 8];
      if (!tmrCrRow) return;

      const allCols = [...gangCols, ...riseCols];
      if (allCols.length === 0) return;
      while (tmrCrRow.length <= Math.max(...allCols)) tmrCrRow.push('');

      const used = initUsed(headerIdx, 8); // seeded with NL values only

      function stagger(cols) {
        if (cols.length === 0) return [];
        const step      = Math.max(1, Math.floor(cols.length / 2));
        const baseShift = dayMode === 2 ? step : 0;
        const rot       = ((listIdx * step) + baseShift) % cols.length;
        return [...cols.slice(rot), ...cols.slice(0, rot)];
      }

      // For each slot, find the highest-ranked workorder that:
      //   (a) has not been placed on THIS list (no per-list duplicate), AND
      //   (b) has no existing placement within ±2 cols on ANY list (1-hour gap).
      // If no gap-respecting WO exists, pick the one placed furthest from this
      // column to minimise the violation.  When the pool is smaller than the
      // list's slot count the per-list dedup is dropped last — a slot is never
      // left empty.
      function fillTmrSlot(col, wos) {
        // Pass 1: gap-respecting
        for (const wo of wos) {
          if (!used.has(wo) && tmrNoConflict(wo, col)) {
            tmrCrRow[col] = wo;
            used.add(wo);
            tmrTrack(wo, col);
            return;
          }
        }
        // Passes 2 & 3: all conflict — pick the WO placed furthest from this
        // column, allowing a per-list repeat only once every unused candidate
        // has been considered.
        const furthest = allowRepeat => {
          let bestWO = null, bestDist = -1;
          for (const wo of wos) {
            if (!allowRepeat && used.has(wo)) continue;
            const placed = tmrTimeTracker.get(wo);
            if (!placed) return wo; // unplaced anywhere → use immediately
            let minDist = Infinity;
            for (const c of placed) minDist = Math.min(minDist, Math.abs(c - col));
            if (minDist > bestDist) { bestDist = minDist; bestWO = wo; }
          }
          return bestWO;
        };
        const pick = furthest(false) || furthest(true);
        if (pick) {
          tmrCrRow[col] = pick;
          used.add(pick);
          tmrTrack(pick, col);
        }
      }

      // Fill GANGBUSTERS first (highest priority), then RISING — each group
      // interleaved so its top ranks spread across the day, not front-loaded.
      for (const col of interleaveHalves(stagger(gangCols))) fillTmrSlot(col, tmrWOs);
      for (const col of interleaveHalves(stagger(riseCols)))  fillTmrSlot(col, tmrWOs);
    });
  }

  // Wipe initials / signature rows (col[8] === "Initals" or "Initials")
  rows.forEach(row => {
    const marker = (row[8] || '').trim().toLowerCase();
    if (marker === 'initals' || marker === 'initials') {
      for (let col = 9; col < row.length; col++) row[col] = '';
    }
  });

  // ── Post-fill gap validation ──────────────────────────────────────────────
  // Scan ALL today creative rows; log any workorder that appears within
  // 2 columns of itself across any two lists (≥3 columns = 60 min required).
  {
    const allPlacements = new Map(); // wo → [{listIdx, headerIdx, col}]
    headerIndices.forEach((headerIdx, listIdx) => {
      if (LISTWISE_HEADER_INDICES.has(headerIdx)) return;
      const crRow = rows[headerIdx + 1] || [];
      for (let col = 9; col < crRow.length; col++) {
        // Only clock-time slots take part in the 60-min rule; date-indexed
        // warming-ramp columns legitimately reuse creative across days/accounts.
        if (!isIterTimeSlot(rows[headerIdx]?.[col])) continue;
        const v = (crRow[col] || '').trim();
        if (!v || /^NL/i.test(v)) continue;
        if (!allPlacements.has(v)) allPlacements.set(v, []);
        allPlacements.get(v).push({ listIdx, headerIdx, col });
      }
    });
    let violations = 0;
    for (const [wo, placements] of allPlacements) {
      for (let i = 0; i < placements.length; i++) {
        for (let j = i + 1; j < placements.length; j++) {
          const gap = Math.abs(placements[i].col - placements[j].col);
          if (gap < 3) {
            console.warn(`[GAP VIOLATION] ${wo}: list${placements[i].listIdx}(hi=${placements[i].headerIdx}) col${placements[i].col} ↔ list${placements[j].listIdx}(hi=${placements[j].headerIdx}) col${placements[j].col}  gap=${gap}`);
            violations++;
          }
        }
      }
    }
    if (violations === 0) console.log('[GAP VALIDATION] ✓ No violations found in Iterable today rows.');
    else console.error(`[GAP VALIDATION] ✗ ${violations} violation(s) found!`);
  }

  return {
    csvString: Papa.unparse(rows),
    rows,
    headerIndices,
  };
}

/**
 * Fills the hardcoded Verve deployment template.
 *
 * Block structure (14 rows per block, col[8] labels each row):
 *   hi + 0  → Time (PST) header
 *   hi + 1  → TODAY Creative     ← fill TOP PREFORMERS + GANGBUSTERS cols
 *   hi + 2  → TODAY Selection/Segment  ← read segment types here
 *   hi + 3  → Sending Domain
 *   hi + 4  → IP Pool
 *   hi + 5  → Initials           ← clear
 *   hi + 6  → blank
 *   hi + 7  → TOMORROW Creative  ← fill when dayMode >= 1
 *   hi + 8  → TOMORROW Selection/Segment
 *   hi + 9  → Sending Domain
 *   hi + 10 → IP Pool
 *   hi + 11 → Initials           ← clear
 *   hi + 12-13 → blank
 *
 * Segment classification:
 *   segment contains "TOP PRE"     → fill first (highest-ranked workorders)
 *   segment contains "GANGBUSTERS" → fill second
 *   anything else (NEW, RECENT ACTIVE, etc.) → leave completely untouched
 *
 * Cross-list 1-hour time gap enforced via global time tracker.
 *
 * @param {string[]} regularWorkorders  Ranked workorder codes for Verve
 * @param {{ dayMode?: number, tomorrowPool?: string[]|null }} options
 */
/**
 * Parse a previously-generated filled Verve CSV to extract which workorder
 * occupied each column. Used to avoid repeating the same WO in the same
 * time-slot column on consecutive deployment days.
 */
export function parsePriorVerveSheet(csvString) {
  if (!csvString) return new Map();
  const parsed = Papa.parse(csvString, { header: false, skipEmptyLines: false });
  const rows = parsed.data;
  const priorCols = new Map();

  rows.forEach((row, idx) => {
    if ((row[8] || '').trim() !== 'Time (PST)') return;
    for (const crOff of [1, 7]) { // today creative = hi+1, tomorrow = hi+7
      const cr = rows[idx + crOff] || [];
      for (let col = 9; col < cr.length; col++) {
        const wo = (cr[col] || '').trim().toUpperCase();
        if (!wo || /^NL/i.test(wo)) continue;
        if (!priorCols.has(wo)) priorCols.set(wo, new Set());
        priorCols.get(wo).add(col);
      }
    }
  });

  return priorCols;
}

export function fillVerveTemplate(regularWorkorders, { dayMode = 0, tomorrowPool = null, priorSheet = null } = {}) {
  const tmrWOs = tomorrowPool || regularWorkorders;
  const parsed = Papa.parse(VERVE_TEMPLATE_CSV, { header: false, skipEmptyLines: false });
  const rows = parsed.data.map(row => [...row]);

  // Locate all list-header rows
  const headerIndices = [];
  rows.forEach((row, idx) => {
    if ((row[8] || '').trim() === 'Time (PST)') headerIndices.push(idx);
  });

  const MIN_COL_GAP = 3; // 3 × 20-min slots = 60 minutes

  // Global time trackers (separate for today and tomorrow)
  const todayTracker = new Map(); // Map<wo, Set<col>>
  const tmrTracker   = new Map();

  function noConflict(wo, col, tracker) {
    const placed = tracker.get(wo);
    if (!placed) return true;
    for (const c of placed) {
      if (Math.abs(c - col) < MIN_COL_GAP) return false;
    }
    return true;
  }

  function trackPlacement(wo, col, tracker) {
    if (!tracker.has(wo)) tracker.set(wo, new Set());
    tracker.get(wo).add(col);
  }

  // Identify TOP_PRE and GANGBUSTERS cols from a segment row.
  // Returns { topCols, gangCols, clearCols }
  //   topCols   → fill with ranked workorders (highest priority)
  //   gangCols  → fill with ranked workorders (second priority)
  //   clearCols → NEW, RECENT ACTIVE, SEND 1/2, etc. — wipe old template
  //               values but do NOT fill with new workorders
  function classifyCols(headerIdx, segRowOff) {
    const segRowIdx = headerIdx + segRowOff;
    if (segRowIdx >= rows.length) return { topCols: [], gangCols: [], clearCols: [] };
    const segRow = rows[segRowIdx] || [];
    const topCols   = [];
    const gangCols  = [];
    const clearCols = [];
    for (let col = 9; col < segRow.length; col++) {
      const seg = (segRow[col] || '').trim().toUpperCase();
      if (!seg) continue;
      if (seg.includes('TOP PRE'))         topCols.push(col);
      else if (seg.includes('GANGBUSTER')) gangCols.push(col);
      else                                 clearCols.push(col); // NEW, RECENT ACTIVE, etc.
    }
    return { topCols, gangCols, clearCols };
  }

  // Fill a single slot: scan workorder pool for first WO that (a) is not already
  // on this block and (b) has no time conflict (≥60-min gap across all blocks).
  //   Pass 1 — avoids the same column as yesterday (priorSheet)
  //   Pass 2 — any gap-respecting WO regardless of prior position
  //   Pass 3 — pool exhausted for this block: relax the gap, picking the WO whose
  //            nearest existing placement is furthest from this column so the
  //            violation is as small as possible
  //   Pass 4 — every WO already sits on this block: allow a repeat rather than
  //            ship a blank send slot, again choosing the furthest-placed WO
  // A send slot is never left empty.
  function fillSlot(col, wos, used, tracker, crRow) {
    const place = wo => { crRow[col] = wo; used.add(wo); trackPlacement(wo, col, tracker); };

    // Pass 1: prefer a WO that wasn't in this column yesterday
    if (priorSheet) {
      for (const wo of wos) {
        if (!used.has(wo) && noConflict(wo, col, tracker) && !priorSheet.get(wo)?.has(col)) {
          return place(wo);
        }
      }
    }
    // Pass 2: fallback — any gap-respecting WO regardless of prior position
    for (const wo of wos) {
      if (!used.has(wo) && noConflict(wo, col, tracker)) return place(wo);
    }
    // Passes 3 & 4: guarantee fullness. `allowRepeat` drops the per-block dedup
    // only after every unused candidate has been considered.
    const furthest = allowRepeat => {
      let bestWO = null, bestDist = -1;
      for (const wo of wos) {
        if (!allowRepeat && used.has(wo)) continue;
        const placed = tracker.get(wo);
        if (!placed) return wo; // never placed anywhere → no conflict at all
        let minDist = Infinity;
        for (const c of placed) minDist = Math.min(minDist, Math.abs(c - col));
        if (minDist > bestDist) { bestDist = minDist; bestWO = wo; }
      }
      return bestWO;
    };
    const pick = furthest(false) || furthest(true);
    if (pick) place(pick);
  }

  // ── TODAY ──────────────────────────────────────────────────────────────────
  for (const headerIdx of headerIndices) {
    const { topCols, gangCols, clearCols } = classifyCols(headerIdx, 2);
    const allFill = [...topCols, ...gangCols];
    const allClear = [...allFill, ...clearCols];
    if (allClear.length === 0) continue;

    const crRow = rows[headerIdx + 1];
    if (!crRow) continue;
    while (crRow.length <= Math.max(...allClear)) crRow.push('');

    // Clear ALL classified columns (fill targets + NEW/RECENT ACTIVE) so no
    // old template values bleed through into the output
    allClear.forEach(col => { crRow[col] = ''; });

    const used = new Set();
    // Interleave each group so its top ranks spread evenly across the day.
    for (const col of interleaveHalves(topCols))  fillSlot(col, regularWorkorders, used, todayTracker, crRow);
    for (const col of interleaveHalves(gangCols)) fillSlot(col, regularWorkorders, used, todayTracker, crRow);
    // clearCols are wiped above and intentionally left empty
  }

  // ── TOMORROW ───────────────────────────────────────────────────────────────
  if (dayMode >= 1) {
    for (const headerIdx of headerIndices) {
      const tmrCrRowIdx = headerIdx + 7;
      if (tmrCrRowIdx >= rows.length) continue;

      const { topCols, gangCols, clearCols } = classifyCols(headerIdx, 8);
      const allFill = [...topCols, ...gangCols];
      const allClear = [...allFill, ...clearCols];
      if (allClear.length === 0) continue;

      const tmrCrRow = rows[tmrCrRowIdx];
      if (!tmrCrRow) continue;
      while (tmrCrRow.length <= Math.max(...allClear)) tmrCrRow.push('');

      allClear.forEach(col => { tmrCrRow[col] = ''; });

      const used = new Set();
      for (const col of interleaveHalves(topCols))  fillSlot(col, tmrWOs, used, tmrTracker, tmrCrRow);
      for (const col of interleaveHalves(gangCols)) fillSlot(col, tmrWOs, used, tmrTracker, tmrCrRow);
      // clearCols are wiped above and intentionally left empty
    }
  }

  // ── Clear initials rows across the entire sheet ────────────────────────────
  rows.forEach(row => {
    const marker = (row[8] || '').trim().toLowerCase();
    if (marker === 'initals' || marker === 'initials') {
      for (let col = 9; col < row.length; col++) row[col] = '';
    }
  });

  return { csvString: Papa.unparse(rows), rows, headerIndices };
}

/**
 * Coverage + repeat rebalance for a sheet.
 *
 * Gives every deployable piece a TARGET number of placements:
 *   • 1 each (coverage) for the top min(N, slots) pieces, then
 *   • the leftover slots go to the strongest pieces, each capped at `maxRepeat`
 *     total — so the top pieces repeat a few times (up to maxRepeat×) and the
 *     cap naturally widens down the ranking, while everything else appears once.
 *
 * It then reaches those targets by moving only the EXCESS: over-served pieces
 * (e.g. a top-5 piece the base fill placed 12×) give up their extra slots, which
 * are handed to under-served pieces (uncovered pieces first, then the top pieces
 * that haven't hit their repeat target).  Pieces already at target are untouched,
 * so the base fill's time-of-day spread is preserved.  Placements honour the
 * per-list "no duplicate creative on a list" rule and the 60-min same-WO gap.
 *
 * `reclaim` lists non-pool codes (e.g. eligible-CUT gap-fillers) whose slots may
 * be repurposed to cover/repeat real deployable pieces.  Mutates rows in place.
 *
 * @param {string[][]} rows
 * @param {number[]}   headerIndices
 * @param {string[]}   pool     deployable codes, best→worst
 * @param {{ crOffs:number[], maxRepeat?:number, weightOf?:Map<string,number>,
 *           blockbusterSet?:Set<string>, blockbusterCap?:number, reclaim?:string[] }} opts
 */
export function rebalanceSheet(rows, headerIndices, pool, { crOffs, maxRepeat = 5, weightOf = null, blockbusterSet = null, blockbusterCap = 20, reclaim = [] }) {
  const rankOf = new Map(pool.map((w, i) => [w, i]));
  const reassignable = new Set([...pool, ...reclaim]);

  // Gather every reassignable slot (cell holding a pool or reclaim piece).
  // Only real time-slot columns qualify: warming-ramp lists index their columns
  // by DATE and hold hand-placed creative for future days, which must not be
  // reassigned even when that creative also appears in today's pool.
  const slotsAll = []; // { row, col, hi, wo }
  for (const hi of headerIndices) {
    for (const crOff of crOffs) {
      const rowIdx = hi + crOff;
      const cr = rows[rowIdx];
      if (!cr) continue;
      for (let c = 9; c < cr.length; c++) {
        if (!isIterTimeSlot(rows[hi]?.[c])) continue;
        const v = (cr[c] || '').trim();
        if (reassignable.has(v)) slotsAll.push({ row: rowIdx, col: c, hi, wo: v });
      }
    }
  }
  const S = slotsAll.length;
  const N = pool.length;
  if (S === 0) return;

  // Targets (sum === S): 1 each for coverage (the discovery floor), then the
  // leftover slots are handed out in proportion to expected DOLLARS — so the
  // home-run tail runs big and ordinary pieces stay at 1×.  Blockbusters get a
  // much higher per-piece cap than everything else, so a $9k piece can rack up
  // many sends instead of being flattened to the same 5× as a $500 piece.
  const coverCount = Math.min(N, S);
  const target = new Array(N).fill(0);
  for (let i = 0; i < coverCount; i++) target[i] = 1;
  let extras = S - coverCount;

  const weight = pool.map((w, i) => {
    const x = weightOf ? (weightOf.get(w) ?? 0) : (N - i); // $ weight, or rank fallback
    return x > 0 ? x : 0;
  });
  const capOf = i => (blockbusterSet && blockbusterSet.has(pool[i]) ? blockbusterCap : maxRepeat);

  // Greedy weighted allocation: each extra slot goes to the piece whose current
  // share is furthest below its dollar weight (weight / current placements),
  // respecting its cap.  This concentrates volume on the biggest raisers.
  while (extras > 0) {
    let best = -1, bestRatio = -Infinity;
    for (let i = 0; i < coverCount; i++) {
      if (weight[i] <= 0 || target[i] >= capOf(i)) continue;
      const ratio = weight[i] / target[i];
      if (ratio > bestRatio) { bestRatio = ratio; best = i; }
    }
    if (best < 0) break; // everything eligible is capped or zero-weight
    target[best]++; extras--;
  }
  // Any slots still left (all weighted pieces capped) spread evenly across the
  // top so the sheet still fills.
  for (let r = 0; extras > 0; r++, extras--) target[r % coverCount]++;

  // Current placements per pool piece.
  const cur = new Map(); // wo -> { slots:[], lists:Set, cols:[] }
  const getCur = wo => { if (!cur.has(wo)) cur.set(wo, { slots: [], lists: new Set(), cols: [] }); return cur.get(wo); };
  for (const s of slotsAll) {
    if (rankOf.has(s.wo)) { const g = getCur(s.wo); g.slots.push(s); g.lists.add(s.hi); g.cols.push(s.col); }
  }

  // Free slots = reclaim (non-pool) slots + every over-target piece's excess.
  const freeSlots = [];
  for (const s of slotsAll) if (!rankOf.has(s.wo)) freeSlots.push(s);
  for (let i = 0; i < N; i++) {
    const g = cur.get(pool[i]); if (!g) continue;
    if (g.slots.length > target[i]) {
      for (let k = target[i]; k < g.slots.length; k++) freeSlots.push(g.slots[k]);
      g.slots.length = target[i];
      g.lists = new Set(g.slots.map(s => s.hi));
      g.cols = g.slots.map(s => s.col);
    }
  }
  for (const s of freeSlots) rows[s.row][s.col] = '';

  // Deficits (below target), strongest first.
  const deficits = [];
  for (let i = 0; i < N; i++) {
    const have = cur.get(pool[i])?.slots.length ?? 0;
    if (have < target[i]) deficits.push({ wo: pool[i], need: target[i] - have });
  }

  const gapOK = (g, col) => { for (const c of g.cols) if (Math.abs(c - col) < 3) return false; return true; };
  const used = new Array(freeSlots.length).fill(false);
  const placeInto = (wo, j) => {
    const s = freeSlots[j]; used[j] = true; rows[s.row][s.col] = wo;
    const g = getCur(wo); g.slots.push(s); g.lists.add(s.hi); g.cols.push(s.col);
  };

  // Fill deficits: prefer a free slot on a new list + gap-ok, then relax gap.
  for (const d of deficits) {
    const g = getCur(d.wo);
    for (let n = 0; n < d.need; n++) {
      let j = freeSlots.findIndex((s, k) => !used[k] && !g.lists.has(s.hi) && gapOK(g, s.col));
      if (j < 0) j = freeSlots.findIndex((s, k) => !used[k] && !g.lists.has(s.hi));
      if (j < 0) break;
      placeInto(d.wo, j);
    }
  }

  // Any still-empty freed slot → give to the strongest eligible piece so the
  // sheet stays full.
  for (let j = 0; j < freeSlots.length; j++) {
    if (used[j]) continue;
    const s = freeSlots[j];
    let pick = pool.find(w => { const g = getCur(w); return !g.lists.has(s.hi) && gapOK(g, s.col); })
            || pool.find(w => !getCur(w).lists.has(s.hi)) || pool[0];
    placeInto(pick, j);
  }
}

/**
 * Daypart pass — frontload the day WITHOUT breaking the 60-min spacing rule.
 *
 * Within each list the already-placed pieces are re-seated into that list's own
 * columns, preferring the hottest-right-now (`priorityOf`) pieces in the earliest
 * slots.  Crucially it enforces the cross-list gap: the SAME workorder may never
 * land within `minColGap` columns (60 min) of itself on any other list in the
 * same day-section — so a piece can't go out at 10:00 on two lists at once.
 * A separate tracker is kept per section (today vs tomorrow) since those are
 * different days.  Per-list de-duplication is preserved (each list keeps its own
 * set of pieces).  Non-pool cells (NL, blanks, artifacts) are left untouched.
 *
 * @param {string[][]} rows
 * @param {number[]}   headerIndices
 * @param {{ crOffs:number[], priorityOf:Map<string,number>, minColGap?:number }} opts
 */
export function daypartSheet(rows, headerIndices, { crOffs, priorityOf, minColGap = 3 }) {
  for (const crOff of crOffs) {
    // Snapshot each list's pool pieces + slot columns, and clear those cells.
    const lists = [];
    for (const hi of headerIndices) {
      const cr = rows[hi + crOff];
      if (!cr) continue;
      const cols = [], pieces = [];
      for (let c = 9; c < cr.length; c++) {
        // Date-indexed warming columns are hand-managed — never re-seat them.
        if (!isIterTimeSlot(rows[hi]?.[c])) continue;
        const v = (cr[c] || '').trim();
        if (v && priorityOf.has(v)) { cols.push(c); pieces.push(v); cr[c] = ''; }
      }
      if (!cols.length) continue;
      cols.sort((a, b) => a - b);
      pieces.sort((a, b) => (priorityOf.get(b) || 0) - (priorityOf.get(a) || 0)); // hottest first
      lists.push({ crOff, hi, colSet: new Set(cols), remaining: pieces });
    }

    const placedCols = new Map(); // wo -> number[]  (this day-section, ALL lists)
    const near = (wo, col) => {
      const cs = placedCols.get(wo);
      if (!cs) return Infinity;
      let best = Infinity;
      for (const c of cs) best = Math.min(best, Math.abs(c - col));
      return best;
    };
    const mark = (wo, col) => { if (!placedCols.has(wo)) placedCols.set(wo, []); placedCols.get(wo).push(col); };

    // Sweep every time-column earliest → latest, ACROSS ALL LISTS at once.  When a
    // workorder is placed at a column on one list it immediately blocks that
    // column (± gap) for the same workorder on every other list — so the same WO
    // can never go out at, say, 10:00 on two lists.  Each list slot takes its
    // highest-recency remaining piece that still clears the gap, which frontloads
    // recent winners while spreading heavy pieces across the day.
    const allCols = [...new Set(lists.flatMap(l => [...l.colSet]))].sort((a, b) => a - b);
    for (const col of allCols) {
      for (const L of lists) {
        if (!L.colSet.has(col) || !L.remaining.length) continue;
        let idx = L.remaining.findIndex(w => near(w, col) >= minColGap);
        if (idx < 0) { // no gap-safe piece → minimise the violation
          let bestDist = -1;
          for (let i = 0; i < L.remaining.length; i++) { const d = near(L.remaining[i], col); if (d > bestDist) { bestDist = d; idx = i; } }
        }
        const w = L.remaining.splice(idx, 1)[0];
        rows[L.hi + crOff][col] = w;
        mark(w, col);
      }
    }
  }
}

/**
 * Gap repair — GUARANTEE the 60-min rule: the same workorder never appears within
 * `minColGap` columns of itself across lists in a day-section.  After fill /
 * rebalance / daypart, any residual too-close pair is fixed by swapping the
 * offending cell with another piece ON THE SAME LIST, chosen so BOTH pieces end
 * up gap-safe.  Iterates a few passes; converges to zero on real sheets.
 * Mutates rows in place.
 *
 * @param {string[][]} rows
 * @param {number[]}   headerIndices
 * When a swap can't fix a pair (a piece is simply over-concentrated), the cell is
 * REPLACED with a different in-pool piece that is gap-safe and not already on that
 * list — which guarantees zero violations while keeping the slot full.
 *
 * @param {{ crOffs:number[], pool?:string[], minColGap?:number, maxPasses?:number }} opts
 * @returns {number} remaining violations after repair (0 when fully spaced)
 */
export function repairGapSpacing(rows, headerIndices, { crOffs, pool = [], minColGap = 3, maxPasses = 6 }) {
  const isPiece = v => v && !/^NL/i.test(v);
  // The 60-min rule is about clock times, so only real time-slot columns take
  // part.  Warming-ramp lists index their columns by DATE and carry hand-placed
  // creative for future days — moving those cells would scramble the ramp.
  const movable = (hi, col, v) => isPiece(v) && isIterTimeSlot(rows[hi]?.[col]);
  let remaining = 0;
  for (const crOff of crOffs) {
    // ── Same-list de-dup ─────────────────────────────────────────────────────
    // A workorder must appear AT MOST ONCE in a list's creative row.  The base
    // fillers guarantee this, but the "never leave a slot empty" fallbacks can
    // drop a duplicate when a block has more slots than distinct pool pieces —
    // which is exactly the "repeats on the same row" deployers flag.  Replace
    // every repeat with the least-deployed pool piece not already on that list;
    // the gap-spacing passes below then seat it a clean ≥60 min away.  When the
    // pool is genuinely exhausted for the list the repeat is unavoidable and is
    // left in place rather than blanking a send slot.
    if (pool.length) {
      const sheetCount = new Map(); // wo -> placements across this crOff (least-used first)
      for (const hi of headerIndices) {
        const cr = rows[hi + crOff]; if (!cr) continue;
        for (let c = 9; c < cr.length; c++) { const v = (cr[c] || '').trim(); if (movable(hi, c, v)) sheetCount.set(v, (sheetCount.get(v) || 0) + 1); }
      }
      for (const hi of headerIndices) {
        const cr = rows[hi + crOff]; if (!cr) continue;
        const onList = new Set();
        for (let c = 9; c < cr.length; c++) { const v = (cr[c] || '').trim(); if (isPiece(v)) onList.add(v); }
        const seen = new Set();
        for (let c = 9; c < cr.length; c++) {
          const v = (cr[c] || '').trim();
          if (!movable(hi, c, v)) continue;
          if (!seen.has(v)) { seen.add(v); continue; }   // first (earliest) placement stays
          let best = null, bestCount = Infinity;
          for (const cand of pool) {
            if (onList.has(cand)) continue;
            const cnt = sheetCount.get(cand) || 0;
            if (cnt < bestCount) { bestCount = cnt; best = cand; if (cnt === 0) break; }
          }
          if (best) { cr[c] = best; onList.add(best); seen.add(best); sheetCount.set(best, (sheetCount.get(best) || 0) + 1); sheetCount.set(v, (sheetCount.get(v) || 1) - 1); }
        }
      }
    }
    for (let pass = 0; pass < maxPasses; pass++) {
      // placements: wo -> [{ hi, col }]
      const placements = new Map();
      for (const hi of headerIndices) {
        const cr = rows[hi + crOff]; if (!cr) continue;
        for (let c = 9; c < cr.length; c++) {
          const v = (cr[c] || '').trim();
          if (!movable(hi, c, v)) continue;
          if (!placements.has(v)) placements.set(v, []);
          placements.get(v).push({ hi, col: c });
        }
      }
      const gapSafe = (w, targetCol, exceptHi, exceptCol) => {
        const arr = placements.get(w) || [];
        for (const p of arr) {
          if (p.hi === exceptHi && p.col === exceptCol) continue;
          if (Math.abs(p.col - targetCol) < minColGap) return false;
        }
        return true;
      };
      let fixed = 0;
      for (const [wo, ps] of placements) {
        ps.sort((a, b) => a.col - b.col);
        for (let i = 1; i < ps.length; i++) {
          if (ps[i].col - ps[i - 1].col >= minColGap) continue;
          const { hi, col } = ps[i];
          const cr = rows[hi + crOff];
          let done = false;
          for (let tc = 9; tc < cr.length && !done; tc++) {
            if (tc === col) continue;
            const P = (cr[tc] || '').trim();
            if (!movable(hi, tc, P) || !placements.has(P)) continue;
            // swap: wo → tc, P → col, only if both stay gap-safe
            if (gapSafe(wo, tc, hi, col) && gapSafe(P, col, hi, tc)) {
              cr[col] = P; cr[tc] = wo;
              placements.get(wo).find(p => p.hi === hi && p.col === col).col = tc;
              placements.get(P).find(p => p.hi === hi && p.col === tc).col = col;
              fixed++; done = true;
            }
          }
          // No gap-safe swap → replace this cell with a different pool piece that
          // is gap-safe here and not already on this list.  Prefer the LEAST-
          // deployed candidate so the fix doesn't re-concentrate onto the top
          // pieces (keeps de-concentration intact); guarantees resolution.
          if (!done && pool.length) {
            const onList = new Set();
            for (let c = 9; c < cr.length; c++) { const p = (cr[c] || '').trim(); if (isPiece(p)) onList.add(p); }
            // (onList intentionally spans the whole row — a piece already sitting
            // in a warming column still counts as "on this list".)
            let best = null, bestCount = Infinity;
            for (const cand of pool) {
              if (onList.has(cand) || !gapSafe(cand, col, -1, -1)) continue;
              const cnt = placements.get(cand)?.length ?? 0;
              if (cnt < bestCount) { bestCount = cnt; best = cand; if (cnt === 0) break; }
            }
            if (best) {
              const wp = placements.get(wo);
              const idx = wp.findIndex(p => p.hi === hi && p.col === col);
              if (idx >= 0) wp.splice(idx, 1);
              cr[col] = best;
              if (!placements.has(best)) placements.set(best, []);
              placements.get(best).push({ hi, col });
              fixed++; done = true;
            }
          }
        }
      }
      if (fixed === 0) break;
    }
    // count any stubborn residual
    const byWO = new Map();
    for (const hi of headerIndices) {
      const cr = rows[hi + crOff]; if (!cr) continue;
      for (let c = 9; c < cr.length; c++) { const v = (cr[c] || '').trim(); if (!movable(hi, c, v)) continue; if (!byWO.has(v)) byWO.set(v, []); byWO.get(v).push(c); }
    }
    for (const cs of byWO.values()) { cs.sort((a, b) => a - b); for (let i = 1; i < cs.length; i++) if (cs[i] - cs[i - 1] < minColGap) remaining++; }
  }
  return remaining;
}

/**
 * Convert raw 2-D rows array to TSV string for clipboard paste into Excel / Google Sheets.
 */
export function rawRowsToTsv(rows) {
  return rows.map(row => row.join('\t')).join('\n');
}

// ─── New-workorder slot filling ───────────────────────────────────────────────
//
// After the regular fills are complete, a separate pass places user-supplied
// "New Work Orders" onto each sheet so brand-new creative gets a real read
// before it has any performance history to rank on.
//
// Per-ESP quota: every new piece targets a fixed number of sends on each sheet
// per deployment day — Verve 4, Iterable 3, Acoustic 1.  Verve and Iterable
// spend that quota on slots the main filler leaves empty (NEW / RECENT ACTIVE);
// Acoustic has no reserved tier, so its single send displaces one ranked
// placement (see fillNewWOsIntoAcousticRows).
//
// Gap rule: the same new workorder may not appear within 4 columns (80 min) of
// another of its own placements.  The tracker is shared across all three ESPs
// so the gap holds for a subscriber who sits on lists in more than one of them.
//
// Fill order: Acoustic → Verve → Iterable.  Acoustic goes first because it has
// the tightest quota (1) and the fewest usable slots, so it should not be left
// picking over columns the other two have already blocked.
//
// The tracker is keyed by day-section (0 = today, 1 = tomorrow) so each day
// grants the full quota and the 80-min gap never leaks across days — today's
// 10:00 send says nothing about tomorrow's 10:00 send.

const NEW_WO_MIN_COL_GAP = 4;  // 80 min ÷ 20 min per column

// Target sends per new piece, per sheet, per deployment day.
export const NEW_WO_SLOTS_PER_ESP = { verve: 4, iterable: 3, acoustic: 1 };

// TEMPORARY (one-time patch, 2026-09-15): these orgs take no new workorders on
// any ESP.  Their lists still get ranked creative as normal.  Matched against
// the list name in column A of each block's "Time (PST)" header row.  Delete
// the entries (or the whole constant + newWOListExcluded checks) to lift it.
const NEW_WO_EXCLUDED_LISTS = [/aronimink/i, /\bcradle\b/i];

function newWOListExcluded(rows, headerIdx) {
  const name = (rows[headerIdx]?.[0] || '').trim();
  return NEW_WO_EXCLUDED_LISTS.some(re => re.test(name));
}

// sharedTracker: Map<sectionIdx, Map<wo, Set<col>>>
function newWOSectionTracker(sharedTracker, sectionIdx) {
  if (!sharedTracker.has(sectionIdx)) sharedTracker.set(sectionIdx, new Map());
  return sharedTracker.get(sectionIdx);
}

function newWONoConflict(wo, col, tracker) {
  const placed = tracker.get(wo);
  if (!placed) return true;
  for (const c of placed) {
    if (Math.abs(c - col) < NEW_WO_MIN_COL_GAP) return false;
  }
  return true;
}

function newWOTrackPlacement(wo, col, tracker) {
  if (!tracker.has(wo)) tracker.set(wo, new Set());
  tracker.get(wo).add(col);
}

// How many times this piece has already landed on THIS sheet in THIS section.
function newWOCountOnSheet(counts, wo) {
  return counts.get(wo) || 0;
}

function newWOBump(counts, wo) {
  counts.set(wo, (counts.get(wo) || 0) + 1);
}

/**
 * Fill Verve NEW / RECENT ACTIVE (clearCol) slots.
 *
 *   Pass 1 — user-supplied newWorkorders (priority), up to `maxPerWO` sends per
 *            piece per day-section, with the shared cross-ESP 80-min gap.
 *   Pass 2 — fallbackWorkorders (the ranked pool): once new workorders run out,
 *            every remaining clearCol is filled with any ranked creative so the
 *            Verve sheet is always totally full.  Respects the 60-min same-WO
 *            gap where possible (seeded from creative already on the sheet),
 *            then relaxes to guarantee no slot is left empty.
 *
 * Today rows are always filled; tomorrow rows (crOff 7) are filled too when
 * dayMode >= 1.  Mutates rows in place; updates sharedTracker for Pass-1 gaps.
 */
export function fillNewWOsIntoVerveRows(rows, headerIndices, newWorkorders, sharedTracker, fallbackWorkorders = [], dayMode = 0, maxPerWO = NEW_WO_SLOTS_PER_ESP.verve) {
  const hasNew = newWorkorders && newWorkorders.length > 0;
  const hasFallback = fallbackWorkorders && fallbackWorkorders.length > 0;
  if (!hasNew && !hasFallback) return;

  // Section row offsets: today (segment +2 / creative +1); tomorrow (+8 / +7).
  const sections = [{ segOff: 2, crOff: 1, idx: 0 }];
  if (dayMode >= 1) sections.push({ segOff: 8, crOff: 7, idx: 1 });

  // Collect every clearCol slot (anything that isn't TOP PRE / GANGBUSTER).
  const slots = []; // [{ headerIdx, col, crOff, idx }]
  for (const headerIdx of headerIndices) {
    for (const { segOff, crOff, idx } of sections) {
      const segRow = rows[headerIdx + segOff] || [];
      for (let col = 9; col < segRow.length; col++) {
        const seg = (segRow[col] || '').trim().toUpperCase();
        if (!seg) continue;
        if (seg.includes('TOP PRE') || seg.includes('GANGBUSTER')) continue;
        slots.push({ headerIdx, col, crOff, idx });
      }
    }
  }
  slots.sort((a, b) => a.col - b.col); // soonest time first

  // Per-(block, section) dedup so a workorder never repeats within one list/day.
  const usedPerBlock = new Map();
  const keyOf = (hi, cr) => hi + ':' + cr;
  const usedSet = k => { if (!usedPerBlock.has(k)) usedPerBlock.set(k, new Set()); return usedPerBlock.get(k); };

  // ── Pass 1: user-supplied new workorders ──
  // Quota is counted per day-section, so tomorrow starts each piece fresh.
  if (hasNew) {
    const sheetCounts = new Map(); // sectionIdx → Map<wo, placements on this sheet>
    const countsFor = i => { if (!sheetCounts.has(i)) sheetCounts.set(i, new Map()); return sheetCounts.get(i); };

    for (const { headerIdx, col, crOff, idx } of slots) {
      if (newWOListExcluded(rows, headerIdx)) continue; // left for the Pass-2 ranked fill
      const crRow = rows[headerIdx + crOff];
      if (!crRow) continue;
      while (crRow.length <= col) crRow.push('');
      if ((crRow[col] || '').trim()) continue; // already filled (TOP/GANG)
      const used = usedSet(keyOf(headerIdx, crOff));
      const tracker = newWOSectionTracker(sharedTracker, idx);
      const counts = countsFor(idx);
      // Least-placed piece gets first refusal, so when the sheet runs out of
      // room the shortfall is shared instead of starving the tail of the list.
      // Sort is stable, so pieces on equal footing keep their entry order.
      const ordered = [...newWorkorders].sort((x, y) => newWOCountOnSheet(counts, x) - newWOCountOnSheet(counts, y));
      for (const wo of ordered) {
        if (newWOCountOnSheet(counts, wo) >= maxPerWO) continue;
        if (!used.has(wo) && newWONoConflict(wo, col, tracker)) {
          crRow[col] = wo;
          used.add(wo);
          newWOBump(counts, wo);
          newWOTrackPlacement(wo, col, tracker);
          break;
        }
      }
    }
  }

  // ── Pass 2: ranked-pool fallback → guarantee every clearCol is filled ──
  if (!hasFallback) return;
  const VERVE_GAP = 3; // 60 minutes at 20-min slots
  const gapTracker = new Map(); // wo → Set<col>
  const track = (wo, col) => { if (!gapTracker.has(wo)) gapTracker.set(wo, new Set()); gapTracker.get(wo).add(col); };
  // Seed from everything already on the relevant creative rows so the fallback
  // respects the gap against TOP/GANG/new placements too.
  for (const headerIdx of headerIndices) {
    for (const { crOff } of sections) {
      const crRow = rows[headerIdx + crOff] || [];
      for (let col = 9; col < crRow.length; col++) {
        const v = (crRow[col] || '').trim();
        if (v && !/^NL/i.test(v)) track(v, col);
      }
    }
  }
  const gapOK = (wo, col) => {
    const p = gapTracker.get(wo);
    if (!p) return true;
    for (const c of p) if (Math.abs(c - col) < VERVE_GAP) return false;
    return true;
  };

  for (const { headerIdx, col, crOff } of slots) {
    const crRow = rows[headerIdx + crOff];
    if (!crRow) continue;
    while (crRow.length <= col) crRow.push('');
    if ((crRow[col] || '').trim()) continue; // filled by TOP/GANG or Pass 1
    const used = usedSet(keyOf(headerIdx, crOff));
    let pick = null;
    // Prefer gap-respecting + not already in this block/section…
    for (const wo of fallbackWorkorders) { if (!used.has(wo) && gapOK(wo, col)) { pick = wo; break; } }
    // …then not-in-block (relax the gap)…
    if (!pick) for (const wo of fallbackWorkorders) { if (!used.has(wo)) { pick = wo; break; } }
    // …then anything at all, so the slot is never left empty.
    if (!pick) pick = fallbackWorkorders[0];
    crRow[col] = pick;
    used.add(pick);
    track(pick, col);
  }
}

/**
 * Fill Iterable NEW / RECENT ACTIVE (clearOut) slots.
 *
 *   Pass 1 — user-supplied newWorkorders (priority) into up to `newContentShare`
 *            of the NEW/RECENT ACTIVE slots (spread across the day), with the
 *            shared 80-min cross-ESP gap.  The remaining slots are treated as
 *            normal and left for Pass 2, so new content never floods the sheet.
 *   Pass 2 — fallbackWorkorders (the ranked pool): fills every remaining slot
 *            (the ~non-new share, plus any new-eligible slots no new WO fit) with
 *            good ranked creative so the Iterable sheet is always totally full.
 *            Respects the 60-min same-WO gap where possible, then relaxes.
 *
 * Today rows are always filled; tomorrow rows (crOff 8) too when dayMode >= 1.
 * Mutates rows in place; updates sharedTracker for Pass-1 gaps.
 */
export function fillNewWOsIntoIterableRows(rows, headerIndices, newWorkorders, sharedTracker, fallbackWorkorders = [], dayMode = 0, newContentShare = 1, maxPerWO = NEW_WO_SLOTS_PER_ESP.iterable) {
  const hasNew = newWorkorders && newWorkorders.length > 0;
  const hasFallback = fallbackWorkorders && fallbackWorkorders.length > 0;
  if (!hasNew && !hasFallback) return;

  // Section offsets: today (segment +3 / creative +1); tomorrow (+10 / +8).
  const sections = [{ segOff: 3, crOff: 1, idx: 0 }];
  if (dayMode >= 1) sections.push({ segOff: 10, crOff: 8, idx: 1 });

  // Collect every NEW-style slot (anything not GANGBUSTERS/RISING), classified
  // the same way as the main filler so the two stay consistent.
  const slots = []; // [{ headerIdx, col, crOff, idx }]
  for (const headerIdx of headerIndices) {
    const timeRow = rows[headerIdx] || [];
    const legend = buildIterableLegend(rows, headerIdx);
    for (const { segOff, crOff, idx } of sections) {
      const segmentRow = rows[headerIdx + segOff] || [];
      const creativeRow = rows[headerIdx + crOff] || [];
      for (let col = 9; col < segmentRow.length; col++) {
        if (!isIterTimeSlot(timeRow[col])) continue;
        const segVal = (segmentRow[col] || '').trim();
        if (!segVal || segVal.toLowerCase() === 'segment') continue;
        if (/^NL/i.test((creativeRow[col] || '').trim())) continue;
        const type = classifyIterableSegment(segVal, legend);
        if (type !== 'GANGBUSTERS' && type !== 'RISING') slots.push({ headerIdx, col, crOff, idx });
      }
    }
  }
  slots.sort((a, b) => a.col - b.col); // soonest first

  const usedPerBlock = new Map(); // key headerIdx:crOff -> Set<wo>
  const keyOf = (hi, cr) => hi + ':' + cr;
  const usedSet = k => { if (!usedPerBlock.has(k)) usedPerBlock.set(k, new Set()); return usedPerBlock.get(k); };

  // Only `newContentShare` of the NEW/RECENT slots are reserved for truly new
  // content — picked evenly across the day so new pieces don't cluster.  The
  // rest are treated as normal and filled with ranked creative in Pass 2.
  //
  // The share is computed PER day-section.  Spreading evenly over the combined
  // today+tomorrow array instead would systematically starve one of them: the
  // two sections interleave once the array is sorted by column, so an
  // every-other-index pick lands on whichever section owns that parity.
  const newEligible = new Set();
  const bySection = new Map(); // sectionIdx → slot-array indices, in column order
  slots.forEach((s, si) => {
    if (!bySection.has(s.idx)) bySection.set(s.idx, []);
    bySection.get(s.idx).push(si);
  });
  for (const sectionSlots of bySection.values()) {
    const budget = Math.round(sectionSlots.length * Math.max(0, Math.min(1, newContentShare)));
    if (budget <= 0) continue;
    const step = sectionSlots.length / budget;
    for (let k = 0; k < budget; k++) {
      newEligible.add(sectionSlots[Math.min(sectionSlots.length - 1, Math.floor(k * step))]);
    }
  }

  // ── Pass 1: user-supplied new workorders (new-eligible slots only) ──
  // Quota is counted per day-section, so tomorrow starts each piece fresh.
  if (hasNew) {
    const sheetCounts = new Map(); // sectionIdx → Map<wo, placements on this sheet>
    const countsFor = i => { if (!sheetCounts.has(i)) sheetCounts.set(i, new Map()); return sheetCounts.get(i); };

    for (let si = 0; si < slots.length; si++) {
      if (!newEligible.has(si)) continue;
      const { headerIdx, col, crOff, idx } = slots[si];
      if (newWOListExcluded(rows, headerIdx)) continue; // left for the Pass-2 ranked fill
      const crRow = rows[headerIdx + crOff];
      if (!crRow) continue;
      while (crRow.length <= col) crRow.push('');
      if ((crRow[col] || '').trim()) continue;
      const used = usedSet(keyOf(headerIdx, crOff));
      const tracker = newWOSectionTracker(sharedTracker, idx);
      const counts = countsFor(idx);
      // Least-placed piece gets first refusal, so when the reserved share runs
      // out the shortfall is shared instead of starving the tail of the list.
      // Sort is stable, so pieces on equal footing keep their entry order.
      const ordered = [...newWorkorders].sort((x, y) => newWOCountOnSheet(counts, x) - newWOCountOnSheet(counts, y));
      for (const wo of ordered) {
        if (newWOCountOnSheet(counts, wo) >= maxPerWO) continue;
        if (!used.has(wo) && newWONoConflict(wo, col, tracker)) {
          crRow[col] = wo;
          used.add(wo);
          newWOBump(counts, wo);
          newWOTrackPlacement(wo, col, tracker);
          break;
        }
      }
    }
  }

  // ── Pass 2: ranked-pool fallback → guarantee every NEW/RECENT slot is filled ──
  if (!hasFallback) return;
  const ITER_GAP = 3; // 60 minutes at 20-min slots
  const gapTracker = new Map(); // wo → Set<col>
  const track = (wo, col) => { if (!gapTracker.has(wo)) gapTracker.set(wo, new Set()); gapTracker.get(wo).add(col); };
  // Seed from everything already placed in the relevant creative rows so the
  // fallback respects the gap against GANG/RISE/new placements too.
  for (const headerIdx of headerIndices) {
    for (const { crOff } of sections) {
      const crRow = rows[headerIdx + crOff] || [];
      for (let col = 9; col < crRow.length; col++) {
        const v = (crRow[col] || '').trim();
        if (v && !/^NL/i.test(v)) track(v, col);
      }
    }
  }
  const gapOK = (wo, col) => {
    const p = gapTracker.get(wo);
    if (!p) return true;
    for (const c of p) if (Math.abs(c - col) < ITER_GAP) return false;
    return true;
  };

  for (const { headerIdx, col, crOff } of slots) {
    const crRow = rows[headerIdx + crOff];
    if (!crRow) continue;
    while (crRow.length <= col) crRow.push('');
    if ((crRow[col] || '').trim()) continue; // filled by GANG/RISE or Pass 1
    const used = usedSet(keyOf(headerIdx, crOff));
    let pick = null;
    for (const wo of fallbackWorkorders) { if (!used.has(wo) && gapOK(wo, col)) { pick = wo; break; } }       // gap + not-in-block
    if (!pick) for (const wo of fallbackWorkorders) { if (!used.has(wo)) { pick = wo; break; } }              // relax gap
    if (!pick) pick = fallbackWorkorders[0];                                                                    // guarantee fill
    crRow[col] = pick;
    used.add(pick);
    track(pick, col);
  }
}

/**
 * Give each new workorder a read on Acoustic.
 *
 * Acoustic has no reserved NEW tier — every time-slot is a ranked send (FPDS_SEND
 * / RECENT ACTIVE / SEND ALL) and the main filler leaves none of them empty.  So
 * unlike Verve and Iterable, this pass DISPLACES ranked creative.  To keep that
 * cost as low as possible it spends RECENT ACTIVE slots first: that tier is the
 * waterfall the main filler only reaches after FPDS_SEND is satisfied, so it
 * carries the weakest-ranked creative on the sheet.  FPDS_SEND is used only as
 * overflow when RECENT ACTIVE runs out, and SEND ALL is never touched (those
 * columns belong to the SLF pool).
 *
 * Candidates are walked from a rotating start offset so the pieces spread across
 * lists and across the day rather than stacking into the earliest slots.
 *
 * Must run AFTER rebalance / daypart / repairGapSpacing — those passes would
 * otherwise relocate or overwrite the placements made here.
 *
 * @param {string[][]} rows
 * @param {number[]}   headerIndices
 * @param {string[]}   newWorkorders
 * @param {Map}        sharedTracker  Map<sectionIdx, Map<wo, Set<col>>>, shared across ESPs
 * @param {number}     dayMode
 * @param {number}     maxPerWO       sends per piece per day-section
 * @returns {number}   placements made
 */
export function fillNewWOsIntoAcousticRows(rows, headerIndices, newWorkorders, sharedTracker, dayMode = 0, maxPerWO = NEW_WO_SLOTS_PER_ESP.acoustic) {
  if (!newWorkorders || newWorkorders.length === 0 || maxPerWO <= 0) return 0;

  // Section offsets: today (query +2 / creative +1); tomorrow (+8 / +7).
  const sections = [{ qOff: 2, crOff: 1, idx: 0 }];
  if (dayMode >= 1) sections.push({ qOff: 8, crOff: 7, idx: 1 });

  let placements = 0;

  for (const { qOff, crOff, idx } of sections) {
    // Two tiers of candidate slots, cheapest to displace first.
    const recentActive = [];
    const fpds = [];
    for (const headerIdx of headerIndices) {
      if (newWOListExcluded(rows, headerIdx)) continue; // keeps its ranked placements
      const timeRow = rows[headerIdx] || [];
      const queryRow = rows[headerIdx + qOff] || [];
      for (let col = 9; col < queryRow.length; col++) {
        if (!isIterTimeSlot(timeRow[col])) continue; // skips date-indexed warming ramps
        const seg = (queryRow[col] || '').trim();
        if (!seg) continue;
        if (/send\s*all/i.test(seg)) continue;       // SLF territory
        if (/recent[_ ]?active/i.test(seg)) recentActive.push({ headerIdx, col });
        else if (/fpds[_ ]?send/i.test(seg)) fpds.push({ headerIdx, col });
      }
    }
    // Cheapest tier first.  Each tier is its own ring with its own stride, so
    // the spread-out starting offset can't skip past RECENT ACTIVE into the much
    // larger FPDS_SEND block — the preference has to survive the spreading.
    const tiers = [recentActive, fpds].filter(t => t.length > 0);
    if (tiers.length === 0) continue;

    const tracker = newWOSectionTracker(sharedTracker, idx);
    const taken = new Set(); // "hi:col" claimed by this pass — never double-assign
    const wanted = Math.max(1, newWorkorders.length * maxPerWO);

    for (let n = 0; n < newWorkorders.length; n++) {
      const wo = newWorkorders[n];
      for (let round = 0; round < maxPerWO; round++) {
        let placed = false;
        // Walk tiers in order; within a tier, two passes — honour the 80-min gap,
        // then relax it so the piece still gets its read rather than being
        // silently dropped.  Only move to the next tier once this one is spent.
        for (const candidates of tiers) {
          // Spread the starting point so consecutive pieces don't crowd the
          // same lists or the same part of the day.
          const stride = Math.max(1, Math.floor(candidates.length / wanted));
          const start = ((n * maxPerWO + round) * stride) % candidates.length;
          for (const strict of [true, false]) {
            for (let k = 0; k < candidates.length && !placed; k++) {
              const { headerIdx, col } = candidates[(start + k) % candidates.length];
              const key = headerIdx + ':' + col;
              if (taken.has(key)) continue;
              const crRow = rows[headerIdx + crOff];
              if (!crRow) continue;
              while (crRow.length <= col) crRow.push('');
              // Never put the same piece on a list twice in one day-section.
              if (crRow.some((v, c) => c >= 9 && (v || '').trim() === wo)) continue;
              if (strict && !newWONoConflict(wo, col, tracker)) continue;
              crRow[col] = wo;
              taken.add(key);
              newWOTrackPlacement(wo, col, tracker);
              placements++;
              placed = true;
            }
            if (placed) break;
          }
          if (placed) break;
        }
        if (!placed) break; // sheet is saturated for this piece
      }
    }
  }

  return placements;
}

// ─── First-come-first-served even fill (manual / no-data mode) ────────────────
//
// Used when there is no performance data to rank with. The rules are simple and
// deliberately not score-driven:
//
//   • First come, first served — work orders are consumed in the order typed.
//   • One send per list, maximum. A piece never repeats on the same list, even
//     if that leaves slots empty.
//   • Even spread — a single rotating cursor carries across list boundaries, so
//     every piece ends up with a near-identical number of sends sheet-wide
//     rather than the first few soaking up the early slots on every list.
//   • The ≥60-minute same-piece gap across lists still holds (MIN_COL_GAP), as
//     it does in the ranked fillers; a slot is left empty rather than break it.
//
// Today and tomorrow rows are tracked separately — they are different days, so
// the time gap does not apply between them.
const FCFS_MIN_COL_GAP = 3; // 3 × 20-min intervals = 60 minutes

const FCFS_TEMPLATES = {
  acoustic: { csv: () => ACOUSTIC_TEMPLATE_CSV, sections: [{ slotOff: 2, crOff: 1 }, { slotOff: 8,  crOff: 7 }] },
  verve:    { csv: () => VERVE_TEMPLATE_CSV,    sections: [{ slotOff: 2, crOff: 1 }, { slotOff: 8,  crOff: 7 }] },
  iterable: { csv: () => ITERABLE_TEMPLATE_CSV, sections: [{ slotOff: 3, crOff: 1 }, { slotOff: 10, crOff: 8 }] },
};

/**
 * Fill one ESP's sheet from a plain list of work orders.
 *
 * @param {'acoustic'|'iterable'|'verve'} esp
 * @param {string[]} workorders  In the order the user entered them.
 * @param {{ dayMode?: number }} options
 * @returns {{ rows: string[][], headerIndices: number[], csvString: string, stats: object }}
 */
export function fillSheetFirstComeFirstServed(esp, workorders, { dayMode = 0 } = {}) {
  const spec = FCFS_TEMPLATES[esp];
  if (!spec) throw new Error(`fillSheetFirstComeFirstServed: unknown ESP "${esp}"`);

  const rows = Papa.parse(spec.csv(), { header: false, skipEmptyLines: false })
    .data.map(row => [...row]);

  const headerIndices = [];
  rows.forEach((row, idx) => {
    if ((row[8] || '').trim() === 'Time (PST)') headerIndices.push(idx);
  });

  // SEND ALL columns are SLF territory; everything else takes regular pieces.
  const slf = workorders.filter(wo => /^SLF/i.test(wo));
  const regular = workorders.filter(wo => !/^SLF/i.test(wo));

  const sections = spec.sections.slice(0, dayMode >= 1 ? 2 : 1);

  // Map<wo, Set<col>> per section — the cross-list time-gap tracker.
  const placedCols = sections.map(() => new Map());
  // Entry order, for the first-come-first-served tie-break.
  const entryIdx = new Map(workorders.map((wo, i) => [wo, i]));

  const sendCounts = new Map(workorders.map(wo => [wo, 0]));
  let slotsSeen = 0, slotsFilled = 0, blockedByGap = 0, blockedByCap = 0;

  const gapOk = (tracker, wo, col) => {
    const cols = tracker.get(wo);
    if (!cols) return true;
    for (const c of cols) if (Math.abs(c - col) < FCFS_MIN_COL_GAP) return false;
    return true;
  };

  for (const headerIdx of headerIndices) {
    const timeRow = rows[headerIdx] || [];

    // One used-set per list block: the "max 1 per list" rule. Shared across
    // today/tomorrow and across both rings so a piece cannot slip in twice.
    const usedOnList = new Set();

    sections.forEach(({ slotOff, crOff }, si) => {
      const slotRow = rows[headerIdx + slotOff] || [];
      const creativeRow = rows[headerIdx + crOff];
      if (!creativeRow) return;
      while (creativeRow.length < slotRow.length) creativeRow.push('');

      const tracker = placedCols[si];

      for (let col = 9; col < slotRow.length; col++) {
        // Only real clock-time columns — skips the date-indexed warming ramps.
        if (!isIterTimeSlot(timeRow[col])) continue;
        const seg = (slotRow[col] || '').trim();
        if (!seg) continue;
        // Never overwrite hand-placed newsletter slots.
        if (/^NL/i.test((creativeRow[col] || '').trim())) continue;

        const isSendAll = /send\s*all/i.test(seg);
        const ring = isSendAll ? slf : regular;
        slotsSeen++;
        if (ring.length === 0) continue;

        // Of the pieces still allowed here, take the one sent least so far —
        // that is what keeps the spread even — and break ties on entry order,
        // so the earliest-typed piece wins and the very first list comes out in
        // exactly the order it was typed.
        let picked = null, bestSends = Infinity, capHits = 0, gapHits = 0;
        for (const cand of ring) {
          if (usedOnList.has(cand)) { capHits++; continue; }
          if (!gapOk(tracker, cand, col)) { gapHits++; continue; }
          const sends = sendCounts.get(cand) || 0;
          if (sends < bestSends ||
              (sends === bestSends && entryIdx.get(cand) < entryIdx.get(picked))) {
            picked = cand;
            bestSends = sends;
          }
        }

        if (!picked) {
          if (gapHits > 0) blockedByGap++;
          else blockedByCap++;
          continue; // leave the slot empty rather than repeat or crowd
        }

        creativeRow[col] = picked;
        usedOnList.add(picked);
        if (!tracker.has(picked)) tracker.set(picked, new Set());
        tracker.get(picked).add(col);
        sendCounts.set(picked, (sendCounts.get(picked) || 0) + 1);
        slotsFilled++;
      }
    });
  }

  const counts = [...sendCounts.values()];
  return {
    rows,
    headerIndices,
    csvString: Papa.unparse(rows),
    stats: {
      lists: headerIndices.length,
      workorders: workorders.length,
      slotsSeen,
      slotsFilled,
      slotsEmpty: slotsSeen - slotsFilled,
      blockedByCap,
      blockedByGap,
      minSends: counts.length ? Math.min(...counts) : 0,
      maxSends: counts.length ? Math.max(...counts) : 0,
      sendCounts,
    },
  };
}

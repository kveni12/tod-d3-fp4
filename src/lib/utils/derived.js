import * as d3 from 'd3';
import { periodCensusBounds } from './periods.js';

/**
 * Great-circle distance between two WGS84 points (metres).
 *
 * Parameters
 * ----------
 * lat1 : number
 * lon1 : number
 * lat2 : number
 * lon2 : number
 *
 * Returns
 * -------
 * number
 */
export function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
	const R = 6371000;
	const toRad = (deg) => (deg * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const MODE_TO_FLAG = {
	rail: 'has_rail',
	commuter_rail: 'has_commuter_rail',
	bus: 'has_bus'
};

/** Display strings for MBTA mode keys (internal keys stay ``rail`` / ``commuter_rail`` / ``bus``). */
const TRANSIT_MODE_UI_LABEL = {
	rail: 'Rapid transit',
	commuter_rail: 'Commuter rail',
	bus: 'Bus'
};

/**
 * Human-readable label for a transit mode key (map overlays, cohort chips, tooltips).
 *
 * Parameters
 * ----------
 * modeKey : string
 *
 * Returns
 * -------
 * string
 */
export function transitModeUiLabel(modeKey) {
	if (modeKey == null || modeKey === '') return '';
	const k = String(modeKey);
	return TRANSIT_MODE_UI_LABEL[k] ?? k.replace(/_/g, ' ');
}

/**
 * Whether a tract has at least one selected transit mode per ``transitModes`` toggles.
 *
 * Parameters
 * ----------
 * tract : object
 * transitModes : Record<string, boolean>
 *
 * Returns
 * -------
 * boolean
 */
export function tractMatchesTransitModes(tract, transitModes) {
	const tm = transitModes ?? {};
	const activeModes = Object.entries(tm).filter(([, on]) => on);
	const inactiveModes = Object.entries(tm).filter(([, on]) => !on);
	if (inactiveModes.length > 0 && activeModes.length > 0) {
		const hasAnyActiveMode = activeModes.some(([key]) => Boolean(tract[MODE_TO_FLAG[key]]));
		const hasAnyMode = Object.keys(MODE_TO_FLAG).some((key) => Boolean(tract[MODE_TO_FLAG[key]]));
		if (hasAnyMode && !hasAnyActiveMode) return false;
	} else if (activeModes.length === 0) {
		return false;
	}
	return true;
}

/**
 * Census tract passes overall universe filters (population, density, minimum
 * transit stop count). Does not apply TOD vs. non-TOD cohort rules.
 *
 * Parameters
 * ----------
 * tract : object
 * panelState : object
 *
 * Returns
 * -------
 * boolean
 */
export function passesTractUniverse(tract, panelState) {
	const tp = panelState.timePeriod;
	const { startY } = periodCensusBounds(tp);
	const gj = tract.gisjoin;
	if (!gj || typeof gj !== 'string' || !gj.startsWith('G')) return false;

	const nStops = Number(tract.transit_stops) || 0;
	if (nStops < (panelState.minStops ?? 0)) return false;

	const pop = Number(tract[`pop_${startY}`]) || 0;
	if (pop < (panelState.minPopulation || 0)) return false;

	const area = Number(tract.area_sq_mi) || 0;
	if ((panelState.minPopDensity || 0) > 0 && area > 0) {
		if (pop / area < panelState.minPopDensity) return false;
	}

	return true;
}

/**
 * MassBuilds affordable share for a tract and period: ``new_affordable / new_units``.
 *
 * Parameters
 * ----------
 * tract : object
 * timePeriod : string
 *     Panel period tag (e.g. ``'10_20'``).
 *
 * Returns
 * -------
 * number | null
 *     Share in ``[0, 1]``, or ``null`` when there is no new-unit activity
 *     (``new_units`` is 0 or missing).
 */
export function tractMassbuildsAffordableShare(tract, timePeriod) {
	const nu = Number(tract[`new_units_${timePeriod}`]) || 0;
	if (nu <= 0) return null;
	const naRaw = Number(tract[`new_affordable_${timePeriod}`]) || 0;
	// Baked tract columns can reflect raw MassBuilds; cap so share stays in [0, 1].
	const na = Math.min(naRaw, nu);
	return na / nu;
}

/**
 * Whether a tract meets the cohort minimum affordable-development ratio (percent
 * of MassBuilds new units that are affordable). When the minimum is 0, passes.
 * Tracts with no new units fail if the minimum is positive.
 *
 * Parameters
 * ----------
 * tract : object
 * panelState : object
 * cohort : 'tod' | 'nonTod'
 *
 * Returns
 * -------
 * boolean
 */
export function passesCohortMinAffordableShare(tract, panelState, cohort) {
	const pctRaw =
		cohort === 'tod'
			? panelState.todMinAffordableSharePct
			: panelState.nonTodMinAffordableSharePct;
	const pct = Math.min(100, Math.max(0, Number(pctRaw) || 0));
	if (pct <= 0) return true;
	const share = tractMassbuildsAffordableShare(tract, panelState.timePeriod);
	if (share == null) return false;
	return share >= pct / 100;
}

/**
 * Housing stock increase (percent) from tract-level MassBuilds totals: new units
 * in ``timePeriod`` divided by decennial census ``total_hu`` at the period start
 * year. Aligns with scatter X ``pct_stock_increase`` when all projects are included
 * (tract JSON aggregates are not filtered by development controls).
 *
 * Parameters
 * ----------
 * tract : object
 * timePeriod : string
 *     Panel period tag (e.g. ``'10_20'``).
 *
 * Returns
 * -------
 * number | null
 *     Percent in ``[0, 100+]``, or ``null`` when base housing stock is missing or zero.
 */
export function tractHousingStockIncreasePct(tract, timePeriod) {
	const { startY } = periodCensusBounds(timePeriod);
	const nu = Number(tract[`new_units_${timePeriod}`]) || 0;
	const baseStock = Number(tract[`total_hu_${startY}`]) || 0;
	if (baseStock <= 0) return null;
	return +((100 * nu) / baseStock).toFixed(4);
}

/**
 * Cohort floor on housing stock increase (%). When the minimum is 0, passes.
 * Tracts with no valid base stock fail if the minimum is positive.
 *
 * Parameters
 * ----------
 * tract : object
 * panelState : object
 * cohort : 'tod' | 'nonTod'
 *
 * Returns
 * -------
 * boolean
 */
export function passesCohortMinHousingStockIncreasePct(tract, panelState, cohort) {
	const pctRaw =
		cohort === 'tod'
			? panelState.todMinStockIncreasePct
			: panelState.nonTodMinStockIncreasePct;
	const minPct = Math.max(0, Number(pctRaw) || 0);
	if (minPct <= 0) return true;
	const v = tractHousingStockIncreasePct(tract, panelState.timePeriod);
	if (v == null) return false;
	return v >= minPct;
}

/**
 * Tract qualifies for the user-defined non-TOD (control) cohort: optional max
 * stop-count ceiling plus non-TOD transit mode toggles.
 *
 * When ``nonTodMaxStops > 0``, a tract must satisfy **stops ≤ max**
 * (equal counts as control). When max is 0, no upper bound is applied.
 *
 * Parameters
 * ----------
 * tract : object
 * panelState : object
 *
 * Returns
 * -------
 * boolean
 */
export function isNonTodCohortTract(tract, panelState) {
	const nStops = Number(tract.transit_stops) || 0;
	const maxStops = panelState.nonTodMaxStops ?? 0;
	if (maxStops > 0 && nStops > maxStops) return false;
	const modes = panelState.nonTodTransitModes ?? panelState.transitModes;
	if (!tractMatchesTransitModes(tract, modes)) return false;
	return true;
}

/**
 * Tract qualifies for the TOD (analysis) cohort: ``isTodTract`` plus TOD mode toggles.
 *
 * Parameters
 * ----------
 * tract : object
 * panelState : object
 *
 * Returns
 * -------
 * boolean
 */
export function isTodCohortTract(tract, panelState) {
	if (!isTodTract(tract, panelState.todMinStops ?? 0)) return false;
	const modes = panelState.todTransitModes ?? panelState.transitModes;
	if (!tractMatchesTransitModes(tract, modes)) return false;
	return true;
}

/**
 * Census tracts in the analysis universe (overall filters only). Map, bar chart,
 * and MassBuilds aggregation use this set; TOD-dominated vs non-TOD-dominated
 * (significant development) highlights use ``getTodTracts`` / ``getNonTodTracts``
 * with MassBuilds TOD units and ``classifyTractDevelopment`` (see TOD Analysis).
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * panelState : object
 *
 * Returns
 * -------
 * Array<object>
 */
export function filterTractsByTract(tracts, panelState) {
	return tracts.filter((t) => passesTractUniverse(t, panelState));
}

/**
 * Test whether a tract qualifies as TOD under a given minimum stop count.
 *
 * When ``todMinStops > 0``, the tract must satisfy **transit_stops ≥ min**.
 * When min is 0, any tract with at least one MBTA stop in the buffer qualifies.
 *
 * Parameters
 * ----------
 * tract : object
 * todMinStops : number
 *     When > 0, the tract must meet or exceed this count.
 *     When 0, any tract with at least one transit stop qualifies.
 *
 * Returns
 * -------
 * boolean
 */
export function isTodTract(tract, todMinStops = 0) {
	const n = Number(tract.transit_stops) || 0;
	if (todMinStops > 0) return n >= todMinStops;
	return n > 0;
}

/**
 * Tracts classified as **TOD-dominated** (significant development with TOD share
 * at or above ``todFractionCutoff``). Uses ``buildTodAnalysisData`` and
 * ``classifyTractDevelopment`` — same rules as the TOD Analysis tab.
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * developments : Array<object>
 * panelState : object
 *
 * Returns
 * -------
 * Array<object>
 */
export function getTodDominatedTracts(tracts, developments, panelState) {
	const { filteredTracts, tractTodMetrics } = buildTodAnalysisData(
		tracts,
		developments,
		panelState
	);
	const sig = panelState.sigDevMinPctStockIncrease ?? 2;
	const cut = panelState.todFractionCutoff ?? 0.5;
	const out = [];
	for (const t of filteredTracts) {
		const m = tractTodMetrics.get(t.gisjoin);
		if (!m) continue;
		if (classifyTractDevelopment(m, sig, cut) === 'tod_dominated') out.push(t);
	}
	return out;
}

/**
 * Tracts with **significant** non-TOD-dominated development (above the stock
 * increase threshold but TOD share below ``todFractionCutoff``).
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * developments : Array<object>
 * panelState : object
 *
 * Returns
 * -------
 * Array<object>
 */
export function getNonTodDominatedSignificantTracts(tracts, developments, panelState) {
	const { filteredTracts, tractTodMetrics } = buildTodAnalysisData(
		tracts,
		developments,
		panelState
	);
	const sig = panelState.sigDevMinPctStockIncrease ?? 2;
	const cut = panelState.todFractionCutoff ?? 0.5;
	const out = [];
	for (const t of filteredTracts) {
		const m = tractTodMetrics.get(t.gisjoin);
		if (!m) continue;
		if (classifyTractDevelopment(m, sig, cut) === 'nontod_dominated') out.push(t);
	}
	return out;
}

/**
 * Alias for ``getTodDominatedTracts`` (bar chart / map / cohort summary).
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * panelState : object
 * developments : Array<object>
 *
 * Returns
 * -------
 * Array<object>
 */
export function getTodTracts(tracts, panelState, developments) {
	return getTodDominatedTracts(tracts, developments, panelState);
}

/**
 * Alias for ``getNonTodDominatedSignificantTracts``.
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * panelState : object
 * developments : Array<object>
 *
 * Returns
 * -------
 * Array<object>
 */
export function getNonTodTracts(tracts, panelState, developments) {
	return getNonTodDominatedSignificantTracts(tracts, developments, panelState);
}

/**
 * Tracts with **minimal development** (below significant stock-growth threshold or
 * indeterminate TOD share) — same rules as ``classifyTractDevelopment``.
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * developments : Array<object>
 * panelState : object
 *
 * Returns
 * -------
 * Array<object>
 */
export function getMinimalDevelopmentTracts(tracts, developments, panelState) {
	return buildCohortDevelopmentSplit(tracts, panelState, developments).minimal;
}

/**
 * Single ``buildTodAnalysisData`` pass: split universe tracts into TOD-dominated,
 * non-TOD-dominated (significant dev), and minimal-development cohorts.
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * panelState : object
 * developments : Array<object>
 *
 * Returns
 * -------
 * {{ tod: Array<object>, nonTod: Array<object>, minimal: Array<object>, nFiltered: number }}
 */
export function buildCohortDevelopmentSplit(tracts, panelState, developments) {
	if (!tracts?.length || !panelState?.timePeriod) {
		return { tod: [], nonTod: [], minimal: [], nFiltered: 0 };
	}
	const { filteredTracts, tractTodMetrics } = buildTodAnalysisData(
		tracts,
		developments ?? [],
		panelState
	);
	const sig = panelState.sigDevMinPctStockIncrease ?? 2;
	const cut = panelState.todFractionCutoff ?? 0.5;
	const tod = [];
	const nonTod = [];
	const minimal = [];
	for (const t of filteredTracts) {
		const m = tractTodMetrics.get(t.gisjoin);
		if (!m) continue;
		const cls = classifyTractDevelopment(m, sig, cut);
		if (cls === 'tod_dominated') tod.push(t);
		else if (cls === 'nontod_dominated') nonTod.push(t);
		else minimal.push(t);
	}
	return { tod, nonTod, minimal, nFiltered: filteredTracts.length };
}

/**
 * Population-weighted means and tract counts for one Y column given a cohort split.
 *
 * Parameters
 * ----------
 * split : {{ tod: Array<object>, nonTod: Array<object>, minimal: Array<object> }}
 * yKey : string
 * weightKey : string | null
 *
 * Returns
 * -------
 * object
 */
export function cohortYMeansForYKey(split, yKey, weightKey) {
	const { tod, nonTod, minimal } = split;
	const meanTod = computeGroupMean(tod, yKey, weightKey);
	const meanNonTod = computeGroupMean(nonTod, yKey, weightKey);
	const meanMinimal = computeGroupMean(minimal, yKey, weightKey);
	const countWithY = (arr) =>
		arr.filter((t) => t[yKey] != null && Number.isFinite(Number(t[yKey]))).length;
	return {
		meanTod,
		meanNonTod,
		meanMinimal,
		nTod: tod.length,
		nNonTod: nonTod.length,
		nMinimal: minimal.length,
		nTodWithY: countWithY(tod),
		nNonTodWithY: countWithY(nonTod),
		nMinimalWithY: countWithY(minimal)
	};
}

/**
 * Compute the (optionally population-weighted) mean of a Y variable.
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * yKey : string
 * weightKey : string | null
 *     Field on each tract to use as weight (e.g. ``pop_2010``). When null,
 *     falls back to an unweighted arithmetic mean.
 *
 * Returns
 * -------
 * number
 */
export function computeGroupMean(tracts, yKey, weightKey = null) {
	const pairs = tracts
		.filter((t) => t[yKey] != null)
		.map((t) => ({ y: Number(t[yKey]), w: weightKey ? (Number(t[weightKey]) || 0) : 1 }))
		.filter((p) => Number.isFinite(p.y) && p.w > 0);
	if (pairs.length === 0) return NaN;
	if (!weightKey) return d3.mean(pairs, (p) => p.y);
	const sumW = d3.sum(pairs, (p) => p.w);
	return sumW > 0 ? d3.sum(pairs, (p) => p.w * p.y) / sumW : NaN;
}

/**
 * Determine the population weight key for a time period.
 *
 * Parameters
 * ----------
 * timePeriod : string
 *
 * Returns
 * -------
 * string
 */
export function popWeightKey(timePeriod) {
	const { startY } = periodCensusBounds(timePeriod);
	return `pop_${startY}`;
}

/**
 * Housing-units weight key at period start (for TOD scatter dot sizing).
 *
 * Parameters
 * ----------
 * timePeriod : string
 *
 * Returns
 * -------
 * string
 */
export function huWeightKey(timePeriod) {
	const { startY } = periodCensusBounds(timePeriod);
	return `total_hu_${startY}`;
}

/**
 * Infer how to format numeric summaries from a Y-variable metadata label.
 *
 * Parameters
 * ----------
 * yVariableMeta : {{ label?: string } | null | undefined}
 *
 * Returns
 * -------
 * 'pp' | 'pct' | 'min'
 */
export function yMetricDisplayKind(yVariableMeta) {
	const label = yVariableMeta?.label ?? '';
	if (/\(pp\)/i.test(label)) return 'pp';
	if (/\(min\)/i.test(label)) return 'min';
	return 'pct';
}

/**
 * Format a single summary value for the cohort-average callout (matches Y-axis semantics).
 *
 * Parameters
 * ----------
 * value : number
 * kind : 'pp' | 'pct' | 'min'
 *
 * Returns
 * -------
 * string
 */
export function formatYMetricSummary(value, kind) {
	if (!Number.isFinite(value)) return '\u2014';
	const fmt = d3.format('.2f');
	if (kind === 'pp') return `${fmt(value)} pp`;
	if (kind === 'min') return `${fmt(value)} min`;
	return `${fmt(value)}%`;
}

/**
 * Population-weighted means of the active Y variable for TOD-dominated vs
 * non-TOD-dominated (significant development) cohorts.
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * panelState : {{ timePeriod: string, yVar: string }}
 * developments : Array<object>
 *     MassBuilds rows (same as dashboard store).
 * yVarOverride : string | null, optional
 *     When set, use this Y metric key instead of ``panelState.yVar`` (e.g. parallel income/education summaries).
 *
 * Returns
 * -------
 * {{ yKey: string, yLabel: string, weightKey: string, weightLabel: string,
 *     meanTod: number, meanNonTod: number, meanMinimal: number,
 *     nTod: number, nNonTod: number, nMinimal: number,
 *     nTodWithY: number, nNonTodWithY: number, nMinimalWithY: number } | null}
 */
export function cohortYMeansForPanel(tracts, panelState, developments, yVarOverride = null) {
	const yBase = yVarOverride ?? panelState?.yVar;
	if (!tracts?.length || !panelState?.timePeriod || !yBase) return null;
	const tp = panelState.timePeriod;
	const yKey = `${yBase}_${tp}`;
	const weightKey = popWeightKey(tp);
	const split = buildCohortDevelopmentSplit(tracts, panelState, developments);
	const m = cohortYMeansForYKey(split, yKey, weightKey);
	const { startY } = periodCensusBounds(tp);
	return {
		yKey,
		yBase,
		weightKey,
		weightLabel: `population in ${startY} (start of selected period)`,
		meanTod: m.meanTod,
		meanNonTod: m.meanNonTod,
		meanMinimal: m.meanMinimal,
		nTod: m.nTod,
		nNonTod: m.nNonTod,
		nMinimal: m.nMinimal,
		nTodWithY: m.nTodWithY,
		nNonTodWithY: m.nNonTodWithY,
		nMinimalWithY: m.nMinimalWithY
	};
}

/**
 * Population-weighted mean of the active Y for a user-chosen tract subset (same weights as
 * ``cohortYMeansForPanel`` / binned bar chart).
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * panelState : {{ timePeriod: string, yVar: string }}
 * selectedGisjoins : Set<string> | Iterable<string>
 * yVarOverride : string | null, optional
 *     When set, use this Y metric key instead of ``panelState.yVar``.
 *
 * Returns
 * -------
 * {{ mean: number, nSelected: number, nWithY: number, yKey: string, weightKey: string } | null}
 *     ``mean`` is NaN when no tracts are selected or none have finite Y; ``nSelected`` counts
 *     tracts in the subset (regardless of Y missingness).
 */
export function selectedTractsYWeightedMean(tracts, panelState, selectedGisjoins, yVarOverride = null) {
	const yBase = yVarOverride ?? panelState?.yVar;
	if (!tracts?.length || !panelState?.timePeriod || !yBase) return null;
	const tp = panelState.timePeriod;
	const yKey = `${yBase}_${tp}`;
	const weightKey = popWeightKey(tp);
	const set =
		selectedGisjoins instanceof Set ? selectedGisjoins : new Set(selectedGisjoins ?? []);
	if (set.size === 0) {
		return { mean: NaN, nSelected: 0, nWithY: 0, yKey, weightKey };
	}
	const selected = tracts.filter((t) => t.gisjoin && set.has(t.gisjoin));
	const mean = computeGroupMean(selected, yKey, weightKey);
	const nWithY = selected.filter(
		(t) => t[yKey] != null && Number.isFinite(Number(t[yKey]))
	).length;
	return { mean, nSelected: selected.length, nWithY, yKey, weightKey };
}

/**
 * Multifamily share of a MassBuilds project: (small + large multifamily units) / total units.
 *
 * Parameters
 * ----------
 * d : {{ hu?: number, smmultifam?: number, lgmultifam?: number }}
 *
 * Returns
 * -------
 * number | null
 *     Share in ``[0, 1]``, or ``null`` when ``hu`` is not positive.
 */
export function developmentMultifamilyShare(d) {
	const hu = Number(d.hu) || 0;
	if (hu <= 0) return null;
	const mf = (Number(d.smmultifam) || 0) + (Number(d.lgmultifam) || 0);
	return mf / hu;
}

/**
 * Affordable unit count for aggregation: cap ``affrd_unit`` at project ``hu``.
 *
 * MassBuilds sometimes lists more affordable units than total ``hu`` (field
 * mismatch in the source). Summing uncapped values can make tract-level
 * affordable units exceed new-unit totals; we cap per project so shares stay
 * in ``[0, 1]``.
 *
 * Parameters
 * ----------
 * d : {{ hu?: number, affrd_unit?: number }}
 *
 * Returns
 * -------
 * number
 *     Non-negative; at most ``hu`` when ``hu`` is positive.
 */
export function developmentAffordableUnitsCapped(d) {
	const hu = Number(d.hu) || 0;
	const aff = Number(d.affrd_unit) || 0;
	if (hu <= 0) return 0;
	return Math.min(aff, hu);
}

/**
 * Affordable share of a MassBuilds project: affordable units / total units.
 *
 * Parameters
 * ----------
 * d : {{ hu?: number, affrd_unit?: number }}
 *
 * Returns
 * -------
 * number | null
 *     Share in ``[0, 1]``, or ``null`` when ``hu`` is not positive.
 */
export function developmentAffordableShare(d) {
	const hu = Number(d.hu) || 0;
	if (hu <= 0) return null;
	return developmentAffordableUnitsCapped(d) / hu;
}

/**
 * Stage 2: filter individual developments by development-level criteria.
 *
 * Parameters
 * ----------
 * developments : Array<object>
 * panelState : object
 *
 * Returns
 * -------
 * Array<object>
 */
export function filterDevelopments(developments, panelState) {
	const tp = panelState.timePeriod;
	const minMfPct = Math.min(100, Math.max(0, Number(panelState.minDevMultifamilyRatioPct) || 0));
	const minAffPct = Math.min(100, Math.max(0, Number(panelState.minDevAffordableRatioPct) || 0));

	return developments.filter((d) => {
		if (!developmentMatchesPeriod(d, tp)) return false;
		if (d.hu < panelState.minUnitsPerProject) return false;

		if (minMfPct > 0) {
			const mfShare = developmentMultifamilyShare(d);
			if (mfShare == null || mfShare < minMfPct / 100) return false;
		}
		if (minAffPct > 0) {
			const affShare = developmentAffordableShare(d);
			if (affShare == null || affShare < minAffPct / 100) return false;
		}

		if (!panelState.includeRedevelopment && d.rdv) return false;

		return true;
	});
}

/**
 * Match a MassBuilds record to a dashboard period.
 *
 * The long window ``90_20`` uses ``completion_year`` (1990–2020 inclusive) so it
 * is not limited to decade bucket overlap with ``10_20`` (which includes 2021+).
 *
 * Parameters
 * ----------
 * d : {{ decade: string, completion_year?: number | null }}
 * tp : string
 *
 * Returns
 * -------
 * boolean
 */
export function developmentMatchesPeriod(d, tp) {
	if (d.decade === tp) return true;
	if (tp === '00_20') {
		const y = d.completion_year;
		return y != null && y >= 2000 && y <= 2020;
	}
	if (tp === '90_20') {
		const y = d.completion_year;
		return y != null && y >= 1990 && y <= 2020;
	}
	return false;
}

/**
 * Aggregate **filtered** developments by tract, producing X-axis values. The
 * caller passes only projects that passed ``filterDevelopments`` (min units,
 * multifamily/affordable ratio floors, redevelopment), so MassBuilds-derived
 * scatter/map X metrics reflect those choices. Census-based X fields on the tract
 * row are unaffected.
 *
 * Parameters
 * ----------
 * filteredDevs : Array<object>
 * tractMap : Map<string, object>
 *     gisjoin -> tract record (needed for ``total_hu_<year>`` base stock).
 * timePeriod : string
 *
 * Returns
 * -------
 * Map<string, object>
 *     gisjoin -> { new_units, new_singfam, new_sm_multifam, new_lg_multifam,
 *                  new_affordable, pct_stock_increase, tod_pct_stock_increase,
 *                  nontod_pct_stock_increase, multifam_share, affordable_share }.
 *     ``new_affordable`` sums ``min(affrd_unit, hu)`` per project (see
 *     ``developmentAffordableUnitsCapped``). TOD vs non-TOD split uses
 *     ``classifyDevTodUnits`` when ``panelState`` is passed (same rules as map/scatter).
 */
export function aggregateDevsByTract(filteredDevs, tractMap, timePeriod, panelState = null) {
	const { startY: baseYear } = periodCensusBounds(timePeriod);
	const result = new Map();

	let transitM = null;
	let minMfFrac = 0;
	if (panelState) {
		transitM = transitDistanceMiToMetres(panelState.transitDistanceMi ?? 0.5);
		minMfFrac = Math.max(0, Math.min(1, (Number(panelState.minDevMultifamilyRatioPct) || 0) / 100));
	}

	for (const d of filteredDevs) {
		const gj = d.gisjoin;
		if (!result.has(gj)) {
			result.set(gj, {
				new_units: 0,
				new_singfam: 0,
				new_sm_multifam: 0,
				new_lg_multifam: 0,
				new_affordable: 0,
				tod_new_units: 0,
				nontod_new_units: 0
			});
		}
		const agg = result.get(gj);
		agg.new_units += d.hu;
		agg.new_singfam += d.singfamhu;
		agg.new_sm_multifam += d.smmultifam;
		agg.new_lg_multifam += d.lgmultifam;
		agg.new_affordable += developmentAffordableUnitsCapped(d);
		if (panelState && transitM != null && Number.isFinite(transitM) && transitM > 0) {
			const { todUnits, nonTodUnits } = classifyDevTodUnits(d, transitM, minMfFrac);
			agg.tod_new_units += todUnits;
			agg.nontod_new_units += nonTodUnits;
		}
	}

	for (const [gj, agg] of result) {
		const tract = tractMap.get(gj);
		const baseStock = Number(tract?.[`total_hu_${baseYear}`]) || 0;
		agg.pct_stock_increase =
			baseStock > 0 ? +((agg.new_units / baseStock) * 100).toFixed(2) : null;
		if (panelState && baseStock > 0) {
			agg.tod_pct_stock_increase = +((agg.tod_new_units / baseStock) * 100).toFixed(2);
			agg.nontod_pct_stock_increase = +((agg.nontod_new_units / baseStock) * 100).toFixed(2);
		} else {
			agg.tod_pct_stock_increase = null;
			agg.nontod_pct_stock_increase = null;
		}
		agg.multifam_share =
			agg.new_units > 0
				? +((agg.new_sm_multifam + agg.new_lg_multifam) / agg.new_units).toFixed(3)
				: null;
		agg.affordable_share =
			agg.new_units > 0 ? +(agg.new_affordable / agg.new_units).toFixed(3) : null;
		const multifamUnits = agg.new_sm_multifam + agg.new_lg_multifam;
		agg.affordable_stock_pct =
			baseStock > 0 ? +((agg.new_affordable / baseStock) * 100).toFixed(2) : null;
		agg.multifam_stock_pct =
			baseStock > 0 ? +((multifamUnits / baseStock) * 100).toFixed(2) : null;
	}

	return result;
}

/**
 * Tract filters plus per-tract MassBuilds aggregates for the current period.
 *
 * ``devAgg`` uses only developments passing ``filterDevelopments`` (and lying
 * in filtered tracts), so **MassBuilds X-axis metrics** respond to those filters.
 * Census X metrics are read from tract rows and ignore development filters.
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * developments : Array<object>
 * panelState : object
 *
 * Returns
 * -------
 * { filteredTracts: Array<object>, devAgg: Map<string, object>, filteredDevs: Array<object> }
 */
export function buildFilteredData(tracts, developments, panelState) {
	const tractFiltered = filterTractsByTract(tracts, panelState);
	const tractSet = new Set(tractFiltered.map((t) => t.gisjoin));

	const tractMap = new Map();
	for (const t of tracts) {
		if (t.gisjoin) tractMap.set(t.gisjoin, t);
	}

	const devFiltered = filterDevelopments(developments, panelState).filter((d) =>
		tractSet.has(d.gisjoin)
	);

	const devAgg = aggregateDevsByTract(devFiltered, tractMap, panelState.timePeriod, panelState);

	return { filteredTracts: tractFiltered, devAgg, filteredDevs: devFiltered };
}

/**
 * Miles to metres (for MBTA nearest-stop distance thresholds).
 *
 * Parameters
 * ----------
 * mi : number
 *
 * Returns
 * -------
 * number
 */
export function transitDistanceMiToMetres(mi) {
	return (Number(mi) || 0) * 1609.344;
}

/**
 * Nearest-stop distance (m) and count of MBTA stops within ``radiusM`` (m).
 * Uses ``nearest_stop_dist_m`` from the pipeline when present; otherwise derives
 * distances from ``stops`` (``lat`` / ``lon``) on the client so tooltips and TOD
 * logic work even when static JSON omits server-side fields.
 *
 * Parameters
 * ----------
 * dev : object
 *     MassBuilds row with ``lat``, ``lon``, optional ``nearest_stop_dist_m``.
 * stops : Array<object>
 *     MBTA stops from ``mbta_stops.json`` (``lat``, ``lon``).
 * radiusM : number
 *     TOD radius in metres (e.g. from ``transitDistanceMiToMetres(panelState.transitDistanceMi)``).
 *
 * Returns
 * -------
 * {{ nearestDistM: number | null, stopsWithinRadius: number }}
 */
export function developmentMbtaProximity(dev, stops, radiusM) {
	const lat = Number(dev?.lat);
	const lon = Number(dev?.lon);
	const r = Number(radiusM);
	const radiusOk = Number.isFinite(r) && r >= 0 && r < 1e9;
	const serverDist = dev?.nearest_stop_dist_m;
	const sd = serverDist == null ? NaN : Number(serverDist);
	const useServerNearest = Number.isFinite(sd);

	if (!stops?.length) {
		return { nearestDistM: useServerNearest ? sd : null, stopsWithinRadius: 0 };
	}
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return { nearestDistM: useServerNearest ? sd : null, stopsWithinRadius: 0 };
	}

	let best = Infinity;
	let stopsWithinRadius = 0;
	for (const s of stops) {
		const slat = Number(s.lat);
		const slon = Number(s.lon);
		if (!Number.isFinite(slat) || !Number.isFinite(slon)) continue;
		const d = haversineDistanceMeters(lat, lon, slat, slon);
		if (!useServerNearest && d < best) best = d;
		if (radiusOk && d <= r) stopsWithinRadius += 1;
	}

	const nearestDistM = useServerNearest
		? sd
		: Number.isFinite(best) && best < Infinity
			? best
			: null;
	return { nearestDistM, stopsWithinRadius };
}

/**
 * Whether the nearest MBTA stop is within the transit-distance threshold (same rule as TOD unit classification).
 *
 * Parameters
 * ----------
 * dev : object
 *     Development row with optional ``nearest_stop_dist_m``.
 * transitDistanceM : number
 *     Maximum distance in metres to the nearest stop.
 *
 * Returns
 * -------
 * boolean
 */
export function isDevelopmentTransitAccessible(dev, transitDistanceM) {
	const transitM = Number(transitDistanceM);
	if (!Number.isFinite(transitM) || transitM <= 0) return false;
	const distRaw = dev?.nearest_stop_dist_m;
	const dist = distRaw == null ? NaN : Number(distRaw);
	return Number.isFinite(dist) && dist <= transitM;
}

/**
 * Classify MassBuilds units into TOD vs non-TOD for a single development.
 *
 * Transit-accessible developments (nearest stop within ``transitDistanceM``)
 * count multifamily units as TOD; all other units are non-TOD. Non-accessible
 * developments are entirely non-TOD.
 *
 * Parameters
 * ----------
 * dev : object
 *     Development row with ``hu``, ``smmultifam``, ``lgmultifam``, ``nearest_stop_dist_m``
 *     (from ``scripts/process_data.py``).
 * transitDistanceM : number
 *     Maximum distance in metres to nearest stop for accessibility.
 * minMultifamilyShare : number
 *     Minimum multifamily share ``(smmultifam + lgmultifam) / hu`` in ``[0, 1]`` for the
 *     project to contribute **any** TOD units. When ``> 0``, projects below this share
 *     are entirely non-TOD (matches the filter-panel “min multifamily %” rule for TOD classification).
 *
 * Returns
 * -------
 * {{ todUnits: number, nonTodUnits: number }}
 */
export function classifyDevTodUnits(dev, transitDistanceM, minMultifamilyShare = 0) {
	const hu = Number(dev.hu) || 0;
	if (hu <= 0) return { todUnits: 0, nonTodUnits: 0 };

	const dist = dev.nearest_stop_dist_m == null ? NaN : Number(dev.nearest_stop_dist_m);
	const accessible =
		Number.isFinite(dist) && Number.isFinite(transitDistanceM) && dist <= transitDistanceM;

	if (!accessible) {
		return { todUnits: 0, nonTodUnits: hu };
	}

	const minMf = Math.min(1, Math.max(0, Number(minMultifamilyShare) || 0));
	if (minMf > 0) {
		const mfShare = developmentMultifamilyShare(dev);
		if (mfShare == null || mfShare < minMf) {
			return { todUnits: 0, nonTodUnits: hu };
		}
	}

	const mf = (Number(dev.smmultifam) || 0) + (Number(dev.lgmultifam) || 0);
	const todUnits = Math.min(mf, hu);
	const nonTodUnits = hu - todUnits;
	return { todUnits, nonTodUnits };
}

/**
 * Census-based % housing stock increase for a tract and period.
 *
 * Parameters
 * ----------
 * tract : object
 * timePeriod : string
 *
 * Returns
 * -------
 * number | null
 */
export function censusPctStockIncrease(tract, timePeriod) {
	const { startY, endY } = periodCensusBounds(timePeriod);
	const huS = Number(tract[`total_hu_${startY}`]) || 0;
	const huE = Number(tract[`total_hu_${endY}`]) || 0;
	if (huS <= 0) return null;
	return +(((huE - huS) / huS) * 100).toFixed(4);
}

/**
 * Per-tract TOD development metrics for the TOD Analysis scatter plots.
 *
 * Uses only ``passesTractUniverse`` tracts (caller supplies the list). For each tract,
 * ``pctStockIncrease`` comes from census or filtered MassBuilds totals per
 * ``huChangeSource``. TOD fractions use MassBuilds development rows only.
 *
 * Parameters
 * ----------
 * filteredDevs : Array<object>
 * tractMap : Map<string, object>
 * universeTracts : Array<object>
 *     Tracts that passed the analysis universe (same order as plotted).
 * timePeriod : string
 * transitDistanceM : number
 * huChangeSource : 'census' | 'massbuilds'
 * minMultifamilyShare : number
 *     Same semantics as ``classifyDevTodUnits`` (typically ``panelState.minDevMultifamilyRatioPct / 100``).
 *
 * Returns
 * -------
 * Map<string, object>
 *     gisjoin -> metrics row.
 */
export function aggregateTractTodMetrics(
	filteredDevs,
	tractMap,
	universeTracts,
	timePeriod,
	transitDistanceM,
	huChangeSource,
	minMultifamilyShare = 0
) {
	const { startY } = periodCensusBounds(timePeriod);
	const byTract = new Map();

	for (const d of filteredDevs) {
		const gj = d.gisjoin;
		if (!byTract.has(gj)) {
			byTract.set(gj, {
				todUnits: 0,
				nonTodUnits: 0,
				totalNewUnits: 0,
				todAffordableUnits: 0
			});
		}
		const agg = byTract.get(gj);
		const { todUnits, nonTodUnits } = classifyDevTodUnits(
			d,
			transitDistanceM,
			minMultifamilyShare
		);
		const affCapped = developmentAffordableUnitsCapped(d);
		const todAff = Math.min(affCapped, todUnits);
		agg.todUnits += todUnits;
		agg.nonTodUnits += nonTodUnits;
		agg.totalNewUnits += Number(d.hu) || 0;
		agg.todAffordableUnits += todAff;
	}

	const result = new Map();
	const src = huChangeSource === 'census' ? 'census' : 'massbuilds';
	// Fix D: tracts with almost no baseline housing stock produce huge,
	// meaningless % increases from a single MassBuilds project (e.g. 1087%).
	// Treat ``pctStockIncrease`` as unavailable when the denominator is too
	// small to be reliable. 25 excludes obvious non-residential tracts while
	// keeping legitimate small-residential tracts. Tweak centrally here.
	const MIN_BASE_STOCK = 25;

	for (const tract of universeTracts) {
		const gj = tract.gisjoin;
		if (!gj) continue;

		const row = byTract.get(gj);
		const totalNewUnits = row ? row.totalNewUnits : 0;
		const todUnits = row ? row.todUnits : 0;
		const nonTodUnits = row ? row.nonTodUnits : 0;

		const baseStock = Number(tract[`total_hu_${startY}`]) || 0;
		const massbuildsPctStockIncrease =
			baseStock >= MIN_BASE_STOCK ? +((totalNewUnits / baseStock) * 100).toFixed(4) : null;
		const rawCensusPct = censusPctStockIncrease(tract, timePeriod);
		const censusPct =
			rawCensusPct != null && Number.isFinite(rawCensusPct) && baseStock >= MIN_BASE_STOCK
				? rawCensusPct
				: null;

		// ``pctStockIncrease`` follows the user-selected source for
		// backwards-compatible charts / scatterplot axes;
		// ``censusPctStockIncrease`` is always reported so the classifier can
		// cross-check (see Fix C in ``classifyTractDevelopment``).
		const pctStockIncrease = src === 'census' ? censusPct : massbuildsPctStockIncrease;

		const tot = todUnits + nonTodUnits;
		let todFraction = null;
		if (tot > 0) {
			todFraction = todUnits / tot;
		}

		let todAffordableFraction = null;
		if (todUnits > 0 && row) {
			todAffordableFraction = row.todAffordableUnits / todUnits;
		}

		result.set(gj, {
			todUnits,
			nonTodUnits,
			totalNewUnits,
			todFraction,
			pctStockIncrease,
			/** Census-derived stock growth (%), regardless of ``huChangeSource``. */
			censusPctStockIncrease: censusPct,
			/** MassBuilds-derived stock growth (%), regardless of ``huChangeSource``. */
			massbuildsPctStockIncrease,
			todAffordableUnits: row ? row.todAffordableUnits : 0,
			todAffordableFraction
		});
	}

	return result;
}

/**
 * Classify a tract into minimal-development / TOD-dominated / non-TOD-dominated development.
 *
 * Uses the selected ``pctStockIncrease`` source for the primary threshold,
 * and (when available on the metrics object) also requires the Census-measured
 * stock growth to be non-negative. This prevents the contradiction the tooltip
 * reported before: a tract marked "TOD-dominated" while its Census housing
 * stock had actually shrunk over the period (i.e. the MassBuilds additions
 * were offset by larger demolitions / conversions the dataset is not aware
 * of).
 *
 * Parameters
 * ----------
 * metrics : {{ pctStockIncrease: number | null, todFraction: number | null,
 *              censusPctStockIncrease?: number | null }}
 * sigDevThresholdPct : number
 * todFractionCutoff : number
 *
 * Returns
 * -------
 * 'minimal' | 'tod_dominated' | 'nontod_dominated'
 */
export function classifyTractDevelopment(metrics, sigDevThresholdPct, todFractionCutoff) {
	const p = metrics?.pctStockIncrease;
	const thr = Math.max(0, Number(sigDevThresholdPct) || 0);
	const cutRaw = Number(todFractionCutoff);
	const cut = Number.isFinite(cutRaw) ? Math.min(1, Math.max(0, cutRaw)) : 0.5;

	if (p == null || !Number.isFinite(p) || p < thr) {
		return 'minimal';
	}
	// Cross-check against Census-measured stock growth when it is available.
	// Tracts whose Census stock shrank are demoted to "minimal" even when
	// MassBuilds records additions, because the net effect on housing supply
	// was negative. (Missing Census data falls through as before.)
	const censusPct = metrics?.censusPctStockIncrease;
	if (censusPct != null && Number.isFinite(censusPct) && censusPct < 0) {
		return 'minimal';
	}
	const tf = metrics?.todFraction;
	if (tf == null || !Number.isFinite(tf)) {
		return 'minimal';
	}
	if (tf >= cut) return 'tod_dominated';
	return 'nontod_dominated';
}

/**
 * Tracts in the TOD Analysis universe: overall filters only (no legacy TOD cohort rules).
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * panelState : object
 *
 * Returns
 * -------
 * Array<object>
 */
export function filterTractsTodAnalysisUniverse(tracts, panelState) {
	return tracts.filter((t) => passesTractUniverse(t, panelState));
}

/**
 * Filtered tracts (universe-only) and per-tract TOD metrics for TOD Analysis charts.
 *
 * Parameters
 * ----------
 * tracts : Array<object>
 * developments : Array<object>
 * panelState : object
 *
 * Returns
 * -------
 * {{ filteredTracts: Array<object>, tractTodMetrics: Map, filteredDevs: Array<object> }}
 */
export function buildTodAnalysisData(tracts, developments, panelState) {
	const tractFiltered = filterTractsTodAnalysisUniverse(tracts, panelState);
	const tractSet = new Set(tractFiltered.map((t) => t.gisjoin));

	const tractMap = new Map();
	for (const t of tracts) {
		if (t.gisjoin) tractMap.set(t.gisjoin, t);
	}

	const devFiltered = filterDevelopments(developments, panelState).filter((d) =>
		tractSet.has(d.gisjoin)
	);

	const transitM = transitDistanceMiToMetres(panelState.transitDistanceMi ?? 0.5);
	const huSrc = panelState.huChangeSource === 'census' ? 'census' : 'massbuilds';
	const minMfShare = Math.min(
		1,
		Math.max(0, (Number(panelState.minDevMultifamilyRatioPct) || 0) / 100)
	);

	const tractTodMetrics = aggregateTractTodMetrics(
		devFiltered,
		tractMap,
		tractFiltered,
		panelState.timePeriod,
		transitM,
		huSrc,
		minMfShare
	);

	return { filteredTracts: tractFiltered, tractTodMetrics, filteredDevs: devFiltered };
}

/**
 * Resolve the X-axis value for a tract from the dev aggregation map.
 *
 * Parameters
 * ----------
 * gisjoin : string
 * xBase : string
 * devAgg : Map
 *
 * Returns
 * -------
 * number | null
 */
export function getXValue(gisjoin, xBase, devAgg) {
	if (!devAgg) return null;
	const agg = devAgg.get(gisjoin);
	if (!agg) return null;
	return agg[xBase] ?? null;
}

/**
 * Census housing stock percent change over ``timePeriod``:
 * ``100 * (HU_end − HU_start) / HU_start`` from decennial counts / ``census_hu_change_*``.
 *
 * Parameters
 * ----------
 * tract : object | null | undefined
 * timePeriod : string
 *     Panel period tag (e.g. ``'10_20'``, ``'00_20'``).
 *
 * Returns
 * -------
 * number
 *     Percent change, or ``NaN`` when net change or baseline stock is missing or baseline is zero.
 */
export function censusHuPctChangeForPeriod(tract, timePeriod) {
	if (!tract) return NaN;
	const { startY } = periodCensusBounds(timePeriod);
	let net = Number(tract[`census_hu_change_${timePeriod}`]);
	if (!Number.isFinite(net) && timePeriod === '00_20') {
		const hu0 = Number(tract.total_hu_2000);
		const hu1 = Number(tract.total_hu_2020);
		if (Number.isFinite(hu0) && Number.isFinite(hu1)) net = hu1 - hu0;
	}
	if (!Number.isFinite(net)) return NaN;
	const base = Number(tract[`total_hu_${startY}`]);
	if (!Number.isFinite(base) || base <= 0) return NaN;
	return (100 * net) / base;
}

/**
 * Scatter / bar X value: census fields on the tract row or MassBuilds aggregates in ``devAgg``.
 *
 * Parameters
 * ----------
 * tract : object | null | undefined
 * gisjoin : string
 * xBase : string
 *     Key from ``meta.xVariables``.
 * devAgg : Map<string, object>
 * timePeriod : string
 *     Panel period tag (e.g. ``'10_20'``).
 *
 * Returns
 * -------
 * number | null
 */
export function getScatterXValue(tract, gisjoin, xBase, devAgg, timePeriod) {
	if (xBase === 'census_hu_change') {
		if (!tract) return null;
		const v = censusHuPctChangeForPeriod(tract, timePeriod);
		return Number.isFinite(v) ? v : null;
	}
	return getXValue(gisjoin, xBase, devAgg);
}

/**
 * Drop points outside ``±k`` marginal standard deviations on X and on Y (means
 * and SDs from the full set). Intended to limit OLS leverage from extreme coordinates.
 *
 * If the filter would leave fewer than two points, returns the original array.
 *
 * Parameters
 * ----------
 * points : Array<{ x: number, y: number }>
 * k : number, optional
 *     Half-width in SD units; default ``10`` matches scatter axis trimming.
 *
 * Returns
 * -------
 * Array<{ x: number, y: number }>
 */
export function filterPointsTenSigmaMarginals(points, k = 10) {
	if (!points?.length || points.length <= 2) return points;
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const xMu = d3.mean(xs);
	const yMu = d3.mean(ys);
	const xVar = d3.variance(xs);
	const yVar = d3.variance(ys);
	const xSd = xVar != null && xVar > 0 ? Math.sqrt(xVar) : 0;
	const ySd = yVar != null && yVar > 0 ? Math.sqrt(yVar) : 0;
	const xOk = (v) => xSd <= 0 || (v >= xMu - k * xSd && v <= xMu + k * xSd);
	const yOk = (v) => ySd <= 0 || (v >= yMu - k * ySd && v <= yMu + k * ySd);
	const out = points.filter((p) => xOk(p.x) && yOk(p.y));
	if (out.length < 2) return points;
	return out;
}

/**
 * Ordinary least-squares line and coefficient of determination.
 *
 * Parameters
 * ----------
 * points : Array<{ x: number, y: number }>
 *
 * Returns
 * -------
 * { slope: number, intercept: number, r2: number }
 */
export function computeRegression(points) {
	const n = points.length;
	if (n < 2) return { slope: 0, intercept: 0, r2: 0 };

	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const xMean = d3.mean(xs);
	const yMean = d3.mean(ys);

	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		const dx = xs[i] - xMean;
		num += dx * (ys[i] - yMean);
		den += dx * dx;
	}
	const slope = den === 0 ? 0 : num / den;
	const intercept = yMean - slope * xMean;

	const ssTot = d3.sum(ys, (y) => (y - yMean) ** 2);
	const ssRes = d3.sum(points, (p) => {
		const pred = slope * p.x + intercept;
		return (p.y - pred) ** 2;
	});
	const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

	return { slope, intercept, r2 };
}

/**
 * Weighted least-squares line ``y ≈ slope * x + intercept`` and weighted R².
 * Matches tract-level weights used in cohort means and binned bars (e.g. population
 * at period start).
 *
 * Parameters
 * ----------
 * points : Array<{ x: number, y: number, w?: number }>
 *     Non-finite or non-positive ``w`` defaults to ``1``.
 *
 * Returns
 * -------
 * { slope: number, intercept: number, r2: number }
 */
export function computeWeightedRegression(points) {
	const n = points.length;
	if (n < 2) return { slope: 0, intercept: 0, r2: 0 };

	const ws = points.map((p) => {
		const w = Number(p.w);
		return Number.isFinite(w) && w > 0 ? w : 1;
	});
	const sumW = d3.sum(ws);
	if (!(sumW > 0)) return { slope: 0, intercept: 0, r2: 0 };

	const xwMean = d3.sum(points, (p, i) => ws[i] * p.x) / sumW;
	const ywMean = d3.sum(points, (p, i) => ws[i] * p.y) / sumW;

	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		const dx = points[i].x - xwMean;
		num += ws[i] * dx * (points[i].y - ywMean);
		den += ws[i] * dx * dx;
	}
	const slope = den === 0 ? 0 : num / den;
	const intercept = ywMean - slope * xwMean;

	let ssTot = 0;
	let ssRes = 0;
	for (let i = 0; i < n; i++) {
		const pred = slope * points[i].x + intercept;
		ssTot += ws[i] * (points[i].y - ywMean) ** 2;
		ssRes += ws[i] * (points[i].y - pred) ** 2;
	}
	const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

	return { slope, intercept, r2 };
}

/**
 * Quantile bins on X with population-weighted Y moments per bin.
 *
 * Each row may carry a ``w`` weight (e.g. population). When weights are present,
 * bin means and standard errors are population-weighted so that larger tracts
 * contribute proportionally more to the bar height.
 *
 * Parameters
 * ----------
 * rows : Array<{ x: number, y: number, w?: number, tract: object }>
 * nBins : number
 *
 * Returns
 * -------
 * Array<{ binLabel: string, xMid: number, xMin: number, xMax: number, yMean: number,
 *          ySE: number, count: number, totalPop: number }>
 */
export function computeBins(rows, nBins = 5) {
	const valid = rows.filter(
		(r) => Number.isFinite(r.x) && Number.isFinite(r.y) && (r.w == null || r.w > 0)
	);
	const n = valid.length;
	if (n === 0) return [];

	const sorted = [...valid].sort((a, b) => a.x - b.x);
	const binCount = Math.min(Math.max(1, nBins), n);
	const size = Math.ceil(n / binCount);
	const useWeights = valid.some((r) => r.w != null && r.w > 0);
	const out = [];

	for (let b = 0; b < binCount; b++) {
		const slice = sorted.slice(b * size, (b + 1) * size);
		if (slice.length === 0) continue;

		const xs = slice.map((r) => r.x);
		const ys = slice.map((r) => r.y);

		let yMean, ySE, totalPop;

		if (useWeights) {
			const ws = slice.map((r) => r.w || 1);
			const sumW = d3.sum(ws);
			totalPop = sumW;
			yMean = d3.sum(slice, (r, i) => ws[i] * ys[i]) / sumW;

			// Weighted variance: sum(w*(y-wm)^2) / sum(w)
			const wVar = d3.sum(slice, (r, i) => ws[i] * (ys[i] - yMean) ** 2) / sumW;
			// Effective sample size for unequal weights
			const nEff = (sumW * sumW) / d3.sum(ws, (w) => w * w);
			ySE = nEff > 1 ? Math.sqrt(wVar / nEff) : 0;
		} else {
			totalPop = 0;
			yMean = d3.mean(ys);
			const variance = d3.variance(ys);
			ySE = slice.length < 2 || variance === undefined ? 0 : Math.sqrt(variance / slice.length);
		}

		const xMid = d3.mean(xs);
		const lo = d3.min(xs);
		const hi = d3.max(xs);
		const fmt = d3.format('.1f');
		const binLabel = lo === hi ? fmt(lo) : `${fmt(lo)}\u2013${fmt(hi)}`;

		out.push({ binLabel, xMid, xMin: lo, xMax: hi, yMean, ySE, count: slice.length, totalPop });
	}

	return out;
}

/**
 * Assign each row's X to a bin index using inclusive ``[xMin, xMax]`` ranges from
 * ``computeBins`` output. When X falls in overlapping ranges (duplicate boundaries),
 * the lowest bin index wins.
 *
 * Parameters
 * ----------
 * x : number
 * bins : Array<{ xMin: number, xMax: number }>
 *
 * Returns
 * -------
 * number
 *     Bin index, or ``-1`` if outside all ranges.
 */
export function binIndexForX(x, bins) {
	if (!Number.isFinite(x) || !bins?.length) return -1;
	for (let i = 0; i < bins.length; i++) {
		const lo = bins[i].xMin;
		const hi = bins[i].xMax;
		if (x >= lo && x <= hi) return i;
	}
	return -1;
}

/**
 * Population-weighted Y mean and SE for rows assigned to each bin by X (same
 * ``xMin``/``xMax`` edges as reference bins).
 *
 * Parameters
 * ----------
 * rows : Array<{ x: number, y: number, w?: number }>
 * bins : Array<{ xMin: number, xMax: number }>
 *
 * Returns
 * -------
 * Array<{ yMean: number, ySE: number, count: number, totalPop: number }>
 *     One entry per reference bin (same length as ``bins``).
 */
export function computeBinnedMomentsForRows(rows, bins) {
	const perBin = bins.map(() => ({ slice: [] }));
	for (const r of rows) {
		if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
		const w = r.w == null || r.w > 0 ? r.w ?? 1 : 0;
		if (w <= 0) continue;
		const idx = binIndexForX(r.x, bins);
		if (idx < 0) continue;
		perBin[idx].slice.push({ y: r.y, w });
	}

	return perBin.map(({ slice }) => {
		const n = slice.length;
		if (n === 0) {
			return { yMean: NaN, ySE: NaN, count: 0, totalPop: 0 };
		}
		const ws = slice.map((r) => r.w || 1);
		const ys = slice.map((r) => r.y);
		const sumW = d3.sum(ws);
		const totalPop = sumW;
		const yMean = d3.sum(slice, (r, i) => ws[i] * ys[i]) / sumW;
		const wVar = d3.sum(slice, (r, i) => ws[i] * (ys[i] - yMean) ** 2) / sumW;
		const nEff = (sumW * sumW) / d3.sum(ws, (w) => w * w);
		const ySE = nEff > 1 ? Math.sqrt(wVar / nEff) : 0;
		return { yMean, ySE, count: n, totalPop };
	});
}

/**
 * Build a compact comparison metric bundle for one tract.
 *
 * Parameters
 * ----------
 * gisjoin : string
 * tractMap : Map<string, object>
 * nhgisRowByGj : Map<string, object>
 * tractTodMetricsMap : Map<string, object> | null
 * devAggMap : Map<string, object> | null
 * timePeriod : string
 *
 * Returns
 * -------
 * {{
 *   gisjoin: string,
 *   label: string,
 *   cohort: string | null,
 *   huGrowthPct: number | null,
 *   stockIncreasePct: number | null,
 *   todSharePct: number | null,
 *   affordableSharePct: number | null,
 *   incomeChangePct: number | null
 * } | null}
 */
export function buildTractComparisonMetrics(
	gisjoin,
	tractMap,
	nhgisRowByGj,
	tractTodMetricsMap,
	devAggMap,
	timePeriod
) {
	if (!gisjoin) return null;
	const tract = tractMap.get(gisjoin);
	const row = nhgisRowByGj.get(gisjoin);
	if (!tract && !row) return null;
	const tod = tractTodMetricsMap?.get(gisjoin) ?? null;
	const agg = devAggMap?.get(gisjoin) ?? null;
	const county = tract?.county && String(tract.county) !== 'County Name' ? String(tract.county) : null;
	return {
		gisjoin,
		label: county ? `Tract in ${county}` : `Tract ${gisjoin}`,
		cohort: row?.devClass ?? null,
		huGrowthPct: Number.isFinite(Number(row?.census_hu_pct_change))
			? Number(row.census_hu_pct_change)
			: null,
		stockIncreasePct: Number.isFinite(Number(tod?.pctStockIncrease))
			? Number(tod.pctStockIncrease)
			: null,
		todSharePct: Number.isFinite(Number(tod?.todFraction))
			? Number(tod.todFraction) * 100
			: null,
		affordableSharePct: Number.isFinite(Number(agg?.affordable_share))
			? Number(agg.affordable_share) * 100
			: null,
		incomeChangePct: Number.isFinite(Number(tract?.[`median_income_change_pct_${timePeriod}`]))
			? Number(tract[`median_income_change_pct_${timePeriod}`])
			: null
	};
}

/**
 * Find semantically related tracts for linked highlighting.
 *
 * Modes:
 * - ``cohort``: same development class as anchor.
 * - ``municipality``: same county label as anchor (best available locality grouping).
 * - ``similar_profile``: nearest tracts in normalized metric space.
 *
 * Parameters
 * ----------
 * anchorGisjoin : string | null
 * tractList : Array<object>
 * nhgisRows : Array<object>
 * tractTodMetricsMap : Map<string, object> | null
 * mode : 'cohort' | 'municipality' | 'similar_profile'
 * topK : number
 * timePeriod : string
 *
 * Returns
 * -------
 * Set<string>
 */
export function findRelatedTracts(
	anchorGisjoin,
	tractList,
	nhgisRows,
	tractTodMetricsMap,
	mode,
	topK,
	timePeriod
) {
	const out = new Set();
	if (!anchorGisjoin) return out;
	const tractByGj = new Map((tractList ?? []).map((t) => [t.gisjoin, t]));
	const rowByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
	const anchorTract = tractByGj.get(anchorGisjoin);
	const anchorRow = rowByGj.get(anchorGisjoin);
	if (!anchorTract && !anchorRow) return out;

	if (mode === 'cohort') {
		const cls = anchorRow?.devClass;
		if (!cls) return out;
		for (const r of nhgisRows ?? []) {
			if (r.gisjoin !== anchorGisjoin && r.devClass === cls) out.add(r.gisjoin);
		}
		return out;
	}

	if (mode === 'municipality') {
		const county =
			anchorTract?.county && String(anchorTract.county) !== 'County Name'
				? String(anchorTract.county)
				: null;
		if (!county) return out;
		for (const t of tractList ?? []) {
			if (t.gisjoin !== anchorGisjoin && String(t.county) === county) out.add(t.gisjoin);
		}
		return out;
	}

	const k = Math.max(1, Number(topK) || 4);
	const metricRows = [];
	for (const t of tractList ?? []) {
		const gj = t.gisjoin;
		if (!gj) continue;
		const r = rowByGj.get(gj);
		const m = tractTodMetricsMap?.get(gj);
		const v = {
			gisjoin: gj,
			huGrowthPct: Number.isFinite(Number(r?.census_hu_pct_change)) ? Number(r.census_hu_pct_change) : NaN,
			stockIncreasePct: Number.isFinite(Number(m?.pctStockIncrease)) ? Number(m.pctStockIncrease) : NaN,
			todSharePct: Number.isFinite(Number(m?.todFraction)) ? Number(m.todFraction) * 100 : NaN,
			incomeChangePct: Number.isFinite(Number(t[`median_income_change_pct_${timePeriod}`]))
				? Number(t[`median_income_change_pct_${timePeriod}`])
				: NaN
		};
		metricRows.push(v);
	}
	const anchor = metricRows.find((d) => d.gisjoin === anchorGisjoin);
	if (!anchor) return out;
	const keys = ['huGrowthPct', 'stockIncreasePct', 'todSharePct', 'incomeChangePct'];
	const stats = new Map();
	for (const key of keys) {
		const vals = metricRows.map((d) => d[key]).filter(Number.isFinite);
		const mu = d3.mean(vals);
		const sd = Math.sqrt(d3.variance(vals) || 0);
		stats.set(key, { mu, sd: sd > 0 ? sd : 1 });
	}
	const scored = [];
	for (const row of metricRows) {
		if (row.gisjoin === anchorGisjoin) continue;
		let dist2 = 0;
		let n = 0;
		for (const key of keys) {
			const a = anchor[key];
			const b = row[key];
			if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
			const { mu, sd } = stats.get(key);
			const za = (a - mu) / sd;
			const zb = (b - mu) / sd;
			dist2 += (za - zb) ** 2;
			n += 1;
		}
		if (n === 0) continue;
		scored.push({ gisjoin: row.gisjoin, score: Math.sqrt(dist2 / n) });
	}
	scored.sort((a, b) => a.score - b.score);
	for (const s of scored.slice(0, k)) out.add(s.gisjoin);
	return out;
}

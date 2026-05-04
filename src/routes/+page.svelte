<script>
	import { base } from '$app/paths';
	import * as d3 from 'd3';
	import {
		loadMunicipalData,
		filterMunicipalProjects,
		buildMunicipalityRows,
		activeRows as getActiveRows
	} from '$lib/utils/municipalModel.js';
	import {
		renderMuniScatter,
		renderMuniComposition,
		renderMuniGrowthCapture,
		renderMuniAffordableTrend
	} from '$lib/utils/municipalCharts.js';
	import { tractData, developments, meta } from '$lib/stores/data.svelte.js';
	import { loadStoryData } from '$lib/stores/data.svelte.js';
	import {
		DEFAULT_MAIN_POC_DEV_OPTS,
		DEFAULT_MAIN_POC_UNIVERSE,
		buildNhgisLikeRows,
		buildTractDevClassMap,
		filterDevelopmentsByYearRange,
		filterTractsForMainPoc,
		uniqueCounties
	} from '$lib/utils/mainPocTractModel.js';
	import { createPanelState } from '$lib/stores/panelState.svelte.js';
	import PocNhgisTractMap from '$lib/components/PocNhgisTractMap.svelte';
	import TodIntensityScatter from '$lib/components/TodIntensityScatter.svelte';
	import {
		buildCohortDevelopmentSplit,
		cohortYMeansForYKey,
		todAffordabilitySplitYMeans,
		popWeightKey,
		yMetricDisplayKind,
		formatYMetricSummary
	} from '$lib/utils/derived.js';
	import { MBTA_BLUE, MBTA_GREEN, MBTA_ORANGE } from '$lib/utils/mbtaColors.js';
	import TodAffordabilityScatter from '$lib/components/TodAffordabilityScatter.svelte';

	/** Minimal-cohort swatch: aligned with ``TodIntensityScatter`` / TOD map greys. */
	const GREY_MINIMAL = '#a8908c';

	/** Affordable TOD share split mini-bars: light blue (<50%) vs MBTA blue (≥50%). */
	const AFFORD_BAR_LO = '#93c5fd';
	const AFFORD_BAR_HI = MBTA_BLUE;

	/* ═══════════════════════════════════════════════════════
	   MUNICIPAL STATE (Part 1)
	   ═══════════════════════════════════════════════════════ */
	let muniLoaded = $state(false);
	let muniData = $state(/** @type {any} */ (null));

	let yearStart = $state(1990);
	let yearEnd = $state(2026);
	let threshold = $state(0.5);
	let growthScale = $state(/** @type {'units' | 'share'} */ ('units'));
	let showTrendline = $state(false);
	let dominanceFilter = $state(/** @type {'all' | 'tod' | 'nonTod'} */ ('all'));
	let zoning = $state(/** @type {Set<string>} */ (new Set()));
	let search = $state('');
	let selected = $state(/** @type {Set<string>} */ (new Set()));
	let mapMetric = $state(/** @type {string} */ ('units'));

	/* ── Derived municipal data ───────────────────────── */
	const muniState = $derived({
		yearStart,
		yearEnd,
		threshold,
		growthScale,
		showTrendline,
		dominanceFilter,
		zoning,
		search,
		selected,
		mapMetric
	});

	const projectRows = $derived.by(() => {
		if (!muniData) return [];
		return filterMunicipalProjects(muniData.projects, muniState);
	});

	const allProjectRows = $derived.by(() => {
		if (!muniData) return [];
		return filterMunicipalProjects(muniData.projects, muniState, false);
	});

	const visibleRows = $derived.by(() => {
		if (!muniData) return [];
		const rows = buildMunicipalityRows(
			projectRows,
			muniData.municipalityList,
			muniData.incomeByNorm,
			muniData.storyByNorm,
			muniData.householdByNorm,
			threshold,
			muniState
		);
		if (dominanceFilter === 'all') return rows;
		return rows.filter(
			(d) => dominanceFilter === 'tod' ? d.dominant === 'tod' : d.dominant !== 'tod'
		);
	});

	const domainRows = $derived.by(() => {
		if (!muniData) return [];
		return buildMunicipalityRows(
			allProjectRows,
			muniData.municipalityList,
			muniData.incomeByNorm,
			muniData.storyByNorm,
			muniData.householdByNorm,
			threshold,
			{ ...muniState, yearStart: 1990, yearEnd: 2026 },
			false
		);
	});

	const muniActive = $derived(getActiveRows(visibleRows, selected));

	/* ── Element refs (municipal) ─────────────────────── */
	let elScatter = $state(/** @type {HTMLElement | undefined} */ (undefined));
	let elComposition = $state(/** @type {HTMLElement | undefined} */ (undefined));
	let elGrowthCapture = $state(/** @type {HTMLElement | undefined} */ (undefined));
	let elAffordableTrend = $state(/** @type {HTMLElement | undefined} */ (undefined));

	function draw() {
		if (!muniData) return;
		const cb = { onSelectionChange: () => { selected = new Set(selected); } };
		if (elScatter) renderMuniScatter(elScatter, visibleRows, domainRows, muniState, cb);
		if (elComposition) renderMuniComposition(elComposition, projectRows, muniState);
		if (elAffordableTrend) renderMuniAffordableTrend(elAffordableTrend, projectRows, muniState);
		if (elGrowthCapture) renderMuniGrowthCapture(elGrowthCapture, projectRows, domainRows, muniState);
	}

	// Debounce draw during playback via rAF
	let rafId = 0;
	$effect(() => {
		void visibleRows;
		void domainRows;
		void projectRows;
		void muniActive;
		void mapMetric;
		void muniData;
		void elScatter;
		void elComposition;
		void elGrowthCapture;
		void elAffordableTrend;
		cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(() => draw());
	});

	/* ── Load municipal data on mount ─────────────────── */
	$effect(() => {
		loadMunicipalData(base).then((data) => {
			muniData = data;
			zoning = new Set(data.zoningOptions);
			muniLoaded = true;
		});
	});

	/* ═══════════════════════════════════════════════════════
	   TRACT STATE (Part 2)
	   ═══════════════════════════════════════════════════════ */
	let tractLoading = $state(true);
	let tractError = $state(/** @type {string | null} */ (null));
	let tractReady = $state(false);

	// Tract analysis defaults (sensible, no user controls)
	const tractTimePeriod = '00_20';
	const tractSigDevMin = 2;
	const tractTodFractionCutoff = 0.5;

	/** Map overlays + dev filters for ``PocNhgisTractMap`` (aligned with tract ``FilterPanel`` / ``MapView``). */
	const pocMapPanel = createPanelState('poc-main');

	$effect(() => {
		if (!tractReady) return;
		pocMapPanel.transitDistanceMi = threshold;
		pocMapPanel.timePeriod = tractTimePeriod;
		pocMapPanel.minStops = DEFAULT_MAIN_POC_UNIVERSE.minStops;
		pocMapPanel.sigDevMinPctStockIncrease = tractSigDevMin;
		pocMapPanel.todFractionCutoff = tractTodFractionCutoff;
		pocMapPanel.huChangeSource = 'massbuilds';
		pocMapPanel.minPopulation = DEFAULT_MAIN_POC_UNIVERSE.minPopulation;
		pocMapPanel.minPopDensity = DEFAULT_MAIN_POC_UNIVERSE.minPopDensity;
		pocMapPanel.minUnitsPerProject = DEFAULT_MAIN_POC_DEV_OPTS.minUnitsPerProject;
		pocMapPanel.minDevMultifamilyRatioPct = DEFAULT_MAIN_POC_DEV_OPTS.minDevMultifamilyRatioPct;
		pocMapPanel.minDevAffordableRatioPct = DEFAULT_MAIN_POC_DEV_OPTS.minDevAffordableRatioPct;
		pocMapPanel.includeRedevelopment = DEFAULT_MAIN_POC_DEV_OPTS.includeRedevelopment;
		pocMapPanel.showRailLines = true;
		pocMapPanel.showRailStops = true;
		pocMapPanel.showCommuterRailLines = true;
		pocMapPanel.showCommuterRailStops = true;
		pocMapPanel.showBusLines = false;
		pocMapPanel.showBusStops = false;
	});

	/** One-shot: avoid re-invoking ``loadStoryData`` if this ``$effect`` re-runs (Svelte 5 can re-execute). */
	let storyDataLoadInit = $state(false);
	$effect(() => {
		if (storyDataLoadInit) return;
		storyDataLoadInit = true;
		loadStoryData()
			.then(() => {
				tractReady = true;
				tractError = null;
			})
			.catch((e) => {
				tractError = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				tractLoading = false;
			});
	});

	const tractDevOpts = $derived({
		minUnitsPerProject: DEFAULT_MAIN_POC_DEV_OPTS.minUnitsPerProject,
		minDevMultifamilyRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevMultifamilyRatioPct,
		minDevAffordableRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevAffordableRatioPct,
		includeRedevelopment: DEFAULT_MAIN_POC_DEV_OPTS.includeRedevelopment
	});

	const tractCounties = $derived.by(() => {
		if (!tractData.length) return new Set();
		return new Set(uniqueCounties(tractData));
	});

	const tractListFiltered = $derived.by(() => {
		if (!tractData.length) return [];
		return filterTractsForMainPoc(tractData, tractCounties, '', {
			timePeriod: tractTimePeriod,
			minStops: DEFAULT_MAIN_POC_UNIVERSE.minStops,
			minPopulation: DEFAULT_MAIN_POC_UNIVERSE.minPopulation,
			minPopDensity: DEFAULT_MAIN_POC_UNIVERSE.minPopDensity
		});
	});

	const tractWindowDevs = $derived.by(() =>
		filterDevelopmentsByYearRange(developments, 1990, 2026, tractDevOpts)
	);

	const tractDevClassByGj = $derived.by(() =>
		buildTractDevClassMap(
			tractListFiltered,
			tractWindowDevs,
			{ timePeriod: tractTimePeriod, minStops: DEFAULT_MAIN_POC_UNIVERSE.minStops, minPopulation: DEFAULT_MAIN_POC_UNIVERSE.minPopulation, minPopDensity: DEFAULT_MAIN_POC_UNIVERSE.minPopDensity },
			threshold,
			tractDevOpts,
			tractSigDevMin,
			tractTodFractionCutoff
		)
	);

	// Always rebuild ``nhgisRows`` live from the current panel parameters so
	// the home-page map uses the same ``devClass`` definition as the playground.
	// (Previously a precomputed ``tract_story_rows.json`` was preferred here,
	// which was a static artifact that could diverge from the live classifier
	// and caused "TOD-dominated" badges on tracts showing 0% live TOD share.)
	const nhgisLikeRows = $derived.by(() =>
		buildNhgisLikeRows(tractListFiltered, tractDevClassByGj, tractTimePeriod)
	);

	const tractPanelConfig = $derived({
		timePeriod: tractTimePeriod,
		transitDistanceMi: threshold,
		sigDevMinPctStockIncrease: tractSigDevMin,
		todFractionCutoff: tractTodFractionCutoff,
		huChangeSource: 'massbuilds',
		minPopulation: DEFAULT_MAIN_POC_UNIVERSE.minPopulation,
		minPopDensity: DEFAULT_MAIN_POC_UNIVERSE.minPopDensity,
		minStops: DEFAULT_MAIN_POC_UNIVERSE.minStops,
		minUnitsPerProject: DEFAULT_MAIN_POC_DEV_OPTS.minUnitsPerProject,
		minDevMultifamilyRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevMultifamilyRatioPct,
		minDevAffordableRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevAffordableRatioPct,
		includeRedevelopment: DEFAULT_MAIN_POC_DEV_OPTS.includeRedevelopment
	});

	const cohortDevSplit = $derived.by(() => {
		if (!tractData.length || !developments.length) return { tod: [], nonTod: [], minimal: [] };
		return buildCohortDevelopmentSplit(tractData, tractPanelConfig, developments);
	});

	/**
	 * Display kind for a Y key when ``meta`` is not loaded yet: matches ``meta.json`` / ``yMetricDisplayKind`` rules.
	 *
	 * @param {string} vKey
	 * @returns {'pp' | 'pct' | 'min'}
	 */
	function yKindForStoryKey(vKey) {
		const v = meta.yVariables?.find((x) => x.key === vKey);
		if (v) return yMetricDisplayKind(v);
		if (vKey === 'bachelors_pct_change') return 'pp';
		if (vKey === 'median_income_change_pct') return 'pct';
		return 'pct';
	}

	/**
	 * Cohort means for a single story metric (independent of ``meta.yVariables`` being populated).
	 *
	 * @param {string} vKey
	 */
	function buildStoryCohortRow(vKey) {
		const weightKey = popWeightKey(tractTimePeriod);
		const yKey = `${vKey}_${tractTimePeriod}`;
		const raw = cohortYMeansForYKey(cohortDevSplit, yKey, weightKey);
		const kind = yKindForStoryKey(vKey);
		return {
			key: vKey,
			kind,
			meanTod: raw.meanTod,
			meanNonTod: raw.meanNonTod,
			meanMinimal: raw.meanMinimal,
			fmtTod: formatYMetricSummary(raw.meanTod, kind),
			fmtCtrl: formatYMetricSummary(raw.meanNonTod, kind),
			fmtMinimal: formatYMetricSummary(raw.meanMinimal, kind)
		};
	}

	const incomeRow = $derived(buildStoryCohortRow('median_income_change_pct'));
	const eduRow = $derived(buildStoryCohortRow('bachelors_pct_change'));

	/**
	 * Population-weighted means for TOD tracts with low vs high affordable share of TOD units
	 * (same dev metrics as ``TodAffordabilityScatter``; split at 50%).
	 *
	 * @param {string} vKey
	 */
	function buildAffordSplitStoryRow(vKey) {
		if (!tractData.length || !developments.length) return null;
		const weightKey = popWeightKey(tractTimePeriod);
		const yKey = `${vKey}_${tractTimePeriod}`;
		const raw = todAffordabilitySplitYMeans(
			tractData,
			tractPanelConfig,
			developments,
			yKey,
			0.5,
			weightKey
		);
		if (!raw) return null;
		const kind = yKindForStoryKey(vKey);
		return {
			...raw,
			kind,
			significantDiff: raw.significantDiff,
			fmtLo: formatYMetricSummary(raw.meanLo, kind),
			fmtHi: formatYMetricSummary(raw.meanHi, kind)
		};
	}

	const affIncomeSplit = $derived(buildAffordSplitStoryRow('median_income_change_pct'));
	const affEduSplit = $derived(buildAffordSplitStoryRow('bachelors_pct_change'));

	/**
	 * Layout for a three-cohort bar chart (same population-weighted means as body copy / scatter Y).
	 * Category axis (TOD / non-TOD / minimal) along the top; value scale increases downward. Default
	 * size and type from ``COHORT_MINI_BAR``.
	 *
	 * @param { { meanTod: number, meanNonTod: number, meanMinimal: number, kind: 'pp' | 'pct' | 'min' } | undefined } row
	 * @param {{ w?: number, h?: number }} [opts]
	 */
	const COHORT_MINI_BAR = { W: 402, H: 288, fs: 14, tickPad: 8, valueLabelyPad: 6, rx: 1.5 };

	/** Down-facing vertical bars: categories (x) along the top; y increases with value going downward. */
	function cohortMiniBarLayout(row, opts) {
		if (!row) return null;
		const W = opts?.w ?? COHORT_MINI_BAR.W;
		const H = opts?.h ?? COHORT_MINI_BAR.H;
		const m = { b: 28, r: 12, l: 54 };
		// Space above the plot for category labels; value scale occupies [valuePlotTop, H - m.b]
		const categoryLabelY = 20;
		const valuePlotTop = 32;
		const ih = H - valuePlotTop - m.b;
		// TOD / non-TOD / minimal: same MBTA green & orange as scatter & map; grey matches minimal-class outline
		const items = [
			{ id: 'tod', shortLabel: 'TOD', v: row.meanTod, fill: MBTA_GREEN },
			{ id: 'nontod', shortLabel: 'Non-TOD', v: row.meanNonTod, fill: MBTA_ORANGE },
			{ id: 'minimal', shortLabel: 'Minimal', v: row.meanMinimal, fill: GREY_MINIMAL }
		];
		const finite = items.filter((d) => Number.isFinite(d.v));
		if (finite.length === 0) return null;
		const minV = d3.min(finite, (d) => d.v) ?? 0;
		const maxV = d3.max(finite, (d) => d.v) ?? 0;
		const y0 = Math.min(0, minV);
		const y1 = Math.max(0, maxV);
		const span = y1 - y0;
		const pad = span > 0 ? span * 0.08 : 0.5;
		const yDomain = [y0 - pad, y1 + pad];
		const iw = W - m.l - m.r;
		const yScale = d3.scaleLinear().domain(yDomain).range([0, ih]);
		/** @param {number} v */
		const toPlotY = (v) => valuePlotTop + yScale(v);
		const y0px = toPlotY(0);
		const x = d3.scaleBand().domain(items.map((d) => d.id)).range([0, iw]).padding(0.22);
		const tickFmt =
			row.kind === 'pp'
				? d3.format('.1f')
				: row.kind === 'min'
					? d3.format('.1f')
					: d3.format('.0f');
		const yTicks = d3
			.ticks(yDomain[0], yDomain[1], 3)
			.filter((t) => t >= yDomain[0] - 1e-9 && t <= yDomain[1] + 1e-9);
		const bars = items.map((d) => {
			if (!Number.isFinite(d.v)) {
				return {
					...d,
					xPx: (x(d.id) ?? 0) + m.l,
					yPx: y0px,
					wPx: x.bandwidth(),
					hPx: 0,
					valueLabel: '—',
					valueLabelY: y0px + 6,
					valueLabelBaseline: /** @type {'middle'} */ ('middle')
				};
			}
			const yV = toPlotY(d.v);
			// Bar segment between zero and v; positive v → bar extends downward in SVG space
			const top = Math.min(y0px, yV);
			const hPx = Math.abs(yV - y0px);
			const valueLabel = formatYMetricSummary(d.v, row.kind);
			/** @type {'hanging' | 'alphabetic'} */
			const valueLabelBaseline = yV > y0px ? 'hanging' : 'alphabetic';
			const valueLabelY = yV > y0px ? yV + 2 : yV - 1;
			return {
				...d,
				xPx: (x(d.id) ?? 0) + m.l,
				yPx: top,
				wPx: x.bandwidth(),
				hPx,
				valueLabel,
				valueLabelY,
				valueLabelBaseline
			};
		});
		const yAxisTicks = yTicks.map((t) => ({
			t,
			yPx: toPlotY(t),
			label:
				row.kind === 'pp'
					? `${tickFmt(t)}`
					: row.kind === 'min'
						? `${tickFmt(t)}`
						: `${tickFmt(t)}%`
		}));
		return {
			W,
			H,
			m,
			mInner: iw,
			ih,
			valuePlotTop,
			plotBottom: valuePlotTop + ih,
			y0px,
			bars,
			yDomain,
			yAxisTicks,
			unitKind: row.kind,
			fontSize: COHORT_MINI_BAR.fs,
			tickTextPad: COHORT_MINI_BAR.tickPad,
			categoryLabelY,
			barRectRx: COHORT_MINI_BAR.rx
		};
	}

	const incomeMiniBar = $derived(cohortMiniBarLayout(incomeRow));
	const eduMiniBar = $derived(cohortMiniBarLayout(eduRow));

	/** Skinnier two-cohort bar chart: low vs high affordable TOD share (matches ``cohortMiniBarLayout`` geometry). */
	/* 1.5× the prior 140×248 geometry so affordability compare bars read more easily beside scatters. */
	const AFFORD_SPLIT_MINI = { W: 210, H: 372, fs: 16.5, tickPad: 9, rx: 2.25 };

	/**
	 * @param { { kind: 'pp' | 'pct' | 'min', meanLo: number, meanHi: number } | null | undefined } row
	 * @param {{ w?: number, h?: number }} [opts]
	 */
	function affordSplitMiniBarLayout(row, opts) {
		if (!row) return null;
		const W = opts?.w ?? AFFORD_SPLIT_MINI.W;
		const H = opts?.h ?? AFFORD_SPLIT_MINI.H;
		const m = { b: 36, r: 12, l: 66 };
		const categoryLabelY = 24;
		const valuePlotTop = 42;
		const ih = H - valuePlotTop - m.b;
		const items = [
			{ id: 'lo', shortLabel: '<50%', v: row.meanLo, errLo: row.ciLoMin, errHi: row.ciLoMax, fill: AFFORD_BAR_LO },
			{ id: 'hi', shortLabel: '≥50%', v: row.meanHi, errLo: row.ciHiMin, errHi: row.ciHiMax, fill: AFFORD_BAR_HI }
		];
		const finite = items.filter((d) => Number.isFinite(d.v));
		if (finite.length === 0) return null;
		const minV =
			d3.min(finite, (d) => (Number.isFinite(d.errLo) ? d.errLo : d.v)) ?? 0;
		const maxV =
			d3.max(finite, (d) => (Number.isFinite(d.errHi) ? d.errHi : d.v)) ?? 0;
		const y0 = Math.min(0, minV);
		const y1 = Math.max(0, maxV);
		const span = y1 - y0;
		const pad = span > 0 ? span * 0.08 : 0.5;
		const yDomain = [y0 - pad, y1 + pad];
		const iw = W - m.l - m.r;
		const yScale = d3.scaleLinear().domain(yDomain).range([0, ih]);
		/** @param {number} v */
		const toPlotY = (v) => valuePlotTop + yScale(v);
		const y0px = toPlotY(0);
		const x = d3.scaleBand().domain(items.map((d) => d.id)).range([0, iw]).padding(0.28);
		const tickFmt =
			row.kind === 'pp'
				? d3.format('.1f')
				: row.kind === 'min'
					? d3.format('.1f')
					: d3.format('.0f');
		const yTicks = d3
			.ticks(yDomain[0], yDomain[1], 3)
			.filter((t) => t >= yDomain[0] - 1e-9 && t <= yDomain[1] + 1e-9);
		const bars = items.map((d) => {
			if (!Number.isFinite(d.v)) {
				return {
					...d,
					xPx: (x(d.id) ?? 0) + m.l,
					yPx: y0px,
					wPx: x.bandwidth(),
					hPx: 0,
					valueLabel: '—',
					valueLabelY: y0px + 8,
					valueLabelBaseline: /** @type {'middle'} */ ('middle')
				};
			}
			const yV = toPlotY(d.v);
			const top = Math.min(y0px, yV);
			const hPx = Math.abs(yV - y0px);
			const valueLabel = formatYMetricSummary(d.v, row.kind);
			const errLoY = Number.isFinite(d.errLo) ? toPlotY(d.errLo) : null;
			const errHiY = Number.isFinite(d.errHi) ? toPlotY(d.errHi) : null;
			const errTop = errLoY != null && errHiY != null ? Math.min(errLoY, errHiY) : yV;
			const errBottom = errLoY != null && errHiY != null ? Math.max(errLoY, errHiY) : yV;
			/** @type {'hanging' | 'alphabetic'} */
			const valueLabelBaseline = yV > y0px ? 'hanging' : 'alphabetic';
			const valueLabelY = yV > y0px ? errBottom + 6 : errTop - 6;
			return {
				...d,
				xPx: (x(d.id) ?? 0) + m.l,
				yPx: top,
				wPx: x.bandwidth(),
				hPx,
				errLoY,
				errHiY,
				valueLabel,
				valueLabelY,
				valueLabelBaseline
			};
		});
		const yAxisTicks = yTicks.map((t) => ({
			t,
			yPx: toPlotY(t),
			label:
				row.kind === 'pp'
					? `${tickFmt(t)}`
					: row.kind === 'min'
						? `${tickFmt(t)}`
						: `${tickFmt(t)}%`
		}));
		return {
			W,
			H,
			m,
			mInner: iw,
			ih,
			valuePlotTop,
			plotBottom: valuePlotTop + ih,
			y0px,
			bars,
			yDomain,
			yAxisTicks,
			unitKind: row.kind,
			fontSize: AFFORD_SPLIT_MINI.fs,
			tickTextPad: AFFORD_SPLIT_MINI.tickPad,
			categoryLabelY,
			barRectRx: AFFORD_SPLIT_MINI.rx
		};
	}

	const affIncomeSplitBar = $derived(affordSplitMiniBarLayout(affIncomeSplit));
	const affEduSplitBar = $derived(affordSplitMiniBarLayout(affEduSplit));

	function makeTodScatterPanelState(yVar) {
		return {
			timePeriod: tractTimePeriod,
			yVar,
			transitDistanceMi: threshold,
			sigDevMinPctStockIncrease: tractSigDevMin,
			todFractionCutoff: tractTodFractionCutoff,
			huChangeSource: 'massbuilds',
			minPopulation: DEFAULT_MAIN_POC_UNIVERSE.minPopulation,
			minPopDensity: DEFAULT_MAIN_POC_UNIVERSE.minPopDensity,
			minStops: DEFAULT_MAIN_POC_UNIVERSE.minStops,
			minUnitsPerProject: DEFAULT_MAIN_POC_DEV_OPTS.minUnitsPerProject,
			minDevMultifamilyRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevMultifamilyRatioPct,
			minDevAffordableRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevAffordableRatioPct,
			includeRedevelopment: DEFAULT_MAIN_POC_DEV_OPTS.includeRedevelopment,
			trimOutliers: true,
			hoveredTract: null,
			selectedTracts: new Set(),
			setHovered(gisjoin) {
				this.hoveredTract = gisjoin;
			},
			clearSelection() {
				this.selectedTracts = new Set();
				this.hoveredTract = null;
			},
			setSelectedTracts(gisjoins) {
				this.selectedTracts = new Set(gisjoins);
				this.hoveredTract = null;
			},
			toggleTract(gisjoin) {
				const next = new Set(this.selectedTracts);
				if (next.has(gisjoin)) next.delete(gisjoin);
				else next.add(gisjoin);
				this.selectedTracts = next;
			}
		};
	}

	let incomePanelState = $state(makeTodScatterPanelState('median_income_change_pct'));
	let eduPanelState = $state(makeTodScatterPanelState('bachelors_pct_change'));
	let affIncomePanelState = $state(makeTodScatterPanelState('median_income_change_pct'));
	let affEduPanelState = $state(makeTodScatterPanelState('bachelors_pct_change'));

	const tractStoryExamples = $derived.by(() => {
		const rows = nhgisLikeRows
			.filter((row) => row.devClass === 'tod_dominated' && row.gisjoin)
			.map((row) => ({
				...row,
				incomeValue: Number(row.median_income_change_pct),
				eduValue: Number(row.bachelors_pct_change)
			}));

		const validIncome = rows.filter((row) => Number.isFinite(row.incomeValue));
		const validEdu = rows.filter((row) => Number.isFinite(row.eduValue));
		const lowerIncomeTod = validIncome.filter((row) => row.is_low_income);

		return {
			incomeLeaders: validIncome.slice().sort((a, b) => b.incomeValue - a.incomeValue).slice(0, 3),
			eduLeaders: validEdu.slice().sort((a, b) => b.eduValue - a.eduValue).slice(0, 3),
			lowerIncomeTod: lowerIncomeTod.slice().sort((a, b) => b.incomeValue - a.incomeValue).slice(0, 3)
		};
	});

	function setSelectedAcrossStoryCharts(gisjoins) {
		const ids = [...new Set(gisjoins.filter(Boolean))];
		incomePanelState.setSelectedTracts(ids);
		eduPanelState.setSelectedTracts(ids);
		affIncomePanelState.setSelectedTracts(ids);
		affEduPanelState.setSelectedTracts(ids);
	}

	function clearStoryChartSelections() {
		incomePanelState.clearSelection();
		eduPanelState.clearSelection();
		affIncomePanelState.clearSelection();
		affEduPanelState.clearSelection();
	}

	function describeExampleSet(rows, metricLabel) {
		if (!rows?.length) return '';
		const labels = rows.map((row) => row.county?.replace(/\s+County$/i, '')).filter(Boolean);
		const unique = [...new Set(labels)];
		const where = unique.length > 0 ? ` in ${unique.join(', ')}` : '';
		return `Highlight ${metricLabel}${where}.`;
	}

	/**
	 * Keep transit distance in sync with the municipal slider (``threshold``) without
	 * replacing the whole panel object. New objects force both ``TodIntensityScatter`` charts
	 * to tear down and rebuild D3 on every run — including extra effect runs on load — which
	 * dominated main-thread time; mutating ``transitDistanceMi`` is enough to refresh plots.
	 */
	$effect(() => {
		const t = threshold;
		incomePanelState.transitDistanceMi = t;
		eduPanelState.transitDistanceMi = t;
		affIncomePanelState.transitDistanceMi = t;
		affEduPanelState.transitDistanceMi = t;
	});
</script>

<div class="poc-root">
	<!-- Narrative + tract story up to "Explore" use a narrower column; Explore stays full poc-root width. -->
	<div class="poc-pre-explore">
	<section class="hero-full card">
		<div class="eyebrow">Guided Story</div>
		<h1>Massachusetts is building more near transit. Who benefits?</h1>
		<p class="byline">By Krishna Parvataneni, Allison Eto, Hanna Chen, and Supriya Lall</p>
		<p class="subtitle">
			If you rely on transit to reach work, school, or childcare, the real question is not just whether more housing is being built. It is whether that housing shows up in places people can actually reach and afford.
		</p>
		<p class="subtitle subtitle--secondary">
			<strong>This story tracks three things:</strong> where new housing is landing, whether it lines up with strong transit access, and what kinds of neighborhood change tend to appear in TOD-heavy places.
		</p>
		<p class="hero-plan-note">
			For methods, design choices, and the project plan:
			<a href={`${base}/writeup`}>open the full writeup</a>.
		</p>
	</section>

	<section class="story card story--signal">
		<h2>The main point</h2>
		<p class="signal-line">Housing growth and transit access do not line up as neatly as policy goals suggest.</p>
		<p class="signal-line">Some well-connected places are still adding little housing, while growth also shows up far from strong transit.</p>
		<p class="signal-line">Where TOD is strongest, affordability becomes the main equity test.</p>
	</section>

	{#if !muniLoaded}
		<div class="loading-status">
			<div class="spinner" aria-hidden="true"></div>
			<p>Loading municipal data…</p>
		</div>
	{:else}
	<section class="story card story--centered">
		<h2>How much new housing is actually transit-oriented?</h2>
		<p>
			TOD has grown over time, but it is still not the dominant pattern. A large share of new housing is still being built outside the strongest transit context.
		</p>
		<p class="chart-source">Source: MassBuilds development records, summarized by year and transit access.</p>

		<section class="chart-card card">
			<h3>TOD vs non-TOD mix by year</h3>
			<div class="chart-wrap small-chart" bind:this={elComposition}></div>
		</section>
	</section>

	<section class="card story-chart-panel story-chart-panel--stacked">
		<div class="story-chart-panel__grid">
			<div class="story-chart-panel__text">
				<h2>Who benefits from TOD?</h2>
				<p>
					The usual promise of TOD is more housing near good transit. But new housing does not automatically mean affordable housing. In recent years, affordability has lagged behind total production, which means transit-rich growth can still come with rising pressure.
				</p>
				<p class="chart-source">Source: MassBuilds unit counts and listed affordable-unit fields.</p>
			</div>
			<div class="story-chart-panel__chart">
				<h3>Most new housing is still market-rate</h3>
				<p class="chart-note">
					The affordable share rises occasionally, but for most years the bulk of new units are still market-rate.
				</p>
				<div class="chart-wrap small-chart compact-side-chart" bind:this={elAffordableTrend}></div>
			</div>
		</div>
	</section>

	<section class="card story-chart-panel story-chart-panel--stacked">
		<div class="story-chart-panel__grid">
			<div class="story-chart-panel__text">
				<h2>Where is development most concentrated?</h2>
				<p>
					This chart asks a simple question: when the region adds new housing, does it land more often in higher-income municipalities or in municipalities where more households are already below roughly middle-income levels?
				</p>
				<p class="chart-source">Source: MassBuilds development records and ACS income summaries, aggregated to municipalities.</p>
			</div>
			<div class="story-chart-panel__chart">
				<h3>For every 100 new units, where do they land?</h3>
				<p class="chart-note">
					Each housing icon is about one percent of all units added in the selected years. Fill color moves from higher-income municipalities to lower-income municipalities, based on the share of households earning under $125k. The outline shows whether that municipality sits above or below the regional midpoint.
				</p>
				<div class="chart-wrap small-chart compact-side-chart" bind:this={elGrowthCapture}></div>
			</div>
		</div>
	</section>

	<!-- <section class="story card">
		<h2>What is the status of TOD in Massachusetts?	</h2>
		<p class="chart-note">
			Despite policy efforts, most new housing being built in Massachusetts consists of non-TOD units. However, total development has increased over time,
			so the volume of TOD units has also been increasing. With the passage of the MBTA Communities Act, TOD is expected to become even more widespread,
			so it is important to understand the effects TOD has already had on the state.
		</p>
		<div class="guide-figures">
			<figure class="guide-figure card">
				<h3>Transit-oriented development is growing, but not always at the same pace as total housing growth</h3>
				<div class="chart-wrap small-chart" bind:this={elComposition}></div>
				<figcaption>
					We start here because it prevents an easy misunderstanding. The question is not whether TOD exists in Greater
					Boston. It clearly does. The question is whether new housing is consistently concentrating in the places with the
					strongest transit access. This figure shows that the answer is no: TOD makes up an important share of recent growth,
					but a large share of new units still lands outside the highest-access transit context.
				</figcaption>
			</figure>
			<figure class="guide-figure card">
				<h3>New housing growth is not only uneven, but socially uneven</h3>
				<div class="chart-wrap small-chart" bind:this={elGrowthCapture}></div>
				<figcaption>
					This figure moves from geography to stakes. It shows how much yearly growth is landing in municipalities with
					higher shares of households below $125k. That matters because the mismatch argument is not only about where growth
					is missing from transit-rich places. It is also about where growth pressure is landing, and who is more likely to
					be living there when that pressure arrives.
				</figcaption>
			</figure>
			<figure class="guide-figure card">
				<h3>Transit access and lower-income geography do not line up cleanly</h3>
				<div class="chart-wrap small-chart" bind:this={elScatter}></div>
				<figcaption>
					Here the point is comparison. Municipalities with larger lower-income shares do not map neatly onto the places with
					the strongest TOD share or the largest amount of new growth. That is why we do not stop at a regional summary. The
					map is needed next, because the tract scale shows where transit access, housing growth, and lower-income context
					line up, and where they begin to pull apart. The dashed gray lines mark the regional averages on each axis, so they
					help the reader see which municipalities sit above or below the typical lower-income share and above or below the
					typical level of housing growth.
				</figcaption>
			</figure>
		</div>
		<p class="chart-note chart-note--after-figures">
			Taken together, these views show the reader what to watch for once the map begins to zoom in. The question is not simply
			where transit is, or where growth is, but where those patterns stop lining up neatly, especially in places where lower-income
			households may have the most to gain from living near strong transit access.
		</p>
	</section> -->
	{/if}

	<!-- ═══════════════════════════════════════════════════════
	     PART 2 — TRACT ANALYSIS
	     ═══════════════════════════════════════════════════════ -->

	
	<section class="story card full-width">
		<p class="story-eyebrow">Why we zoom in</p>
		<h2>What to look for in the tract-level map</h2>
		<p>
			Municipal summaries help us see the regional pattern, but they smooth over a lot of local variation. Census tracts let us look more closely at where transit access is strongest, where housing growth is actually happening, and where signs of neighborhood change tend to appear.
		</p>
		<ul class="story-list">
			<li><strong>Median income change</strong>, a common warning sign for rising housing costs</li>
			<li><strong>Bachelor’s degree share change</strong>, a common warning sign for turnover or selective in-migration</li>
		</ul>
		<p class="chart-note">Read these as warning signs, not proof. Source: NHGIS / U.S. Census tract measures, MBTA stop access, and MassBuilds development records.</p>
	</section>
	
	<section class="tract-section">
		<section class="story card full-width story--framing">
			<div class="framing-grid">
				<div class="framing-block">
					<h2>Key definitions</h2>
					<p>
						<strong>TOD developments</strong> are projects within <strong>0.5 miles</strong> of an MBTA stop; all others are treated as
						<strong> non-TOD developments</strong>.
					</p>
					<p>
						<strong>TOD-dominated tracts</strong> get at least half of their filtered new units from TOD projects and clear a 2 percent housing-growth threshold. <strong>Non-TOD-dominated tracts</strong> also grow, but less of that growth is transit-oriented. <strong>Minimal-development tracts</strong> stay below the growth threshold.
					</p>
				</div>
				<div class="framing-block">
					<h2>Key assumptions</h2>
					<p>
						This walkthrough uses a fixed <strong>0.5-mile MBTA access threshold</strong> and compares tracts descriptively rather than causally.
					</p>
					<p>
						Mismatch categories depend on how each tract compares with the rest of the regional sample. In the walkthrough, tract averages are shown as tract-level comparisons rather than population-weighted totals.
					</p>
				</div>
			</div>
		</section>


		<!-- <section class="story card full-width">
			<h2>Guided walkthrough: where the mismatch appears</h2>
			<p>
				The map below is the guided part of the story. It introduces one layer at a time so the reader can see how transit
				access, housing growth, mismatch, and lower-income context build on one another. The point is not simply to identify
				where transit is strongest, but to notice where expected growth does not follow and where that has broader social
				consequences.
			</p>
			<ul class="story-list">
				<li><strong>First:</strong> establish the geography of strong MBTA access.</li>
				<li><strong>Then:</strong> compare that geography to where housing growth has actually occurred.</li>
				<li><strong>Then:</strong> isolate the mismatch layer, which is the core analytical claim.</li>
				<li><strong>Finally:</strong> bring in lower-income context to show why the mismatch matters beyond a purely spatial planning question.</li>
			</ul>
		</section> -->

		{#if tractLoading}
			<div class="loading-status">
				<div class="spinner" aria-hidden="true"></div>
				<p>Loading tract data…</p>
			</div>
		{:else if tractError}
			<div class="loading-status loading-status--error">
				<h3>Failed to load tract data</h3>
				<p>{tractError}</p>
			</div>
		{:else}
			<section class="chart-card card full-width chart-card--guided">
				<p class="story-eyebrow story-eyebrow--center">Guided map story</p>
				<h2 class="chart-card__headline">Transit access and new housing growth do not consistently align across Greater Boston tracts</h2>
				<p class="chart-note">
					The walkthrough moves from the full network to a closer Greater Boston view, then to tract examples, mismatch, projects, and lower-income context. Example cards use short names like <strong>“Tract in Suffolk County”</strong> for readability, and tooltips lead with the same takeaway before offering <strong>More info</strong>.
				</p>
				<div class="takeaway-strip" aria-label="Main takeaway from the guided map">
					<strong>Main takeaway:</strong> the region is adding housing, but not consistently in the places with the strongest transit access or in ways that clearly expand access for lower-income residents.
				</div>
				<div class="chart-wrap chart-tall chart-wrap--poc-map chart-wrap--poc-map--main-tall">
					<PocNhgisTractMap
						panelState={pocMapPanel}
						tractList={tractListFiltered}
						nhgisRows={nhgisLikeRows}
						metricsDevelopments={tractWindowDevs}
						guidedMode={true}
						choroplethMapHeight={645}
						showKeyFindings={true}
					/>
				</div>
			</section>

			<section class="story card">
				<h2>Three places to notice</h2>
				<p class="chart-note">
					These are quick anchors while you scroll. They are not the whole story, but they make the regional pattern easier to read.
				</p>
				<div class="annotation-grid">
					<div class="annotation-card">
						<h3>Boston and Cambridge</h3>
						<p>The strongest rapid-transit geography in the region, and the clearest version of the expected case: strong access and substantial growth in the same place.</p>
					</div>
					<div class="annotation-card">
						<h3>Quincy and Revere</h3>
						<p>Transit is still present here, but nearby tracts with similar access can still end up with different housing outcomes.</p>
					</div>
					<div class="annotation-card">
						<h3>Outer-ring tracts west of Boston</h3>
						<p>Some tracts far from the strongest MBTA access still show meaningful growth, revealing the other side of the mismatch story.</p>
					</div>
				</div>
			</section>


			<section class="story card">
				<h2>Comparing TOD-heavy and non-TOD-heavy tracts</h2>
				<p>
					To separate TOD from development more generally, we compare three tract groups from the map.
				</p>
				<ul class="story-list story-list--nested">
					<li>
						<strong>Minimal development tracts</strong> grew too little to anchor the main comparison.
					</li>
					<li>
						High-development tracts are then split in two:
						<ul>
							<li>
								<strong>TOD-dominated tracts</strong>, where TOD makes up at least half of new development.
							</li>
							<li>
								<strong>Non-TOD-dominated tracts</strong>, where it does not.
							</li>
						</ul>
					</li>
				</ul>
			</section>

			<section class="story card story--brief">
				<p class="story-eyebrow">What the tract charts are for</p>
				<h2>The next charts ask a simpler question</h2>
				<p>
					Once we separate TOD-heavy tracts from the rest, do they also show stronger signs of neighborhood change? The point is not to prove causation. It is to see whether the places absorbing more TOD also look different on income, education, and affordability.
				</p>
				<div class="takeaway-grid takeaway-grid--three">
					<div class="takeaway-card">
						<p class="takeaway-label">Income</p>
						<p class="takeaway-meta">TOD-heavy tracts tend to show larger median income increases.</p>
					</div>
					<div class="takeaway-card">
						<p class="takeaway-label">Education</p>
						<p class="takeaway-meta">They also tend to show larger increases in bachelor’s degree share.</p>
					</div>
					<div class="takeaway-card">
						<p class="takeaway-label">Affordability</p>
						<p class="takeaway-meta">Where a larger share of new units is affordable, those pressure signals are weaker.</p>
					</div>
				</div>
			</section>

			<section class="story card story--brief tract-interaction-card">
				<p class="story-eyebrow">Try the tract charts</p>
				<h2>Start with a few highlighted examples</h2>
				<p>
					Hover any point for the quick read. If you want a closer look, use these buttons to keep the same tracts highlighted across the charts below.
				</p>
				<div class="tract-interaction-controls" role="group" aria-label="Highlight tract examples in the demographic charts">
					<button
						type="button"
						class="chip-button"
						onclick={() => setSelectedAcrossStoryCharts(tractStoryExamples.incomeLeaders.map((row) => row.gisjoin))}
						disabled={!tractStoryExamples.incomeLeaders.length}
						title={describeExampleSet(tractStoryExamples.incomeLeaders, 'higher-income-change TOD tracts')}
					>
						Show income examples
					</button>
					<button
						type="button"
						class="chip-button"
						onclick={() => setSelectedAcrossStoryCharts(tractStoryExamples.eduLeaders.map((row) => row.gisjoin))}
						disabled={!tractStoryExamples.eduLeaders.length}
						title={describeExampleSet(tractStoryExamples.eduLeaders, 'higher-education-change TOD tracts')}
					>
						Show education examples
					</button>
					<button
						type="button"
						class="chip-button"
						onclick={() => setSelectedAcrossStoryCharts(tractStoryExamples.lowerIncomeTod.map((row) => row.gisjoin))}
						disabled={!tractStoryExamples.lowerIncomeTod.length}
						title={describeExampleSet(tractStoryExamples.lowerIncomeTod, 'lower-income TOD tracts')}
					>
						Show lower-income TOD examples
					</button>
					<button type="button" class="chip-button chip-button--subtle" onclick={clearStoryChartSelections}>
						Clear highlights
					</button>
				</div>
			</section>

			<!-- Income / education tract analysis (reinstated from earlier POC story layout) -->
			<div class="story-chart-row story-chart-row--tract full-width">
				<section class="story card story-chart-text">
					<h2>Where income is rising fastest</h2>
					<p>
						TOD-heavy tracts tend to show bigger income increases than the non-TOD comparison group.
					</p>
					<p>
						On average, income change is <strong>{incomeRow.fmtTod}</strong> in TOD-dominated tracts, versus <strong>{incomeRow.fmtCtrl}</strong> in non-TOD-dominated tracts.
					</p>
					<p class="chart-source">Source: NHGIS tract income measures and MassBuilds-derived TOD tract groupings.</p>
					{#if incomeMiniBar}
						<figure class="cohort-mini-bar">
							<svg
								width={incomeMiniBar.W}
								height={incomeMiniBar.H}
								viewBox="0 0 {incomeMiniBar.W} {incomeMiniBar.H}"
								role="img"
								aria-label="Bar chart: population-weighted mean median income change in percent for TOD-dominated, non-TOD-dominated, and minimal-development tracts, matching the summary values above."
							>
								<line
									x1={incomeMiniBar.m.l - 0.5}
									y1={incomeMiniBar.valuePlotTop}
									x2={incomeMiniBar.m.l - 0.5}
									y2={incomeMiniBar.plotBottom}
									stroke="#cbd5e1"
									stroke-width="1"
								/>
								{#each incomeMiniBar.yAxisTicks as tick (tick.t)}
									<line
										x1={incomeMiniBar.m.l}
										y1={tick.yPx}
										x2={incomeMiniBar.m.l + incomeMiniBar.mInner}
										y2={tick.yPx}
										stroke="#f1f5f9"
										stroke-width="1"
									/>
									<text
										x={incomeMiniBar.m.l - incomeMiniBar.tickTextPad}
										y={tick.yPx}
										text-anchor="end"
										dominant-baseline="middle"
										fill="var(--muted, #5e6573)"
										font-size={incomeMiniBar.fontSize}
									>
										{tick.label}
									</text>
								{/each}
								<line
									x1={incomeMiniBar.m.l}
									y1={incomeMiniBar.y0px}
									x2={incomeMiniBar.m.l + incomeMiniBar.mInner}
									y2={incomeMiniBar.y0px}
									stroke="#94a3b8"
									stroke-width="1"
									stroke-dasharray="3 2"
									opacity="0.85"
								/>
								{#each incomeMiniBar.bars as b (b.id)}
									<rect
										x={b.xPx}
										y={b.yPx}
										width={b.wPx}
										height={b.hPx}
										fill={b.fill}
										rx={incomeMiniBar.barRectRx}
									>
										<title
											>{b.shortLabel}: {formatYMetricSummary(b.v, incomeRow.kind)} (population-weighted mean)</title
										>
									</rect>
									<text
										x={b.xPx + b.wPx / 2}
										y={b.valueLabelY}
										text-anchor="middle"
										dominant-baseline={b.valueLabelBaseline}
										font-size={incomeMiniBar.fontSize}
										font-weight="600"
										fill="var(--ink, #1f2430)"
									>
										{b.valueLabel}
									</text>
								{/each}
								{#each incomeMiniBar.bars as b (b.id)}
									<text
										x={b.xPx + b.wPx / 2}
										y={incomeMiniBar.categoryLabelY}
										text-anchor="middle"
										dominant-baseline="middle"
										fill="var(--ink, #1f2430)"
										font-size={incomeMiniBar.fontSize}
									>
										{b.shortLabel}
									</text>
								{/each}
							</svg>
							<figcaption class="cohort-mini-bar__cap">
								Average change by tract group.
							</figcaption>
						</figure>
					{:else}
						<figure class="cohort-mini-bar cohort-mini-bar--empty">
							<p class="cohort-mini-bar__cap">
								Bar chart of population-weighted means will appear when tract data includes enough
								non-missing values for this metric.
							</p>
						</figure>
					{/if}

				</section>

				<section class="chart-card card story-chart-plot">
					<h3>More TOD often lines up with faster income change</h3>
					<p class="chart-note">
						Hover for a tract summary, or keep a few tracts highlighted with the buttons above. The main thing to notice is that tracts with more TOD tend to appear higher on the chart.
					</p>
					<div class="scatter-container scatter-container--compact">
						<TodIntensityScatter panelState={incomePanelState} wideLayout showTrimControl={false} storyMode />
					</div>
				</section>
			</div>

			<div class="story-chart-row story-chart-row--tract full-width">
				<section class="story card story-chart-text">
					<h2>Where education levels are rising fastest</h2>
					<p>
						TOD-dominated tracts also tend to show bigger increases in the share of adults with bachelor’s degrees or higher.
					</p>
					<p>
						The average change is <strong>{eduRow.fmtTod}</strong> in TOD-dominated tracts, compared with <strong>{eduRow.fmtCtrl}</strong> in non-TOD-dominated tracts.
					</p>
					<p class="chart-source">Source: NHGIS tract education measures and MassBuilds-derived TOD tract groupings.</p>
					{#if eduMiniBar}
						<figure class="cohort-mini-bar">
							<svg
								width={eduMiniBar.W}
								height={eduMiniBar.H}
								viewBox="0 0 {eduMiniBar.W} {eduMiniBar.H}"
								role="img"
								aria-label="Bar chart: population-weighted mean change in bachelor degree share (percentage points) for TOD-dominated, non-TOD-dominated, and minimal-development tracts, matching the summary values above."
							>
								<line
									x1={eduMiniBar.m.l - 0.5}
									y1={eduMiniBar.valuePlotTop}
									x2={eduMiniBar.m.l - 0.5}
									y2={eduMiniBar.plotBottom}
									stroke="#cbd5e1"
									stroke-width="1"
								/>
								{#each eduMiniBar.yAxisTicks as tick (tick.t)}
									<line
										x1={eduMiniBar.m.l}
										y1={tick.yPx}
										x2={eduMiniBar.m.l + eduMiniBar.mInner}
										y2={tick.yPx}
										stroke="#f1f5f9"
										stroke-width="1"
									/>
									<text
										x={eduMiniBar.m.l - eduMiniBar.tickTextPad}
										y={tick.yPx}
										text-anchor="end"
										dominant-baseline="middle"
										fill="var(--muted, #5e6573)"
										font-size={eduMiniBar.fontSize}
									>
										{tick.label}
									</text>
								{/each}
								<line
									x1={eduMiniBar.m.l}
									y1={eduMiniBar.y0px}
									x2={eduMiniBar.m.l + eduMiniBar.mInner}
									y2={eduMiniBar.y0px}
									stroke="#94a3b8"
									stroke-width="1"
									stroke-dasharray="3 2"
									opacity="0.85"
								/>
								{#each eduMiniBar.bars as b (b.id)}
									<rect
										x={b.xPx}
										y={b.yPx}
										width={b.wPx}
										height={b.hPx}
										fill={b.fill}
										rx={eduMiniBar.barRectRx}
									>
										<title
											>{b.shortLabel}: {formatYMetricSummary(b.v, eduRow.kind)} (population-weighted mean)</title
										>
									</rect>
									<text
										x={b.xPx + b.wPx / 2}
										y={b.valueLabelY}
										text-anchor="middle"
										dominant-baseline={b.valueLabelBaseline}
										font-size={eduMiniBar.fontSize}
										font-weight="600"
										fill="var(--ink, #1f2430)"
									>
										{b.valueLabel}
									</text>
								{/each}
								{#each eduMiniBar.bars as b (b.id)}
									<text
										x={b.xPx + b.wPx / 2}
										y={eduMiniBar.categoryLabelY}
										text-anchor="middle"
										dominant-baseline="middle"
										fill="var(--ink, #1f2430)"
										font-size={eduMiniBar.fontSize}
									>
										{b.shortLabel}
									</text>
								{/each}
							</svg>
							<figcaption class="cohort-mini-bar__cap">
								Average change by tract group.
							</figcaption>
						</figure>
					{:else}
						<figure class="cohort-mini-bar cohort-mini-bar--empty">
							<p class="cohort-mini-bar__cap">
								Summary: average change in bachelor's degree share (pp) for each tract category, weighted by population.
							</p>
						</figure>
					{/if}
				</section>

				<section class="chart-card card story-chart-plot">
					<h3>More TOD often lines up with bigger education gains</h3>
					<p class="chart-note">
						This chart tells a similar story. The highlighted tracts carry over, so it is easier to see whether the same places also sit higher on the education-change axis.
					</p>
					<div class="scatter-container scatter-container--compact">
						<TodIntensityScatter panelState={eduPanelState} wideLayout showTrimControl={false} storyMode />
					</div>
				</section>
			</div>

			<!-- <section class="chart-card card full-width">
				<h3>Income & education summary</h3>
				<p class="chart-note">
					Population-weighted means of income and education changes in the three groups of census tracts.
				</p>
				<div class="chart-wrap chart-wrap--tract-edu" bind:this={elTractEdu}></div>
			</section> -->

			<section class="story card full-width afford-compare">
				<h2>How affordability could help</h2>
				<p>
					Here we narrow the question. Among TOD-heavy tracts, do places with more affordable housing show weaker signs of market pressure?
				</p>
				{#if affIncomeSplit && affEduSplit}
					<p>
						The broad pattern is encouraging: TOD-heavy places with more affordability tend to show smaller increases in both income and college-degree share.
					</p>
				{/if}
				<p class="chart-source">Source: MassBuilds affordable-unit fields paired with NHGIS tract income and education change measures.</p>

				<div
					class="afford-comparison-stack"
					role="group"
					aria-label="Affordable TOD share: income and education scatters and cohort bars"
				>
					<div
						class="afford-metric-row"
						role="group"
						aria-label="Income change vs affordable TOD share"
					>
					<div class="afford-four-cell">
						<h3 class="afford-four-cell__title">Income Change vs Affordability</h3>
						<figure class="afford-scatter-embed-figure">
							<div class="scatter-container scatter-container--afford-embed">
								<TodAffordabilityScatter panelState={affIncomePanelState} showTrimControl={false} storyMode />
							</div>
							<figcaption class="cohort-mini-bar__cap">The same selected tracts stay highlighted here, so you can compare whether more affordability also lines up with smaller income increases.</figcaption>
						</figure>
					</div>
					<div class="afford-four-cell afford-four-cell--bar">
						<h3 class="afford-four-cell__title">Income Change Averages</h3>
						{#if affIncomeSplitBar && affIncomeSplit}
							<figure class="afford-split-mini-bar cohort-mini-bar">
								<svg
									width={affIncomeSplitBar.W}
									height={affIncomeSplitBar.H}
									viewBox="0 0 {affIncomeSplitBar.W} {affIncomeSplitBar.H}"
									role="img"
									aria-label="Bar chart: population-weighted mean income change in TOD tracts with below 50% vs at least 50% affordable TOD share."
								>
									<line
										x1={affIncomeSplitBar.m.l - 0.5}
										y1={affIncomeSplitBar.valuePlotTop}
										x2={affIncomeSplitBar.m.l - 0.5}
										y2={affIncomeSplitBar.plotBottom}
										stroke="#cbd5e1"
										stroke-width="1"
									/>
									{#each affIncomeSplitBar.yAxisTicks as tick (tick.t)}
										<line
											x1={affIncomeSplitBar.m.l}
											y1={tick.yPx}
											x2={affIncomeSplitBar.m.l + affIncomeSplitBar.mInner}
											y2={tick.yPx}
											stroke="#f1f5f9"
											stroke-width="1"
										/>
										<text
											x={affIncomeSplitBar.m.l - affIncomeSplitBar.tickTextPad}
											y={tick.yPx}
											text-anchor="end"
											dominant-baseline="middle"
											fill="var(--muted, #5e6573)"
											font-size={affIncomeSplitBar.fontSize}
										>
											{tick.label}
										</text>
									{/each}
									<line
										x1={affIncomeSplitBar.m.l}
										y1={affIncomeSplitBar.y0px}
										x2={affIncomeSplitBar.m.l + affIncomeSplitBar.mInner}
										y2={affIncomeSplitBar.y0px}
										stroke="#94a3b8"
										stroke-width="1"
										stroke-dasharray="3 2"
										opacity="0.85"
									/>
									{#each affIncomeSplitBar.bars as b (b.id)}
										<rect
											x={b.xPx}
											y={b.yPx}
											width={b.wPx}
											height={b.hPx}
											fill={b.fill}
											rx={affIncomeSplitBar.barRectRx}
										>
											<title
												>{b.shortLabel} affordable TOD share: {formatYMetricSummary(b.v, affIncomeSplit.kind)} (population-weighted mean)</title
											>
										</rect>
										{#if b.errLoY != null && b.errHiY != null}
											<line
												x1={b.xPx + b.wPx / 2}
												y1={b.errLoY}
												x2={b.xPx + b.wPx / 2}
												y2={b.errHiY}
												stroke="var(--ink, #1f2430)"
												stroke-width="1.5"
											/>
											<line
												x1={b.xPx + b.wPx * 0.25}
												y1={b.errLoY}
												x2={b.xPx + b.wPx * 0.75}
												y2={b.errLoY}
												stroke="var(--ink, #1f2430)"
												stroke-width="1.5"
											/>
											<line
												x1={b.xPx + b.wPx * 0.25}
												y1={b.errHiY}
												x2={b.xPx + b.wPx * 0.75}
												y2={b.errHiY}
												stroke="var(--ink, #1f2430)"
												stroke-width="1.5"
											/>
										{/if}
										<text
											x={b.xPx + b.wPx / 2}
											y={b.valueLabelY}
											text-anchor="middle"
											dominant-baseline={b.valueLabelBaseline}
											font-size={affIncomeSplitBar.fontSize}
											font-weight="600"
											fill="var(--ink, #1f2430)"
										>
											{b.valueLabel}{affIncomeSplit.significantDiff ? '*' : ''}
										</text>
									{/each}
									{#each affIncomeSplitBar.bars as b (b.id)}
										<text
											x={b.xPx + b.wPx / 2}
											y={affIncomeSplitBar.categoryLabelY}
											text-anchor="middle"
											dominant-baseline="middle"
											fill="var(--ink, #1f2430)"
											font-size={affIncomeSplitBar.fontSize}
										>
											{b.shortLabel}
										</text>
									{/each}
								</svg>
								<figcaption class="cohort-mini-bar__cap">
									Tracts w/ &lt;50% affordable units see larger avg. income increases.{affIncomeSplit.significantDiff ? ' * difference is statistically distinguishable.' : ''}
								</figcaption>
							</figure>
						{:else}
							<figure class="cohort-mini-bar cohort-mini-bar--empty">
								<p class="cohort-mini-bar__cap">Bars appear when enough TOD tracts have affordable-share data.</p>
							</figure>
						{/if}
					</div>
					</div>
					<div
						class="afford-metric-row"
						role="group"
						aria-label="Education change vs affordable TOD share"
					>
					<div class="afford-four-cell">
						<h3 class="afford-four-cell__title">Education Change vs Affordability</h3>
						<figure class="afford-scatter-embed-figure">
							<div class="scatter-container scatter-container--afford-embed">
								<TodAffordabilityScatter panelState={affEduPanelState} showTrimControl={false} storyMode />
							</div>
							<figcaption class="cohort-mini-bar__cap">The same comparison carries over here too: more affordability generally points toward smaller education change.</figcaption>
						</figure>
					</div>
					<div class="afford-four-cell afford-four-cell--bar">
						<h3 class="afford-four-cell__title">Education Change Averages</h3>
						{#if affEduSplitBar && affEduSplit}
							<figure class="afford-split-mini-bar cohort-mini-bar">
								<svg
									width={affEduSplitBar.W}
									height={affEduSplitBar.H}
									viewBox="0 0 {affEduSplitBar.W} {affEduSplitBar.H}"
									role="img"
									aria-label="Bar chart: population-weighted mean bachelors share change in TOD tracts with below 50% vs at least 50% affordable TOD share."
								>
									<line
										x1={affEduSplitBar.m.l - 0.5}
										y1={affEduSplitBar.valuePlotTop}
										x2={affEduSplitBar.m.l - 0.5}
										y2={affEduSplitBar.plotBottom}
										stroke="#cbd5e1"
										stroke-width="1"
									/>
									{#each affEduSplitBar.yAxisTicks as tick (tick.t)}
										<line
											x1={affEduSplitBar.m.l}
											y1={tick.yPx}
											x2={affEduSplitBar.m.l + affEduSplitBar.mInner}
											y2={tick.yPx}
											stroke="#f1f5f9"
											stroke-width="1"
										/>
										<text
											x={affEduSplitBar.m.l - affEduSplitBar.tickTextPad}
											y={tick.yPx}
											text-anchor="end"
											dominant-baseline="middle"
											fill="var(--muted, #5e6573)"
											font-size={affEduSplitBar.fontSize}
										>
											{tick.label}
										</text>
									{/each}
									<line
										x1={affEduSplitBar.m.l}
										y1={affEduSplitBar.y0px}
										x2={affEduSplitBar.m.l + affEduSplitBar.mInner}
										y2={affEduSplitBar.y0px}
										stroke="#94a3b8"
										stroke-width="1"
										stroke-dasharray="3 2"
										opacity="0.85"
									/>
									{#each affEduSplitBar.bars as b (b.id)}
										<rect
											x={b.xPx}
											y={b.yPx}
											width={b.wPx}
											height={b.hPx}
											fill={b.fill}
											rx={affEduSplitBar.barRectRx}
										>
											<title
												>{b.shortLabel} affordable TOD share: {formatYMetricSummary(b.v, affEduSplit.kind)} (population-weighted mean)</title
											>
										</rect>
										{#if b.errLoY != null && b.errHiY != null}
											<line
												x1={b.xPx + b.wPx / 2}
												y1={b.errLoY}
												x2={b.xPx + b.wPx / 2}
												y2={b.errHiY}
												stroke="var(--ink, #1f2430)"
												stroke-width="1.5"
											/>
											<line
												x1={b.xPx + b.wPx * 0.25}
												y1={b.errLoY}
												x2={b.xPx + b.wPx * 0.75}
												y2={b.errLoY}
												stroke="var(--ink, #1f2430)"
												stroke-width="1.5"
											/>
											<line
												x1={b.xPx + b.wPx * 0.25}
												y1={b.errHiY}
												x2={b.xPx + b.wPx * 0.75}
												y2={b.errHiY}
												stroke="var(--ink, #1f2430)"
												stroke-width="1.5"
											/>
										{/if}
										<text
											x={b.xPx + b.wPx / 2}
											y={b.valueLabelY}
											text-anchor="middle"
											dominant-baseline={b.valueLabelBaseline}
											font-size={affEduSplitBar.fontSize}
											font-weight="600"
											fill="var(--ink, #1f2430)"
										>
											{b.valueLabel}{affEduSplit.significantDiff ? '*' : ''}
										</text>
									{/each}
									{#each affEduSplitBar.bars as b (b.id)}
										<text
											x={b.xPx + b.wPx / 2}
											y={affEduSplitBar.categoryLabelY}
											text-anchor="middle"
											dominant-baseline="middle"
											fill="var(--ink, #1f2430)"
											font-size={affEduSplitBar.fontSize}
										>
											{b.shortLabel}
										</text>
									{/each}
								</svg>
								<figcaption class="cohort-mini-bar__cap">
									Tracts with &lt;50% affordable units see larger avg. education change.{affEduSplit.significantDiff ? ' * difference is statistically distinguishable.' : ''}
								</figcaption>
							</figure>
						{:else}
							<figure class="cohort-mini-bar cohort-mini-bar--empty">
								<p class="cohort-mini-bar__cap">Bars appear when enough TOD tracts have affordable-share data.</p>
							</figure>
						{/if}
					</div>
					</div>
				</div>
			</section>

			<section class="story card conclusion-card">
				<h2>What does this tell us?</h2>
				<p>
					TOD can still be a powerful housing strategy. But in this prototype, the places with the most transit-oriented growth also tend to show stronger signs of neighborhood change. That makes affordability less of an add-on and more of the core equity safeguard.
				</p>
			</section>

			<section class="story card recommendation-card">
				<p class="story-eyebrow">What planners could do with this</p>
				<h2>Planning implications from the patterns above</h2>
				<p>
					This prototype does not tell planners exactly what to build in every place. It does suggest a few practical ways to use transit, growth, and affordability data together.
				</p>
				<div class="recommendation-grid">
					<div class="recommendation-item">
						<h3>Target high-access, low-growth tracts first</h3>
						<p>
							Where the map shows strong transit access but little housing growth, planners could treat those tracts as priority areas for zoning review, public land review, or station-area housing strategies.
						</p>
					</div>
					<div class="recommendation-item">
						<h3>Measure TOD by affordability, not just unit count</h3>
						<p>
							If most new units near transit are still market-rate, then a TOD strategy should be evaluated partly by whether it expands access for lower-income households, not only by how many units it adds.
						</p>
					</div>
					<div class="recommendation-item">
						<h3>Watch for pressure where TOD is strongest</h3>
						<p>
							Income and education shifts do not prove displacement, but they can help flag places where growth near transit may need stronger affordability protections or anti-displacement tools.
						</p>
					</div>
					<div class="recommendation-item">
						<h3>Use tract-level monitoring alongside municipal goals</h3>
						<p>
							Municipal totals are useful, but the tract map shows why local variation matters. A city can meet broad production goals while still missing the tracts where transit-linked opportunity is strongest.
						</p>
					</div>
				</div>
			</section>
		{/if}
	</section>

	</div>

	{#if muniLoaded && !tractLoading && !tractError}
		<div class="explore-after-narrow">
			<section class="explore-gate card full-width" aria-labelledby="explore-gate-heading">
				<h2 id="explore-gate-heading">Explore the full map</h2>
				<p>
					The guided version above fixes the argument in place. The full map keeps the same data, but opens up all of the toggles and filters.
				</p>
				<p class="explore-gate__cta">
					<a class="explore-gate__button" href={`${base}/playground`}>Open the playground</a>
				</p>
			</section>

			<section class="story card full-width sources-card">
				<h2>Data sources and acknowledgments</h2>
				<p>
					This project combines tract-level census data, MBTA network geometry, and project-level housing development records. Together, those sources make it possible to compare housing growth, transit access, affordability, and neighborhood change in the same regional frame.
				</p>
				<ul class="story-list sources-list">
					<li>
						<strong>NHGIS / U.S. Census tract data:</strong> provides tract-level housing-unit counts, housing growth,
						median household income, income change, and other demographic measures that anchor both the choropleth and the
						lower-income context in the walkthrough.
					</li>
					<li>
						<strong>Tract geometry:</strong> census tract boundary geometries are used to draw the base choropleth, support
						linked tract selection, and make it possible to compare neighboring places directly on the map.
					</li>
					<li>
						<strong>MassBuilds development records:</strong> provide project-level unit counts, affordable-unit fields,
						multifamily share, completion year, and tract assignment. Those records drive the TOD / non-TOD tract grouping,
						the project-dot layer, and the examples used later in the guided story.
					</li>
					<li>
						<strong>HUD LIHTC match where available:</strong> supplements affordability information for some development
						records when affordable-unit data is not complete in the base project file, helping us say a little more about
						who may or may not benefit from new housing.
					</li>
					<li>
						<strong>MBTA stops and line geometry:</strong> provide the transit network used both for display and for
						calculating project proximity to transit and tract-level stop access, which is what makes the TOD and mismatch
						classifications possible.
					</li>
				</ul>
				<p>
					The current prototype also reflects repeated classroom feedback and revision. It was designed to lead with the planning question, then open out into exploration only after the main pattern is visible.
				</p>
			</section>
		</div>
	{/if}
</div>

<style>
	/* ── Warm editorial theme (matches static/municipal/index.html) ── */
	.poc-root {
		--bg: #f8f5ef;
		--paper: #fffefb;
		--ink: #1f2430;
		--muted: #5e6573;
		--line: #ddd7cb;
		--accent: #00843d;
		--accent-soft: #d8efe2;
		--warning: #ed8b00;
		--warning-soft: #fbe6cc;
		--blue-1: #edf4ff;
		--blue-2: #bfd6f6;
		--blue-3: #6fa8dc;
		--blue-4: #2f6ea6;
		--blue-5: #003da5;
		--shadow: 0 10px 24px rgba(31, 36, 48, 0.05);
		--radius: 18px;

		/* Light-mode tokens for embedded charts (TodIntensityScatter, D3) — darker than app :root dark theme */
		--text: #1f2430;
		--text-muted: #3d4a5c;
		--border: #b8b0a3;
		--bg-hover: #e8e0d4;
		--bg-card: #fffdf8;
		--cat-a: #006b32;
		--radius-sm: 6px;
		--shadow-sm: 0 4px 14px rgba(31, 36, 48, 0.12);

		/* mainPocTractCharts.js — same as MainPocTractDashboard warm theme */
		--mpc-ink: #1f2430;
		--mpc-muted: #454d5c;
		--mpc-line: #d8d2c7;
		--mpc-paper: #fffdf8;
		--mpc-bg: #f5f2eb;
		--mpc-accent: #00843d;
		--mpc-accent-soft: #d8efe2;
		--mpc-warning: #ed8b00;
		--mpc-blue5: #003da5;

		--poc-max-width: 1680px;

		font-family: var(--font-body);
		color: var(--ink);
		background: var(--bg);
		max-width: var(--poc-max-width);
		margin: 0 auto;
		padding: 18px 24px 44px;
	}

	/* 75% of the main column max width — keeps long-form narrative readable; explore map stays wide below. */
	.poc-pre-explore {
		max-width: calc(var(--poc-max-width) * 0.75);
		margin-inline: auto;
		width: 100%;
	}

	.explore-after-narrow {
		margin-top: 14px;
		display: grid;
		gap: 18px;
		max-width: 58rem;
		margin-inline: auto;
		width: 100%;
	}

	.explore-gate {
		padding: 20px 0 0;
		display: grid;
		gap: 10px;
		border-top: 1px solid rgba(120, 114, 102, 0.2);
		text-align: center;
	}

	.explore-gate h2 {
		margin: 0;
		font-size: 1.35rem;
		line-height: 1.15;
	}

	.explore-gate p {
		margin: 0;
		color: var(--muted);
		line-height: 1.62;
		max-width: 42rem;
		margin-inline: auto;
	}

	.explore-gate__cta {
		margin-top: 6px;
	}

	.explore-gate__button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 10px 16px;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		text-decoration: none;
		box-shadow: none;
	}

	.explore-gate__button:hover {
		background: #0a6a38;
	}

	.sources-card {
		margin-top: 6px;
		text-align: center;
	}

	.sources-card h2,
	.sources-card > p {
		max-width: 46rem;
		margin-inline: auto;
	}

	.sources-list {
		max-width: 50rem;
		margin-inline: auto;
		text-align: left;
	}

	* { box-sizing: border-box; }

	h1, h2, h3 {
		margin-top: 0;
		font-family: var(--font-body);
		font-weight: 700;
	}

	h1 {
		margin-bottom: 14px;
		font-size: clamp(2.6rem, 6vw, 4.7rem);
		line-height: 0.96;
		letter-spacing: -0.03em;
		max-width: 9.6ch;
		margin-inline: auto;
	}

	.card {
		background: transparent;
		border: 0;
		border-radius: 0;
		box-shadow: none;
	}

	/* ── Hero ─────────────────────────────────────────── */
	.hero-full {
		padding: clamp(12px, 2vw, 22px) 0 28px;
		margin-bottom: 18px;
		border-bottom: 1px solid rgba(120, 114, 102, 0.2);
		text-align: center;
	}

	.eyebrow {
		display: inline-block;
		margin-bottom: 12px;
		padding: 0;
		border-radius: 0;
		background: transparent;
		color: var(--accent);
		font-weight: 700;
		font-size: 0.78rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.byline {
		margin: 0 auto 14px;
		font-size: 0.95rem;
		font-weight: 600;
		line-height: 1.45;
		color: var(--ink);
		max-width: min(42rem, 92vw);
	}

	.subtitle {
		color: var(--muted);
		line-height: 1.72;
		margin: 0 auto;
		font-size: clamp(1.02rem, 1.8vw, 1.16rem);
		max-width: min(46rem, 92vw);
		margin-inline: auto;
	}

	.subtitle--secondary {
		margin-top: 12px;
		font-size: clamp(0.98rem, 1.6vw, 1.08rem);
	}

	/* ── Dashboard layout ─────────────────────────────── */
	.dashboard {
		display: grid;
		gap: 14px;
	}

	.controls-bar {
		padding: 14px 16px;
	}

	.controls-header {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: end;
		flex-wrap: wrap;
	}

	.controls-bar h2 { margin-bottom: 6px; font-size: 1.05rem; }
	.controls-note { color: var(--muted); line-height: 1.5; font-size: 0.9rem; margin: 0; }
	.controls-reset { white-space: nowrap; }

	.controls-grid,
	.advanced-grid {
		display: grid;
		gap: 12px;
	}

	.controls-grid {
		grid-template-columns: minmax(260px, 1.35fr) minmax(220px, 1fr) minmax(220px, 1fr);
		align-items: end;
		margin-top: 14px;
	}

	.advanced-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		margin-top: 14px;
	}

	.control-field {
		min-width: 0;
	}

	.control-field--range {
		max-width: 420px;
	}

	.control-block + .control-block {
		margin-top: 0;
		padding-top: 0;
		border-top: 0;
	}

	.label {
		display: block;
		margin-bottom: 8px;
		font-weight: 700;
		font-size: 0.9rem;
	}

	.range-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}

	.play-row {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.play-row button { flex: 0 0 auto; min-width: 92px; }

	.play-slider-wrap { flex: 1 1 auto; }
	.play-caption { margin-top: 6px; font-size: 0.84rem; color: var(--muted); }

	input[type="number"], select, input[type="search"] {
		width: 100%;
		padding: 9px 10px;
		border: 1px solid #c9c1b4;
		border-radius: 8px;
		background: #fff;
		color: var(--ink);
		font: inherit;
	}

	input[type="range"] { width: 100%; }

	.check-grid {
		display: grid;
		gap: 8px;
		max-height: 180px;
		overflow: auto;
		padding-right: 4px;
	}

	.check-item {
		display: flex;
		gap: 8px;
		align-items: start;
		font-size: 0.92rem;
		color: var(--muted);
		cursor: pointer;
	}

	.button-row, .preset-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	button {
		font: inherit;
		border: 1px solid #cfc6b8;
		border-radius: 8px;
		padding: 8px 12px;
		background: #fff;
		color: var(--ink);
		cursor: pointer;
		transition: background 120ms ease, border-color 120ms ease;
	}

	button.secondary {
		background: #fff;
		color: var(--ink);
	}

	button:hover {
		background: #faf7f0;
		border-color: #bdb3a4;
	}

	/* ── Content area ─────────────────────────────────── */
	.content {
		display: grid;
		gap: 14px;
	}

	.summary { padding: 16px; }

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 10px;
		margin: 12px 0;
	}

	.summary-stat {
		padding: 12px;
		border-radius: 10px;
		background: transparent;
		border: 1px solid var(--line);
	}

	.summary-stat .k {
		color: var(--muted);
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-weight: 700;
	}

	.summary-stat .v {
		margin-top: 6px;
		font-size: 1.7rem;
		font-weight: 800;
		letter-spacing: -0.03em;
	}

	.selection-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}

	.finding-list {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
		margin-top: 12px;
	}

	.finding-item {
		padding: 12px;
		border-radius: 10px;
		background: transparent;
		border: 1px solid var(--line);
	}

	.finding-kicker {
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		margin-bottom: 6px;
	}

	.finding-item p {
		color: var(--muted);
		line-height: 1.5;
		margin: 0;
	}

	.chip {
		padding: 5px 8px;
		border-radius: 8px;
		background: transparent;
		border: 1px solid var(--line);
		color: #433d34;
		font-size: 0.85rem;
		font-weight: 500;
	}

	/* ── Story / narrative cards ──────────────────────── */
	.story {
		padding: 24px 0;
		border-top: 1px solid rgba(120, 114, 102, 0.12);
	}

	.story h2 {
		font-size: 1.7rem;
		margin-bottom: 14px;
		letter-spacing: -0.01em;
		color: var(--ink);
		max-width: 32rem;
	}
	.story p {
		color: var(--muted);
		line-height: 1.72;
		margin-bottom: 14px;
		font-size: 1.03rem;
		max-width: 44rem;
	}
	.story p:last-child { margin-bottom: 0; }

	.story-eyebrow {
		margin: 0 0 10px;
		font-size: 0.74rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.story-eyebrow--center {
		text-align: center;
	}

	.story--brief h2 {
		max-width: 40rem;
	}

	.hero-plan-note {
		margin-top: 14px;
		font-size: 0.95rem;
		color: var(--muted);
	}

	.hero-plan-note a {
		color: var(--accent);
		font-weight: 700;
		text-decoration: none;
	}

	.hero-plan-note a:hover {
		text-decoration: underline;
	}

	.story-list {
		color: var(--muted);
		line-height: 1.68;
		padding-left: 22px;
		margin: 10px 0;
		list-style-position: outside;
		max-width: 42rem;
		font-size: 1.03rem;
	}

	.story-list li { margin-bottom: 6px; }

	.plan-section {
		scroll-margin-top: 24px;
	}

	.plan-grid {
		display: grid;
		gap: 14px;
		margin-top: 16px;
	}

	.plan-card {
		padding: 16px;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: #faf7f0;
	}

	.plan-card h3 {
		margin-bottom: 12px;
		font-size: 1.05rem;
	}

	.plan-block + .plan-people {
		margin-top: 14px;
		padding-top: 14px;
		border-top: 1px solid var(--line);
	}

	.plan-people {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}

	.plan-block h4,
	.plan-person h4,
	.plan-contingency h3 {
		margin-bottom: 8px;
		font-size: 0.95rem;
	}

	.plan-list {
		margin: 0;
	}

	.plan-contingency {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--line);
	}

	/* Nested methodology list: indent sub-bullets and leave space before the next paragraph */
	.story-list--nested {
		margin-bottom: 18px;
		padding-left: 1.5em;
	}

	.story-list--nested ul {
		margin-top: 8px;
		margin-bottom: 0;
		padding-left: 1.5em;
		list-style-position: outside;
	}

	.story-list--nested > li:last-child > ul > li:last-child {
		margin-bottom: 0;
	}

	.supplemental {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
	}

	.supplemental summary {
		cursor: pointer;
		font-weight: 700;
		color: var(--ink);
		list-style: none;
	}

	.supplemental summary::-webkit-details-marker {
		display: none;
	}

	.supplemental summary::before {
		content: '+';
		display: inline-block;
		margin-right: 8px;
		font-weight: 700;
		color: var(--accent);
	}

	.supplemental[open] summary::before {
		content: '–';
	}

	.supplemental-grid,
	.supplemental-card {
		margin-top: 14px;
	}

	/* ── Chart cards ──────────────────────────────────── */
	.chart-card { padding: 16px 0 0; }
	.chart-card {
		display: grid;
		justify-items: center;
		width: 100%;
	}

	.chart-card--guided {
		padding-bottom: 12px;
	}

	.chart-card__headline {
		font-size: 1.9rem;
		line-height: 1.15;
		margin: 0 0 10px;
		max-width: 44rem;
		text-align: center;
		letter-spacing: -0.02em;
	}

	.chart-card h2 { font-size: 1.15rem; margin-bottom: 8px; }
	.chart-card h3 {
		font-size: 1.18rem;
		margin-bottom: 10px;
		color: var(--ink);
		letter-spacing: -0.01em;
		text-align: center;
		max-width: 34rem;
	}

	.chart-note {
		color: var(--muted);
		line-height: 1.6;
		font-size: 0.93rem;
		margin-bottom: 10px;
		text-align: center;
		max-width: 42rem;
		margin-inline: auto;
	}

	.chart-source {
		margin: 8px auto 0;
		max-width: 42rem;
		font-size: 0.82rem;
		line-height: 1.45;
		color: color-mix(in srgb, var(--muted) 90%, white);
		text-align: center;
	}

	.takeaway-strip {
		max-width: 48rem;
		margin: 8px auto 16px;
		padding: 12px 14px;
		border-top: 1px solid rgba(15, 128, 64, 0.22);
		border-bottom: 1px solid rgba(15, 128, 64, 0.14);
		color: var(--ink);
		background: rgba(236, 247, 239, 0.44);
		line-height: 1.55;
		text-align: center;
	}

	.takeaway-grid--three {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.chart-toolbar {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.chart-toolbar select { width: auto; min-width: 210px; }

	.chart-wrap {
		position: relative;
		min-height: 420px;
		width: min(100%, 860px);
		margin-inline: auto;
	}

	.small-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 14px;
	}

	.small-chart { min-height: 320px; }
	.chart-tall { min-height: 560px; }

	/* Tract overview map: full width of card; map uses wheel capture so zoom stays on the map */
	.chart-wrap--poc-map {
		width: 100%;
		max-width: 100%;
		min-height: 560px;
	}

	/* Main story: taller choropleth (645px viewBox height vs 430px default) — keep playground at default. */
	.chart-wrap--poc-map--main-tall {
		min-height: 840px;
	}

	/* Cohort comparison chart: responsive height, scroll if needed */
	.chart-wrap--tract-edu {
		min-height: 0;
		max-height: min(78vh, 620px);
		overflow: auto;
	}

	.scatter-container {
		display: flex;
		justify-content: center;
		overflow-x: auto;
	}

	.scatter-container--compact {
		justify-content: flex-start;
		max-width: 100%;
	}

	/* Story + chart side-by-side */
	.story-chart-row {
		display: grid;
		gap: 14px;
		align-items: start;
	}

	/* Narrative + chart in one white card (municipal affordability & vulnerability) */
	.story-chart-panel {
		padding: 28px 0;
		border-top: 1px solid rgba(120, 114, 102, 0.14);
	}

	.story-card--embedded {
		margin-top: 12px;
		padding: 0;
		border: 0;
		background: transparent;
	}

	.story-chart-panel__grid {
		display: grid;
		gap: 18px;
		align-items: start;
		grid-template-columns: minmax(0, 1fr) minmax(300px, 1.05fr);
	}

	/* Stacked: narrative uses full card width; chart keeps prior right-column width (1fr : 1.05fr → 1.05/2.05 of row) */
	.story-chart-panel--stacked .story-chart-panel__grid {
		grid-template-columns: 1fr;
	}

	.story-chart-panel--stacked .story-chart-panel__text {
		width: 100%;
		max-width: 48rem;
		justify-self: stretch;
		text-align: center;
		margin-inline: auto;
	}

	.story-chart-panel--stacked .story-chart-panel__chart {
		width: min(100%, 920px);
		margin-inline: auto;
	}

	.story-chart-panel__text h2 {
		font-size: clamp(1.8rem, 2vw, 2.15rem);
		margin-bottom: 16px;
		max-width: 36rem;
		margin-inline: auto;
		line-height: 1.12;
	}

	.story-chart-panel__text p {
		color: var(--muted);
		line-height: 1.68;
		margin-bottom: 14px;
		font-size: 1.05rem;
		max-width: 42rem;
		margin-inline: auto;
	}

	.story-chart-panel__text p:last-child {
		margin-bottom: 0;
	}

	.story-chart-panel__chart {
		width: 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.story-chart-panel__chart h3 {
		font-size: 1.25rem;
		margin-bottom: 12px;
		color: var(--ink);
		text-align: center;
		line-height: 1.2;
	}

	.story-chart-panel__chart .chart-wrap.small-chart.compact-side-chart {
		flex: 0 0 auto;
		min-height: 360px;
		height: auto;
		width: 100%;
	}

	.story-chart-panel .compact-side-chart :global(svg) {
		display: block;
		width: 100%;
		height: auto;
	}

	/* Tract TOD scatters: wider copy column, plot slightly narrower than before */
	.story-chart-row--tract {
		grid-template-columns: minmax(0, 0.36fr) minmax(0, 0.64fr);
		align-items: start;
		justify-items: center;
	}

	.story-chart-row--tract .story-chart-text {
		max-width: 40em;
		justify-self: center;
	}

	.tract-interaction-card {
		text-align: center;
		max-width: 52rem;
		margin-inline: auto;
	}

	.tract-interaction-controls {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 10px;
		margin-top: 16px;
	}

	.chip-button {
		border: 1px solid rgba(0, 132, 61, 0.22);
		background: rgba(0, 132, 61, 0.07);
		color: var(--ink);
		padding: 9px 14px;
		border-radius: 999px;
		font: inherit;
		font-size: 0.92rem;
		font-weight: 600;
		line-height: 1.2;
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
	}

	.chip-button:hover:not(:disabled) {
		background: rgba(0, 132, 61, 0.12);
		border-color: rgba(0, 132, 61, 0.34);
	}

	.chip-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.chip-button--subtle {
		background: rgba(31, 36, 48, 0.04);
		border-color: rgba(31, 36, 48, 0.12);
	}

	.chip-button--subtle:hover:not(:disabled) {
		background: rgba(31, 36, 48, 0.08);
		border-color: rgba(31, 36, 48, 0.18);
	}

	.story-chart-row--tract .story-chart-plot {
		max-width: 100%;
		width: 100%;
		justify-self: center;
	}

	.story-chart-text {
		margin: 0;
		max-width: 34em;
	}

	/* Compact cohort means bar: mirrors population-weighted values in the paragraph and scatter */
	.cohort-mini-bar {
		margin: 12px 0 0;
		max-width: 420px;
	}

	.cohort-mini-bar svg {
		display: block;
		max-width: 100%;
		height: auto;
	}

	.cohort-mini-bar__cap {
		font-size: 0.75rem;
		color: var(--muted);
		margin: 6px 0 0;
		line-height: 1.45;
	}

	.story-chart-plot {
		min-width: 0;
	}

	.story-chart-plot h3 {
		font-size: 1.12rem;
		color: var(--ink);
	}

	.story-chart-row--tract .scatter-container--compact {
		width: 100%;
	}

	@media (max-width: 920px) {
		.controls-grid,
		.advanced-grid {
			grid-template-columns: 1fr;
		}

		.finding-list,
		.plan-people,
		.story-chart-panel__grid,
		.story-chart-row--tract {
			grid-template-columns: 1fr;
		}

		.story-chart-panel .compact-side-chart {
			max-height: none;
			min-height: 260px;
		}

		.takeaway-grid--three {
			grid-template-columns: 1fr;
		}
	}

	.story--signal,
	.story--centered,
	.hero-full,
	.story-chart-panel--stacked {
		text-align: center;
	}

	.story--signal h2,
	.story--signal p,
	.story--centered h2,
	.story--centered p {
		margin-inline: auto;
	}

	.signal-line {
		max-width: 48rem;
	}

	.story.card.full-width > h2,
	.story.card.full-width > p,
	.story.card.full-width > ul {
		max-width: 52rem;
		margin-inline: auto;
	}

	.story.card.full-width > h2 {
		font-size: clamp(1.75rem, 2vw, 2.05rem);
		line-height: 1.14;
		margin-bottom: 14px;
		text-align: center;
	}

	.story.card.full-width > p {
		text-align: center;
		line-height: 1.7;
	}

	.story.card.full-width > ul {
		text-align: left;
	}

	:global(.poc-root .mpc-map-zoom-hint) {
		font-size: 0.78rem;
		color: var(--muted);
		margin: 8px 0 0;
		line-height: 1.45;
	}

	:global(.poc-root .mpc-tract-edu-legend) {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 20px;
		align-items: center;
		margin-bottom: 6px;
		font-size: 0.82rem;
		color: var(--muted);
	}

	:global(.poc-root .mpc-tract-edu-legend-item) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	:global(.poc-root .mpc-tract-edu-swatch) {
		width: 11px;
		height: 11px;
		border-radius: 2px;
		flex-shrink: 0;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
	}

	/* TodIntensityScatter: readable tooltip on warm background */
	:global(.poc-root .tod-intensity-wrap .scatter-tooltip) {
		color: var(--ink);
		border-color: var(--line);
		box-shadow: var(--shadow-sm);
	}

	/* ── Tooltip & legend (global for D3 injected elements) ── */
	:global(.poc-root .tooltip) {
		position: absolute;
		pointer-events: none;
		opacity: 0;
		background: rgba(20, 24, 31, 0.94);
		color: #fff;
		padding: 10px 12px;
		border-radius: 10px;
		font-size: 0.82rem;
		line-height: 1.45;
		width: 230px;
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22);
		z-index: 20;
		max-width: 280px;
	}

	:global(.poc-root .tooltip strong) {
		display: block;
		margin-bottom: 4px;
		font-size: 0.9rem;
	}

	:global(.poc-root .legend) {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		color: var(--muted);
		font-size: 0.84rem;
	}

	:global(.poc-root .legend-item) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	:global(.poc-root .legend-scale) {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	:global(.poc-root .legend-ramp) {
		display: inline-grid;
		grid-auto-flow: column;
		gap: 2px;
	}

	:global(.poc-root .legend-ramp span) {
		width: 18px;
		height: 10px;
		border-radius: 999px;
		display: inline-block;
	}

	:global(.poc-root .swatch) {
		width: 12px;
		height: 12px;
		border-radius: 999px;
		display: inline-block;
	}

	:global(.poc-root .chart-note) {
		font-size: 0.85rem;
		color: var(--muted);
		margin: 0 0 8px;
	}

	:global(.poc-root .empty) {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 240px;
		color: var(--muted);
		text-align: center;
		padding: 20px;
		border: 1px dashed var(--line);
		border-radius: 14px;
		background: #faf7f1;
	}

	:global(.poc-root .summary-stat) {
		padding: 14px;
		border-radius: 14px;
		background: #faf7f0;
		border: 1px solid var(--line);
	}

	:global(.poc-root .summary-stat .k) {
		font-size: 0.78rem;
		color: var(--muted);
	}

	:global(.poc-root .summary-stat .v) {
		font-size: 1.15rem;
		font-weight: 700;
	}

	/* NHGIS-style tract globals */
	:global(.poc-root .mpc-tooltip) {
		position: absolute;
		pointer-events: none;
		background: rgba(17, 24, 39, 0.94);
		color: #fff;
		padding: 8px 10px;
		border-radius: 8px;
		font-size: 12px;
		line-height: 1.45;
		opacity: 0;
		z-index: 20;
		max-width: 280px;
	}

	:global(.poc-root .mpc-legend) {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 14px;
		font-size: 0.82rem;
		color: var(--mpc-muted);
	}

	:global(.poc-root .mpc-legend-item) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	:global(.poc-root .mpc-swatch) {
		width: 12px;
		height: 12px;
		border-radius: 3px;
		display: inline-block;
	}

	:global(.poc-root .mpc-legend-scale) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	:global(.poc-root .mpc-legend-ramp span) {
		display: inline-block;
		width: 18px;
		height: 10px;
	}

	:global(.poc-root .mpc-empty) {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 160px;
		color: var(--muted);
		border: 1px dashed var(--line);
		border-radius: 12px;
		background: #faf7f1;
		padding: 16px;
		text-align: center;
	}

	:global(.poc-root .mpc-chart-note) {
		font-size: 0.85rem;
		color: var(--mpc-muted);
		margin: 0 0 8px;
	}

	:global(.poc-root .mpc-summary-stat) {
		padding: 12px;
		border-radius: 10px;
		background: #faf7f0;
		border: 1px solid var(--line);
	}

	:global(.poc-root .mpc-k) {
		font-size: 0.78rem;
		color: var(--muted);
	}

	:global(.poc-root .mpc-v) {
		font-size: 1.1rem;
		font-weight: 700;
	}

	/* ── Tract section ────────────────────────────────── */
	.tract-section {
		margin-top: 18px;
		display: grid;
		gap: 14px;
	}

	.full-width { grid-column: 1 / -1; }

	.subtitle--compact {
		max-width: 760px;
		font-size: 1rem;
	}

	.story--signal {
		display: grid;
		gap: 10px;
	}

	.signal-line {
		margin: 0;
		font-size: 1.12rem;
		line-height: 1.62;
		color: var(--ink);
		max-width: 48rem;
	}

	.guide-figures {
		display: grid;
		grid-template-columns: 1fr;
		gap: 18px;
		margin-top: 14px;
		max-width: 860px;
	}

	.guide-figure {
		margin: 0;
		padding: 16px;
		display: grid;
		gap: 12px;
	}

	.guide-figure h3 {
		margin: 0;
		font-size: 1rem;
		line-height: 1.35;
	}

	.guide-figure figcaption {
		font-size: 0.94rem;
		line-height: 1.55;
		color: var(--muted);
	}

	.annotation-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px;
		margin-top: 12px;
		align-items: start;
	}

	.annotation-card {
		padding: 10px 0 0;
		border: 0;
		border-top: 1px solid rgba(120, 114, 102, 0.14);
		border-radius: 0;
		background: transparent;
		display: grid;
		gap: 6px;
	}

	.annotation-card h3 {
		margin: 0;
		font-size: 1rem;
	}

	.annotation-card p {
		margin: 0;
		font-size: 0.94rem;
		line-height: 1.5;
		color: var(--muted);
	}

	/* ── Takeaway cards ───────────────────────────────── */
	.takeaway-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 10px;
		margin-top: 10px;
	}

	.takeaway-card {
		padding: 10px 0 0;
		border-radius: 0;
		background: transparent;
		border: 0;
		border-top: 1px solid rgba(120, 114, 102, 0.14);
	}

	.takeaway-label {
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		margin-bottom: 8px;
	}

	.takeaway-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
	}

	.takeaway-dumbbell {
		position: relative;
		height: 132px;
		margin: 10px 0 6px;
	}

	.takeaway-dumbbell--compact {
		height: 110px;
	}

	.takeaway-axis {
		position: absolute;
		left: 0;
		right: 0;
		top: 56px;
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(90deg, #e8e0d4, #ddd3c3);
	}

	.takeaway-dumbbell--compact .takeaway-axis {
		top: 46px;
	}

	.takeaway-dot-group {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		display: grid;
		justify-items: center;
		gap: 4px;
		min-width: 72px;
		max-width: 92px;
	}

	.takeaway-dot-group--lower {
		top: 24px;
	}

	.takeaway-dot-label {
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		text-align: center;
		line-height: 1.15;
		white-space: nowrap;
	}

	.takeaway-dot {
		width: 16px;
		height: 16px;
		border-radius: 999px;
		border: 3px solid #fff;
		box-shadow: 0 2px 10px rgba(31, 36, 48, 0.15);
		margin-top: 18px;
	}

	.takeaway-dumbbell--compact .takeaway-dot {
		margin-top: 12px;
	}

	.takeaway-dot-group.tod .takeaway-dot,
	.takeaway-dot-group.hi-aff .takeaway-dot {
		background: var(--accent);
	}

	.takeaway-dot-group.ctrl .takeaway-dot {
		background: #94a3b8;
	}

	.takeaway-dot-group.minimal .takeaway-dot,
	.takeaway-dot-group.lo-aff .takeaway-dot {
		background: #c9bfaf;
	}

	.takeaway-dot-value {
		font-size: 0.95rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		white-space: nowrap;
		background: rgba(255, 253, 248, 0.96);
		padding: 0 4px;
		border-radius: 6px;
	}

	.takeaway-meta {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
		display: grid;
		gap: 6px;
	}

	.takeaway-statline {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 14px;
		font-size: 0.9rem;
		color: var(--muted);
	}

	.takeaway-statline strong {
		color: var(--ink);
		font-size: 1rem;
		font-variant-numeric: tabular-nums;
	}

	.takeaway-tag {
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 3px 8px;
		border-radius: 999px;
		min-width: 60px;
		text-align: center;
	}

	.takeaway-tag.tod { background: var(--accent-soft); color: #0b5e2c; }
	.takeaway-tag.ctrl { background: #e2e8f0; color: #475569; }
	.takeaway-tag.minimal { background: #f1f5f9; color: #64748b; }
	.takeaway-tag.hi-aff { background: #d1fae5; color: #065f46; }
	.takeaway-tag.lo-aff { background: #f5f5f4; color: #57534e; }

	.takeaway-value {
		font-size: 1.1rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.story--framing {
		padding-top: 18px;
		padding-bottom: 18px;
	}

	.framing-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px;
		align-items: start;
		max-width: 70rem;
		margin-inline: auto;
	}

	.framing-block {
		padding: 14px 0 0;
		border: 0;
		border-top: 1px solid rgba(120, 114, 102, 0.14);
		border-radius: 0;
		background: transparent;
	}

	.framing-block h2 {
		margin: 0 0 10px;
		font-size: 1.14rem;
		text-align: center;
	}

	.framing-block p {
		margin: 0;
		color: var(--muted);
		line-height: 1.6;
		max-width: 31rem;
		margin-inline: auto;
		text-align: center;
	}

	.framing-block p + p {
		margin-top: 10px;
	}

	/* Affordability: stacked rows (income, then education), each row = scatter + skinny compare bar */
	.afford-compare {
		margin-top: 8px;
	}

	.afford-comparison-stack {
		display: flex;
		flex-direction: column;
		gap: 28px;
		margin-top: 14px;
		align-items: center;
	}

	.afford-metric-row {
		display: grid;
		grid-template-columns: 3fr 2fr;
		gap: 10px 12px;
		align-items: start;
		width: 100%;
	}

	.afford-four-cell {
		min-width: 0;
	}

	.afford-four-cell--bar {
		justify-self: center;
	}

	.afford-four-cell__title {
		margin: 0 0 6px;
		font-size: 0.84rem;
		font-weight: 700;
		line-height: 1.25;
		color: var(--muted);
		text-align: center;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.afford-scatter-embed-figure {
		margin: 0;
		min-width: 0;
	}

	.scatter-container--afford-embed {
		justify-content: center;
		width: 100%;
	}

	.afford-comparison-stack :global(.tod-aff-wrap) {
		width: 100%;
	}

	.afford-comparison-stack :global(.tod-aff-chart svg) {
		max-width: 100%;
		height: auto;
	}

	.afford-split-mini-bar {
		margin-top: 2px;
		max-width: 100%;
	}

	.afford-split-mini-bar.cohort-mini-bar {
		max-width: 252px;
		margin-left: auto;
		margin-right: auto;
	}

	.conclusion-card {
		max-width: 52rem;
		margin-inline: auto;
		text-align: center;
	}

	.recommendation-card {
		max-width: 58rem;
		margin-inline: auto;
		text-align: center;
	}

	.recommendation-card h2,
	.recommendation-card > p {
		max-width: 44rem;
		margin-inline: auto;
	}

	.recommendation-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px 24px;
		margin-top: 16px;
		text-align: left;
	}

	.recommendation-item {
		padding-top: 12px;
		border-top: 1px solid rgba(120, 114, 102, 0.14);
	}

	.recommendation-item h3 {
		margin: 0 0 8px;
		font-size: 1rem;
		line-height: 1.25;
	}

	.recommendation-item p {
		margin: 0;
		font-size: 0.98rem;
		line-height: 1.62;
		color: var(--muted);
	}

	.conclusion-card h2,
	.conclusion-card p {
		max-width: 42rem;
		margin-inline: auto;
	}

	@media (max-width: 700px) {
		.afford-metric-row {
			grid-template-columns: 1fr;
		}

		.recommendation-grid {
			grid-template-columns: 1fr;
		}
	}

	/* ── Conclusion ───────────────────────────────────── */
	.conclusion {
		border-left: 4px solid var(--accent);
	}

	/* ── Loading ──────────────────────────────────────── */
	.loading-status {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		min-height: 200px;
		color: var(--muted);
	}

	.loading-status--error h3 { color: #c0392b; font-size: 1.1rem; margin: 0; }

	.spinner {
		width: 40px;
		height: 40px;
		border: 3px solid var(--line);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin { to { transform: rotate(360deg); } }

	/* ── Responsive ───────────────────────────────────── */
	@media (max-width: 1060px) {
		.dashboard, .small-grid, .summary-grid, .framing-grid {
			grid-template-columns: 1fr;
		}
	}
</style>

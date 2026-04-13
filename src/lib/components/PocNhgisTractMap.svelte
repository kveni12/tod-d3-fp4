<script>
	import { onDestroy } from 'svelte';
	import * as d3 from 'd3';
	import {
		tractGeo,
		developments,
		mbtaStops,
		mbtaLines
	} from '$lib/stores/data.svelte.js';
	import {
		aggregateDevsByTract,
		aggregateTractTodMetrics,
		buildFilteredData,
		developmentAffordableUnitsCapped,
		developmentMultifamilyShare,
		developmentMbtaProximity,
		isDevelopmentTransitAccessible,
		transitDistanceMiToMetres,
		transitModeUiLabel
	} from '$lib/utils/derived.js';
	import { periodCensusBounds, periodDisplayLabel } from '$lib/utils/periods.js';
	import { LOW_INCOME_MEDIAN_THRESHOLD } from '$lib/utils/incomeTract.js';
	import { computeTodMismatchClusters } from '$lib/utils/todMismatchClusters.js';
	import {
		MBTA_BLUE,
		MBTA_GREEN,
		MBTA_MAP_NEUTRAL,
		MBTA_ORANGE,
		MBTA_RED
	} from '$lib/utils/mbtaColors.js';
	import { renderMuniComposition, renderMuniRankedGrowth } from '$lib/utils/municipalCharts.js';

	/**
	 * Tract-dashboard–style map: census % housing-unit growth choropleth (period from panel), TOD-tier
	 * outlines, optional MassBuilds developments and MBTA overlays.
	 *
	 * Parameters
	 * ----------
	 * panelState : PanelState
	 *     Shared with ``FilterPanel`` / ``MapView`` (transit toggles, dev filters, zoom).
	 * tractList : Array<object>
	 *     Filtered census tract rows (same universe as ``nhgisRows``).
	 * nhgisRows : Array<object>
	 *     Rows from ``buildNhgisLikeRows`` including ``gisjoin``, ``devClass``, ``census_hu_pct_change``.
	 * metricsDevelopments : Array<object> | null | undefined
	 *     Optional MassBuilds rows for TOD / stock tooltips — use the same window as ``buildTractDevClassMap``
	 *     (e.g. 1990–2026 on the main POC). When omitted, uses ``buildFilteredData`` (panel period only).
	 */
	let { panelState, tractList, nhgisRows, metricsDevelopments = null } = $props();

	let containerEl = $state(null);
	let stepEls = $state([]);
	let tooltip = $state({
		visible: false,
		x: 0,
		y: 0,
		eyebrow: '',
		title: '',
		badge: '',
		badgeTone: '',
		primaryRows: [],
		secondaryRows: []
	});
	let revealStage = $state(0);
	let hoveredSpotlight = $state(/** @type {'tod_dominated' | 'nontod_dominated' | 'minimal' | null} */ (null));
	let pinnedSpotlight = $state(/** @type {'tod_dominated' | 'nontod_dominated' | 'minimal' | null} */ (null));
	let comparisonMetric = $state(/** @type {'hu_growth' | 'tod_share' | 'stock_increase'} */ ('hu_growth'));
	/** When true, dim everything except currently visible mismatch tracts. */
	let focusMismatchOnly = $state(false);
	/** Optional: emphasize tracts with median household income below the lower-income threshold. */
	let focusLowIncomeTracts = $state(false);
	/** Hover-linked cluster highlight: all tracts in this category read as one pattern. */
	let hoveredMismatchCluster = $state(/** @type {null | 'ha_lg' | 'hg_la'} */ (null));

	/** Nice unit ticks + pixel radii for HTML dot-size legend (same sqrt scale as map dots). */
	let devSizeLegendTicks = $state(/** @type {{ units: number; rPx: number }[] | null} */ (null));

	/** Reserved width per map colorbar (ticks + bar + vertical title, inset from map). */
	const CHORO_LEGEND_COL_W = 70;
	const DEV_LEGEND_COL_W = 70;
	const mapUid = Math.random().toString(36).slice(2, 11);

	/** Lighter grey for minimal-development tract outline (half stroke vs TOD tiers); legend ring matches. */
	const MINIMAL_TRACT_STROKE = '#94a3b8';
	/** High access + low growth — softer violet (thick edges read calmer than pure #7B61FF). */
	const MISMATCH_STROKE_HA = '#8A78E0';
	/** High growth + low access — lighter, dashed. */
	const MISMATCH_STROKE_HG = '#C4B5F0';
	/** Slightly transparent mismatch strokes so dense boundaries feel less “ink heavy”. */
	const MISMATCH_STROKE_OPACITY = 0.88;
	const MISMATCH_W_HA = 2;
	const MISMATCH_W_HG = 1.45;
	/**
	 * Non–mismatch tracts when the mismatch layer is on (revealStage ≥2).
	 * ~0.11 opacity ≈ 89% dimming vs full (≥50% reduction vs the previous 0.22 pass) so violet/lavender outlines read clearly.
	 */
	const NON_MISMATCH_DIM = 0.11;
	/** When “Show mismatch areas only”: hide context almost entirely. */
	const NON_MISMATCH_FOCUS_ONLY = 0.06;
	const FILL_DESAT = '#a8a29e';
	/** When “lower-income tracts” focus is on: hide choropleth for tracts at/above $125k median (not a dimmed blue). */
	const LOW_INCOME_FOCUS_INACTIVE_FILL = '#e2e8f0';
	const HIGH_ACCESS_LOW_GROWTH = 'high_access_low_growth';
	const HIGH_GROWTH_LOW_ACCESS = 'high_growth_low_access';

	function devClassStroke(row) {
		const dc = row?.devClass;
		if (dc === 'tod_dominated') return 'var(--accent, #0d9488)';
		if (dc === 'nontod_dominated') return 'var(--warning, #ea580c)';
		if (dc === 'minimal') return MINIMAL_TRACT_STROKE;
		return 'rgba(60,64,67,0.22)';
	}

	function cohortLabel(devClass) {
		if (devClass === 'tod_dominated') return 'TOD-dominated';
		if (devClass === 'nontod_dominated') return 'Non-TOD-dominated';
		if (devClass === 'minimal') return 'Minimal development';
		return 'Unclassified';
	}

	function spotlightDescription(devClass) {
		if (devClass === 'tod_dominated') {
			return 'Most filtered new development in these tracts is clustered near transit.';
		}
		if (devClass === 'nontod_dominated') {
			return 'These tracts saw significant development, but less of it is concentrated near transit.';
		}
		if (devClass === 'minimal') {
			return 'These tracts had relatively little housing growth in the selected period.';
		}
		return '';
	}

	function isSpotlightMatch(row, spotlight) {
		return !!spotlight && row?.devClass === spotlight;
	}

	function passesGrowthFilter(row) {
		const v = Number(row?.census_hu_pct_change);
		return Number.isFinite(v);
	}

	function tintFill(baseFill, row) {
		if (revealStage < 1) return baseFill;
		const dc = row?.devClass;
		if (!dc) return baseFill;
		const accent =
			dc === 'tod_dominated'
				? 'var(--accent, #0d9488)'
				: dc === 'nontod_dominated'
					? 'var(--warning, #ea580c)'
					: MINIMAL_TRACT_STROKE;
		return d3.interpolateRgb(baseFill, accent)(dc === 'minimal' ? 0.1 : 0.17);
	}

	const mismatchClusters = $derived.by(() =>
		computeTodMismatchClusters(tractList, nhgisRows, panelState.timePeriod)
	);
	const mismatchFlagsByGj = $derived.by(() => mismatchClusters.flagsByGj);

	/** Which mismatch tracts are shown — scroll-driven progressive reveal (stages 2–3). */
	const visibleMismatchIds = $derived.by(() => {
		const s = new Set();
		const c = mismatchClusters;
		if (revealStage < 2) return s;
		if (revealStage === 2) {
			c.highAccessLowGrowth.forEach((id) => s.add(id));
			return s;
		}
		c.highAccessLowGrowth.forEach((id) => s.add(id));
		c.highGrowthLowAccess.forEach((id) => s.add(id));
		return s;
	});

	/**
	 * Optional override: which mismatch outlines to draw (scroll-driven by default).
	 * Use “All” / single-type modes to explore without waiting on scroll steps.
	 */
	let mismatchOutlineMode = $state(
		/** @type {'follow_scroll' | 'off' | 'all' | 'ha_only' | 'hg_only'} */ ('follow_scroll')
	);

	const effectiveMismatchIds = $derived.by(() => {
		const c = mismatchClusters;
		if (mismatchOutlineMode === 'follow_scroll') return visibleMismatchIds;
		if (mismatchOutlineMode === 'off') return new Set();
		if (mismatchOutlineMode === 'all') {
			const s = new Set();
			c.highAccessLowGrowth.forEach((id) => s.add(id));
			c.highGrowthLowAccess.forEach((id) => s.add(id));
			return s;
		}
		if (mismatchOutlineMode === 'ha_only') return new Set(c.highAccessLowGrowth);
		if (mismatchOutlineMode === 'hg_only') return new Set(c.highGrowthLowAccess);
		return visibleMismatchIds;
	});

	/** When the mismatch outline layer should affect fill/stroke (respects scroll unless user overrides). */
	const mismatchLayerOn = $derived(
		effectiveMismatchIds.size > 0 && (mismatchOutlineMode !== 'follow_scroll' || revealStage >= 2)
	);

	/**
	 * @param {string} id
	 * @returns {'ha_lg' | 'hg_la' | null}
	 */
	function mismatchKind(id) {
		const f = mismatchFlagsByGj.get(id);
		if (!f) return null;
		if (f.isHighAccessLowGrowth) return 'ha_lg';
		if (f.isHighGrowthLowAccess) return 'hg_la';
		return null;
	}

	const stepContent = [
		{
			kicker: 'Step 1',
			title: 'Transit-rich places',
			body: 'These areas are well-served by transit and are often considered ideal for dense housing. Read tract color as housing growth before adding outlines.'
		},
		{
			kicker: 'Step 2',
			title: 'Growth is not only “on the line”',
			body: 'However, housing development is not concentrated only in these areas. Green, orange, and gray outlines show TOD-dominated, non-TOD-dominated, and minimal-development tracts.'
		},
		{
			kicker: 'Step 3',
			title: 'A measurable mismatch',
			body: 'These highlighted tracts reveal a mismatch between transit access and housing growth (quartile-based). Solid purple begins with high access + low growth.'
		},
		{
			kicker: 'Step 4',
			title: 'Who can live near transit?',
			body: 'In some high-access areas, limited development reduces opportunities for lower-income households (<$125k median) to live near transit. Dashed lavender adds high growth + low access; optional project dots layer on.'
		}
	];

	const mapCallouts = $derived.by(() => {
		if (revealStage === 0) {
			return [
				'Blue fill = stronger census housing growth in the selected period; red = weaker or negative growth.',
				'Scroll to add tract-category outlines and then mismatch highlights—without changing the choropleth scale.'
			];
		}
		if (revealStage === 1) {
			return [
				'Outlines encode MassBuilds-based cohorts; fill still shows census growth.',
				'Next steps add access–growth “mismatch” tracts—use toggles to focus when the map gets busier.'
			];
		}
		if (revealStage === 2) {
			return [
				'Solid violet tracts = high access + low growth. The map pushes everything else back (dimmer fill, lighter cohort outlines) so the mismatch layer stays in front.',
				'If it still feels busy: turn on “Show mismatch areas only,” or hover any highlighted tract to spotlight its whole cluster.',
				'Optional: “Show lower-income tracts” replaces growth color with neutral fill for tracts at/above the $125k median (no second choropleth).'
			];
		}
		return [
			'Dashed lavender = high growth + low access. Same hierarchy: background tracts fade; violet / lavender stay the focus.',
			'Project dots (step 4) add site-level detail—tract fill and outlines still carry the regional story.',
			'Income detail stays in tooltips and the charts below; hover or select a tract to link map → charts.'
		];
	});

	function stepRef(node, index) {
		stepEls[index] = node;
		stepEls = [...stepEls];
		return {
			destroy() {
				stepEls[index] = null;
				stepEls = [...stepEls];
			}
		};
	}

	/**
	 * Z-order rank for tract polygons (later in DOM = drawn on top at shared edges).
	 * Excluded (tan / no reliable % change) → minimal → non-TOD → TOD.
	 *
	 * Parameters
	 * ----------
	 * row : object | undefined
	 *     Row with ``census_hu_pct_change`` and optional ``devClass``.
	 *
	 * Returns
	 * -------
	 * number
	 *     Integer 0–3 (0 lowest).
	 */
	function tractTierRankFromRow(row) {
		if (!row) return 0;
		const v = Number(row.census_hu_pct_change);
		if (!Number.isFinite(v)) return 0;
		const dc = row.devClass;
		if (dc === 'tod_dominated') return 3;
		if (dc === 'nontod_dominated') return 2;
		if (dc === 'minimal') return 1;
		return 0;
	}

	/** Re-append tract paths so stroke precedence follows ``tractTierRankFromRow`` after data updates. */
	function reorderTractLayerPaths() {
		if (!containerEl) return;
		const rowByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
		const layer = d3.select(containerEl).select('.tract-layer');
		const nodes = layer.selectAll('path.tract-poly').nodes();
		if (nodes.length === 0) return;
		nodes.sort((na, nb) => {
			const da = d3.select(na).datum();
			const db = d3.select(nb).datum();
			const ra = tractTierRankFromRow(rowByGj.get(da.properties?.gisjoin));
			const rb = tractTierRankFromRow(rowByGj.get(db.properties?.gisjoin));
			if (ra !== rb) return ra - rb;
			return String(da.properties?.gisjoin ?? '').localeCompare(String(db.properties?.gisjoin ?? ''));
		});
		const parent = nodes[0].parentNode;
		if (!parent) return;
		for (const n of nodes) parent.appendChild(n);
	}

	let mapCanvasLeft = 0;
	let mapW = 520;
	const mapH = 430;
	/** ViewBox dimensions for anchoring HTML callouts to projection coordinates. */
	let mapViewBox = $state(/** @type {{ svgW: number; mapW: number; mapH: number }} */ ({
		svgW: 520 + CHORO_LEGEND_COL_W,
		mapW: 520,
		mapH: 430
	}));
	let chartResizeTick = $state(0);
	let elComposition = $state(/** @type {HTMLElement | null} */ (null));
	let elRanked = $state(/** @type {HTMLElement | null} */ (null));

	let svgRef = $state(null);
	let zoomBehaviorRef = $state(null);
	let projectionRef = $state(null);
	let lastStructuralKey = $state('');

	/** @type {Map<string, object> | null} */
	let tractTodMetricsMap = $state(null);
	/** @type {Map<string, object> | null} */
	let devAggMap = $state(null);

	const structuralKey = $derived(
		JSON.stringify({
			n: tractList.length,
			gf: tractGeo?.features?.length ?? 0,
			ms: mbtaStops.length,
			showDev: panelState.showDevelopments
		})
	);

	const supplementalChartState = $derived.by(() => ({
		yearStart: 1990,
		yearEnd: 2026,
		threshold: Number(panelState.transitDistanceMi ?? 0.5)
	}));

	const supplementalProjectRows = $derived.by(() => {
		const radiusM = transitDistanceMiToMetres(panelState.transitDistanceMi ?? 0.5);
		const source =
			metricsDevelopments && metricsDevelopments.length
				? metricsDevelopments
				: buildFilteredData(developments, panelState);
		return source
			.map((d) => {
				const year = Number(d?.year ?? d?.completion_year ?? d?.year_compl ?? d?.yrcomp_est);
				const units = Number(d?.hu ?? d?.units);
				const affordableUnits = Number(d?.affrd_unit ?? d?.affordableUnits);
				const municipality = String(d?.municipal ?? d?.municipality ?? '').trim();
				const prox = developmentMbtaProximity(d, mbtaStops, radiusM);
				const distM = Number(prox?.nearestDistM);
				return {
					year,
					units,
					affordableUnits: Number.isFinite(affordableUnits) ? affordableUnits : 0,
					municipality,
					distance: Number.isFinite(distM) ? distM / 1609.344 : NaN,
					hasDistance: Number.isFinite(distM)
				};
			})
			.filter((d) => d.municipality && d.year >= 1990 && d.year <= 2026 && d.units > 0);
	});

	const supplementalMuniRows = $derived.by(() =>
		d3
			.rollups(
				supplementalProjectRows,
				(values) => {
					const units = d3.sum(values, (d) => d.units);
					const affordableUnits = d3.sum(values, (d) => d.affordableUnits);
					return {
						municipality: values[0].municipality,
						units,
						affordableShare: units > 0 ? affordableUnits / units : 0
					};
				},
				(d) => d.municipality
			)
			.map(([, row]) => row)
	);

	const dataKey = $derived(
		JSON.stringify({
			tp: panelState.timePeriod,
			stops: panelState.minStops,
			tdMi: panelState.transitDistanceMi,
			sig: panelState.sigDevMinPctStockIncrease,
			todCut: panelState.todFractionCutoff,
			huSrc: panelState.huChangeSource,
			devMin: panelState.minUnitsPerProject,
			devMfPct: panelState.minDevMultifamilyRatioPct,
			devAffPct: panelState.minDevAffordableRatioPct,
			redev: panelState.includeRedevelopment,
			minPop: panelState.minPopulation,
			minDens: panelState.minPopDensity,
			dn: developments.length,
			nr: nhgisRows?.length ?? 0,
			md: metricsDevelopments?.length ?? -1,
			showDev: panelState.showDevelopments
		})
	);

	function meetsTodMultifamilyFloor(d, ps) {
		const minPct = Math.min(100, Math.max(0, Number(ps.minDevMultifamilyRatioPct) || 0));
		if (minPct <= 0) return true;
		const s = developmentMultifamilyShare(d);
		return s != null && s >= minPct / 100;
	}

	function stopColor(stop) {
		if (stop.color) return stop.color;
		const m = stop.modes ?? [];
		if (m.includes('commuter_rail')) return '#a855f7';
		if (m.includes('rail')) return '#3b82f6';
		if (m.includes('bus')) return '#f97316';
		return '#888';
	}

	function recenterMap() {
		if (!svgRef || !zoomBehaviorRef) return;
		svgRef
			.transition()
			.duration(350)
			.call(zoomBehaviorRef.transform, d3.zoomIdentity);
	}

	function zoomBy(factor) {
		if (!svgRef || !zoomBehaviorRef) return;
		const node = svgRef.node();
		if (!node) return;
		const current = d3.zoomTransform(node).k;
		const next = Math.max(1, Math.min(28, current * factor));
		svgRef.transition().duration(250).call(zoomBehaviorRef.scaleTo, next);
	}

	function zoomInMap() {
		zoomBy(1.25);
	}

	function zoomOutMap() {
		zoomBy(0.8);
	}

	function zoomToTract(gisjoin) {
		if (!gisjoin || !svgRef || !zoomBehaviorRef || !projectionRef) return;
		const feature = (tractGeo?.features ?? []).find((f) => f.properties?.gisjoin === gisjoin);
		if (!feature) return;
		const path = d3.geoPath(projectionRef);
		const [[x0, y0], [x1, y1]] = path.bounds(feature);
		const dx = x1 - x0;
		const dy = y1 - y0;
		if (!Number.isFinite(dx) || !Number.isFinite(dy) || dx <= 0 || dy <= 0) return;
		const scale = Math.max(1, Math.min(10, 0.82 / Math.max(dx / mapW, dy / mapH)));
		const tx = mapCanvasLeft + mapW / 2 - scale * (x0 + x1) / 2;
		const ty = mapH / 2 - scale * (y0 + y1) / 2;
		svgRef
			.transition()
			.duration(500)
			.call(zoomBehaviorRef.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
	}

	function stopRadius(stop) {
		const m = stop.modes ?? [];
		if (m.includes('rail') || m.includes('commuter_rail')) return 3;
		return 1.2;
	}

	function lineStrokeColor(routeColor) {
		if (routeColor == null || routeColor === '') return '#888';
		const s = String(routeColor).trim();
		return s.startsWith('#') ? s : `#${s}`;
	}

	function lineMode(routeType) {
		if (routeType === 0 || routeType === 1) return 'rail';
		if (routeType === 2) return 'commuter_rail';
		if (routeType === 3) return 'bus';
		return 'other';
	}

	/** Multifamily share ramp: MBTA orange → MBTA green (matches SVG MF legend and dots). */
	function interpolateOrangeGreen(t) {
		return d3.interpolateRgb(MBTA_ORANGE, MBTA_GREEN)(Math.min(1, Math.max(0, t)));
	}

	/**
	 * Pick human-friendly unit values between ``lo`` and ``hi`` for a sqrt-sized dot legend.
	 *
	 * Parameters
	 * ----------
	 * lo : number
	 *     Domain minimum (same as ``rScale`` domain lower bound).
	 * hi : number
	 *     Domain maximum.
	 * rScale : d3.ScaleContinuousNumeric<number, number>
	 *     Sqrt scale mapping units → dot radius in SVG px (same as map).
	 *
	 * Returns
	 * -------
	 * Array<{ units: number, rPx: number }>
	 */
	function computeDevSizeLegendTicks(lo, hi, rScale) {
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
		const raw = d3.ticks(lo, hi, 5).filter((t) => t >= lo && t <= hi);
		if (raw.length === 0) {
			const u = (lo + hi) / 2;
			return [{ units: u, rPx: rScale(u) }];
		}
		let vals = raw;
		if (raw.length > 4) {
			const pick = (i) => raw[Math.min(Math.max(0, i), raw.length - 1)];
			const idxs = [0, Math.floor(raw.length / 3), Math.floor((2 * raw.length) / 3), raw.length - 1];
			vals = [...new Set(idxs.map(pick))];
		}
		vals.sort((a, b) => a - b);
		return vals.map((units) => ({ units, rPx: rScale(units) }));
	}

	/** Format unit counts for the dot-size legend (comma-separated integers). */
	function formatDevUnitsLegend(u) {
		const n = Math.round(Number(u));
		if (!Number.isFinite(n)) return '—';
		return d3.format(',.0f')(n);
	}

	function buildTractLookup() {
		const m = new Map();
		for (const t of tractList) {
			if (t.gisjoin && typeof t.gisjoin === 'string' && t.gisjoin.startsWith('G')) m.set(t.gisjoin, t);
		}
		return m;
	}

	function refreshMetrics() {
		if (!tractList.length) {
			tractTodMetricsMap = null;
			devAggMap = null;
			return;
		}
		const tractMap = new Map();
		for (const t of tractList) {
			if (t.gisjoin) tractMap.set(t.gisjoin, t);
		}
		const transitM = transitDistanceMiToMetres(panelState.transitDistanceMi ?? 0.5);
		const minMf = Math.min(1, Math.max(0, (Number(panelState.minDevMultifamilyRatioPct) || 0) / 100));
		const tractSet = new Set(tractList.map((t) => t.gisjoin).filter(Boolean));
		let devsForMetrics;
		if (metricsDevelopments && Array.isArray(metricsDevelopments)) {
			devsForMetrics = metricsDevelopments.filter((d) => tractSet.has(d.gisjoin));
		} else {
			devsForMetrics = buildFilteredData(tractList, developments, panelState).filteredDevs;
		}
		tractTodMetricsMap = aggregateTractTodMetrics(
			devsForMetrics,
			tractMap,
			tractList,
			panelState.timePeriod,
			transitM,
			panelState.huChangeSource ?? 'massbuilds',
			minMf
		);
		devAggMap = aggregateDevsByTract(devsForMetrics, tractMap, panelState.timePeriod, panelState);
	}

	function rebuildSVG() {
		if (!containerEl) return;
		const root = d3.select(containerEl);
		root.selectAll('*').remove();

		const features = tractGeo?.features ?? [];
		if (features.length === 0) {
			root.append('p').attr('class', 'map-empty').text('Loading map data…');
			return;
		}

		const rowByGjForOrder = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
		const sortedFeatures = [...features].sort((a, b) => {
			const ra = tractTierRankFromRow(rowByGjForOrder.get(a.properties?.gisjoin));
			const rb = tractTierRankFromRow(rowByGjForOrder.get(b.properties?.gisjoin));
			if (ra !== rb) return ra - rb;
			return String(a.properties?.gisjoin ?? '').localeCompare(String(b.properties?.gisjoin ?? ''));
		});

		const cw = containerEl.clientWidth || 900;
		mapW = Math.max(400, Math.min(1100, cw - CHORO_LEGEND_COL_W - DEV_LEGEND_COL_W - 16));

		mapCanvasLeft = 0;
		const svgW = mapCanvasLeft + mapW + CHORO_LEGEND_COL_W;
		const svgH = mapH;

		const projection = d3
			.geoMercator()
			.fitExtent(
				[
					[mapCanvasLeft, 0],
					[mapCanvasLeft + mapW, mapH]
				],
				tractGeo
			);
		projectionRef = projection;
		const path = d3.geoPath(projection);

		const svg = root
			.append('svg')
			.attr('viewBox', `0 0 ${svgW} ${svgH}`)
			.attr('width', '100%')
			.attr('height', 'auto')
			.attr('preserveAspectRatio', 'xMidYMid meet')
			.style('display', 'block')
			.style('background', 'var(--bg, #0f1115)');
		svgRef = svg;

		const clipId = `poc-map-clip-${mapUid}`;
		svg.append('defs').append('clipPath').attr('id', clipId)
			.append('rect')
			.attr('x', mapCanvasLeft)
			.attr('y', 0)
			.attr('width', mapW)
			.attr('height', mapH);

		svg.append('g').attr('class', 'map-dev-legend-group');

		const mapRoot = svg.append('g').attr('class', 'map-root').attr('clip-path', `url(#${clipId})`);
		const zoomLayer = mapRoot.append('g').attr('class', 'map-zoom-layer');

		zoomLayer
			.append('g')
			.attr('class', 'tract-layer')
			.selectAll('path.tract-poly')
			.data(sortedFeatures, (d) => d.properties?.gisjoin)
			.join('path')
			.attr('class', 'tract-poly')
			.attr('vector-effect', 'non-scaling-stroke')
			.attr('d', path)
			.attr('fill', 'var(--bg-card)')
			.attr('stroke', 'var(--border)')
			.attr('stroke-width', 0.5)
			.style('cursor', 'pointer')
			.on('mouseenter', handleTractEnter)
			.on('mousemove', handleMouseMove)
			.on('mouseleave', handleTractLeave)
			.on('click', handleTractClick);

		zoomLayer
			.append('g')
			.attr('class', 'mbta-lines-layer')
			.selectAll('path.mbta-line')
			.data(mbtaLines?.features ?? [], (d, i) => d.properties?.route_id ?? i)
			.join('path')
			.attr('class', 'mbta-line')
			.attr('d', path)
			.attr('fill', 'none')
			.attr('stroke', (d) => lineStrokeColor(d.properties?.route_color))
			.attr('stroke-width', 1.5)
			.attr('stroke-opacity', 0.7)
			.attr('vector-effect', 'non-scaling-stroke')
			.style('cursor', 'pointer')
			.on('mouseenter', handleLineEnter)
			.on('mousemove', handleMouseMove)
			.on('mouseleave', handleOverlayLeave);

		const stopG = zoomLayer.append('g').attr('class', 'mbta-stops-layer');
		stopG
			.selectAll('circle.mbta-stop')
			.data(mbtaStops, (d) => d.id)
			.join('circle')
			.attr('class', 'mbta-stop')
			.attr('r', (d) => stopRadius(d))
			.attr('cx', (d) => projection([d.lon, d.lat])?.[0] ?? -9999)
			.attr('cy', (d) => projection([d.lon, d.lat])?.[1] ?? -9999)
			.attr('fill', (d) => stopColor(d))
			.attr('stroke', '#555')
			.attr('stroke-width', 0.3)
			.style('cursor', 'pointer')
			.on('mouseenter', handleStopEnter)
			.on('mousemove', handleMouseMove)
			.on('mouseleave', handleOverlayLeave);

		zoomLayer.append('g').attr('class', 'dev-dots-layer');
		zoomLayer.append('g').attr('class', 'insight-layer');

		const zoom = d3
			.zoom()
			.scaleExtent([1, 28])
			.on('zoom', (event) => {
				zoomLayer.attr('transform', event.transform);
				const k = event.transform.k;
				const invK = 1 / k;
				stopG.selectAll('circle.mbta-stop')
					.attr('r', (d) => stopRadius(d) * invK)
					.attr('stroke-width', 0.3 * invK);
				zoomLayer.select('.dev-dots-layer').selectAll('circle.dev-dot')
					.attr('r', function () {
						const d = d3.select(this).datum();
						return (d?.rBase ?? 2.5) * invK;
					})
					.attr('stroke-width', function () {
						const d = d3.select(this).datum();
						return (d?.strokeWBase ?? 0.3) * invK;
					});
				zoomLayer
					.select('.insight-layer')
					.selectAll('g.insight-marker')
					.each(function (d) {
						const g = d3.select(this);
						g.select('circle.insight-marker__halo')
							.attr('r', (d?.rHaloBase ?? 5.5) * invK)
							.attr('stroke-width', 0.9 * invK);
						g.select('circle.insight-marker__dot')
							.attr('r', (d?.rDotBase ?? 2.2) * invK)
							.attr('stroke-width', 0.8 * invK);
					});
			});
		zoomBehaviorRef = zoom;

		svg.call(zoom).on('dblclick.zoom', null).style('touch-action', 'none');

		svg.append('g').attr('class', 'map-legend-group');

		mapViewBox = { svgW, mapW, mapH };
	}

	function updateChoropleth() {
		if (!containerEl || !svgRef) return;

		refreshMetrics();

		const rowByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
		const spotlight = activeSpotlight;
		const values = (nhgisRows ?? [])
			.map((r) => Number(r.census_hu_pct_change))
			.filter(Number.isFinite);
		const maxAbs = Math.max(1, d3.max(values, (d) => Math.abs(d)) || 1);
		const color = d3
			.scaleLinear()
			.domain([-maxAbs, 0, maxAbs])
			.range([MBTA_RED, MBTA_MAP_NEUTRAL, MBTA_BLUE]);

		d3.select(containerEl)
			.selectAll('path.tract-poly')
			.transition()
			.duration(350)
			.attr('fill', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				const li = mismatchFlagsByGj.get(id)?.isLowIncome;
				const isSelHover = id === panelState.hoveredTract || panelState.selectedTracts.has(id);
				if (focusLowIncomeTracts && li !== true && !isSelHover) {
					return LOW_INCOME_FOCUS_INACTIVE_FILL;
				}
				const v = row ? Number(row.census_hu_pct_change) : NaN;
				let baseFill = Number.isFinite(v) ? color(v) : '#e7e0d5';
				let fill = tintFill(baseFill, row);
				if (mismatchLayerOn) {
					if (!effectiveMismatchIds.has(id)) {
						fill = d3.interpolateRgb(fill, FILL_DESAT)(0.65);
					} else if (hoveredMismatchCluster) {
						const mk = mismatchKind(id);
						if (mk && mk !== hoveredMismatchCluster) {
							fill = d3.interpolateRgb(fill, FILL_DESAT)(0.22);
						}
					}
				}
				return fill;
			})
			.attr('stroke', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				if (effectiveMismatchIds.has(id)) {
					return mismatchKind(id) === 'ha_lg' ? MISMATCH_STROKE_HA : MISMATCH_STROKE_HG;
				}
				if (revealStage < 1) return 'rgba(60,64,67,0.18)';
				return devClassStroke(row);
			})
			.attr('stroke-dasharray', (d) => {
				const id = d.properties?.gisjoin;
				if (!effectiveMismatchIds.has(id)) return 'none';
				return mismatchKind(id) === 'hg_la' ? '6 5' : 'none';
			})
			.attr('stroke-width', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				const dc = row?.devClass;
				if (effectiveMismatchIds.has(id)) {
					return mismatchKind(id) === 'ha_lg' ? MISMATCH_W_HA : MISMATCH_W_HG;
				}
				if (revealStage < 1) return 0.45;
				if (!dc) return 0.5;
				if (isSpotlightMatch(row, spotlight)) return dc === 'minimal' ? 1.8 : 3.2;
				return dc === 'tod_dominated' ? 2.8 : dc === 'minimal' ? 1.1 : 2.1;
			})
			.attr('stroke-opacity', (d) => {
				const id = d.properties?.gisjoin;
				if (effectiveMismatchIds.has(id)) return MISMATCH_STROKE_OPACITY;
				if (mismatchLayerOn) {
					const row = rowByGj.get(id);
					const dc = row?.devClass;
					if (dc === 'tod_dominated' || dc === 'nontod_dominated' || dc === 'minimal') return 0.38;
				}
				return 1;
			})
			.attr('opacity', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				if (id === panelState.hoveredTract || panelState.selectedTracts.has(id)) return 1;
				if (spotlight && !isSpotlightMatch(row, spotlight)) return 0.2;
				if (revealStage === 0) return 1;
				if (!mismatchLayerOn) return 1;
				const vis = effectiveMismatchIds.has(id);
				const mk = mismatchKind(id);
				if (hoveredMismatchCluster) {
					if (!vis) return NON_MISMATCH_DIM;
					if (mk === hoveredMismatchCluster) return 1;
					return 0.35;
				}
				if (focusMismatchOnly) return vis ? 1 : NON_MISMATCH_FOCUS_ONLY;
				return vis ? 1 : NON_MISMATCH_DIM;
			});

		const svg = svgRef;
		const legGroup = svg.select('.map-legend-group');
		legGroup.selectAll('*').remove();
		const mapRight = mapCanvasLeft + mapW;
		legGroup.attr('transform', `translate(${mapRight + 6},0)`);

		const y0 = 10;
		const legBarH = Math.max(120, mapH - y0 - 14);
		const barW = 10;
		const barRight = 58;
		const barLeft = barRight - barW;
		const fmtTick = (v) => {
			const n = Number(v);
			if (!Number.isFinite(n)) return '';
			const ax = Math.abs(n);
			if (ax >= 1000 || (ax > 0 && ax < 0.01)) return `${d3.format('.2~s')(n)}%`;
			return `${d3.format('.1f')(n)}%`;
		};

		const legendG = legGroup.append('g').attr('class', 'map-legend-inner');
		const gradId = `poc-choro-grad-${mapUid}`;
		svg.select('defs').selectAll(`#${gradId}`).remove();
		const grad = svg
			.select('defs')
			.append('linearGradient')
			.attr('id', gradId)
			.attr('x1', '0%')
			.attr('y1', '100%')
			.attr('x2', '0%')
			.attr('y2', '0%');

		const d0 = -maxAbs;
		const d1 = maxAbs;
		const nStops = 48;
		for (let i = 0; i <= nStops; i++) {
			const t = i / nStops;
			const v = d0 + t * (d1 - d0);
			grad.append('stop').attr('offset', `${t * 100}%`).attr('stop-color', color(v));
		}
		legendG
			.append('rect')
			.attr('x', barLeft)
			.attr('y', y0)
			.attr('width', barW)
			.attr('height', legBarH)
			.attr('rx', 2)
			.attr('fill', `url(#${gradId})`)
			.attr('stroke', 'var(--border)')
			.attr('stroke-width', 0.5);

		const yScale = d3.scaleLinear().domain([d0, d1]).range([y0 + legBarH, y0]);
		const choroAxisX = barLeft - 0.5;
		legendG
			.append('g')
			.attr('transform', `translate(${choroAxisX},0)`)
			.call(
				d3
					.axisLeft(yScale)
					.ticks(5)
					.tickFormat((v) => fmtTick(v))
					.tickSize(3)
			)
			.call((g) => g.selectAll('path,line').attr('stroke', 'var(--border)'))
			.call((g) => g.selectAll('text').attr('fill', 'var(--text-muted)').attr('font-size', '8px'));

		legendG
			.append('text')
			.attr('transform', `translate(4, ${y0 + legBarH * 0.5}) rotate(-90)`)
			.attr('text-anchor', 'middle')
			.attr('fill', 'var(--text-muted)')
			.attr('font-size', '7.5px')
			.attr('font-weight', 600)
			.text(`% housing growth (${periodDisplayLabel(panelState.timePeriod)})`);

		containerEl.__pocChoroMaxAbs = maxAbs;
		containerEl.__pocRowByGj = rowByGj;
		reorderTractLayerPaths();
	}

	function updateDevelopments() {
		if (!containerEl || !svgRef || !projectionRef) return;

		const svg = svgRef;
		const devLeg = svg.select('.map-dev-legend-group');
		devLeg.selectAll('*').remove();

		const devLayer = d3.select(containerEl).select('.dev-dots-layer');
		const t = d3.transition().duration(350);

		if (revealStage < 3) {
			devSizeLegendTicks = null;
			devLayer
				.selectAll('circle.dev-dot')
				.transition(t)
				.attr('opacity', 0)
				.style('pointer-events', 'none');
			return;
		}

		const { filteredDevs } = buildFilteredData(tractList, developments, panelState);
		const projection = projectionRef;

		const currentK = d3.zoomTransform(svgRef.node()).k;
		const invK = 1 / currentK;

		const transitM = transitDistanceMiToMetres(panelState.transitDistanceMi ?? 0.5);
		const huVals = filteredDevs.map((d) => Number(d.hu) || 0).filter((h) => h > 0);
		const huMin = huVals.length ? d3.min(huVals) : 1;
		const huMax = huVals.length ? d3.max(huVals) : 1;
		const lo = Math.max(1, huMin);
		const hi = Math.max(lo + 1e-6, huMax);
		const rScale = d3.scaleSqrt().domain([lo, hi]).range([1.4, 8]);

		devSizeLegendTicks = filteredDevs.length ? computeDevSizeLegendTicks(lo, hi, rScale) : [];

		const mfColor = d3.scaleSequential((t) => interpolateOrangeGreen(t)).domain([0, 1]).clamp(true);

		const glyphData = filteredDevs.map((d) => {
			const hu = Number(d.hu) || 0;
			const mf = developmentMultifamilyShare(d);
			const access =
				isDevelopmentTransitAccessible(d, transitM) && meetsTodMultifamilyFloor(d, panelState);
			const rBase = hu > 0 ? rScale(Math.max(lo, Math.min(hi, hu))) : rScale(lo);
			return {
				...d,
				mfShare: mf,
				rBase,
				strokeWBase: access ? 0.55 : 0.4,
				transitAccessible: access
			};
		});

		devLayer
			.selectAll('circle.dev-dot')
			.data(glyphData, (d, i) => `${d.gisjoin}-${d.lat}-${d.lon}-${i}`)
			.join(
				(enter) =>
					enter
						.append('circle')
						.attr('class', 'dev-dot')
						.attr('cx', (d) => projection([d.lon, d.lat])?.[0] ?? -9999)
						.attr('cy', (d) => projection([d.lon, d.lat])?.[1] ?? -9999)
						.attr('r', (d) => d.rBase * invK)
						.attr('fill', (d) =>
							d.mfShare == null || !Number.isFinite(d.mfShare) ? '#475569' : mfColor(d.mfShare)
						)
						.attr('fill-opacity', 0.78)
						.attr('stroke', (d) => (d.transitAccessible ? '#ffffff' : 'rgba(15, 23, 42, 0.55)'))
						.attr('stroke-width', (d) => d.strokeWBase * invK)
						.attr('opacity', 0)
						.style('cursor', 'pointer')
						.style('pointer-events', 'none')
						.call((sel) =>
							sel
								.on('mouseenter', handleDevEnter)
								.on('mousemove', handleMouseMove)
								.on('mouseleave', handleOverlayLeave)
						),
				(update) => update,
				(exit) => exit.transition(t).attr('opacity', 0).remove()
			)
			.transition(t)
			.attr('cx', (d) => projection([d.lon, d.lat])?.[0] ?? -9999)
			.attr('cy', (d) => projection([d.lon, d.lat])?.[1] ?? -9999)
			.attr('r', (d) => d.rBase * invK)
			.attr('fill', (d) =>
				d.mfShare == null || !Number.isFinite(d.mfShare) ? '#475569' : mfColor(d.mfShare)
			)
			.attr('fill-opacity', 0.78)
			.attr('stroke', (d) => (d.transitAccessible ? '#ffffff' : 'rgba(15, 23, 42, 0.55)'))
			.attr('stroke-width', (d) => d.strokeWBase * invK)
			.attr('opacity', 1)
			.selection()
			.style('pointer-events', 'auto');
	}

	function updateInsightMarkers() {
		if (!containerEl || !svgRef || !projectionRef) return;
		const layer = d3.select(containerEl).select('.insight-layer');
		const t = d3.transition().duration(250);
		if (!mismatchLayerOn || effectiveMismatchIds.size === 0) {
			layer.selectAll('g.insight-marker').transition(t).attr('opacity', 0).remove();
			return;
		}

		const rowsByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
		const candidates = (tractGeo?.features ?? [])
			.map((f) => {
				const id = f?.properties?.gisjoin;
				if (!id || !effectiveMismatchIds.has(id)) return null;
				const centroid = d3.geoPath(projectionRef).centroid(f);
				const row = rowsByGj.get(id);
				const tract = tractList.find((t) => t.gisjoin === id);
				const growth = Number(row?.census_hu_pct_change);
				const stops = Number(tract?.transit_stops);
				const type = mismatchFlagsByGj.get(id)?.isHighAccessLowGrowth
					? HIGH_ACCESS_LOW_GROWTH
					: HIGH_GROWTH_LOW_ACCESS;
				const score = type === HIGH_ACCESS_LOW_GROWTH
					? (Number.isFinite(stops) ? stops : 0) - (Number.isFinite(growth) ? growth : 0)
					: (Number.isFinite(growth) ? growth : 0) - (Number.isFinite(stops) ? stops : 0);
				return Number.isFinite(centroid[0]) && Number.isFinite(centroid[1])
					? { id, x: centroid[0], y: centroid[1], growth, stops, score, type, rHaloBase: 5.5, rDotBase: 2.2 }
					: null;
			})
			.filter(Boolean)
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
			.slice(0, revealStage >= 3 ? 5 : 4);

		const markers = layer
			.selectAll('g.insight-marker')
			.data(candidates, (d) => d.id)
			.join(
				(enter) => {
					const g = enter
						.append('g')
						.attr('class', 'insight-marker')
						.attr('opacity', 0)
						.style('cursor', 'help')
						.on('mouseenter', handleInsightEnter)
						.on('mousemove', handleMouseMove)
						.on('mouseleave', handleOverlayLeave)
						.on('click', handleInsightClick);
					g.append('circle').attr('class', 'insight-marker__halo').attr('r', 10);
					g.append('circle').attr('class', 'insight-marker__dot').attr('r', 4);
					return g;
				},
				(update) => update,
				(exit) => exit.transition(t).attr('opacity', 0).remove()
			);

		markers
			.transition(t)
			.attr('transform', (d) => `translate(${d.x},${d.y})`)
			.attr('opacity', 1);
		const invK = 1 / d3.zoomTransform(svgRef.node()).k;
		markers.each(function (d) {
			const g = d3.select(this);
			g.select('circle.insight-marker__halo')
				.attr('r', (d?.rHaloBase ?? 5.5) * invK)
				.attr('stroke-width', 0.9 * invK);
			g.select('circle.insight-marker__dot')
				.attr('r', (d?.rDotBase ?? 2.2) * invK)
				.attr('stroke-width', 0.8 * invK);
		});
	}

	function updateOverlays() {
		if (!containerEl || !svgRef) return;

		const lineVis = {
			rail: panelState.showRailLines,
			commuter_rail: panelState.showCommuterRailLines,
			bus: panelState.showBusLines
		};
		const stopVis = {
			rail: panelState.showRailStops,
			commuter_rail: panelState.showCommuterRailStops,
			bus: panelState.showBusStops
		};

		d3.select(containerEl).selectAll('path.mbta-line')
			.attr('display', (d) => {
				const mode = lineMode(d.properties?.route_type);
				return lineVis[mode] ? null : 'none';
			});

		d3.select(containerEl).selectAll('circle.mbta-stop')
			.attr('display', (d) => {
				const modes = d.modes ?? [];
				const visible = modes.some((m) => stopVis[m]);
				return visible ? null : 'none';
			});
	}

	function updateSelection() {
		if (!containerEl) return;
		const hoveredId = panelState.hoveredTract;
		const selectedSet = panelState.selectedTracts;
		const rowByGj = containerEl.__pocRowByGj;
		const spotlight = activeSpotlight;
		d3.select(containerEl)
			.selectAll('path.tract-poly')
			.attr('stroke', (d) => {
				const id = d.properties?.gisjoin;
				if (id === hoveredId) return '#ffffff';
				if (selectedSet.has(id)) return 'var(--cat-a, #6366f1)';
				if (effectiveMismatchIds.has(id)) {
					return mismatchKind(id) === 'ha_lg' ? MISMATCH_STROKE_HA : MISMATCH_STROKE_HG;
				}
				const row = rowByGj?.get(id);
				if (revealStage < 1) return 'rgba(60,64,67,0.18)';
				return devClassStroke(row);
			})
			.attr('stroke-dasharray', (d) => {
				const id = d.properties?.gisjoin;
				if (id === hoveredId || selectedSet.has(id)) return 'none';
				if (!effectiveMismatchIds.has(id)) return 'none';
				return mismatchKind(id) === 'hg_la' ? '6 5' : 'none';
			})
			.attr('stroke-width', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj?.get(id);
				const dc = row?.devClass;
				if (id === hoveredId) return dc === 'minimal' ? 2 : 3.6;
				if (selectedSet.has(id)) return dc === 'minimal' ? 1.7 : 3;
				if (effectiveMismatchIds.has(id)) {
					return mismatchKind(id) === 'ha_lg' ? MISMATCH_W_HA : MISMATCH_W_HG;
				}
				if (revealStage < 1) return 0.45;
				if (!dc) return 0.5;
				if (isSpotlightMatch(row, spotlight)) return dc === 'minimal' ? 1.8 : 3.2;
				return dc === 'tod_dominated' ? 2.8 : dc === 'minimal' ? 1.1 : 2.1;
			})
			.attr('stroke-opacity', (d) => {
				const id = d.properties?.gisjoin;
				if (id === hoveredId || selectedSet.has(id)) return 1;
				if (effectiveMismatchIds.has(id)) return MISMATCH_STROKE_OPACITY;
				if (mismatchLayerOn) {
					const row = rowByGj?.get(id);
					const dc = row?.devClass;
					if (dc === 'tod_dominated' || dc === 'nontod_dominated' || dc === 'minimal') return 0.38;
				}
				return 1;
			})
			.attr('opacity', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj?.get(id);
				if (id === hoveredId || selectedSet.has(id)) return 1;
				if (spotlight && !isSpotlightMatch(row, spotlight)) return 0.2;
				if (revealStage === 0) return 1;
				if (!mismatchLayerOn) return 1;
				const vis = effectiveMismatchIds.has(id);
				const mk = mismatchKind(id);
				if (hoveredMismatchCluster) {
					if (!vis) return NON_MISMATCH_DIM;
					if (mk === hoveredMismatchCluster) return 1;
					return 0.35;
				}
				if (focusMismatchOnly) return vis ? 1 : NON_MISMATCH_FOCUS_ONLY;
				return vis ? 1 : NON_MISMATCH_DIM;
			});
	}

	function handleTractEnter(event, d) {
		const id = d.properties?.gisjoin;
		panelState.setHovered(id);
		const mk = id ? mismatchKind(id) : null;
		hoveredMismatchCluster =
			mk && effectiveMismatchIds.has(id) ? mk : null;
		const el = containerEl;
		if (!el) return;
		const rowByGj = el.__pocRowByGj;
		const row = rowByGj?.get(id);
		const fmt = d3.format('.2f');
		const fmt1 = d3.format('.1f');
		const fmtInt = d3.format(',.0f');
		const tractLookup = buildTractLookup();
		const t = tractLookup.get(id);
		const county = t?.county;
		const tractPlace = county && String(county) !== 'County Name' ? String(county) : String(id);

		const huPct = row ? Number(row.census_hu_pct_change) : NaN;
		const pl = periodDisplayLabel(panelState.timePeriod);

		const mismatchFlag = mismatchFlagsByGj.get(id);
		const mismatchEyebrow =
			mismatchFlag?.isHighAccessLowGrowth
				? 'High access, low growth'
				: mismatchFlag?.isHighGrowthLowAccess
					? 'High growth, low access'
					: null;
		const tier =
			row?.devClass === 'tod_dominated'
				? 'TOD-dominated tract'
				: row?.devClass === 'nontod_dominated'
					? 'Non-TOD-dominated (significant dev)'
					: row?.devClass === 'minimal'
						? 'Minimal development'
						: 'Unclassified';
		const badgeTone =
			row?.devClass === 'tod_dominated'
				? 'tod'
				: row?.devClass === 'nontod_dominated'
					? 'nontod'
					: row?.devClass === 'minimal'
						? 'minimal'
						: 'neutral';
		const primaryRows = [
			{
				label: `Census % housing growth (${pl})`,
				value: Number.isFinite(huPct) ? `${fmt1(huPct)}%` : '—'
			}
		];
		const mhRow = row?.median_household_income ?? mismatchFlag?.medianHouseholdIncome;
		if (Number.isFinite(Number(mhRow))) {
			const mhNum = Number(mhRow);
			primaryRows.push({
				label: 'Median household income (period end)',
				value: d3.format('$,.0f')(mhNum)
			});
			primaryRows.push({
				label: 'Income group',
				value: mhNum < LOW_INCOME_MEDIAN_THRESHOLD ? 'Lower income (<$125k)' : '≥ $125k median'
			});
		}
		if (mismatchEyebrow && t) {
			const stopsRaw = Number(t.transit_stops) || 0;
			primaryRows.push({
				label: 'Transit access (approx. MBTA stops in tract)',
				value: fmtInt(stopsRaw)
			});
		}
		const secondaryRows = [];

		if (t) {
			const tp = panelState.timePeriod;
			const { startY, endY } = periodCensusBounds(tp);

			const pop = t[`pop_${endY}`] ?? t.pop_2020;
			if (pop != null) secondaryRows.push({ label: `Population (${endY})`, value: fmtInt(pop) });

			const huS = t[`total_hu_${startY}`];
			const huE = t[`total_hu_${endY}`];
			if (huS != null) secondaryRows.push({ label: `Housing units (${startY})`, value: fmtInt(huS) });
			if (huE != null) secondaryRows.push({ label: `Housing units (${endY})`, value: fmtInt(huE) });
			if (huS != null && huE != null) {
				const diff = huE - huS;
				const sign = diff >= 0 ? '+' : '';
				secondaryRows.push({ label: 'Net HU change (census)', value: `${sign}${fmtInt(diff)}` });
			}

			const m = tractTodMetricsMap?.get(id);
			if (m && Number.isFinite(m.totalNewUnits) && m.totalNewUnits > 0) {
				primaryRows.push({
					label: 'New units (MassBuilds)',
					value: fmtInt(m.totalNewUnits)
				});
			}
			if (m?.todFraction != null && Number.isFinite(m.todFraction)) {
				primaryRows.push({ label: 'TOD share of new dev units', value: `${fmt1(m.todFraction * 100)}%` });
			}
			if (m?.pctStockIncrease != null && Number.isFinite(m.pctStockIncrease)) {
				primaryRows.push({ label: 'Housing stock increase', value: `${fmt1(m.pctStockIncrease)}%` });
			}

			const agg = devAggMap?.get(id);
			if (agg?.new_units) {
				secondaryRows.push({ label: 'Filtered new units (sum)', value: fmtInt(agg.new_units) });
			}

			const stopsRaw = Number(t.transit_stops) || 0;
			if (!mismatchEyebrow) {
				secondaryRows.push({ label: 'MBTA stops (tract + buffer)', value: String(stopsRaw) });
			}

			const medInc = t[`median_income_change_pct_${tp}`];
			if (medInc != null && Number.isFinite(medInc)) {
				primaryRows.push({ label: `Median income change (${periodDisplayLabel(tp)})`, value: `${fmt1(medInc)}%` });
			}
		} else {
			secondaryRows.push({ label: 'Tract data', value: 'No tract attributes loaded' });
		}

		if (mismatchFlag?.isLowIncomeHighAccessLowGrowth) {
			secondaryRows.push({
				label: 'Pattern note',
				value: 'Lower-income tract where strong transit access has not paired with comparable housing growth.'
			});
		} else if (mismatchFlag?.isLowIncomeHighGrowthLowAccess) {
			secondaryRows.push({
				label: 'Pattern note',
				value: 'Lower-income tract where growth has been relatively strong despite weaker transit access.'
			});
		}

		tooltip = {
			visible: true,
			x: event.clientX,
			y: event.clientY,
			eyebrow: mismatchEyebrow ?? 'Census tract',
			title: county && String(county) !== 'County Name' ? `Tract in ${tractPlace}` : `Tract: ${tractPlace}`,
			badge: tier,
			badgeTone,
			primaryRows,
			secondaryRows
		};
	}

	function handleMouseMove(event) {
		tooltip = { ...tooltip, x: event.clientX, y: event.clientY };
	}

	function handleTractLeave() {
		panelState.setHovered(null);
		hoveredMismatchCluster = null;
		tooltip = { ...tooltip, visible: false };
	}

	function handleTractClick(event, d) {
		event.stopPropagation();
		const id = d.properties?.gisjoin;
		if (!id) return;
		panelState.toggleTract(id);
		// Shift-click builds explicit A/B tract comparison.
		if (event.shiftKey) panelState.toggleComparisonTract(id);
	}

	function handleStopEnter(event, d) {
		const routes = d.routes?.join(', ') || 'Unknown';
		const modes = (d.modes ?? []).map((m) => transitModeUiLabel(m)).join(', ') || 'Unknown';
		tooltip = {
			visible: true,
			x: event.clientX,
			y: event.clientY,
			eyebrow: 'Transit stop',
			title: d.name || 'MBTA Stop',
			badge: 'Transit stop',
			badgeTone: 'neutral',
			primaryRows: [
				{ label: 'Routes', value: routes },
				{ label: 'Mode', value: modes }
			],
			secondaryRows: []
		};
	}

	function handleLineEnter(event, d) {
		const props = d.properties ?? {};
		const name = props.route_long_name || props.route_short_name || props.route_id || 'MBTA Route';
		tooltip = {
			visible: true,
			x: event.clientX,
			y: event.clientY,
			eyebrow: 'Transit line',
			title: name,
			badge: 'MBTA line',
			badgeTone: 'neutral',
			primaryRows: [
				{ label: 'Route', value: props.route_short_name || props.route_id || '—' }
			],
			secondaryRows: []
		};
	}

	function handleDevEnter(event, d) {
		const fmtPct = d3.format('.1f');
		const primaryRows = [
			{ label: 'Municipality', value: d.municipal || '—' },
			{ label: 'Units', value: String(d.hu ?? '—') }
		];
		const secondaryRows = [];
		const mf = developmentMultifamilyShare(d);
		if (mf != null && Number.isFinite(mf)) {
			primaryRows.push({ label: 'Multifamily share', value: `${fmtPct(mf * 100)}%` });
		}
		const transitM = transitDistanceMiToMetres(panelState.transitDistanceMi ?? 0.5);
		const todMi = panelState.transitDistanceMi ?? 0.5;
		const prox = developmentMbtaProximity(d, mbtaStops, transitM);
		const access =
			isDevelopmentTransitAccessible(d, transitM) && meetsTodMultifamilyFloor(d, panelState);
		const nearestM = prox.nearestDistM;
		const nWithin = prox.stopsWithinRadius;
		if (nearestM != null && Number.isFinite(nearestM)) {
			secondaryRows.push({
				label: 'Nearest stop',
				value: `${nearestM.toFixed(0)} m${access ? ' (within TOD radius)' : ''}`
			});
		} else {
			secondaryRows.push({ label: 'Nearest stop', value: '—' });
		}
		secondaryRows.push({ label: `Stops within ${todMi} mi`, value: String(nWithin) });
		const affCap = developmentAffordableUnitsCapped(d);
		if (affCap > 0) {
			const src = d.affrd_source === 'lihtc' ? ' (HUD LIHTC)' : '';
			primaryRows.push({ label: 'Affordable units', value: `${affCap}${src}` });
		}
		secondaryRows.push({ label: 'Type', value: d.mixed_use ? 'Mixed-use' : 'Residential' });
		if (d.rdv) secondaryRows.push({ label: 'Redevelopment', value: 'Yes' });
		tooltip = {
			visible: true,
			x: event.clientX,
			y: event.clientY,
			eyebrow: 'MassBuilds project',
			title: `Development: ${d.name || 'Unnamed project'}`,
			badge: access ? 'Transit-accessible' : 'Not transit-accessible',
			badgeTone: access ? 'tod' : 'minimal',
			primaryRows,
			secondaryRows
		};
	}

	function handleOverlayLeave() {
		panelState.setHovered(null);
		hoveredMismatchCluster = null;
		tooltip = { ...tooltip, visible: false };
	}

	function handleInsightEnter(event, d) {
		const modeLabel =
			d.type === HIGH_ACCESS_LOW_GROWTH
				? 'High access + low growth'
				: 'High growth + low access';
		hoveredMismatchCluster = d.type === HIGH_ACCESS_LOW_GROWTH ? 'ha_lg' : 'hg_la';
		tooltip = {
			visible: true,
			x: event.clientX,
			y: event.clientY,
			eyebrow: 'Insight marker',
			title: modeLabel,
			badge: 'Mismatch tract',
			badgeTone: 'nontod',
			primaryRows: [
				{ label: 'Housing growth', value: Number.isFinite(d.growth) ? `${d3.format('.1f')(d.growth)}%` : '—' },
				{ label: 'Transit stops', value: Number.isFinite(d.stops) ? d3.format(',.0f')(d.stops) : '—' }
			],
			secondaryRows: [
				{
					label: 'Why flagged',
					value:
						d.type === HIGH_ACCESS_LOW_GROWTH
							? 'High stop access but relatively weak housing growth.'
							: 'Strong housing growth despite relatively low stop access.'
				}
			]
		};
	}

	function handleInsightClick(event, d) {
		event.stopPropagation();
		if (!d?.id) return;
		zoomToTract(d.id);
		if (!panelState.selectedTracts.has(d.id)) {
			panelState.toggleTract(d.id);
		}
		panelState.setLastInteracted(d.id);
	}

	const overlayKey = $derived(
		JSON.stringify({
			busL: panelState.showBusLines,
			railL: panelState.showRailLines,
			crL: panelState.showCommuterRailLines,
			busS: panelState.showBusStops,
			railS: panelState.showRailStops,
			crS: panelState.showCommuterRailStops
		})
	);

	const activeSpotlight = $derived(hoveredSpotlight ?? pinnedSpotlight);
	const spotlightSummary = $derived.by(() => {
		const spotlight = activeSpotlight;
		if (!spotlight) return null;
		const rows = (nhgisRows ?? []).filter((row) => row?.devClass === spotlight && passesGrowthFilter(row));
		if (!rows.length) {
			return {
				label: cohortLabel(spotlight),
				description: spotlightDescription(spotlight),
				count: 0,
				avgHuGrowth: null,
				avgTodShare: null,
				avgStockIncrease: null
			};
		}
		const huVals = rows
			.map((row) => Number(row.census_hu_pct_change))
			.filter(Number.isFinite);
		const metricVals = rows
			.map((row) => tractTodMetricsMap?.get(row.gisjoin))
			.filter(Boolean);
		const todShares = metricVals
			.map((m) => Number(m.todFraction))
			.filter(Number.isFinite);
		const stockIncreases = metricVals
			.map((m) => Number(m.pctStockIncrease))
			.filter(Number.isFinite);
		return {
			label: cohortLabel(spotlight),
			description: spotlightDescription(spotlight),
			count: rows.length,
			avgHuGrowth: huVals.length ? d3.mean(huVals) : null,
			avgTodShare: todShares.length ? d3.mean(todShares) : null,
			avgStockIncrease: stockIncreases.length ? d3.mean(stockIncreases) : null
		};
	});

	const focusedSelection = $derived.by(() => {
		const selected = [...panelState.selectedTracts];
		if (!selected.length) return null;
		return panelState.lastInteractedGisjoin && panelState.selectedTracts.has(panelState.lastInteractedGisjoin)
			? panelState.lastInteractedGisjoin
			: selected[0];
	});

	const selectedTractDetail = $derived.by(() => {
		const gisjoin = focusedSelection;
		if (!gisjoin) return null;
		const tract = tractList.find((t) => t.gisjoin === gisjoin) ?? null;
		const row = (nhgisRows ?? []).find((r) => r.gisjoin === gisjoin) ?? null;
		if (!tract && !row) return null;
		const metric = tractTodMetricsMap?.get(gisjoin) ?? null;
		const devClass = row?.devClass ?? null;
		const cohortRows = (nhgisRows ?? []).filter((r) => r?.devClass === devClass && passesGrowthFilter(r));
		const cohortHu = cohortRows
			.map((r) => Number(r.census_hu_pct_change))
			.filter(Number.isFinite);
		const cohortAvgHu = cohortHu.length ? d3.mean(cohortHu) : null;
		const county = tract?.county && String(tract.county) !== 'County Name' ? String(tract.county) : null;
		return {
			gisjoin,
			title: county ? `Tract in ${county}` : `Tract ${gisjoin}`,
			cohortLabel: cohortLabel(devClass),
			description: spotlightDescription(devClass),
			countSelected: panelState.selectedTracts.size,
			huGrowth: row && Number.isFinite(Number(row.census_hu_pct_change)) ? Number(row.census_hu_pct_change) : null,
			cohortAvgHu,
			todShare: metric && Number.isFinite(Number(metric.todFraction)) ? Number(metric.todFraction) : null,
			stockIncrease: metric && Number.isFinite(Number(metric.pctStockIncrease)) ? Number(metric.pctStockIncrease) : null,
			newUnits: metric && Number.isFinite(Number(metric.totalNewUnits)) ? Number(metric.totalNewUnits) : null
		};
	});

	const selectionComparison = $derived.by(() => {
		const selectedIds = [...panelState.selectedTracts];
		const metricValue = (rows) => {
			const huVals = rows.map((row) => Number(row.census_hu_pct_change)).filter(Number.isFinite);
			const metricVals = rows.map((row) => tractTodMetricsMap?.get(row.gisjoin)).filter(Boolean);
			const todShares = metricVals.map((m) => Number(m.todFraction) * 100).filter(Number.isFinite);
			const stockIncreases = metricVals.map((m) => Number(m.pctStockIncrease)).filter(Number.isFinite);
			return comparisonMetric === 'hu_growth'
				? (huVals.length ? d3.mean(huVals) : null)
				: comparisonMetric === 'tod_share'
					? (todShares.length ? d3.mean(todShares) : null)
					: (stockIncreases.length ? d3.mean(stockIncreases) : null);
		};
		/** @type {Array<{ key: string; label: string; value: number | null; count: number }>} */
		let rows;
		let title;
		let copy;

		if (selectedIds.length) {
			const selectedRows = (nhgisRows ?? []).filter(
				(row) => selectedIds.includes(row.gisjoin) && passesGrowthFilter(row)
			);
			const focusedRow = focusedSelection
				? (nhgisRows ?? []).find((row) => row.gisjoin === focusedSelection) ?? null
				: null;
			const focusedClass = focusedRow?.devClass ?? selectedRows[0]?.devClass ?? null;
			const cohortRows = (nhgisRows ?? []).filter(
				(row) => row?.devClass === focusedClass && passesGrowthFilter(row)
			);
			const allRows = (nhgisRows ?? []).filter((row) => passesGrowthFilter(row));
			rows = [
				{
					key: 'selected',
					label: 'Selected tracts',
					value: metricValue(selectedRows),
					count: selectedRows.length
				},
				{
					key: 'cohort',
					label: `${cohortLabel(focusedClass)} avg.`,
					value: metricValue(cohortRows),
					count: cohortRows.length
				},
				{
					key: 'all',
					label: 'All analyzed tracts',
					value: metricValue(allRows),
					count: allRows.length
				}
			];
			title = 'Compare your map selection';
			copy = 'The bars update from the tracts you click on the map and compare them to the matching cohort and full analyzed set.';
		} else {
			/** @type {Array<'tod_dominated' | 'nontod_dominated' | 'minimal'>} */
			const order = ['tod_dominated', 'nontod_dominated', 'minimal'];
			rows = order.map((devClass) => {
				const cohortRows = (nhgisRows ?? []).filter(
					(row) => row?.devClass === devClass && passesGrowthFilter(row)
				);
				return {
					key: devClass,
					label: cohortLabel(devClass),
					value: metricValue(cohortRows),
					count: cohortRows.length
				};
			});
			title = 'Compare the tract groups';
			copy = 'Once you click map tracts, this chart will switch to a selection-based comparison.';
		}
		const maxValue = d3.max(rows, (row) => Math.abs(Number(row.value) || 0)) || 1;
		return {
			title,
			copy,
			rows: rows.map((row) => ({
				...row,
				widthPct: row.value == null ? 0 : Math.max(6, (Math.abs(row.value) / maxValue) * 100)
			}))
		};
	});

	const comparisonMetricMeta = $derived.by(() => {
		if (comparisonMetric === 'tod_share') {
			return { label: 'Avg. TOD share', suffix: '%', formatter: d3.format('.1f') };
		}
		if (comparisonMetric === 'stock_increase') {
			return { label: 'Avg. housing stock increase', suffix: '%', formatter: d3.format('.1f') };
		}
		return { label: 'Avg. housing growth', suffix: '%', formatter: d3.format('.1f') };
	});

	const comparisonPairDetails = $derived.by(() => {
		const pair = panelState.comparisonPair ?? [];
		if (!pair.length) return [];
		const rowByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
		return pair.map((id) => {
			const row = rowByGj.get(id) ?? null;
			const metric = tractTodMetricsMap?.get(id) ?? null;
			const tract = tractList.find((t) => t.gisjoin === id) ?? null;
			return {
				id,
				label: tract?.county && String(tract.county) !== 'County Name' ? `Tract in ${tract.county}` : id,
				cohort: cohortLabel(row?.devClass),
				huGrowth: Number.isFinite(Number(row?.census_hu_pct_change)) ? Number(row.census_hu_pct_change) : null,
				todShare: Number.isFinite(Number(metric?.todFraction)) ? Number(metric.todFraction) : null,
				stockIncrease: Number.isFinite(Number(metric?.pctStockIncrease)) ? Number(metric.pctStockIncrease) : null,
				newUnits: Number.isFinite(Number(metric?.totalNewUnits)) ? Number(metric.totalNewUnits) : null,
				stops: Number.isFinite(Number(tract?.transit_stops)) ? Number(tract.transit_stops) : null
			};
		});
	});

	$effect(() => {
		void structuralKey;
		void containerEl;
		if (!containerEl) return;
		if (structuralKey !== lastStructuralKey) {
			lastStructuralKey = structuralKey;
			rebuildSVG();
			updateChoropleth();
			updateDevelopments();
			updateOverlays();
			updateSelection();
		}
	});

	$effect(() => {
		void dataKey;
		void revealStage;
		void activeSpotlight;
		void focusMismatchOnly;
		void focusLowIncomeTracts;
		void hoveredMismatchCluster;
		void mismatchOutlineMode;
		void panelState.hoveredTract;
		void panelState.selectedTracts;
		void panelState.selectedTracts.size;
		if (!containerEl || !svgRef) return;
		updateChoropleth();
		updateDevelopments();
		updateInsightMarkers();
		updateSelection();
	});

	$effect(() => {
		void overlayKey;
		if (!containerEl || !svgRef) return;
		updateOverlays();
	});

	$effect(() => {
		void panelState.hoveredTract;
		void panelState.selectedTracts;
		void panelState.selectedTracts.size;
		void focusMismatchOnly;
		void focusLowIncomeTracts;
		void hoveredMismatchCluster;
		void mismatchOutlineMode;
		if (!containerEl || !svgRef) return;
		updateSelection();
		updateInsightMarkers();
	});

	$effect(() => {
		if (stepEls.filter(Boolean).length !== stepContent.length) return;
		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((entry) => entry.isIntersecting)
					.sort((a, b) => b.intersectionRatio - a.intersectionRatio);
				if (!visible.length) return;
				const next = Number(visible[0].target.getAttribute('data-step-index'));
				if (Number.isFinite(next)) revealStage = next;
			},
			{
				root: null,
				threshold: [0.35, 0.6, 0.85],
				rootMargin: '-10% 0px -30% 0px'
			}
		);
		for (const el of stepEls) {
			if (el) observer.observe(el);
		}
		return () => observer.disconnect();
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		let raf = 0;
		const onResize = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				chartResizeTick += 1;
			});
		};
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
			cancelAnimationFrame(raf);
		};
	});

	$effect(() => {
		void chartResizeTick;
		const state = supplementalChartState;
		if (elComposition) renderMuniComposition(elComposition, supplementalProjectRows, state);
		if (elRanked) renderMuniRankedGrowth(elRanked, supplementalMuniRows);
	});

	onDestroy(() => {
		if (containerEl) d3.select(containerEl).selectAll('*').remove();
		lastStructuralKey = '';
		svgRef = null;
		projectionRef = null;
	});
</script>

<div class="poc-nhgis-map">
	<div class="poc-scrolly">
		<div class="poc-scrolly-map">
			<div class="poc-methods poc-methods--lead card-key" role="note" aria-label="TOD definitions">
				<p class="poc-methods__title">Definitions</p>
				<p class="poc-methods__text">
					<strong>TOD developments</strong> are projects within <strong>{d3.format('.2~f')(panelState.transitDistanceMi ?? 0.5)} miles</strong> of an MBTA stop; other projects are treated as <strong>non-TOD developments</strong>.
					<strong>TOD-dominated tracts</strong> are tracts with at least <strong>{d3.format('.0f')((panelState.todFractionCutoff ?? 0.5) * 100)}%</strong> of filtered new units in TOD developments and at least <strong>{d3.format('.1f')(panelState.sigDevMinPctStockIncrease ?? 2)}%</strong> housing stock increase.
					<strong>Non-TOD-dominated tracts</strong> meet the same development threshold but fall below that TOD share cutoff.
					<strong>Minimal development</strong> tracts stay below the stock-increase threshold.
				</p>
			</div>
			<div class="poc-methods poc-methods--encoding card-key" role="note" aria-label="Visual encoding and scrolly map">
				<p class="poc-methods__title">How to read this map</p>
				<ul class="poc-methods__list poc-methods__list--encoding">
					<li>
						<span class="poc-methods__label">Fill (choropleth):</span>
						Census % change in housing units for the selected period (diverging red–neutral–blue). This is the primary encoding; it does not change across scroll steps.
					</li>
					<li>
						<span class="poc-methods__label">Cohort outlines (steps 2–4):</span>
						Teal / orange / slate rings show MassBuilds-derived tract classes (TOD-dominated, non-TOD-dominated, minimal development), with a light interior tint—not a second color scale for growth.
					</li>
					<li>
						<span class="poc-methods__label">Mismatch overlays (steps 3–4):</span>
						Violet and dashed lavender mark quartile-based “access vs growth” tension (transit stops vs census growth). Outlines only—so the story stays tied to the choropleth. Step 3 introduces one mismatch type; step 4 adds the second; step 4 can add optional project dots.
					</li>
					<li>
						<span class="poc-methods__label">Scrolly structure:</span>
						Each step adds at most one layer (fill → cohorts → first mismatch → both mismatches + dots) to limit cognitive load. Toggles (mismatch-only, low-income emphasis) are optional filters for when the field feels dense.
					</li>
					<li>
						<span class="poc-methods__label">Income:</span>
						Median income and “lower income” (&lt;$125k) appear in tooltips and supplementary charts—not as map fill—so the view stays legible.
					</li>
				</ul>
			</div>
			<div class="poc-methods poc-methods--assumptions card-key" role="note" aria-label="Assumptions used">
				<p class="poc-methods__title">Assumptions Used</p>
				<ul class="poc-methods__list">
					<li>
						<span class="poc-methods__label">TOD access assumption:</span>
						Distance to MBTA is approximated with a fixed cutoff of
						<strong> {d3.format('.2~f')(panelState.transitDistanceMi ?? 0.5)} miles</strong>.
					</li>
					<li>
						<span class="poc-methods__label">Tract grouping assumption:</span>
						Classification uses
						<strong> {d3.format('.1f')(panelState.sigDevMinPctStockIncrease ?? 2)}%</strong> housing stock increase as the significant-development floor and
						<strong> {d3.format('.0f')((panelState.todFractionCutoff ?? 0.5) * 100)}%</strong> TOD share as the TOD-dominated cutoff.
					</li>
					<li>
						<span class="poc-methods__label">Aggregation assumption:</span>
						Displayed averages are simple tract-level means (each tract weighted equally), not weighted by tract population or unit counts.
					</li>
					<li>
						<span class="poc-methods__label">Data quality assumption:</span>
						Tan tracts are excluded from choropleth interpretation when % change is missing or unreliable.
					</li>
				</ul>
			</div>

			<div class="map-wrap">
				<div class="map-left-column">
					<div class="poc-legend-row">
				<fieldset class="poc-transit-field">
					<legend class="poc-transit-legend">MBTA Overlays</legend>
					<div class="poc-transit-compact" role="group" aria-label="Transit overlays">
						<div class="poc-t-row">
							<span class="poc-t-h"></span>
							<span class="poc-t-h">Lines</span>
							<span class="poc-t-h">Stops</span>
						</div>
						<div class="poc-t-row">
							<span class="poc-t-l">Bus</span>
							<label class="poc-t-cell"><input type="checkbox" bind:checked={panelState.showBusLines} /></label>
							<label class="poc-t-cell"><input type="checkbox" bind:checked={panelState.showBusStops} /></label>
						</div>
						<div class="poc-t-row">
							<span class="poc-t-l">Rapid Transit</span>
							<label class="poc-t-cell"><input type="checkbox" bind:checked={panelState.showRailLines} /></label>
							<label class="poc-t-cell"><input type="checkbox" bind:checked={panelState.showRailStops} /></label>
						</div>
						<div class="poc-t-row">
							<span class="poc-t-l">Commuter Rail</span>
							<label class="poc-t-cell"><input type="checkbox" bind:checked={panelState.showCommuterRailLines} /></label>
							<label class="poc-t-cell"><input type="checkbox" bind:checked={panelState.showCommuterRailStops} /></label>
						</div>
					</div>
				</fieldset>

				<div class="poc-map-key card-key" role="region" aria-label="Map legend">
					<div
						class="poc-map-key-compact"
						class:poc-map-key-compact--split={revealStage >= 3}
					>
						<div class="poc-map-key-col poc-map-key-col--tract">
							<p class="poc-key-one poc-key-tract-fill">
								<strong>Tract fill</strong>
								<span class="poc-key-tract-fill-body">
									<span class="poc-key-tract-fill-line">
										Census % housing growth ({periodDisplayLabel(panelState.timePeriod)}), vs housing stock at period start. Full scale on map colorbar.
									</span>
									<span
										class="poc-key-tract-bar"
										style="background: linear-gradient(to right, {MBTA_RED}, {MBTA_MAP_NEUTRAL}, {MBTA_BLUE});"
										role="img"
										aria-label="Percent housing growth scale: more negative toward red, more positive toward blue"
									></span>
									<span class="poc-key-tract-bar-labels" aria-hidden="true">
										<span class="poc-key-tract-bar-label">- lower growth</span>
										<span class="poc-key-tract-bar-label">+ higher growth</span>
									</span>
								</span>
							</p>
							<p class="poc-key-no-data">
								<span
									class="poc-key-fill-swatch poc-key-fill-swatch--no-data"
									style="background: #e7e0d5;"
									role="img"
									aria-hidden="true"
								></span>
								<span class="poc-key-no-data-text">Tan fill: excluded due to limited data (missing or unreliable % change).</span>
							</p>
							{#if revealStage >= 1}
								<ul class="poc-key-rings">
									<li><span class="poc-k-ring poc-k-ring--tod"></span> TOD-dominated (significant development)</li>
									<li><span class="poc-k-ring poc-k-ring--nontod"></span> Non-TOD-dominated (significant development)</li>
									<li><span class="poc-k-ring poc-k-ring--min"></span> Minimal development</li>
								</ul>
							{/if}
							{#if revealStage >= 2}
								<p class="poc-key-mismatch-sub">
									Mismatch outlines (quartiles): transit access vs housing growth are not always aligned—see charts below for income context.
								</p>
								<ul class="poc-key-rings">
									<li>
										<span class="poc-k-ring poc-k-ring--mismatch-ha"></span> High access, low growth (solid purple)
									</li>
									<li>
										<span class="poc-k-ring poc-k-ring--mismatch-hg"></span> High growth, low access (dashed lavender)
									</li>
								</ul>
							{/if}
						</div>
						{#if revealStage >= 3}
							<div class="poc-map-key-col poc-map-key-col--dev">
								<p class="poc-key-one poc-key-dev">
									<strong>Developments</strong>
									<span class="poc-key-tract-fill-body">
										<span class="poc-key-tract-fill-line">
											Fill = share of new units that are multi-family. Full scale on map colorbar.
										</span>
										<span
											class="poc-key-tract-bar"
											style="background: linear-gradient(to right, {MBTA_ORANGE}, {MBTA_GREEN});"
											role="img"
											aria-label="Share of new units that are multi-family: lower toward orange, higher toward green"
										></span>
									</span>
								</p>
								{#if devSizeLegendTicks && devSizeLegendTicks.length > 0}
									<div class="poc-key-dev-sizes" aria-label="Development dot size by unit count">
										<p class="poc-key-dev-sizes-title">Units (radius ∝ √units, same as map)</p>
										<ul class="poc-key-dev-sizes-list">
											{#each devSizeLegendTicks as t, i (i)}
												<li class="poc-key-dev-size-item">
													<span class="poc-key-dev-size-dot-wrap">
														<span
															class="poc-key-dev-size-dot"
															style:width="{2 * t.rPx}px"
															style:height="{2 * t.rPx}px"
														></span>
													</span>
													<span class="poc-key-dev-size-num">{formatDevUnitsLegend(t.units)}</span>
												</li>
											{/each}
										</ul>
									</div>
								{/if}
								<ul class="poc-key-rings" aria-label="Development dot outlines">
									<li>
										<span class="poc-k-ring poc-k-ring--dev-access"></span> Transit-accessible
									</li>
									<li>
										<span class="poc-k-ring poc-k-ring--dev-noaccess"></span> Not transit-accessible
									</li>
								</ul>
							</div>
						{/if}
					</div>
				</div>
				</div>

				<div
					class="map-main"
					role="region"
					aria-label="Interactive census tract map"
					onmouseleave={handleOverlayLeave}
				>
					<div class="poc-stage-chip">Map step {revealStage + 1} of 4</div>
					<div class="poc-map-callouts card-key" role="note" aria-label="What to notice in this step">
						<p class="poc-detail__kicker">What to notice</p>
						<ul class="poc-map-callouts__list">
							{#each mapCallouts as c, i (i)}
								<li>{c}</li>
							{/each}
						</ul>
					</div>
					<div class="map-widget">
						<div class="map-widget__controls" role="group" aria-label="Map zoom and reset controls">
							<button class="poc-map-control" type="button" onclick={zoomInMap} aria-label="Zoom in">+</button>
							<button class="poc-map-control" type="button" onclick={zoomOutMap} aria-label="Zoom out">−</button>
							<button class="poc-map-control poc-map-control--wide" type="button" onclick={recenterMap}>Recenter</button>
						</div>
						<div class="map-root" bind:this={containerEl}></div>
					</div>
					{#if tooltip.visible}
						<div
							class="map-tooltip"
							style:left="{tooltip.x + 12}px"
							style:top="{tooltip.y + 12}px"
						>
							<div class="map-tooltip__header">
								<div class="map-tooltip__header-copy">
									{#if tooltip.eyebrow}
										<p class="map-tooltip__eyebrow">{tooltip.eyebrow}</p>
									{/if}
									<p class="map-tooltip__title">{tooltip.title}</p>
								</div>
								{#if tooltip.badge}
									<span class="map-tooltip__badge map-tooltip__badge--{tooltip.badgeTone}">{tooltip.badge}</span>
								{/if}
							</div>
							{#if tooltip.primaryRows.length > 0}
								<div
									class="map-tooltip__primary"
									class:map-tooltip__primary--tod={tooltip.badgeTone === 'tod'}
									class:map-tooltip__primary--nontod={tooltip.badgeTone === 'nontod'}
									class:map-tooltip__primary--minimal={tooltip.badgeTone === 'minimal'}
								>
									{#each tooltip.primaryRows as row, i (i)}
										<div class="map-tooltip__primary-row">
											<span class="map-tooltip__primary-label">{row.label}</span>
											<span class="map-tooltip__primary-value">{row.value}</span>
										</div>
									{/each}
								</div>
							{/if}
							{#if tooltip.secondaryRows.length > 0}
								<div class="map-tooltip__details">
									<p class="map-tooltip__details-label">Details</p>
									<div class="map-tooltip__rows">
										{#each tooltip.secondaryRows as row, i (i)}
											<div class="map-tooltip__row">
												<span class="map-tooltip__label">{row.label}</span>
												<span class="map-tooltip__value">{row.value}</span>
											</div>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="poc-control-stack">
				<div class="poc-side-cards">

				<div class="poc-spotlight card-key" role="group" aria-label="Tract cohort spotlight">
					<div class="poc-spotlight__head">
						<p class="poc-spotlight__kicker">Cohort spotlight</p>
						{#if pinnedSpotlight}
							<button
								class="poc-spotlight__clear"
								type="button"
								onclick={() => {
									pinnedSpotlight = null;
									hoveredSpotlight = null;
								}}
							>
								Clear
							</button>
						{/if}
					</div>
					<div class="poc-spotlight__buttons">
						<button
							type="button"
							class="poc-spotlight__button"
							class:poc-spotlight__button--active={activeSpotlight === 'tod_dominated'}
							data-tone="tod"
							onmouseenter={() => (hoveredSpotlight = 'tod_dominated')}
							onmouseleave={() => (hoveredSpotlight = null)}
							onfocus={() => (hoveredSpotlight = 'tod_dominated')}
							onblur={() => (hoveredSpotlight = null)}
							onclick={() => (pinnedSpotlight = pinnedSpotlight === 'tod_dominated' ? null : 'tod_dominated')}
						>
							TOD-dominated
						</button>
						<button
							type="button"
							class="poc-spotlight__button"
							class:poc-spotlight__button--active={activeSpotlight === 'nontod_dominated'}
							data-tone="nontod"
							onmouseenter={() => (hoveredSpotlight = 'nontod_dominated')}
							onmouseleave={() => (hoveredSpotlight = null)}
							onfocus={() => (hoveredSpotlight = 'nontod_dominated')}
							onblur={() => (hoveredSpotlight = null)}
							onclick={() => (pinnedSpotlight = pinnedSpotlight === 'nontod_dominated' ? null : 'nontod_dominated')}
						>
							Non-TOD-dominated
						</button>
						<button
							type="button"
							class="poc-spotlight__button"
							class:poc-spotlight__button--active={activeSpotlight === 'minimal'}
							data-tone="minimal"
							onmouseenter={() => (hoveredSpotlight = 'minimal')}
							onmouseleave={() => (hoveredSpotlight = null)}
							onfocus={() => (hoveredSpotlight = 'minimal')}
							onblur={() => (hoveredSpotlight = null)}
							onclick={() => (pinnedSpotlight = pinnedSpotlight === 'minimal' ? null : 'minimal')}
						>
							Minimal development
						</button>
					</div>
					{#if spotlightSummary}
						<div class="poc-spotlight__summary">
							<p class="poc-spotlight__summary-title">{spotlightSummary.label}</p>
							<p class="poc-spotlight__summary-copy">{spotlightSummary.description}</p>
							<div class="poc-spotlight__stats">
								<div>
									<span class="poc-spotlight__stat-label">Tracts</span>
									<span class="poc-spotlight__stat-value">{spotlightSummary.count}</span>
								</div>
								<div>
									<span class="poc-spotlight__stat-label">Avg. housing growth</span>
									<span class="poc-spotlight__stat-value">
										{spotlightSummary.avgHuGrowth == null ? '—' : `${d3.format('.1f')(spotlightSummary.avgHuGrowth)}%`}
									</span>
								</div>
								<div>
									<span class="poc-spotlight__stat-label">Avg. TOD share</span>
									<span class="poc-spotlight__stat-value">
										{spotlightSummary.avgTodShare == null ? '—' : `${d3.format('.1f')(spotlightSummary.avgTodShare * 100)}%`}
									</span>
								</div>
								<div>
									<span class="poc-spotlight__stat-label">Avg. housing stock increase</span>
									<span class="poc-spotlight__stat-value">
										{spotlightSummary.avgStockIncrease == null ? '—' : `${d3.format('.1f')(spotlightSummary.avgStockIncrease)}%`}
									</span>
								</div>
							</div>
						</div>
					{/if}
				</div>

					{#if selectedTractDetail}
						<div class="poc-detail card-key" role="region" aria-label="Selected tract detail">
							<div class="poc-detail__head">
								<div>
									<p class="poc-detail__kicker">Selected tract detail</p>
									<p class="poc-detail__title">{selectedTractDetail.title}</p>
								</div>
							<div class="poc-detail__actions">
								<button
									type="button"
									class="poc-detail__btn"
									onclick={() => zoomToTract(selectedTractDetail.gisjoin)}
								>
									Zoom to tract
								</button>
								<button
									type="button"
									class="poc-detail__btn poc-detail__btn--ghost"
									onclick={() => panelState.clearSelection()}
								>
									Clear
									</button>
								</div>
							</div>
							<div class="poc-detail__topline">
								<span class="poc-detail__cohort">{selectedTractDetail.cohortLabel}</span>
								{#if selectedTractDetail.description}
									<span class="poc-detail__summary">{selectedTractDetail.description}</span>
								{/if}
							</div>
							<div class="poc-detail__primary">
								<div class="poc-detail__hero">
									<span class="poc-detail__stat-label">Housing growth</span>
									<span class="poc-detail__hero-value">
										{selectedTractDetail.huGrowth == null ? '—' : `${d3.format('.1f')(selectedTractDetail.huGrowth)}%`}
									</span>
								</div>
								<div class="poc-detail__hero">
									<span class="poc-detail__stat-label">Cohort avg.</span>
									<span class="poc-detail__hero-value">
										{selectedTractDetail.cohortAvgHu == null ? '—' : `${d3.format('.1f')(selectedTractDetail.cohortAvgHu)}%`}
									</span>
								</div>
							</div>
							<div class="poc-detail__stats">
								<div>
									<span class="poc-detail__stat-label">TOD share</span>
									<span class="poc-detail__stat-value">
										{selectedTractDetail.todShare == null ? '—' : `${d3.format('.1f')(selectedTractDetail.todShare * 100)}%`}
									</span>
								</div>
								<div>
									<span class="poc-detail__stat-label">Housing stock increase</span>
									<span class="poc-detail__stat-value">
										{selectedTractDetail.stockIncrease == null ? '—' : `${d3.format('.1f')(selectedTractDetail.stockIncrease)}%`}
									</span>
								</div>
								<div>
									<span class="poc-detail__stat-label">New units</span>
									<span class="poc-detail__stat-value">
										{selectedTractDetail.newUnits == null ? '—' : d3.format(',.0f')(selectedTractDetail.newUnits)}
									</span>
								</div>
								<div>
									<span class="poc-detail__stat-label">Selected tracts</span>
									<span class="poc-detail__stat-value">{selectedTractDetail.countSelected}</span>
								</div>
							</div>
						</div>
					{/if}
				</div>

				<div class="poc-compare card-key" role="region" aria-label="Selected tract comparison chart">
					<div class="poc-compare__head">
						<div>
							<p class="poc-detail__kicker">Selected tract chart</p>
							<p class="poc-detail__title">{selectionComparison.title}</p>
						</div>
						<div class="poc-compare__metric-tabs">
							<button
								type="button"
								class="poc-compare__tab"
								class:poc-compare__tab--active={comparisonMetric === 'hu_growth'}
								onclick={() => (comparisonMetric = 'hu_growth')}
							>
								Growth
							</button>
							<button
								type="button"
								class="poc-compare__tab"
								class:poc-compare__tab--active={comparisonMetric === 'tod_share'}
								onclick={() => (comparisonMetric = 'tod_share')}
							>
								TOD share
							</button>
							<button
								type="button"
								class="poc-compare__tab"
								class:poc-compare__tab--active={comparisonMetric === 'stock_increase'}
								onclick={() => (comparisonMetric = 'stock_increase')}
							>
								Housing stock increase
							</button>
						</div>
					</div>
					<p class="poc-detail__summary">
						{selectionComparison.copy}
					</p>
					<div class="poc-compare__bars" aria-label={comparisonMetricMeta.label}>
						{#each selectionComparison.rows as row (row.key)}
								<div class="poc-compare__row" data-tone={row.key}>
								<span class="poc-compare__label">{row.label}</span>
								<span class="poc-compare__track">
									<span class="poc-compare__bar" style:width={`${row.widthPct}%`}></span>
								</span>
								<span class="poc-compare__value">
									{row.value == null ? '—' : `${comparisonMetricMeta.formatter(row.value)}${comparisonMetricMeta.suffix}`}
								</span>
								</div>
						{/each}
					</div>
				</div>

				<div class="poc-insight card-key" role="group" aria-label="Mismatch focus">
					<p class="poc-detail__kicker">Mismatch focus</p>
					<label class="poc-focus-toggle">
						<input type="checkbox" bind:checked={focusMismatchOnly} />
						<span>Show mismatch areas only</span>
					</label>
					<label class="poc-focus-toggle">
						<input type="checkbox" bind:checked={focusLowIncomeTracts} />
						<span>Show lower-income tracts (&lt;$125k median)</span>
					</label>
					<p class="poc-detail__kicker" style="margin-top: 12px">Mismatch outlines</p>
					<div class="poc-mismatch-mode" role="group" aria-label="Which mismatch categories to outline">
						<button
							type="button"
							class="poc-mismatch-mode__btn"
							class:poc-mismatch-mode__btn--active={mismatchOutlineMode === 'follow_scroll'}
							onclick={() => (mismatchOutlineMode = 'follow_scroll')}
						>
							Match scroll
						</button>
						<button
							type="button"
							class="poc-mismatch-mode__btn"
							class:poc-mismatch-mode__btn--active={mismatchOutlineMode === 'off'}
							onclick={() => (mismatchOutlineMode = 'off')}
						>
							Off
						</button>
						<button
							type="button"
							class="poc-mismatch-mode__btn"
							class:poc-mismatch-mode__btn--active={mismatchOutlineMode === 'all'}
							onclick={() => (mismatchOutlineMode = 'all')}
						>
							All mismatch
						</button>
						<button
							type="button"
							class="poc-mismatch-mode__btn"
							class:poc-mismatch-mode__btn--active={mismatchOutlineMode === 'ha_only'}
							onclick={() => (mismatchOutlineMode = 'ha_only')}
						>
							High access, low growth
						</button>
						<button
							type="button"
							class="poc-mismatch-mode__btn"
							class:poc-mismatch-mode__btn--active={mismatchOutlineMode === 'hg_only'}
							onclick={() => (mismatchOutlineMode = 'hg_only')}
						>
							High growth, low access
						</button>
					</div>
					<p class="poc-detail__summary">
						When on, non-mismatch tracts fade so the access–growth patterns are easier to read. Default follows
						scroll steps; use the buttons above to explore one or both mismatch types anytime.
					</p>
					<p class="poc-detail__summary">
						The lower-income toggle drops growth color to a neutral fill for tracts at or above the $125k median—exploratory;
						it does not replace the choropleth legend for those tracts.
					</p>
					<p class="poc-detail__summary">
						Markers flag notable examples within the visible mismatch set. Click a marker to zoom to that tract.
					</p>
				</div>

				{#if comparisonPairDetails.length > 0}
					<div class="poc-pair card-key" role="region" aria-label="Two-tract side-by-side comparison">
						<div class="poc-detail__head">
							<div>
								<p class="poc-detail__kicker">A/B tract comparison</p>
								<p class="poc-detail__title">Shift-click tracts to compare side by side</p>
							</div>
							<button class="poc-detail__btn poc-detail__btn--ghost" type="button" onclick={() => panelState.clearComparisonPair()}>
								Reset
							</button>
						</div>
						<div class="poc-pair__grid" style={`grid-template-columns: repeat(${Math.max(1, comparisonPairDetails.length)}, minmax(0, 1fr));`}>
							{#each comparisonPairDetails as tract (tract.id)}
								<section class="poc-pair__card">
									<p class="poc-pair__title">{tract.label}</p>
									<p class="poc-pair__sub">{tract.cohort}</p>
									<div class="poc-pair__rows">
										<div><span>Housing growth</span><strong>{tract.huGrowth == null ? '—' : `${d3.format('.1f')(tract.huGrowth)}%`}</strong></div>
										<div><span>TOD share</span><strong>{tract.todShare == null ? '—' : `${d3.format('.1f')(tract.todShare * 100)}%`}</strong></div>
										<div><span>Stock increase</span><strong>{tract.stockIncrease == null ? '—' : `${d3.format('.1f')(tract.stockIncrease)}%`}</strong></div>
										<div><span>New units</span><strong>{tract.newUnits == null ? '—' : d3.format(',.0f')(tract.newUnits)}</strong></div>
										<div><span>Transit stops</span><strong>{tract.stops == null ? '—' : d3.format(',.0f')(tract.stops)}</strong></div>
									</div>
								</section>
							{/each}
						</div>
					</div>
					{/if}
					</div>

					<div class="poc-supp-grid">
						<section class="poc-supp-card card-key" aria-label="TOD versus non-TOD composition by year">
							<h3 class="poc-supp-title">TOD vs non-TOD mix by year</h3>
							<div class="poc-supp-chart" bind:this={elComposition}></div>
						</section>
						<section class="poc-supp-card card-key" aria-label="Ranked municipalities by development volume">
							<h3 class="poc-supp-title">New development is concentrated in a small set of municipalities</h3>
							<div class="poc-supp-chart" bind:this={elRanked}></div>
						</section>
					</div>
				</div>

						<aside class="poc-stepper-side" aria-label="Map explanation steps">
					<div class="poc-stepper-head">
						<p class="poc-stepper-inline-kicker">Map walkthrough</p>
						<p class="poc-stepper-inline-hint">Scroll down the page and the map will progressively add layers.</p>
					</div>
					<div class="poc-stepper-inline-rail" aria-label="Map steps">
						{#each stepContent as step, i (i)}
							<section
								use:stepRef={i}
								class="poc-stepper-card"
								class:poc-stepper-card--active={revealStage === i}
								data-step-index={i}
							>
								<div class="poc-stepper-card-top">
									<span class="poc-stepper-pill-num">{i + 1}</span>
									<div class="poc-stepper-pill-text">
										<span class="poc-stepper-pill-kicker">{step.kicker}</span>
										<span class="poc-stepper-pill-title">{step.title}</span>
									</div>
								</div>
								<p class="poc-stepper-card-body">{step.body}</p>
							</section>
						{/each}
					</div>
				</aside>
			</div>
			<p class="poc-map-zoom-hint">Scroll through the narrative steps · drag to pan · scroll or pinch to zoom</p>
		</div>
	</div>
</div>

<style>
	.poc-nhgis-map {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.poc-scrolly {
		display: block;
	}

	.poc-scrolly-map {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-height: 0;
	}

	.poc-stage-chip {
		align-self: flex-start;
		padding: 5px 9px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
		border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		color: var(--text);
	}

	.poc-stepper-side {
		display: grid;
		gap: 18px;
		align-content: start;
		padding-top: 8px;
		min-width: 0;
		position: relative;
		z-index: 1;
	}

	.poc-stepper-head {
		position: sticky;
		top: 16px;
		z-index: 3;
		display: grid;
		gap: 6px;
		padding: 14px 16px;
		border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
		border-radius: 16px;
		background: color-mix(in srgb, var(--bg-card) 94%, white 6%);
		box-shadow: 0 8px 24px rgba(18, 30, 51, 0.06);
	}

	.poc-stepper-inline-kicker,
	.poc-stepper-inline-body-kicker {
		margin: 0;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
	}

	.poc-stepper-inline-hint,
	.poc-stepper-inline-body-copy {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.poc-stepper-inline-rail {
		display: grid;
		gap: 14vh;
		padding-top: 136px;
		/* Extra runway after step 3 so the page does not jump to the next section immediately */
		padding-bottom: 32vh;
		isolation: isolate;
	}

	.poc-stepper-card {
		display: grid;
		align-content: start;
		gap: 14px;
		width: 100%;
		min-height: 58vh;
		padding: 18px 18px 18px 20px;
		border-left: 3px solid color-mix(in srgb, var(--accent) 18%, var(--border));
		border-radius: 16px;
		border-top: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
		border-right: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
		border-bottom: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
		background: color-mix(in srgb, var(--bg-card) 95%, white 5%);
		box-shadow: 0 10px 24px rgba(18, 30, 51, 0.04);
		text-align: left;
		color: var(--text);
		opacity: 0.58;
		transform: translateY(10px);
		transition:
			opacity 220ms ease,
			transform 220ms ease,
			border-color 220ms ease,
			box-shadow 220ms ease,
			background 220ms ease;
	}

	.poc-stepper-card--active {
		border-left-color: color-mix(in srgb, var(--accent) 52%, var(--border));
		border-top-color: color-mix(in srgb, var(--accent) 24%, var(--border));
		border-right-color: color-mix(in srgb, var(--accent) 24%, var(--border));
		border-bottom-color: color-mix(in srgb, var(--accent) 24%, var(--border));
		background: color-mix(in srgb, var(--bg-card) 90%, white 10%);
		box-shadow: 0 16px 32px rgba(18, 30, 51, 0.08);
		opacity: 1;
		transform: translateY(0);
	}

	.poc-stepper-card-top {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		gap: 10px;
		align-items: center;
	}

	.poc-stepper-pill-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.84rem;
		font-weight: 700;
		color: var(--text);
		background: color-mix(in srgb, var(--bg-card) 94%, white 6%);
	}

	.poc-stepper-card--active .poc-stepper-pill-num {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 15%, var(--bg-card));
	}

	.poc-stepper-pill-text {
		display: grid;
		min-width: 0;
	}

	.poc-stepper-pill-title {
		font-size: 0.98rem;
		font-weight: 700;
		line-height: 1.25;
		color: var(--text);
		text-wrap: balance;
	}

	.poc-stepper-pill-kicker {
		font-size: 0.68rem;
		line-height: 1.25;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.poc-stepper-card-body {
		margin: 0;
		max-width: 31ch;
		font-size: 0.95rem;
		line-height: 1.72;
		color: color-mix(in srgb, var(--text) 78%, var(--text-muted));
		text-wrap: pretty;
	}

	/* Transit toggles ~1/4 width; text legend ~3/4 on wide viewports */
	.poc-legend-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: stretch;
		min-width: 0;
	}

	.poc-control-stack {
		display: grid;
		gap: 8px;
	}

	.poc-supp-grid {
		display: grid;
		gap: 8px;
		margin-top: 8px;
	}

	.poc-supp-card {
		display: grid;
		gap: 8px;
		padding: 10px 12px;
	}

	.poc-supp-title {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 800;
		color: var(--text);
	}

	.poc-supp-chart {
		width: 100%;
		min-height: 330px;
	}

	.poc-supp-chart :global(svg) {
		width: 100%;
		height: auto;
		display: block;
	}

	.poc-supp-chart :global(.legend) {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.9rem;
		align-items: center;
		color: var(--text-muted);
	}

	.poc-supp-chart :global(.legend-item) {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}

	.poc-supp-chart :global(.swatch) {
		width: 0.85rem;
		height: 0.85rem;
		border-radius: 999px;
		display: inline-block;
	}

	.poc-supp-chart :global(.legend-scale) {
		display: inline-flex;
		gap: 0.6rem;
		align-items: center;
	}

	.poc-supp-chart :global(.legend-ramp) {
		display: inline-flex;
		gap: 0.25rem;
	}

	.poc-supp-chart :global(.legend-ramp span) {
		width: 1.8rem;
		height: 0.95rem;
		border-radius: 999px;
	}

	.poc-supp-chart :global(.chart-note),
	.poc-supp-chart :global(.empty) {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.86rem;
		line-height: 1.4;
	}

	.poc-side-cards {
		display: grid;
		gap: 8px;
		align-content: start;
	}

	@media (min-width: 640px) {
		.poc-legend-row {
			flex-direction: row;
			align-items: flex-start;
		}

		/* Transit block was capped at 25% width, which crushed the label column; size to content instead. */
		.poc-transit-field {
			flex: 0 0 auto;
			max-width: none;
			min-width: min-content;
		}

		.poc-map-key {
			flex: 1 1 0;
			min-width: 0;
		}

		.poc-control-stack {
			grid-template-columns: minmax(320px, 1fr) minmax(340px, 1.08fr);
			align-items: start;
		}

		.poc-side-cards {
			grid-column: 1;
		}

		.poc-compare {
			grid-column: 2;
		}

		.poc-supp-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 900px) {
		.map-wrap {
			grid-template-columns: 1fr;
		}

		.map-left-column {
			position: relative;
			top: auto;
		}

		.map-main {
			position: relative;
			top: auto;
		}

		.map-widget__controls {
			top: 8px;
			right: 8px;
		}

		.poc-stepper-head {
			position: relative;
			top: auto;
		}

		.poc-stepper-inline-rail {
			gap: 20px;
			padding-top: 18px;
			padding-bottom: 18px;
		}

		.poc-stepper-card {
			min-height: 0;
			padding: 16px;
			opacity: 1;
			transform: none;
		}
	}

	.poc-transit-field {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-card);
		padding: 2px 5px 4px;
		margin: 0;
	}

	.poc-spotlight {
		display: grid;
		gap: 8px;
		align-content: start;
		min-height: 100%;
	}

	.poc-methods {
		display: grid;
		gap: 6px;
	}

	.poc-methods--lead {
		margin-bottom: 8px;
		padding: 12px 14px;
	}

	.poc-methods--encoding {
		margin-bottom: 8px;
		padding: 12px 14px;
		border-color: color-mix(in srgb, var(--border) 92%, var(--text-muted));
	}

	.poc-methods__list--encoding {
		margin-top: 6px;
	}

	.poc-methods__list--encoding li {
		margin-bottom: 8px;
	}

	.poc-methods--assumptions {
		margin-bottom: 10px;
		padding: 12px 14px;
		border-color: color-mix(in srgb, var(--accent) 24%, var(--border));
		background: color-mix(in srgb, var(--accent) 4%, var(--bg-card));
	}

	.poc-methods__title {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 800;
		letter-spacing: 0.02em;
		color: var(--accent);
	}

	.poc-methods__text {
		margin: 0;
		font-size: 0.9rem;
		line-height: 1.6;
		color: var(--text-muted);
	}

	.poc-methods__list {
		margin: 0;
		padding-left: 1.1rem;
		display: grid;
		gap: 0.35rem;
		font-size: 0.82rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.poc-methods__label {
		font-weight: 700;
		color: var(--text);
	}

	.poc-spotlight__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.poc-spotlight__kicker {
		margin: 0;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
	}

	.poc-spotlight__clear {
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-card);
		color: var(--text);
		font-size: 0.68rem;
		font-weight: 700;
		padding: 0.28rem 0.55rem;
	}

	.poc-spotlight__buttons {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}

	.poc-spotlight__button {
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-card);
		color: var(--text);
		padding: 0.58rem 0.6rem;
		font-size: 0.74rem;
		font-weight: 700;
		line-height: 1.25;
		text-align: left;
		min-height: 76px;
		transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
	}

	.poc-spotlight__button:hover,
	.poc-spotlight__button:focus-visible,
	.poc-spotlight__button--active {
		transform: translateY(-1px);
	}

	.poc-spotlight__button[data-tone='tod']:hover,
	.poc-spotlight__button[data-tone='tod']:focus-visible,
	.poc-spotlight__button[data-tone='tod'].poc-spotlight__button--active {
		border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
		background: color-mix(in srgb, var(--accent) 11%, var(--bg-card));
	}

	.poc-spotlight__button[data-tone='nontod']:hover,
	.poc-spotlight__button[data-tone='nontod']:focus-visible,
	.poc-spotlight__button[data-tone='nontod'].poc-spotlight__button--active {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
		background: color-mix(in srgb, var(--warning) 12%, var(--bg-card));
	}

	.poc-spotlight__button[data-tone='minimal']:hover,
	.poc-spotlight__button[data-tone='minimal']:focus-visible,
	.poc-spotlight__button[data-tone='minimal'].poc-spotlight__button--active {
		border-color: #94a3b8;
		background: color-mix(in srgb, #94a3b8 14%, var(--bg-card));
	}

	.poc-spotlight__summary {
		display: grid;
		gap: 6px;
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));
		border-radius: 12px;
		background: color-mix(in srgb, var(--accent) 5%, var(--bg-card));
	}

	.poc-spotlight__summary-title {
		margin: 0;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text);
	}

	.poc-spotlight__summary-copy {
		margin: 0;
		font-size: 0.71rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.poc-spotlight__stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px 12px;
	}

	.poc-spotlight__stat-label {
		display: block;
		font-size: 0.62rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.poc-spotlight__stat-value {
		display: block;
		margin-top: 2px;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text);
	}

	.poc-detail {
		display: grid;
		gap: 6px;
		align-content: start;
	}

	.poc-detail__head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 10px;
	}

	.poc-detail__kicker {
		margin: 0 0 2px;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
	}

	.poc-detail__title {
		margin: 0;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text);
	}

	.poc-detail__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}

	.poc-detail__btn {
		border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
		color: var(--text);
		padding: 0.3rem 0.6rem;
		font-size: 0.68rem;
		font-weight: 700;
	}

	.poc-detail__btn--ghost {
		border-color: var(--border);
		background: var(--bg-card);
	}

	.poc-detail__summary {
		margin: 0;
		font-size: 0.7rem;
		line-height: 1.4;
		color: var(--text-muted);
	}

	.poc-detail__cohort {
		display: inline-flex;
		align-items: center;
		padding: 0.18rem 0.5rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
		font-weight: 700;
		color: var(--text);
	}

	.poc-detail__topline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.poc-detail__primary {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.poc-detail__hero {
		display: grid;
		gap: 2px;
		padding: 6px 8px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--accent) 7%, var(--bg-card));
		border: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
	}

	.poc-detail__hero-value {
		font-size: 1rem;
		font-weight: 800;
		line-height: 1.1;
		color: var(--text);
	}

	.poc-detail__stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px 10px;
	}

	.poc-detail__stat-label {
		display: block;
		font-size: 0.58rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.poc-detail__stat-value {
		display: block;
		margin-top: 2px;
		font-size: 0.76rem;
		font-weight: 700;
		color: var(--text);
	}

	.poc-compare {
		display: grid;
		gap: 10px;
		align-content: start;
		height: 100%;
	}

	.poc-insight {
		display: grid;
		gap: 8px;
	}

	.poc-insight__buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.poc-pair {
		display: grid;
		gap: 8px;
	}

	.poc-pair__grid {
		display: grid;
		gap: 8px;
	}

	.poc-pair__card {
		border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));
		border-radius: 10px;
		background: color-mix(in srgb, var(--accent) 4%, var(--bg-card));
		padding: 8px;
	}

	.poc-pair__title {
		margin: 0;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--text);
	}

	.poc-pair__sub {
		margin: 2px 0 6px;
		font-size: 0.68rem;
		color: var(--text-muted);
	}

	.poc-pair__rows {
		display: grid;
		gap: 5px;
	}

	.poc-pair__rows div {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		font-size: 0.7rem;
		color: var(--text-muted);
	}

	.poc-pair__rows strong {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.poc-compare__head {
		display: grid;
		gap: 8px;
	}

	.poc-compare__metric-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.poc-compare__tab {
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-card);
		color: var(--text);
		padding: 0.32rem 0.62rem;
		font-size: 0.69rem;
		font-weight: 700;
	}

	.poc-compare__tab--active {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
	}

	.poc-compare__bars {
		display: grid;
		gap: 10px;
	}

	.poc-compare__row {
		display: grid;
		grid-template-columns: minmax(0, 156px) minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		border: 1px solid color-mix(in srgb, var(--accent) 10%, var(--border));
		border-radius: 12px;
		padding: 0.55rem 0.7rem;
		background: color-mix(in srgb, var(--bg-card) 96%, white 4%);
		color: inherit;
		text-align: left;
	}

	.poc-compare__label {
		font-size: 0.74rem;
		font-weight: 700;
		color: var(--text);
	}

	.poc-compare__track {
		display: flex;
		align-items: center;
		height: 14px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--border) 72%, var(--bg-card));
		overflow: hidden;
	}

	.poc-compare__bar {
		display: block;
		height: 100%;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 74%, white 26%);
	}

	.poc-compare__row[data-tone='selected'] .poc-compare__bar {
		background: color-mix(in srgb, var(--accent) 82%, white 18%);
	}

	.poc-compare__row[data-tone='cohort'] .poc-compare__bar {
		background: color-mix(in srgb, var(--warning) 78%, white 22%);
	}

	.poc-compare__row[data-tone='all'] .poc-compare__bar {
		background: #94a3b8;
	}

	.poc-compare__row[data-tone='tod_dominated'] .poc-compare__bar {
		background: color-mix(in srgb, var(--accent) 82%, white 18%);
	}

	.poc-compare__row[data-tone='nontod_dominated'] .poc-compare__bar {
		background: color-mix(in srgb, var(--warning) 78%, white 22%);
	}

	.poc-compare__row[data-tone='minimal'] .poc-compare__bar {
		background: #94a3b8;
	}

	.poc-compare__value {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}


	.poc-transit-legend {
		padding: 0 2px;
		font-size: 0.58rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
	}

	.poc-transit-compact {
		display: block;
		width: max-content;
		max-width: 100%;
		min-width: 0;
	}

	/* auto label column + fixed narrow checkbox columns keeps rows on one line with less dead space */
	.poc-t-row {
		display: grid;
		grid-template-columns: auto 1.575rem 1.575rem;
		column-gap: 0.525rem;
		row-gap: 2px;
		align-items: center;
		font-size: 0.6rem;
		line-height: 1.2;
		color: var(--text-muted);
	}

	.poc-t-h {
		text-align: center;
		font-weight: 700;
		font-size: 0.52rem;
		text-transform: uppercase;
		letter-spacing: 0.02em;
		color: var(--text-muted);
	}

	.poc-t-l {
		font-weight: 500;
		color: var(--text);
		padding-right: 0.15rem;
		white-space: nowrap;
	}

	.poc-t-cell {
		display: flex;
		justify-content: center;
		align-items: center;
		cursor: pointer;
		min-height: 23px;
		margin: 0;
		padding: 0;
	}

	.poc-t-cell input {
		accent-color: var(--accent);
		margin: 0;
	}

	.card-key {
		border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
		background: color-mix(in srgb, var(--accent) 5%, var(--bg-card));
		border-radius: var(--radius-sm);
		padding: 5px 8px;
	}

	.poc-map-key-compact {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.65rem;
		line-height: 1.35;
		color: var(--text-muted);
	}

	/* Tract (left) vs developments (right) when MassBuilds overlay is on */
	.poc-map-key-compact--split {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 8px 14px;
		align-items: start;
	}

	@media (max-width: 639px) {
		.poc-control-stack {
			grid-template-columns: 1fr;
		}

		.poc-side-cards {
			grid-column: auto;
		}

		.poc-detail__topline {
			flex-direction: column;
			align-items: flex-start;
		}

		.poc-detail__primary {
			grid-template-columns: 1fr;
		}

		.poc-compare__row {
			grid-template-columns: 1fr;
			gap: 4px;
		}


		.poc-spotlight__buttons {
			grid-template-columns: 1fr;
		}

		.poc-spotlight__stats {
			grid-template-columns: 1fr;
		}

		.poc-detail__stats {
			grid-template-columns: 1fr 1fr;
		}

		.poc-map-key-compact--split {
			grid-template-columns: 1fr;
		}

		.poc-map-key-col--dev {
			border-left: none;
			padding-left: 0;
			border-top: 1px dashed var(--border);
			padding-top: 8px;
		}
	}

	.poc-map-key-col {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.poc-map-key-col--dev {
		border-left: 1px dashed var(--border);
		padding-left: 10px;
	}

	.poc-map-key-col--dev .poc-key-dev {
		padding-top: 0;
		border-top: none;
	}

	.poc-key-no-data {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0;
		font-size: 0.6rem;
		line-height: 1.35;
		color: var(--text-muted);
	}

	.poc-key-fill-swatch {
		display: inline-block;
		width: 14px;
		height: 14px;
		border-radius: 3px;
		border: 1px solid var(--border);
		flex-shrink: 0;
		margin-top: 0.1rem;
		box-sizing: border-box;
	}

	.poc-key-no-data-text {
		color: var(--text-muted);
	}

	.poc-key-one {
		margin: 0;
		display: flex;
		align-items: flex-start;
		gap: 4px;
	}

	.poc-key-tract-fill {
		flex-wrap: wrap;
		align-items: center;
	}

	.poc-key-tract-fill-body {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		min-width: 0;
		flex: 1 1 12rem;
	}

	.poc-key-tract-fill-line {
		display: block;
	}

	.poc-key-tract-bar {
		display: block;
		width: 100%;
		max-width: 9rem;
		height: 5px;
		border-radius: 2px;
		border: 1px solid var(--border);
		flex-shrink: 0;
	}

	.poc-key-tract-bar-labels {
		display: flex;
		justify-content: space-between;
		width: 100%;
		max-width: 9rem;
		gap: 8px;
		font-size: 0.62rem;
		font-weight: 700;
		line-height: 1.2;
		color: var(--text-muted);
	}

	.poc-key-tract-bar-label:last-child {
		text-align: right;
	}

	.poc-key-one strong {
		color: var(--text);
		font-weight: 600;
		flex-shrink: 0;
	}

	.poc-key-dev {
		padding-top: 2px;
		border-top: 1px dashed var(--border);
		flex-wrap: wrap;
		align-items: center;
	}

	.poc-key-dev-sizes {
		margin: 0;
		padding: 4px 0 0;
	}

	.poc-key-dev-sizes-title {
		margin: 0 0 5px;
		font-size: 0.58rem;
		font-weight: 600;
		color: var(--text-muted);
		line-height: 1.25;
	}

	.poc-key-dev-sizes-list {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 6px 14px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.poc-key-dev-size-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
	}

	/* Match map max r (8); keeps small circles bottom-aligned with large ones. */
	.poc-key-dev-size-dot-wrap {
		display: flex;
		align-items: flex-end;
		justify-content: center;
		min-height: 18px;
		width: 100%;
	}

	.poc-key-dev-size-dot {
		display: block;
		border-radius: 999px;
		flex-shrink: 0;
		box-sizing: border-box;
		/* Neutral grey: size legend encodes area only; MF fill is the colorbar above. */
		background: #94a3b8;
		border: 1px solid rgba(15, 23, 42, 0.35);
	}

	.poc-key-dev-size-num {
		font-size: 0.58rem;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		font-weight: 600;
	}

	.poc-key-rings {
		display: flex;
		flex-wrap: wrap;
		gap: 3px 10px;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.62rem;
	}

	.poc-key-rings li {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.poc-k-ring {
		display: inline-block;
		width: 14px;
		height: 14px;
		border-radius: 999px;
		flex-shrink: 0;
		border: 2px solid var(--border);
		background: color-mix(in srgb, var(--bg-card) 88%, transparent);
	}

	.poc-k-ring--tod {
		border-color: var(--accent, #0d9488);
	}
	.poc-k-ring--nontod {
		border-color: var(--warning, #ea580c);
	}
	.poc-k-ring--min {
		border-color: #94a3b8;
	}

	.poc-key-mismatch-sub {
		margin: 0 0 0.35rem;
		font-size: 0.68rem;
		line-height: 1.35;
		color: var(--text-muted);
	}

	.poc-k-ring--mismatch-ha {
		border-color: #8a78e0;
		border-width: 2px;
	}

	.poc-k-ring--mismatch-hg {
		border-color: #c4b5f0;
		border-width: 1.45px;
		border-style: dashed;
	}

	.poc-focus-toggle {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		font-size: 0.78rem;
		line-height: 1.35;
		color: var(--text);
		cursor: pointer;
		user-select: none;
	}

	.poc-focus-toggle input {
		margin-top: 0.2rem;
		accent-color: var(--accent, #6366f1);
	}

	.poc-mismatch-mode {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0 0 8px;
	}

	.poc-mismatch-mode__btn {
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--bg-card) 92%, transparent);
		color: var(--text);
		font-size: 0.68rem;
		line-height: 1.25;
		padding: 5px 8px;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
		transition:
			background 0.15s ease,
			border-color 0.15s ease;
	}

	.poc-mismatch-mode__btn:hover {
		border-color: color-mix(in srgb, var(--accent, #6366f1) 45%, var(--border));
	}

	.poc-mismatch-mode__btn--active {
		border-color: var(--accent, #6366f1);
		background: color-mix(in srgb, var(--accent, #6366f1) 12%, var(--bg-card));
		font-weight: 600;
	}

	/* Dev outline swatches: grey fill so stroke semantics stay visible (map dots stay orange–green by MF). */
	.poc-k-ring--dev-access,
	.poc-k-ring--dev-noaccess {
		background: #94a3b8;
	}

	.poc-k-ring--dev-access {
		border-color: #ffffff;
		box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.38);
	}

	.poc-k-ring--dev-noaccess {
		border-color: rgba(15, 23, 42, 0.55);
	}

	.map-wrap {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(220px, 260px);
		gap: 28px;
		width: 100%;
		background: transparent;
		align-items: start;
	}

	/* Legend + MBTA overlays + map move as one sticky stack so they stay visible while steps scroll */
	.map-left-column {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		position: sticky;
		top: 18px;
		align-self: start;
		z-index: 2;
	}

	.map-main {
		position: relative;
		min-width: 0;
		display: grid;
		gap: 8px;
	}

	.poc-map-callouts {
		padding: 8px 10px;
	}

	.poc-map-callouts__list {
		margin: 0;
		padding-left: 1.05rem;
		display: grid;
		gap: 0.32rem;
		font-size: 0.76rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.map-widget {
		position: relative;
	}

	.map-widget__controls {
		position: absolute;
		top: 10px;
		right: 10px;
		z-index: 6;
		display: inline-flex;
		gap: 6px;
	}

	.poc-map-control {
		position: relative;
		top: auto;
		right: auto;
		padding: 0.36rem 0.58rem;
		border: 1px solid color-mix(in srgb, var(--border) 88%, white 12%);
		border-radius: 999px;
		background: color-mix(in srgb, var(--bg-card) 92%, white 8%);
		color: var(--text);
		font-size: 0.8rem;
		font-weight: 700;
		line-height: 1;
		box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
		backdrop-filter: blur(6px);
		min-width: 30px;
	}

	.poc-map-control--wide {
		padding-inline: 0.72rem;
		min-width: auto;
	}

	.poc-map-control:hover {
		background: color-mix(in srgb, var(--bg-card) 82%, white 18%);
	}

	.poc-map-control:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--accent) 60%, white 40%);
		outline-offset: 2px;
	}

	.map-root {
		width: 100%;
		max-width: 100%;
		min-height: 300px;
	}

	.map-tooltip {
		position: fixed;
		z-index: 20;
		max-width: 360px;
		padding: 12px 13px;
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--text);
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow);
		pointer-events: none;
	}

	.map-tooltip__header {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		align-items: flex-start;
		margin-bottom: 8px;
	}

	.map-tooltip__header-copy {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.map-tooltip__eyebrow {
		margin: 0;
		font-size: 0.63rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.map-tooltip__title {
		margin: 0;
		font-size: 0.92rem;
		font-weight: 700;
		line-height: 1.2;
		color: var(--text);
	}

	.map-tooltip__badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 8px;
		border-radius: 999px;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--bg-card) 85%, transparent);
	}

	.map-tooltip__badge--tod {
		border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
		background: color-mix(in srgb, var(--accent) 13%, var(--bg-card));
		color: var(--accent);
	}

	.map-tooltip__badge--nontod {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
		background: color-mix(in srgb, var(--warning) 13%, var(--bg-card));
		color: var(--warning);
	}

	.map-tooltip__badge--minimal {
		border-color: #94a3b8;
		background: color-mix(in srgb, #94a3b8 13%, var(--bg-card));
		color: #526074;
	}

	.map-tooltip__badge--neutral {
		color: var(--text-muted);
	}

	.map-tooltip__primary {
		display: grid;
		gap: 6px;
		padding: 8px 10px;
		margin-bottom: 8px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--accent) 6%, var(--bg-card));
		border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));
	}

	.map-tooltip__primary--tod {
		background: color-mix(in srgb, var(--accent) 9%, var(--bg-card));
		border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
	}

	.map-tooltip__primary--nontod {
		background: color-mix(in srgb, var(--warning) 9%, var(--bg-card));
		border-color: color-mix(in srgb, var(--warning) 28%, var(--border));
	}

	.map-tooltip__primary--minimal {
		background: color-mix(in srgb, #94a3b8 10%, var(--bg-card));
		border-color: color-mix(in srgb, #94a3b8 28%, var(--border));
	}

	.map-tooltip__primary-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: baseline;
	}

	.map-tooltip__primary-label {
		font-size: 0.68rem;
		font-weight: 700;
		line-height: 1.3;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-muted);
	}

	.map-tooltip__primary-value {
		font-size: 0.86rem;
		font-weight: 700;
		line-height: 1.25;
		text-align: right;
		color: var(--text);
	}

	.map-tooltip__details {
		display: grid;
		gap: 6px;
	}

	.map-tooltip__details-label {
		margin: 0;
		font-size: 0.63rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.map-tooltip__rows {
		display: grid;
		gap: 6px;
	}

	.map-tooltip__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: start;
	}

	.map-tooltip__label {
		color: var(--text-muted);
		font-size: 0.73rem;
		line-height: 1.35;
	}

	.map-tooltip__value {
		color: var(--text);
		font-size: 0.76rem;
		font-weight: 600;
		line-height: 1.35;
		text-align: right;
	}

	.poc-map-zoom-hint {
		margin: 0;
		font-size: 0.7rem;
		color: var(--text-muted);
	}

	:global(.map-empty) {
		margin: 0;
		padding: 16px;
		font-size: 0.875rem;
		color: var(--text-muted);
	}

	:global(.insight-marker__halo) {
		fill: color-mix(in srgb, var(--warning) 26%, white 74%);
		stroke: color-mix(in srgb, var(--warning) 58%, #1f2937);
		stroke-width: 1.1;
		vector-effect: non-scaling-stroke;
	}

	:global(.insight-marker__dot) {
		fill: color-mix(in srgb, var(--warning) 86%, #7c2d12);
		stroke: #fff;
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	:global(.insight-marker:hover .insight-marker__halo) {
		stroke-width: 1.8;
		filter: brightness(1.08);
	}
</style>

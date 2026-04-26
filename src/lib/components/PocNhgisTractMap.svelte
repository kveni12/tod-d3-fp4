<script>
	import { onDestroy } from 'svelte';
	import * as d3 from 'd3';
	import {
		tractGeo,
		allTractsGeo,
		developments,
		mbtaStops,
		mbtaLines
	} from '$lib/stores/data.svelte.js';
	import {
		aggregateDevsByTract,
		aggregateTractTodMetrics,
		buildFilteredData,
		classifyTractDevelopment,
		developmentAffordableUnitsCapped,
		developmentMultifamilyShare,
		developmentMbtaProximity,
		isDevelopmentTransitAccessible,
		popWeightKey,
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
		MBTA_RED,
		MBTA_YELLOW
	} from '$lib/utils/mbtaColors.js';

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
	 * mapFocusedTractDetail : object | null | undefined
	 *     When bound, mirrors the focused tract’s choropleth summary (for sidebars, e.g. ``TractDetail``).
	 * mapViewActions : { zoomToTract: (gisjoin: string) => void } | null | undefined
	 *     When bound, exposes map zoom for that sidebar.
	 */
	let {
		panelState,
		tractList,
		nhgisRows,
		metricsDevelopments = null,
		guidedMode = false,
		mapFocusedTractDetail = $bindable(null),
		mapViewActions = $bindable(null)
	} = $props();

	let containerEl = $state(null);
	let tooltipEl = $state(null);
	let stepEls = $state([]);
	let focusWaypointEls = $state([]);
	let tooltip = $state({
		visible: false,
		x: 0,
		y: 0,
		anchorX: null,
		anchorY: null,
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
	/** Optional: emphasize tracts with median household income below the lower-income threshold. */
	let focusLowIncomeTracts = $state(false);
	/** Hover-linked cluster highlight: all tracts in this category read as one pattern. */
	let hoveredMismatchCluster = $state(/** @type {null | 'ha_lg' | 'hg_la'} */ (null));
	let guidedLowerIncomeOverlay = $state(/** @type {'cohort' | 'mismatch'} */ ('cohort'));
	let pinnedTooltipStage = $state(/** @type {number | null} */ (null));
	let lastAutoFocusedStage = $state(/** @type {string | null} */ (null));
	let guidedFocusDetail = $state(/** @type {string | null} */ (null));
	let activeGuidedDevelopmentKey = $state(/** @type {string | null} */ (null));
	/** Tract ID currently pinned via click (tooltip stays until click-off). */
	let pinnedTractId = $state(/** @type {string | null} */ (null));
	/** Frozen tooltip snapshot while a tract is pinned. */
	let pinnedTooltip = $state(/** @type {typeof tooltip | null} */ (null));
	/** Development project key (``developmentKey``) pinned via click — tooltip stays until click-off. */
	let pinnedDevKey = $state(/** @type {string | null} */ (null));
	/** Frozen tooltip snapshot while a development is pinned. */
	let pinnedDevTooltip = $state(/** @type {typeof tooltip | null} */ (null));
	/** Timer handle for the 200ms hover-rest debounce. */
	let hoverRestTimer = $state(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
	/** Last known mouse position (client coords) for debounced tooltip placement. */
	let pendingHoverPos = $state(/** @type {{ x: number; y: number } | null} */ (null));
	/** Tract ID waiting for debounce to complete. */
	let pendingHoverId = $state(/** @type {string | null} */ (null));
	const lowIncomeFocusOn = $derived(guidedMode ? revealStage === 10 : focusLowIncomeTracts);

	/** Use pinned tooltip when a tract or development is click-locked, otherwise live. */
	const activeTooltip = $derived(
		pinnedTractId && pinnedTooltip
			? pinnedTooltip
			: pinnedDevKey && pinnedDevTooltip
				? pinnedDevTooltip
				: tooltip
	);

	const tooltipPosition = $derived.by(() => {
		const offset = 12;
		const margin = 8;
		const fallbackWidth = 360;
		const fallbackHeight = 260;
		const width = tooltipEl?.offsetWidth ?? fallbackWidth;
		const height = tooltipEl?.offsetHeight ?? fallbackHeight;
		const rawLeft = activeTooltip.x + offset;
		const rawTop = activeTooltip.y + offset;
		if (typeof window === 'undefined') return { left: rawLeft, top: rawTop };
		const maxLeft = Math.max(margin, window.innerWidth - width - margin);
		const maxTop = Math.max(margin, window.innerHeight - height - margin);
		return {
			left: Math.min(maxLeft, Math.max(margin, rawLeft)),
			top: Math.min(maxTop, Math.max(margin, rawTop))
		};
	});

	const tooltipArrow = $derived.by(() => {
		if (activeTooltip.anchorX == null || activeTooltip.anchorY == null) return null;
		const width = tooltipEl?.offsetWidth ?? 360;
		const height = tooltipEl?.offsetHeight ?? 260;
		const left = tooltipPosition.left;
		const top = tooltipPosition.top;
		const right = left + width;
		const bottom = top + height;
		const ax = activeTooltip.anchorX;
		const ay = activeTooltip.anchorY;
		const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
		if (ax < left) {
			return { side: 'left', top: clamp(ay - top, 18, height - 18) };
		}
		if (ax > right) {
			return { side: 'right', top: clamp(ay - top, 18, height - 18) };
		}
		if (ay < top) {
			return { side: 'top', left: clamp(ax - left, 18, width - 18) };
		}
		return { side: 'bottom', left: clamp(ax - left, 18, width - 18) };
	});

	/** Nice unit ticks + pixel radii for HTML dot-size legend (same sqrt scale as map dots). */
	let devSizeLegendTicks = $state(/** @type {{ units: number; rPx: number }[] | null} */ (null));

	const mapUid = Math.random().toString(36).slice(2, 11);

	/** Lighter grey for minimal-development tract outline (half stroke vs TOD tiers); legend ring matches. */
	const MINIMAL_TRACT_STROKE = '#94a3b8';
	/** Tan fill for tracts excluded from the analysis (limited data / below pop density). */
	const EXCLUDED_TRACT_FILL = '#e7e0d5';
	/**
	 * Lighter bus-yellow for hover / tooltip-only ``tract-interaction`` ring; selected tracts use full ``MBTA_YELLOW``.
	 */
	const TRACT_HOVER_OUTLINE = `color-mix(in srgb, ${MBTA_YELLOW} 42%, #ffffff 58%)`;
	/** High access + low growth — softer violet (thick edges read calmer than pure #7B61FF). */
	const MISMATCH_STROKE_HA = '#8A78E0';
	/** High growth + low access — lighter, dashed. */
	const MISMATCH_STROKE_HG = '#C4B5F0';
	/** Mismatch outline opacity — high enough to read clearly on the choropleth. */
	const MISMATCH_STROKE_OPACITY = 0.96;
	const MISMATCH_W_HA = 2;
	const MISMATCH_W_HG = 1.45;
	const CHORO_COLOR_STEPS = ['#d73027', '#f46d43', '#f7d8cf', '#ffffff', '#d5e3f5', '#7ea6da', '#2f6eb5'];
	/**
	 * Non–mismatch tracts when the mismatch layer is on (revealStage ≥2).
	 * ~0.11 opacity ≈ 89% dimming vs full (≥50% reduction vs the previous 0.22 pass) so violet/lavender outlines read clearly.
	 */
	const NON_MISMATCH_DIM = 0.11;
	/**
	 * Group opacity for guided tracts outside the geographic focus — lower pushes them further
	 * into the background so in-focus tracts read more clearly.
	 */
	const GUIDED_UNFOCUS_OPACITY = 0.28;
	/** When “lower-income tracts” focus is on: use neutral tan for tracts at/above $125k median. */
	const LOW_INCOME_FOCUS_INACTIVE_FILL = '#e7e0d5';

	/**
	 * Hue-preserving desaturation for "out-of-focus" tracts.
	 *
	 * The previous implementation blended the tract fill toward a flat warm
	 * gray, which turned any blue/red mid-range choropleth color into a muddy
	 * tan. That made it look like the choropleth was "randomly disappearing"
	 * on scroll, because the dimming rule depends on whichever focus/mismatch
	 * set is active — not on the underlying growth value. Reducing chroma in
	 * HCL space instead keeps the hue (blue stays blue, red stays red) while
	 * lowering saturation and raising lightness, so out-of-focus tracts still
	 * read as "muted blue" / "muted red" rather than "tan".
	 *
	 * Parameters
	 * ----------
	 * baseFill : string
	 *     Any CSS color D3 can parse.
	 * amount : number
	 *     In [0, 1]. 0 returns the input, 1 fully neutralizes chroma and
	 *     lightens the color to near-paper.
	 *
	 * Returns
	 * -------
	 * string
	 *     Hex color.
	 */
	function desaturateFill(baseFill, amount) {
		const a = Math.min(1, Math.max(0, Number(amount) || 0));
		const hcl = d3.hcl(baseFill);
		if (!Number.isFinite(hcl.c) || !Number.isFinite(hcl.l)) return baseFill;
		hcl.c *= 1 - a;
		hcl.l = Math.min(95, hcl.l + a * 12);
		const hex = hcl.formatHex();
		return hex || baseFill;
	}
	const HIGH_ACCESS_LOW_GROWTH = 'high_access_low_growth';
	const HIGH_GROWTH_LOW_ACCESS = 'high_growth_low_access';

	function devClassStroke(row) {
		const dc = row?.devClass;
		if (dc === 'tod_dominated') return 'var(--accent, #0d9488)';
		if (dc === 'nontod_dominated') return 'var(--warning, #ea580c)';
		if (dc === 'minimal') return MINIMAL_TRACT_STROKE;
		return 'rgba(60,64,67,0.22)';
	}

	function showCohortOutlines() {
		if (guidedMode) return (revealStage >= 4 && revealStage <= 7) || (revealStage === 10 && guidedLowerIncomeOverlay === 'cohort');
		return revealStage === 1 || revealStage === 3;
	}

	function showMismatchOutlines() {
		if (guidedMode) return revealStage === 3 || (revealStage === 10 && guidedLowerIncomeOverlay === 'mismatch');
		return revealStage === 2;
	}

	function showDevelopmentDots() {
		if (guidedMode) return revealStage >= 8 && revealStage <= 9;
		return panelState.showDevelopments;
	}

	function visibleCohortStroke(row, id) {
		const dc = row?.devClass;
		// When cohort outlines aren't active, show a faint but visible
		// boundary so tract shapes are always legible.
		if (!showCohortOutlines()) return 'rgba(60,64,67,0.28)';
		// When the lower-income focus overlay is active (step 11), suppress
		// TOD/non-TOD colored outlines on non-lower-income tracts so the
		// income split reads clearly.
		if (lowIncomeFocusOn && id) {
			const li = mismatchFlagsByGj.get(id)?.isLowIncome;
			if (li !== true) return 'rgba(60,64,67,0.28)';
		}
		if (dc === 'tod_dominated') return 'var(--accent, #0d9488)';
		if (dc === 'nontod_dominated') return 'var(--warning, #ea580c)';
		// Minimal/unclassified tracts when cohort outlines are active:
		// visible thin boundary so all tract shapes are clear.
		return 'rgba(60,64,67,0.35)';
	}

	/**
	 * Green / orange TOD tiers and mismatch (purple) use clip-masked interior rims.
	 * Neutral grey boundaries use a separate centered stroke (``tract-edge-plain``).
	 *
	 * Parameters
	 * ----------
	 * row : object | undefined
	 * id : string | undefined
	 *
	 * Returns
	 * -------
	 * boolean
	 */
	function tractEdgeUsesInteriorClip(row, id) {
		if (showMismatchOutlines() && id && effectiveMismatchIds.has(id)) return true;
		if (!showCohortOutlines()) return false;
		if (lowIncomeFocusOn && id) {
			const li = mismatchFlagsByGj.get(id)?.isLowIncome;
			if (li !== true) return false;
		}
		const dc = row?.devClass;
		return dc === 'tod_dominated' || dc === 'nontod_dominated';
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

	function developmentKey(d) {
		if (!d) return null;
		const name = String(d.name || d.project_name || '').trim();
		const lon = Number(d.longitude ?? d.lon);
		const lat = Number(d.latitude ?? d.lat);
		const coordPart =
			Number.isFinite(lon) && Number.isFinite(lat) ? `${lon.toFixed(5)},${lat.toFixed(5)}` : 'no-coords';
		if (!name && coordPart === 'no-coords') return null;
		return `${name || 'unnamed'}|${coordPart}`;
	}

	function isSpotlightMatch(row, spotlight) {
		return !!spotlight && row?.devClass === spotlight;
	}

	function passesGrowthFilter(row) {
		const v = Number(row?.census_hu_pct_change);
		return Number.isFinite(v);
	}

	function tintFill(baseFill, row) {
		if (!showCohortOutlines()) return baseFill;
		const dc = row?.devClass;
		if (dc !== 'tod_dominated' && dc !== 'nontod_dominated') return baseFill;
		const accent =
			dc === 'tod_dominated'
				? 'var(--accent, #0d9488)'
				: 'var(--warning, #ea580c)';
		return d3.interpolateRgb(baseFill, accent)(0.17);
	}

	const mismatchClusters = $derived.by(() =>
		computeTodMismatchClusters(tractList, nhgisRows, panelState.timePeriod)
	);
	const mismatchFlagsByGj = $derived.by(() => mismatchClusters.flagsByGj);

	/** Which mismatch tracts are shown — scroll-driven progressive reveal (stages 2–3). */
	const visibleMismatchIds = $derived.by(() => {
		const s = new Set();
		const c = mismatchClusters;
		if (!showMismatchOutlines()) return s;
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
	 * Stable key for guided auto-zoom: stage + data sizes only. Listing ``tractList`` / ``tractGeo``
	 * on the zoom ``$effect`` caused re-runs whenever parent passed new array references during
	 * scroll, stacking D3 transitions and freezing the page.
	 */
	const guidedMapZoomDeps = $derived(
		guidedMode
			? `${revealStage}:${tractGeo?.features?.length ?? 0}:${tractList?.length ?? 0}:${nhgisRows?.length ?? 0}`
			: ''
	);

	/** Computed once per stage/data change — avoid rebuilding in ``isTractDimmed`` (hot path). */
	const guidedGeographicFocusIds = $derived.by(() => {
		if (!guidedMode) return new Set();
		return guidedRegionIdsForStage(revealStage);
	});

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

	const stepContent = guidedMode
		? [
			{
				kicker: 'Step 1',
				title: 'Where Transit Access Is Strongest',
				bodyHtml:
					'This map shows how transit access across Greater Boston is concentrated in a dense, radial network centered on the urban core. The Red, Orange, Blue, and Green lines cluster around Boston and Cambridge, while the commuter rail extends outward into surrounding suburbs, with services like the CapeFLYER reaching even farther.<br><br>Focus on where lines overlap most. Boston and Cambridge stand out, along with places like Quincy and Revere. These areas represent the strongest and most consistent transit access.<br><br>This sets up a simple question: does housing growth appear in these same places?'
			},
			{
				kicker: 'Step 2',
				title: 'Where Housing Growth Is Happening',
				bodyHtml:
					'This map adds housing growth. Darker blues show stronger growth, reds show weaker or negative growth. The Seaport stands out, but strong growth also appears farther out in parts of Plymouth, Essex, and Worcester counties.<br><br>Now compare this to the previous map. Some growth appears near strong transit, but much of it appears beyond those areas.<br><br>If transit-oriented development is working as intended, we might expect growth to be more concentrated near the strongest parts of the network. Instead, the pattern looks more spread out, raising questions about how growth and access are distributed.'
			},
			{
				kicker: 'Step 3',
				title: 'Looking at the Contrast Up Close',
				bodyHtml:
					'Here, we zoom into individual tracts to make the pattern easier to see.<br><br>Focus on a few examples. Some tracts show strong housing growth with only limited transit access nearby. Others sit closer to strong transit but show little or even negative growth.<br><br>Looking at these side by side makes the contrast clearer. Growth and transit access do not consistently appear together.'
			},
			{
				kicker: 'Step 4',
				title: 'A measurable mismatch',
				bodyHtml:
					'This step makes the pattern explicit. Solid purple outlines mark tracts with strong transit access but low or negative housing growth. Dashed purple outlines mark the opposite, where growth is strong despite weaker or minimal transit access.<br><br>Both patterns appear across the region. Some high-access areas show limited growth, while some lower-access areas show substantial growth.<br><br>This does not mean growth outside transit is inherently negative, but it highlights a clear difference between where access is strongest and where housing is being added.'
			},
			{
				kicker: 'Step 5',
				title: 'How Growth Is Distributed Relative to Transit',
				bodyHtml:
					'We now move from mismatch to classification. Tracts are grouped based on how development is distributed relative to transit. Green outlines mark more transit-oriented development, while orange outlines mark more non-TOD patterns.<br><br>The map still shows housing growth underneath, but now also shows whether that growth is concentrated near transit or not.<br><br>This makes it easier to compare not just where growth appears, but how it relates to transit access across the region.'
			},
			{
				kicker: 'Step 6',
				title: 'Boston and Cambridge',
				bodyHtml:
					'This zoom focuses on Boston and Cambridge as a reference case. Most tracts here are TOD-dominated, which aligns with strong transit access.<br><br>At the same time, the pattern is not uniform. There are areas with minimal development, and some tracts show low or even negative growth.<br><br>This shows that even in the most connected areas, housing growth is not consistently high.'
			},
			{
				kicker: 'Step 7',
				title: 'Quincy and Revere',
				bodyHtml:
					'Moving outward to Quincy and Revere, the pattern becomes more mixed. Transit access is still present, but nearby tracts do not all show the same relationship between growth and TOD.<br><br>There are slightly more non-TOD tracts, and there are also areas with minimal development or low growth.<br><br>This suggests that the relationship between transit and growth becomes less consistent outside the urban core.'
			},
			{
				kicker: 'Step 8',
				title: 'Outer-Ring Growth',
				bodyHtml:
					'In the outer ring, the pattern shifts more clearly. Many tracts are farther from strong transit, and much of the development appears in non-TOD categories.<br><br>Transit is still present in some places, but it is more limited and less frequent. Growth appears more dispersed and less closely associated with strong transit access.<br><br>This highlights a different pattern compared to the urban core.'
			},
			{
				kicker: 'Step 9',
				title: 'Projects Enter the Picture',
				bodyHtml:
					'This step adds individual developments. Each dot represents a project, with size reflecting units and color showing the share of multi-family housing from white to purple. Green outlines indicate transit-accessible projects, while yellow outlines indicate those that are not.<br><br>Most projects are overwhelmingly multi-family, with many near 100 percent. Larger projects appear more often near the core, but projects are distributed across the region.<br><br>Many projects, even in highly accessible areas, include little or no affordable housing, which limits who is able to access those units.'
			},
			{
				kicker: 'Step 10',
				title: 'Projects as Examples',
				bodyHtml:
					'This step highlights a few projects to make the pattern more concrete. Some, like Assembly Row and 16 Boardman St, represent strong TOD cases with dense housing near transit. Others, like 16 Dyer, are near transit but less tightly integrated.<br><br>On the other end, projects like Mahoney Farm and The Pinehills show substantial growth farther from strong transit access.<br><br>These examples make it easier to compare how location, scale, and affordability vary across developments.'
			},
			{
				kicker: 'Step 11',
				title: 'Who This Affects',
				bodyHtml:
					'In this final step, higher-income tracts fade into the background, where high income is defined as greater than $125k per year and lower income as less than $125k.<br><br>Many lower-income tracts appear within mismatch categories. Some are in high-access areas with limited growth, while others are in areas with growth but weaker transit access.<br><br>Among lower-income tracts, there also appear to be more areas with minimal development, even in places with transit access.<br><br>This shifts the focus from where housing is built to how access is distributed. Transit-oriented development is often associated with improved access, but without affordability, that access may not be equally available to all households.'
			}
		]
		: [
			{
				kicker: 'Step 1',
				title: 'Transit-rich places',
				body: 'Start with tract fill only. This is the baseline view of housing growth before any extra layers appear.'
			},
			{
				kicker: 'Step 2',
				title: 'Growth is not only “on the line”',
				body: 'Orange and green outlines mark tracts that lean more TOD-dominated or non-TOD-dominated, while the choropleth still carries the main story.'
			},
			{
				kicker: 'Step 3',
				title: 'A measurable mismatch',
				body: 'Purple outlines take over here to show where transit access and housing growth pull apart, without the cohort outlines getting in the way.'
			},
			{
				kicker: 'Step 4',
				title: 'Bring projects back in',
				body: 'The cohort outlines return with development dots on top, so you can compare tract patterns with the projects that sit inside them.'
			}
		];

	const keyFindings = guidedMode
		? [
			'Transit access and housing growth are not aligned evenly across Greater Boston.',
			'Some transit-rich tracts still show weak housing growth, while some faster-growing tracts sit farther from strong transit access.',
			'The mismatch layer is the main takeaway: access and growth do not automatically arrive together.',
			'Lower-income tracts make that mismatch more consequential because access to transit and access to housing are both at stake.'
		]
		: [
			'Housing growth is uneven across the region, and the strongest growth does not simply track the transit network.',
			'TOD-dominated and non-TOD-dominated tracts both show up across the map, so transit-oriented development is only one part of the bigger pattern.',
			'Several transit-rich tracts still show relatively weak housing growth, which points to a clear access-growth mismatch.',
			'Project dots in the final view make it easier to compare tract-level patterns with the developments located there.'
		];

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

	function focusWaypointRef(node, meta) {
		focusWaypointEls = [...focusWaypointEls.filter((item) => item.node !== node), { node, ...meta }];
		return {
			update(nextMeta) {
				focusWaypointEls = focusWaypointEls.map((item) =>
					item.node === node ? { node, ...nextMeta } : item
				);
			},
			destroy() {
				focusWaypointEls = focusWaypointEls.filter((item) => item.node !== node);
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

	/**
	 * Higher value = should paint later (on top). Pinned / selected / hovered tracts
	 * render above others so dimmed polygons do not obscure focused geometry.
	 *
	 * Parameters
	 * ----------
	 * id : string | undefined
	 *     Tract ``gisjoin``.
	 *
	 * Returns
	 * -------
	 * number
	 *     Sort key 0–3.
	 */
	function tractFocusLiftRank(id) {
		if (!id) return 0;
		if (pinnedTractId === id) return 3;
		if (panelState.selectedTracts.has(id)) return 2;
		if (panelState.hoveredTract === id) return 1;
		return 0;
	}

	/** Re-append tract paths: focus lift first, then cohort tier rank, then id. */
	function reorderTractLayerPaths() {
		if (!containerEl) return;
		const rowByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
		const layer = d3.select(containerEl).select('.tract-layer');
		const nodes = layer.selectAll('g.tract-g').nodes();
		if (nodes.length === 0) return;
		nodes.sort((na, nb) => {
			const da = d3.select(na).datum();
			const db = d3.select(nb).datum();
			const ida = da.properties?.gisjoin;
			const idb = db.properties?.gisjoin;
			const fa = tractFocusLiftRank(ida);
			const fb = tractFocusLiftRank(idb);
			if (fa !== fb) return fa - fb;
			const ra = tractTierRankFromRow(rowByGj.get(ida));
			const rb = tractTierRankFromRow(rowByGj.get(idb));
			if (ra !== rb) return ra - rb;
			return String(ida ?? '').localeCompare(String(idb ?? ''));
		});
		const parent = nodes[0].parentNode;
		if (!parent) return;
		for (const n of nodes) parent.appendChild(n);
	}

	function buildChoroplethThresholds(maxAbs) {
		const abs = Math.max(1, Number(maxAbs) || 1);
		return [-0.66 * abs, -0.33 * abs, -0.08 * abs, 0.08 * abs, 0.33 * abs, 0.66 * abs];
	}

	let mapCanvasLeft = 0;
	let mapW = 520;
	const mapH = 430;
	/** ViewBox dimensions for anchoring HTML callouts to projection coordinates. */
	let mapViewBox = $state(/** @type {{ svgW: number; mapW: number; mapH: number }} */ ({
		svgW: 520,
		mapW: 520,
		mapH: 470
	}));

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
			af: allTractsGeo?.features?.length ?? 0,
			ms: mbtaStops.length,
			showDev: panelState.showDevelopments
		})
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
		svgRef.interrupt();
		svgRef
			.transition()
			.duration(600)
			.ease(d3.easeCubicInOut)
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
		svgRef.interrupt();
		svgRef
			.transition()
			.duration(500)
			.call(zoomBehaviorRef.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
	}

	function tractScreenAnchor(gisjoin) {
		if (!gisjoin || !projectionRef || !svgRef || !containerEl) return null;
		const feature = (tractGeo?.features ?? []).find((f) => f.properties?.gisjoin === gisjoin);
		if (!feature) return null;
		const centroid = d3.geoPath(projectionRef).centroid(feature);
		if (!Number.isFinite(centroid[0]) || !Number.isFinite(centroid[1])) return null;
		const transform = d3.zoomTransform(svgRef.node());
		const rect = containerEl.getBoundingClientRect();
		return {
			x: rect.left + transform.applyX(centroid[0]),
			y: rect.top + transform.applyY(centroid[1])
		};
	}

	function developmentScreenAnchor(d) {
		if (!d || !projectionRef || !svgRef || !containerEl) return null;
		const lon = Number(d.longitude ?? d.lon);
		const lat = Number(d.latitude ?? d.lat);
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
		const point = projectionRef([lon, lat]);
		if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
		const transform = d3.zoomTransform(svgRef.node());
		const rect = containerEl.getBoundingClientRect();
		return {
			x: rect.left + transform.applyX(point[0]),
			y: rect.top + transform.applyY(point[1])
		};
	}

	function zoomToFeatureGroup(features, scaleCap = 9) {
		if (!features?.length || !svgRef || !zoomBehaviorRef || !projectionRef) return;
		svgRef.interrupt();
		const path = d3.geoPath(projectionRef);
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const feature of features) {
			const [[fx0, fy0], [fx1, fy1]] = path.bounds(feature);
			if (!Number.isFinite(fx0) || !Number.isFinite(fy0) || !Number.isFinite(fx1) || !Number.isFinite(fy1)) continue;
			x0 = Math.min(x0, fx0);
			y0 = Math.min(y0, fy0);
			x1 = Math.max(x1, fx1);
			y1 = Math.max(y1, fy1);
		}
		const dx = x1 - x0;
		const dy = y1 - y0;
		if (!Number.isFinite(dx) || !Number.isFinite(dy) || dx <= 0 || dy <= 0) return;
		const scale = Math.max(1, Math.min(scaleCap, 0.84 / Math.max(dx / mapW, dy / mapH)));
		const tx = mapCanvasLeft + mapW / 2 - scale * (x0 + x1) / 2;
		const ty = mapH / 2 - scale * (y0 + y1) / 2;
		svgRef
			.transition()
			.duration(700)
			.ease(d3.easeCubicInOut)
			.call(zoomBehaviorRef.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
	}

	function zoomToDevelopment(d) {
		if (!d || !svgRef || !zoomBehaviorRef || !projectionRef) return;
		svgRef.interrupt();
		const lon = Number(d.longitude ?? d.lon);
		const lat = Number(d.latitude ?? d.lat);
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
		const point = projectionRef([lon, lat]);
		if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
		const scale = 11.5;
		const tx = mapCanvasLeft + mapW / 2 - scale * point[0];
		const ty = mapH / 2 - scale * point[1];
		svgRef
			.transition()
			.duration(600)
			.call(zoomBehaviorRef.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
	}

	function tractFeatureByGeoFilter(filterFn) {
		const feats = tractGeo?.features ?? [];
		if (!feats.length || !tractList?.length) return [];
		const byGj = new Map(tractList.map((t) => [t.gisjoin, t]));
		const out = [];
		for (const f of feats) {
			const gj = f.properties?.gisjoin;
			const tract = gj ? byGj.get(gj) : undefined;
			if (tract && filterFn(tract)) out.push(f);
		}
		return out;
	}

	function guidedRegionFeaturesForStage(stage) {
		if (!guidedMode) return [];
		if (stage === 5) {
			return tractFeatureByGeoFilter((t) => {
				const lat = Number(t.centlat);
				const lon = Number(t.centlon);
				return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 42.30 && lat <= 42.43 && lon >= -71.17 && lon <= -70.98;
			});
		}
		if (stage === 6) {
			return tractFeatureByGeoFilter((t) => {
				const lat = Number(t.centlat);
				const lon = Number(t.centlon);
				const isQuincy =
					Number.isFinite(lat) && Number.isFinite(lon) && lat >= 42.22 && lat <= 42.31 && lon >= -71.07 && lon <= -70.96;
				const isRevere =
					Number.isFinite(lat) && Number.isFinite(lon) && lat >= 42.39 && lat <= 42.45 && lon >= -71.04 && lon <= -70.96;
				return isQuincy || isRevere;
			});
		}
		if (stage === 7 || stage === 9) {
			const rowsByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
			return tractFeatureByGeoFilter((t) => {
				const lat = Number(t.centlat);
				const lon = Number(t.centlon);
				const row = rowsByGj.get(t.gisjoin);
				const growth = Number(row?.census_hu_pct_change);
				return Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(growth) && lon <= -71.15 && lon >= -72.2 && lat >= 42.1 && lat <= 42.55 && growth >= (stage === 9 ? 10 : 15);
			});
		}
		return [];
	}

	function guidedRegionIdsForStage(stage) {
		return new Set(guidedRegionFeaturesForStage(stage).map((f) => f.properties?.gisjoin).filter(Boolean));
	}

	function guidedRegionOutlineFeaturesForStage(stage) {
		return [];
	}

	function stopRadius(stop) {
		const m = stop.modes ?? [];
		if (m.includes('rail') || m.includes('commuter_rail')) return 1.5;
		return 0.6;
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

	/**
	 * Population-weighted mean for NHGIS-style rows (weights = tract population at period start).
	 *
	 * Parameters
	 * ----------
	 * rows : Array<object>
	 *     Rows with ``gisjoin``; Y comes from ``getY``.
	 * tractByGj : Map<string, object>
	 *     GISJOIN → tract row including ``weightKey`` (e.g. ``pop_2000``).
	 * weightKey : string
	 *     Tract field for weights, typically from ``popWeightKey(timePeriod)``.
	 * getY : (row: object, tract: object | undefined) => number
	 *     Outcome; non-finite values skip the row.
	 *
	 * Returns
	 * -------
	 * number | null
	 *     Weighted mean, or null when no row has positive weight and finite Y.
	 */
	function popWeightedMeanForRows(rows, tractByGj, weightKey, getY) {
		let sumW = 0;
		let sumWY = 0;
		for (const row of rows) {
			const tract = tractByGj.get(row.gisjoin);
			const w = tract ? Number(tract[weightKey]) : NaN;
			if (!Number.isFinite(w) || w <= 0) continue;
			const y = getY(row, tract);
			if (!Number.isFinite(y)) continue;
			sumW += w;
			sumWY += w * y;
		}
		return sumW > 0 ? sumWY / sumW : null;
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
		mapW = Math.max(400, Math.min(1100, cw - 16));

		mapCanvasLeft = 0;
		const svgW = mapCanvasLeft + mapW;
		const svgH = mapH;
		// Fit projection to the full-state GeoJSON when available so excluded
		// background tracts render correctly; fall back to the story subset.
		const fitGeo = allTractsGeo?.features?.length ? allTractsGeo : tractGeo;
		const projection = d3
			.geoMercator()
			.fitExtent(
				[
					[mapCanvasLeft, 0],
					[mapCanvasLeft + mapW, mapH]
				],
				fitGeo
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
			.style('background', 'var(--bg, #0f1115)')
			.on('click', handleBackgroundClick);
		svgRef = svg;

		const clipId = `poc-map-clip-${mapUid}`;
		const defs = svg.append('defs');
		defs.append('clipPath').attr('id', clipId)
			.append('rect')
			.attr('x', mapCanvasLeft)
			.attr('y', 0)
			.attr('width', mapW)
			.attr('height', mapH);

		svg.append('g').attr('class', 'map-dev-legend-group');

		const mapRoot = svg.append('g').attr('class', 'map-root').attr('clip-path', `url(#${clipId})`);
		const zoomLayer = mapRoot.append('g').attr('class', 'map-zoom-layer');

		// Background context layer: ALL tracts (including excluded-from-
		// analysis ones) so the shape of Massachusetts is always visible.
		// These get tan fill + thin boundaries + no pointer events. They
		// render underneath the data-bearing story tracts.
		const storyGjSet = new Set(sortedFeatures.map((f) => f.properties?.gisjoin).filter(Boolean));
		const excludedFeatures = (allTractsGeo?.features ?? []).filter(
			(f) => f.properties?.gisjoin && !storyGjSet.has(f.properties.gisjoin)
		);
		zoomLayer
			.append('g')
			.attr('class', 'bg-tract-layer')
			.selectAll('path.bg-tract')
			.data(excludedFeatures, (d) => d.properties?.gisjoin)
			.join('path')
			.attr('class', 'bg-tract')
			.attr('vector-effect', 'non-scaling-stroke')
			.attr('d', path)
			.attr('fill', EXCLUDED_TRACT_FILL)
			.attr('stroke', 'rgba(60,64,67,0.22)')
			.attr('stroke-width', 0.4)
			.style('paint-order', 'stroke')
			.style('pointer-events', 'none');

		// Per-tract <g>: choropleth fill, then two edge paths — ``tract-edge-clip`` for
		// TOD green/orange and mismatch purple (interior rim via clipPath); ``tract-edge-plain``
		// for neutral grey boundaries (centered stroke, no clip — classic map shell).
		// ``tract-interaction`` stays clipped: full ``MBTA_YELLOW`` = selection; lighter yellow = hover / tooltip
		// focus when the tract is not in the map selection.
		const tractGroup = zoomLayer.append('g').attr('class', 'tract-layer');

		const tractGs = tractGroup
			.selectAll('g.tract-g')
			.data(sortedFeatures, (d) => d.properties?.gisjoin)
			.join('g')
			.attr('class', 'tract-g');

		tractGs.each(function (d) {
			const gid = d.properties?.gisjoin;
			if (!gid) return;
			const cid = `poc-tract-clip-${mapUid}-${gid}`;
			d3.select(this)
				.append('defs')
				.append('clipPath')
				.attr('id', cid)
				.append('path')
				.attr('d', path(d));
		});

		const tractClipUrl = (d) => {
			const gid = d.properties?.gisjoin;
			return gid ? `url(#poc-tract-clip-${mapUid}-${gid})` : null;
		};

		tractGs.append('path')
			.attr('class', 'tract-fill')
			.attr('vector-effect', 'non-scaling-stroke')
			.attr('d', path)
			.attr('fill', 'var(--bg-card)')
			.attr('stroke', 'none')
			.style('pointer-events', 'none');

		tractGs.append('path')
			.attr('class', 'tract-edge-clip')
			.attr('vector-effect', 'non-scaling-stroke')
			.attr('d', path)
			.attr('clip-path', tractClipUrl)
			.attr('fill', 'none')
			.attr('stroke', 'none')
			.attr('stroke-width', 0)
			.style('pointer-events', 'none');

		tractGs.append('path')
			.attr('class', 'tract-edge-plain')
			.attr('vector-effect', 'non-scaling-stroke')
			.attr('d', path)
			.attr('fill', 'none')
			.attr('stroke', 'var(--border)')
			.attr('stroke-width', 1)
			.style('pointer-events', 'none');

		tractGs.append('path')
			.attr('class', 'tract-interaction')
			.attr('vector-effect', 'non-scaling-stroke')
			.attr('d', path)
			.attr('clip-path', tractClipUrl)
			.attr('fill', 'none')
			.attr('stroke', 'none')
			.attr('stroke-width', 0)
			.style('pointer-events', 'none');

		tractGs.append('path')
			.attr('class', 'tract-hit')
			.attr('vector-effect', 'non-scaling-stroke')
			.attr('d', path)
			.attr('fill', 'rgba(0,0,0,0)')
			.attr('stroke', 'none')
			.style('cursor', 'default')
			.style('pointer-events', 'all')
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

		zoomLayer.append('g').attr('class', 'focus-region-layer');
		zoomLayer.append('g').attr('class', 'dev-dots-layer');
		zoomLayer.append('g').attr('class', 'insight-layer');

		const zoom = d3
			.zoom()
			.scaleExtent([1, 28])
			.filter((event) => {
				if (guidedMode) return false;
				return (!event.ctrlKey || event.type === 'wheel') && !event.button;
			})
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

	/**
	 * Repaint tract fills and cohort strokes. Heavy legend work runs only when ``legend`` is true
	 * so hover/selection updates do not rebuild gradients (avoids jank and map-wide transitions).
	 *
	 * Parameters
	 * ----------
	 * animate : boolean
	 *     When false, skip D3 transitions (used for hover/selection-only repaints).
	 * legend : boolean
	 *     When false, skip colorbar / cache-only geometry updates still run.
	 */
	function updateChoropleth({ animate = true, legend = true } = {}) {
		if (!containerEl || !svgRef) return;

		refreshMetrics();

		const rowByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
		const spotlight = activeSpotlight;
		const values = (nhgisRows ?? [])
			.map((r) => Number(r.census_hu_pct_change))
			.filter(Number.isFinite);
		// Clip colorbar domain to 5-sigma so extreme outlier tracts don't
		// squash the scale and make the rest of the map look uniform.
		const mean = values.length ? d3.mean(values) : 0;
		const sd = values.length > 1 ? d3.deviation(values) : 1;
		const clipBound = Math.max(1, Math.abs(mean) + 5 * (sd || 1));
		const maxAbs = Math.min(clipBound, Math.max(1, d3.max(values, (d) => Math.abs(d)) || 1));
		const choroThresholds = buildChoroplethThresholds(maxAbs);
		const color = d3
			.scaleThreshold()
			.domain(choroThresholds)
			.range(CHORO_COLOR_STEPS);
		const guidedFocusIds = guidedGeographicFocusIds;

		// Choropleth fill for ``path.tract-fill`` only.
		const computeFill = (d) => {
			const id = d.properties?.gisjoin;
			const row = rowByGj.get(id);
			const li = mismatchFlagsByGj.get(id)?.isLowIncome;
			const isSelHover = id === panelState.hoveredTract || panelState.selectedTracts.has(id);
			if (guidedMode && revealStage === 0) {
				return isSelHover ? '#dbe7f6' : '#f2ede3';
			}
			if (lowIncomeFocusOn && li !== true && !isSelHover) {
				return LOW_INCOME_FOCUS_INACTIVE_FILL;
			}
			const v = row ? Number(row.census_hu_pct_change) : NaN;
			let baseFill = Number.isFinite(v) ? color(v) : '#e7e0d5';
			let fill = tintFill(baseFill, row);
			if (guidedMode && guidedFocusIds.size && !guidedFocusIds.has(id) && !isSelHover) {
				fill = desaturateFill(fill, 0.72);
			}
			if (mismatchLayerOn) {
				if (!effectiveMismatchIds.has(id)) {
					fill = desaturateFill(fill, 0.5);
				} else if (hoveredMismatchCluster) {
					const mk = mismatchKind(id);
					if (mk && mk !== hoveredMismatchCluster) {
						fill = desaturateFill(fill, 0.2);
					}
				}
			}
			return fill;
		};

		const computeOpacity = (d) => {
			const id = d.properties?.gisjoin;
			const row = rowByGj.get(id);
			if (id === panelState.hoveredTract || panelState.selectedTracts.has(id)) return 1;
			if (guidedMode && guidedFocusIds.size) {
				return guidedFocusIds.has(id) ? 1 : GUIDED_UNFOCUS_OPACITY;
			}
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
			return vis ? 1 : NON_MISMATCH_DIM;
		};

		const sel = d3.select(containerEl);

		const transitionSel = (s) =>
			animate ? s.transition().duration(450).ease(d3.easeCubicInOut) : s;

		// Opacity lives on the per-tract <g> so the fill-mask composites
		// correctly even when the group is dimmed.
		transitionSel(sel.selectAll('g.tract-g')).attr('opacity', computeOpacity);

		// Choropleth fill only.
		transitionSel(sel.selectAll('path.tract-fill')).attr('fill', computeFill);

		// Interior rim: TOD green/orange + mismatch purple (clip removes outer half of stroke).
		transitionSel(sel.selectAll('path.tract-edge-clip'))
			.attr('fill', 'none')
			.attr('stroke', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				if (!tractEdgeUsesInteriorClip(row, id)) return 'none';
				if (showMismatchOutlines() && effectiveMismatchIds.has(id)) {
					return mismatchKind(id) === 'ha_lg' ? MISMATCH_STROKE_HA : MISMATCH_STROKE_HG;
				}
				return visibleCohortStroke(row, id);
			})
			.attr('stroke-dasharray', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				if (!tractEdgeUsesInteriorClip(row, id)) return 'none';
				if (!showMismatchOutlines() || !effectiveMismatchIds.has(id)) return 'none';
				return mismatchKind(id) === 'hg_la' ? '6 5' : 'none';
			})
			.attr('stroke-width', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				if (!tractEdgeUsesInteriorClip(row, id)) return 0;
				const dc = row?.devClass;
				if (showMismatchOutlines() && effectiveMismatchIds.has(id)) {
					return (mismatchKind(id) === 'ha_lg' ? MISMATCH_W_HA : MISMATCH_W_HG) * 2;
				}
				if (guidedMode && revealStage === 0) return 1;
				if (!showCohortOutlines()) return 1.4;
				if (dc !== 'tod_dominated' && dc !== 'nontod_dominated') return 1.4;
				if (isSpotlightMatch(row, spotlight)) return 4.8;
				return dc === 'tod_dominated' ? 3.6 : 2.8;
			})
			.attr('stroke-opacity', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				if (!tractEdgeUsesInteriorClip(row, id)) return 0;
				if (showMismatchOutlines() && effectiveMismatchIds.has(id)) return MISMATCH_STROKE_OPACITY;
				if (guidedMode && guidedFocusIds.size && !guidedFocusIds.has(id)) return 0.62;
				if (mismatchLayerOn) {
					const dc = row?.devClass;
					if (dc === 'tod_dominated' || dc === 'nontod_dominated') return 0.92;
				}
				return 1;
			});

		// Neutral grey shells: centered stroke, no clip (not interior-halved).
		transitionSel(sel.selectAll('path.tract-edge-plain'))
			.attr('clip-path', null)
			.attr('fill', 'none')
			.attr('stroke', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				if (tractEdgeUsesInteriorClip(row, id)) return 'none';
				return visibleCohortStroke(row, id);
			})
			.attr('stroke-dasharray', 'none')
			.attr('stroke-width', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				if (tractEdgeUsesInteriorClip(row, id)) return 0;
				const dc = row?.devClass;
				if (guidedMode && revealStage === 0) return 1;
				if (!showCohortOutlines()) return 1.4;
				if (dc !== 'tod_dominated' && dc !== 'nontod_dominated') return 1.4;
				if (isSpotlightMatch(row, spotlight) && (dc === 'tod_dominated' || dc === 'nontod_dominated')) {
					return 4.8;
				}
				return 1.4;
			})
			.attr('stroke-opacity', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj.get(id);
				if (tractEdgeUsesInteriorClip(row, id)) return 0;
				return 1;
			});

		const svg = svgRef;
		if (legend) {
			const legGroup = svg.select('.map-legend-group');
			legGroup.selectAll('*').remove();
			// Bottom-left of the map canvas: inset so axis labels + rotated title do not clip at x=0.
			const leftInset = 34;
			legGroup.attr('transform', `translate(${mapCanvasLeft + leftInset},0)`);

			const barW = 10;
			const barRight = 58;
			const barLeft = barRight - barW;
			const bottomPad = 3;
			const tanH = 11;
			const legBarH = Math.min(132, Math.max(88, mapH * 0.31));
			const y0 = mapH - bottomPad - tanH - legBarH;
			const fmtTick = (v) => {
				const n = Number(v);
				if (!Number.isFinite(n)) return '';
				const ax = Math.abs(n);
				if (ax >= 1000 || (ax > 0 && ax < 0.01)) return `${d3.format('.2~s')(n)}%`;
				return `${d3.format('.1f')(n)}%`;
			};

			const legendG = legGroup.append('g').attr('class', 'map-legend-inner');
			const d0 = -maxAbs;
			const d1 = maxAbs;
			const binEdges = [d0, ...choroThresholds, d1];
			for (let i = 0; i < CHORO_COLOR_STEPS.length; i += 1) {
				const topVal = binEdges[i + 1];
				const bottomVal = binEdges[i];
				const yTop = y0 + ((d1 - topVal) / (d1 - d0)) * legBarH;
				const yBottom = y0 + ((d1 - bottomVal) / (d1 - d0)) * legBarH;
				legendG
					.append('rect')
					.attr('x', barLeft)
					.attr('y', yTop)
					.attr('width', barW)
					.attr('height', Math.max(1, yBottom - yTop))
					.attr('fill', CHORO_COLOR_STEPS[i])
					.attr('stroke', 'var(--border)')
					.attr('stroke-width', 0.35);
			}

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

			// Tan tracts: explain under the in-map colorbar (HTML duplicate removed from the key card).
			legendG
				.append('text')
				.attr('x', 0)
				.attr('y', y0 + legBarH + 9)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '6.5px')
				.attr('font-weight', 500)
				.text('Tan = limited or unreliable data');
		}

		containerEl.__pocChoroMaxAbs = maxAbs;
		containerEl.__pocRowByGj = rowByGj;
		if (legend) reorderTractLayerPaths();
	}

	function updateDevelopments() {
		if (!containerEl || !svgRef || !projectionRef) return;

		const svg = svgRef;
		const devLeg = svg.select('.map-dev-legend-group');
		devLeg.selectAll('*').remove();

		const devLayer = d3.select(containerEl).select('.dev-dots-layer');
		const t = d3.transition().duration(350);

		if (!showDevelopmentDots()) {
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
		const featuredDevelopmentKeys =
			guidedMode && revealStage === 9 && guidedStepTenExamples?.length
				? new Set((guidedStepTenExamples ?? []).map((item) => developmentKey(item?.dev)).filter(Boolean))
				: null;
		const huVals = filteredDevs.map((d) => Number(d.hu) || 0).filter((h) => h > 0);
		const huMin = huVals.length ? d3.min(huVals) : 1;
		const huMax = huVals.length ? d3.max(huVals) : 1;
		const lo = Math.max(1, huMin);
		const hi = Math.max(lo + 1e-6, huMax);
		const rScale = d3.scaleSqrt().domain([lo, hi]).range([1.4, 8]);

		devSizeLegendTicks = filteredDevs.length ? computeDevSizeLegendTicks(lo, hi, rScale) : [];

		const mfColor = d3.scaleLinear().domain([0, 1]).range(['#ffffff', '#7c3f98']).clamp(true);

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
				transitAccessible: access,
				isFeatured: featuredDevelopmentKeys ? featuredDevelopmentKeys.has(developmentKey(d)) : false,
				isActiveGuidedDevelopment:
					activeGuidedDevelopmentKey != null && developmentKey(d) === activeGuidedDevelopmentKey
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
						.attr('fill', (d) =>
							d.mfShare == null || !Number.isFinite(d.mfShare) ? '#cbd5e1' : mfColor(d.mfShare)
						)
						.attr('fill-opacity', 0.92)
						.attr('stroke', (d) => (d.transitAccessible ? MBTA_GREEN : MBTA_ORANGE))
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
			.attr('fill', (d) =>
				d.mfShare == null || !Number.isFinite(d.mfShare) ? '#cbd5e1' : mfColor(d.mfShare)
			)
			.attr('fill-opacity', 0.92)
			.attr('stroke', (d) => (d.transitAccessible ? MBTA_GREEN : MBTA_ORANGE))
			.attr('opacity', (d) => {
				if (!featuredDevelopmentKeys) return 1;
				if (d.isActiveGuidedDevelopment) return 1;
				return d.isFeatured ? 1 : 0.16;
			})
			.selection()
			.style('pointer-events', 'auto')
			.on('click', handleDevClick);

		// Set radius/stroke-width immediately from the *current* zoom
		// transform rather than animating them. This avoids a stale invK
		// when scrolling backward causes a zoom transition to run
		// concurrently — the zoom handler will keep rescaling from here.
		const liveK = d3.zoomTransform(svgRef.node()).k;
		const liveInvK = 1 / liveK;
		devLayer.selectAll('circle.dev-dot')
			.attr('r', (d) => (d.rBase * (d.isActiveGuidedDevelopment ? 1.22 : 1)) * liveInvK)
			.attr('stroke-width', (d) => ((d.strokeWBase + (d.isFeatured ? 0.18 : 0) + (d.isActiveGuidedDevelopment ? 0.55 : 0)) * liveInvK));

		devLayer.selectAll('circle.dev-dot').filter((d) => d.isFeatured).raise();
		devLayer.selectAll('circle.dev-dot').filter((d) => d.isActiveGuidedDevelopment).raise();
	}

	function updateFocusRegion() {
		if (!containerEl || !projectionRef) return;
		const layer = d3.select(containerEl).select('.focus-region-layer');
		const t = d3.transition().duration(250);
		const focusFeatures = guidedRegionOutlineFeaturesForStage(revealStage);
		if (!guidedMode || focusFeatures.length === 0) {
			layer.selectAll('g.focus-region').transition(t).attr('opacity', 0).remove();
			return;
		}
		const groups = layer
			.selectAll('g.focus-region')
			.data(focusFeatures, (d) => d.properties?.stage)
			.join(
				(enter) => {
					const g = enter.append('g').attr('class', 'focus-region').attr('opacity', 0);
					g.append('path').attr('class', 'focus-region__halo');
					g.append('path').attr('class', 'focus-region__outline');
					return g;
				},
				(update) => update,
				(exit) => exit.transition(t).attr('opacity', 0).remove()
			);
		const path = d3.geoPath(projectionRef);
		groups
			.select('path.focus-region__halo')
			.attr('d', path)
			.attr('fill', 'none')
			.attr('stroke', 'rgba(255, 253, 248, 0.98)')
			.attr('stroke-width', 4)
			.attr('stroke-linejoin', 'round')
			.attr('vector-effect', 'non-scaling-stroke');
		groups
			.select('path.focus-region__outline')
			.attr('d', path)
			.attr('fill', 'none')
			.attr('stroke', guidedMode && revealStage >= 7 ? MBTA_ORANGE : MBTA_GREEN)
			.attr('stroke-width', 2.2)
			.attr('stroke-linejoin', 'round')
			.attr('stroke-dasharray', revealStage >= 7 ? '7 5' : 'none')
			.attr('vector-effect', 'non-scaling-stroke');
		groups.transition(t).attr('opacity', 1);
	}

	function updateInsightMarkers() {
		if (!containerEl || !svgRef || !projectionRef) return;
		const layer = d3.select(containerEl).select('.insight-layer');
		const t = d3.transition().duration(250);
		if (!showMismatchOutlines() || !mismatchLayerOn || effectiveMismatchIds.size === 0) {
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
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
		const topHaLg = candidates.filter((d) => d.type === HIGH_ACCESS_LOW_GROWTH).slice(0, 2);
		const topHgLa = candidates.filter((d) => d.type === HIGH_GROWTH_LOW_ACCESS).slice(0, 2);
		const markerRows = [...topHaLg, ...topHgLa];

		const markers = layer
			.selectAll('g.insight-marker')
			.data(markerRows, (d) => d.id)
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

	/**
	 * Pointer / help cursor only where hover shows a tooltip (see ``handle*Enter`` early returns).
	 * When a tract or dev tooltip is pinned, overlay hovers are inert — use the default arrow.
	 */
	function updateMapHoverCursors() {
		if (!containerEl || !svgRef) return;
		const hoverTooltips = !guidedMode && !pinnedTractId && !pinnedDevKey;
		const root = d3.select(containerEl);
		root.selectAll('path.mbta-line').style('cursor', hoverTooltips ? 'pointer' : 'default');
		root.selectAll('circle.mbta-stop').style('cursor', hoverTooltips ? 'pointer' : 'default');
		root.selectAll('circle.dev-dot').style('cursor', hoverTooltips ? 'pointer' : 'default');
		root.selectAll('g.insight-marker').style('cursor', hoverTooltips ? 'help' : 'default');
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
		const effectiveHoveredId = hoveredId && !isTractDimmed(hoveredId) ? hoveredId : null;

		const selRoot = d3.select(containerEl);

		const computeSelOpacity = (d) => {
			const id = d.properties?.gisjoin;
			const row = rowByGj?.get(id);
			if (id === effectiveHoveredId || selectedSet.has(id)) return 1;
			if (guidedMode && guidedGeographicFocusIds.size) {
				return guidedGeographicFocusIds.has(id) ? 1 : GUIDED_UNFOCUS_OPACITY;
			}
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
			return vis ? 1 : NON_MISMATCH_DIM;
		};

		// Opacity on the per-tract group.
		selRoot.selectAll('g.tract-g')
			.attr('opacity', computeSelOpacity);

		// Clipped TOD/mismatch strokes on ``tract-edge-clip``; grey on ``tract-edge-plain``.
		// Hover / selection on ``tract-interaction`` (clipped).
		selRoot.selectAll('path.tract-interaction')
			.attr('stroke', (d) => {
				const id = d.properties?.gisjoin;
				// Map selection: full bus yellow. Hover / last-clicked ring (when not selected): same hue, lighter.
				if (selectedSet.has(id)) return MBTA_YELLOW;
				if (id === effectiveHoveredId) return TRACT_HOVER_OUTLINE;
				return 'none';
			})
			.attr('stroke-dasharray', (d) => {
				const id = d.properties?.gisjoin;
				if (id === effectiveHoveredId || selectedSet.has(id)) return 'none';
				return 'none';
			})
			.attr('stroke-width', (d) => {
				const id = d.properties?.gisjoin;
				const row = rowByGj?.get(id);
				const dc = row?.devClass;
				// Slightly stronger ring on selected tracts; a touch wider for hover / tooltip-only focus.
				if (selectedSet.has(id)) return dc === 'minimal' ? 3.4 : 6;
				if (id === effectiveHoveredId) return dc === 'minimal' ? 4 : 7.2;
				return 0;
			})
			.attr('stroke-opacity', (d) => {
				const id = d.properties?.gisjoin;
				if (id === effectiveHoveredId || selectedSet.has(id)) return 1;
				return 0;
			});

		// Hand cursor only when this tract would show a hover tooltip (``handleTractEnter``).
		selRoot.selectAll('path.tract-hit').style('cursor', (d) => {
			const id = d.properties?.gisjoin;
			if (!id || pinnedTractId || pinnedDevKey) return 'default';
			return isTractDimmed(id) ? 'default' : 'pointer';
		});
	}

	function showTractTooltip(id, x, y, anchor = null) {
		if (!id) return;
		const el = containerEl;
		if (!el) return;
		const rowByGj = el.__pocRowByGj;
		const row = rowByGj?.get(id);
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
		// Recompute the tier from live metrics when possible so the badge is
		// always consistent with the numeric "TOD share" and "stock increase"
		// rows below. Falls back to ``row.devClass`` only when the live
		// metrics map is unavailable (e.g. before developments finish loading
		// — though the awaited ``loadGuidedDevelopments`` also prevents that).
		const liveMetrics = tractTodMetricsMap?.get(id);
		const liveTier = liveMetrics
			? classifyTractDevelopment(
					liveMetrics,
					panelState.sigDevMinPctStockIncrease ?? 2,
					panelState.todFractionCutoff ?? 0.5
				)
			: null;
		const devClass = liveTier ?? row?.devClass ?? null;
		const tier =
			devClass === 'tod_dominated'
				? 'TOD-dominated tract'
				: devClass === 'nontod_dominated'
					? 'Non-TOD-dominated (significant dev)'
					: devClass === 'minimal'
						? 'Minimal development'
						: 'Unclassified';
		const badgeTone =
			devClass === 'tod_dominated'
				? 'tod'
				: devClass === 'nontod_dominated'
					? 'nontod'
					: devClass === 'minimal'
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
			x,
			y,
			anchorX: anchor?.x ?? null,
			anchorY: anchor?.y ?? null,
			eyebrow: mismatchEyebrow ?? 'Census tract',
			title: county && String(county) !== 'County Name' ? `Tract in ${tractPlace}` : `Tract: ${tractPlace}`,
			badge: tier,
			badgeTone,
			primaryRows,
			secondaryRows
		};
		pinnedTooltipStage = anchor ? revealStage : null;
	}

	/**
	 * Whether a tract is currently dimmed / out-of-focus and should be
	 * inert to hover (no tooltip, no stroke highlight, no opacity change).
	 */
	function isTractDimmed(id) {
		if (!id) return false;
		// Guided geographic focus (stages 5-7, 9).
		if (guidedMode) {
			if (guidedGeographicFocusIds.size && !guidedGeographicFocusIds.has(id)) return true;
		}
		// Mismatch layer dims non-mismatch tracts.
		if (mismatchLayerOn && !effectiveMismatchIds.has(id)) return true;
		// Low-income focus dims non-lower-income tracts.
		if (lowIncomeFocusOn) {
			const li = mismatchFlagsByGj.get(id)?.isLowIncome;
			if (li !== true) return true;
		}
		// Spotlight dims non-matching tracts.
		if (activeSpotlight) {
			const rowByGj = containerEl?.__pocRowByGj;
			const row = rowByGj?.get(id);
			if (!isSpotlightMatch(row, activeSpotlight)) return true;
		}
		return false;
	}

	function cancelHoverRest() {
		if (hoverRestTimer) { clearTimeout(hoverRestTimer); hoverRestTimer = null; }
		pendingHoverPos = null;
		pendingHoverId = null;
	}

	function commitHoverTooltip(id, x, y) {
		if (!id || pinnedTractId || pinnedDevKey) return;
		showTractTooltip(id, x, y);
		// Set the mismatch-cluster highlight only now (not on enter)
		// so the opposite group doesn't fade while the user is still
		// moving toward a tract.
		const mk = id ? mismatchKind(id) : null;
		hoveredMismatchCluster = mk && effectiveMismatchIds.has(id) ? mk : null;
		// Clear pending state so subsequent mousemove tracks normally.
		pendingHoverId = null;
		pendingHoverPos = null;
	}

	function handleTractEnter(event, d) {
		if (guidedMode) return;
		const id = d.properties?.gisjoin;
		if (isTractDimmed(id)) return;
		if (pinnedTractId || pinnedDevKey) return;
		panelState.setHovered(id);
		// Don't set hoveredMismatchCluster yet — wait for the debounce
		// so the user sees the group-fade only after the tooltip appears.
		cancelHoverRest();
		pendingHoverId = id;
		pendingHoverPos = { x: event.clientX, y: event.clientY };
		hoverRestTimer = setTimeout(() => {
			commitHoverTooltip(id, pendingHoverPos?.x ?? event.clientX, pendingHoverPos?.y ?? event.clientY);
			hoverRestTimer = null;
		}, 200);
	}

	function handleMouseMove(event) {
		if (guidedMode) return;
		if (pinnedTractId || pinnedDevKey) return;
		if (pendingHoverId) {
			pendingHoverPos = { x: event.clientX, y: event.clientY };
			if (hoverRestTimer) clearTimeout(hoverRestTimer);
			hoverRestTimer = setTimeout(() => {
				commitHoverTooltip(pendingHoverId, pendingHoverPos?.x ?? event.clientX, pendingHoverPos?.y ?? event.clientY);
				hoverRestTimer = null;
			}, 200);
			return;
		}
		if (tooltip.visible) {
			tooltip = { ...tooltip, x: event.clientX, y: event.clientY };
		}
	}

	function handleTractLeave() {
		if (guidedMode) return;
		cancelHoverRest();
		// Don't clear pinned tooltip on mouse leave.
		if (!pinnedTractId && !pinnedDevKey) {
			panelState.setHovered(null);
			hoveredMismatchCluster = null;
			pinnedTooltipStage = null;
			tooltip = { ...tooltip, visible: false };
		}
	}

	function handleTractClick(event, d) {
		event.stopPropagation();
		const id = d.properties?.gisjoin;
		if (!id) return;

		// Dimmed tract: dismiss any pinned tooltip without selecting this tract.
		if (isTractDimmed(id)) {
			const hadPin = pinnedTractId || pinnedDevKey;
			if (pinnedTractId) {
				panelState.clearSelection();
				pinnedTractId = null;
				pinnedTooltip = null;
				panelState.setHovered(null);
			}
			if (pinnedDevKey) {
				pinnedDevKey = null;
				pinnedDevTooltip = null;
			}
			if (hadPin) {
				tooltip = { ...tooltip, visible: false };
				cancelHoverRest();
			}
			return;
		}

		if (pinnedDevKey) {
			pinnedDevKey = null;
			pinnedDevTooltip = null;
		}

		cancelHoverRest();
		// One click = toggle map selection; re-click the same tract to remove it. Tooltip/pin
		// always tracks the last-clicked tract, independent of whether it is still selected.
		panelState.toggleTract(id);
		if (!panelState.selectedTracts.size) {
			pinnedTractId = null;
			pinnedTooltip = null;
			// Resets lastInteractedGisjoin; selectedTracts is already empty from toggle.
			panelState.clearSelection();
			panelState.setHovered(null);
			tooltip = { ...tooltip, visible: false };
		} else {
			pinnedTractId = id;
			panelState.setHovered(id);
			showTractTooltip(id, event.clientX, event.clientY);
			pinnedTooltip = { ...tooltip };
		}

		if (event.shiftKey) panelState.toggleComparisonTract(id);
	}

	/** Click on map background (not on a tract) → deselect pinned tract or development. */
	function handleBackgroundClick() {
		if (pinnedTractId) {
			pinnedTractId = null;
			pinnedTooltip = null;
			panelState.setHovered(null);
			panelState.clearSelection();
			tooltip = { ...tooltip, visible: false };
		}
		if (pinnedDevKey) {
			pinnedDevKey = null;
			pinnedDevTooltip = null;
			tooltip = { ...tooltip, visible: false };
		}
	}

	function handleStopEnter(event, d) {
		if (guidedMode) return;
		if (pinnedTractId || pinnedDevKey) return;
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
		if (guidedMode) return;
		if (pinnedTractId || pinnedDevKey) return;
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

	function showDevelopmentTooltip(d, x, y, anchor = null) {
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
		const src = d.affrd_source === 'lihtc' ? ' (HUD LIHTC)' : '';
		primaryRows.push({
			label: 'Affordable units',
			value: affCap > 0 ? `${affCap}${src}` : (d.manualAffordableLabel || 'No affordable units listed')
		});
		const affPct = Number(d.affrd_percent);
		secondaryRows.push({
			label: 'Affordability',
			value: Number.isFinite(affPct)
				? `${fmtPct(affPct)}% income-restricted`
				: affCap > 0
					? 'Some affordable units listed'
					: (d.manualAffordabilityNote || 'No affordability share listed')
		});
		secondaryRows.push({ label: 'Type', value: d.mixed_use ? 'Mixed-use' : 'Residential' });
		if (d.rdv) secondaryRows.push({ label: 'Redevelopment', value: 'Yes' });
		tooltip = {
			visible: true,
			x,
			y,
			anchorX: anchor?.x ?? null,
			anchorY: anchor?.y ?? null,
			eyebrow: 'MassBuilds project',
			title: `Development: ${d.name || 'Unnamed project'}`,
			badge: access ? 'Transit-accessible' : 'Not transit-accessible',
			badgeTone: access ? 'tod' : 'minimal',
			primaryRows,
			secondaryRows
		};
		pinnedTooltipStage = anchor ? revealStage : null;
	}

	function handleDevEnter(event, d) {
		if (guidedMode) return;
		if (pinnedTractId || pinnedDevKey) return;
		showDevelopmentTooltip(d, event.clientX, event.clientY);
	}

	function handleDevClick(event, d) {
		event.stopPropagation();
		const key = developmentKey(d);
		if (!key) return;

		if (pinnedDevKey === key) {
			pinnedDevKey = null;
			pinnedDevTooltip = null;
			tooltip = { ...tooltip, visible: false };
			return;
		}

		if (pinnedTractId) {
			panelState.clearSelection();
			pinnedTractId = null;
			pinnedTooltip = null;
			panelState.setHovered(null);
		}
		cancelHoverRest();
		pinnedDevKey = key;
		showDevelopmentTooltip(d, event.clientX, event.clientY);
		pinnedDevTooltip = { ...tooltip };
	}

	function handleOverlayLeave() {
		cancelHoverRest();
		if (pinnedTractId || pinnedDevKey) return;
		panelState.setHovered(null);
		hoveredMismatchCluster = null;
		pinnedTooltipStage = null;
		activeGuidedDevelopmentKey = null;
		tooltip = { ...tooltip, visible: false };
	}

	function handleInsightEnter(event, d) {
		if (pinnedTractId || pinnedDevKey) return;
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
		const weightKey = popWeightKey(panelState.timePeriod);
		const tractByGj = new Map((tractList ?? []).map((t) => [t.gisjoin, t]));
		return {
			label: cohortLabel(spotlight),
			description: spotlightDescription(spotlight),
			count: rows.length,
			avgHuGrowth: popWeightedMeanForRows(rows, tractByGj, weightKey, (r) => Number(r.census_hu_pct_change)),
			avgTodShare: popWeightedMeanForRows(rows, tractByGj, weightKey, (r) => {
				const m = tractTodMetricsMap?.get(r.gisjoin);
				return m ? Number(m.todFraction) : NaN;
			}),
			avgStockIncrease: popWeightedMeanForRows(rows, tractByGj, weightKey, (r) => {
				const m = tractTodMetricsMap?.get(r.gisjoin);
				return m ? Number(m.pctStockIncrease) : NaN;
			})
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
		const weightKey = popWeightKey(panelState.timePeriod);
		const tractByGj = new Map((tractList ?? []).map((t) => [t.gisjoin, t]));
		const cohortAvgHu = popWeightedMeanForRows(cohortRows, tractByGj, weightKey, (r) =>
			Number(r.census_hu_pct_change)
		);
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

	// Expose focused-tract summary + zoom to sidebars (TractDetail) when the parent binds these props.
	$effect(() => {
		mapFocusedTractDetail = selectedTractDetail;
	});
	$effect(() => {
		mapViewActions = { zoomToTract };
	});

	// Clearing selection from the sidebar (not via map click) should drop the pinned tooltip/ring, too.
	$effect(() => {
		const n = panelState.selectedTracts.size;
		if (n === 0 && pinnedTractId) {
			pinnedTractId = null;
			pinnedTooltip = null;
			panelState.setHovered(null);
			tooltip = { ...tooltip, visible: false };
		}
	});

	const selectionComparison = $derived.by(() => {
		const selectedIds = [...panelState.selectedTracts];
		const weightKey = popWeightKey(panelState.timePeriod);
		const tractByGj = new Map((tractList ?? []).map((t) => [t.gisjoin, t]));
		const metricValue = (rows) => {
			if (comparisonMetric === 'hu_growth') {
				return popWeightedMeanForRows(rows, tractByGj, weightKey, (row) =>
					Number(row.census_hu_pct_change)
				);
			}
			if (comparisonMetric === 'tod_share') {
				return popWeightedMeanForRows(rows, tractByGj, weightKey, (row) => {
					const m = tractTodMetricsMap?.get(row.gisjoin);
					return m ? Number(m.todFraction) * 100 : NaN;
				});
			}
			return popWeightedMeanForRows(rows, tractByGj, weightKey, (row) => {
				const m = tractTodMetricsMap?.get(row.gisjoin);
				return m ? Number(m.pctStockIncrease) : NaN;
			});
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
			return { label: 'Avg. stock increase', suffix: '%', formatter: d3.format('.1f') };
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

	const guidedContrastExamples = $derived.by(() => {
		if (!guidedMode) return [];
		const tractByGj = new Map((tractList ?? []).map((t) => [t.gisjoin, t]));
		const rowByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
		const curated = [
			{
				id: 'G2500250060600',
				label: 'Tract in Suffolk County',
				note:
					'This Suffolk County tract shows very strong housing growth in a high-income, transit-accessible part of the core, reminding us that growth can still be concentrated in places that already hold strong access advantages.'
			},
			{
				id: 'G2500170373600',
				label: 'Tract in Middlesex County',
				note:
					'This tract sits along the Green Line corridor but still shows negative housing growth, which helps show that strong transit access does not guarantee new housing production.'
			},
			{
				id: 'G2500270732902',
				label: 'Tract in Worcester County',
				note:
					'This tract is far from any MBTA line but still shows very high housing growth, making the reverse contrast especially clear.'
			}
		];
		return curated
			.map((item) => {
				const tract = tractByGj.get(item.id);
				const row = rowByGj.get(item.id);
				if (!tract || !row) return null;
				const growth = Number(row?.census_hu_pct_change);
				const stops = Number(tract?.transit_stops);
				const county =
					tract?.county && String(tract.county) !== 'County Name' ? String(tract.county) : null;
				const incomeRaw =
					row?.median_household_income ??
					tract?.median_income_2020 ??
					null;
				const income = Number(incomeRaw);
				if (!Number.isFinite(growth) || !Number.isFinite(stops)) return null;
				return {
					id: item.id,
					county,
					label: item.label,
					growth,
					stops,
					income: Number.isFinite(income) ? income : null,
					note: item.note
				};
			})
			.filter(Boolean);
	});
	const guidedContrastFeatured = $derived(guidedContrastExamples?.[0] ?? null);

	const guidedMismatchExamples = $derived.by(() => {
		if (!guidedMode) return [];
		const rowsByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
		const tractByGj = new Map((tractList ?? []).map((t) => [t.gisjoin, t]));
		const candidates = (tractGeo?.features ?? [])
			.map((f) => {
				const id = f?.properties?.gisjoin;
				if (!id || !effectiveMismatchIds.has(id)) return null;
				const row = rowsByGj.get(id);
				const tract = tractByGj.get(id);
				const mismatch = mismatchFlagsByGj.get(id);
				const growth = Number(row?.census_hu_pct_change);
				const stops = Number(tract?.transit_stops);
				if (!Number.isFinite(growth) || !Number.isFinite(stops)) return null;
				const county =
					tract?.county && String(tract.county) !== 'County Name'
						? String(tract.county)
						: null;
				const incomeRaw =
					row?.median_household_income ??
					mismatch?.medianHouseholdIncome ??
					tract?.median_income_2020 ??
					null;
				const income = Number(incomeRaw);
				const isHaLg = Boolean(mismatch?.isHighAccessLowGrowth);
				return {
					id,
					county,
					label: county ? `Tract in ${county}` : `Tract ${id}`,
					kind: isHaLg ? 'High access, low growth' : 'High growth, low access',
					note: isHaLg
						? 'This red marker highlights a tract with strong transit access but relatively weak housing growth.'
						: 'This red marker highlights a tract where housing growth has been stronger despite weaker transit access.',
					growth,
					stops,
					income: Number.isFinite(income) ? income : null,
					score: isHaLg ? stops - growth : growth - stops,
					kindRank: isHaLg ? 0 : 1
				};
			})
			.filter(Boolean)
			.sort((a, b) => {
				if (a.kindRank !== b.kindRank) return a.kindRank - b.kindRank;
				return b.score - a.score;
			});
		const haLg = candidates.filter((d) => d.kindRank === 0).slice(0, 2);
		const hgLa = candidates.filter((d) => d.kindRank === 1).slice(0, 2);
		return [...haLg, ...hgLa];
	});
	const guidedMismatchFeatured = $derived(guidedMismatchExamples?.[0] ?? null);

	const guidedDevelopmentExamples = $derived.by(() => {
		if (!guidedMode || !tractList?.length) return [];
		const { filteredDevs } = buildFilteredData(tractList, developments, panelState);
		const transitM = transitDistanceMiToMetres(panelState.transitDistanceMi ?? 0.5);
		const enriched = filteredDevs
			.map((d) => {
				const units = Number(d.hu) || 0;
				const affordableUnits = developmentAffordableUnitsCapped(d);
				const isTod = isDevelopmentTransitAccessible(d, transitM) && meetsTodMultifamilyFloor(d, panelState);
				return {
					...d,
					units,
					affordableUnits,
					isTod,
					categoryLabel: isTod ? 'TOD development' : 'Non-TOD development',
					score: affordableUnits * 3 + units + (isTod ? 120 : 0)
				};
			})
			.filter((d) => d.units > 0)
			.sort((a, b) => b.score - a.score);
		const tod = enriched.find((d) => d.isTod);
		const nonTod = enriched.find((d) => !d.isTod);
		const affordability = enriched.find((d) => d.affordableUnits > 0 && d !== tod && d !== nonTod) ?? enriched.find((d) => d.affordableUnits > 0);
		return [tod, nonTod, affordability].filter(Boolean).slice(0, 3);
	});

	const guidedClusterDevelopmentExamples = $derived.by(() => {
		if (!guidedMode || !tractList?.length) return [];
		const { filteredDevs } = buildFilteredData(tractList, developments, panelState);
		const transitM = transitDistanceMiToMetres(panelState.transitDistanceMi ?? 0.5);
		const includesAny = (text, needles) => needles.some((needle) => text.includes(needle));
		const curatedTargets = [
			{
				match: (name, municipal) =>
					municipal === 'somerville' &&
					includesAny(name, ['assembly row', 'assembly', 'xmbly', 'alloy assembly', 'montaje']),
				preferred: (name) => includesAny(name, ['assembly row: block 2', 'block 2']),
				sortBoost: 420,
				importanceNote:
					'Assembly Row is one of the clearest alignment cases in the region: dense housing delivered right on top of rapid transit, which is the TOD pattern planners often hope to reproduce.'
			},
			{
				match: (name, municipal) =>
					municipal === 'cambridge' &&
					includesAny(name, ['cambridge crossing', 'north point', 'northpoint', 'earhart', 'park 151']),
				preferred: (name) => includesAny(name, ['park 151', 'building i']),
				sortBoost: 360,
				importanceNote:
					'Cambridge Crossing shows that strong TOD can still lean heavily market-rate, which matters because transit access alone does not guarantee affordability.'
			},
			{
				match: (name, municipal) =>
					includesAny(name, ['suffolk downs', 'suffolk']) ||
					(municipal === 'revere' && includesAny(name, ['amaya'])),
				preferred: (name) => includesAny(name, ['amaya suffolk downs', 'amaya']),
				sortBoost: 380,
				importanceNote:
					'Suffolk Downs matters because it represents TOD at very large future scale, but the affordability story is phased over time rather than arriving all at once.'
			},
			{
				match: (name) => includesAny(name, ['south bay', 'dorchester avenue', 'dorchester ave']),
				preferred: (name) => includesAny(name, ['south bay town center']),
				sortBoost: 260,
				importanceNote:
					'South Bay helps show a weaker TOD case: substantial housing growth near transit infrastructure, but not with the same direct, subway-oriented accessibility as the strongest core examples.'
			},
			{
				match: (name, municipal) => municipal === 'boston' && includesAny(name, ['seaport', 'echelon']),
				preferred: (name) => includesAny(name, ['echelon seaport']),
				sortBoost: 300,
				importanceNote:
					'Seaport growth is important because it shows how a large share of housing and jobs can still accumulate outside the strongest rapid-transit geography.'
			},
			{
				match: (_name, municipal) => municipal === 'quincy',
				preferred: (name) => includesAny(name, ['avalon bay on quarry street', 'neponset landing apartments']),
				sortBoost: 180,
				importanceNote:
					'A Quincy example helps show that even in a transit-served city, development is uneven and not every major project lands in the strongest TOD setting.'
			},
			{
				match: (_name, municipal) => municipal === 'weymouth',
				preferred: (name) => includesAny(name, ['fulton school', 'tirrell', 'commercial street']),
				sortBoost: 170,
				importanceNote:
					'A Weymouth example shows the reverse case: meaningful multifamily growth can still occur in places that depend more on weaker or less frequent transit access.'
			}
		];
		const enriched = filteredDevs
			.map((d) => {
				const lon = Number(d.longitude ?? d.lon);
				const lat = Number(d.latitude ?? d.lat);
				const units = Number(d.hu) || 0;
				if (!Number.isFinite(lon) || !Number.isFinite(lat) || units <= 0) return null;
				const affordableUnits = developmentAffordableUnitsCapped(d);
				const isTod = isDevelopmentTransitAccessible(d, transitM) && meetsTodMultifamilyFloor(d, panelState);
				const normalizedName = String(d.name || d.project_name || '').toLowerCase();
				const normalizedMunicipal = String(d.municipal || '').toLowerCase();
				const curated = curatedTargets.find((t) => t.match(normalizedName, normalizedMunicipal));
				const preferredMatch = curated?.preferred?.(normalizedName) ?? false;
				return {
					...d,
					units,
					affordableUnits,
					isTod,
					categoryLabel: isTod ? 'TOD development' : 'Non-TOD development',
					importanceNote: curated
						? curated.importanceNote
						: isTod
							? 'This TOD project shows where new housing is being added close to transit, which is the alignment case the policy conversation often expects.'
							: 'This non-TOD project shows that substantial housing can still be added outside the strongest transit geography, which matters for the mismatch argument.',
					curatedPriority: curated ? 1 : 0,
					score:
						units +
						affordableUnits * 3 +
						(affordableUnits > 0 ? 120 : 0) +
						(isTod ? 40 : 0) +
						(curated?.sortBoost ?? 0) +
						(preferredMatch ? 900 : 0)
				};
			})
			.filter(Boolean)
			.sort((a, b) => b.score - a.score);
		const curated = enriched.filter((d) => d.curatedPriority === 1);
		if (curated.length) return curated.slice(0, 4);
		const tod = enriched.find((d) => d.isTod);
		const nonTod = enriched.find((d) => !d.isTod);
		const affordability = enriched.find((d) => d.affordableUnits > 0 && d !== tod && d !== nonTod) ?? enriched.find((d) => d.affordableUnits > 0);
		return [tod, nonTod, affordability].filter(Boolean).slice(0, 3);
	});

	const manualImportantDevelopmentExamples = $derived.by(() => {
		if (!guidedMode || !tractList?.length || !developments?.length) return [];
		const { filteredDevs } = buildFilteredData(tractList, developments, panelState);
		const transitM = transitDistanceMiToMetres(panelState.transitDistanceMi ?? 0.5);
		const candidates = filteredDevs
			.map((d) => {
				const lon = Number(d.longitude ?? d.lon);
				const lat = Number(d.latitude ?? d.lat);
				const units = Number(d.hu) || 0;
				if (!Number.isFinite(lon) || !Number.isFinite(lat) || units <= 0) return null;
				const affordableUnits = developmentAffordableUnitsCapped(d);
				const isTod = isDevelopmentTransitAccessible(d, transitM) && meetsTodMultifamilyFloor(d, panelState);
				return {
					...d,
					units,
					affordableUnits,
					isTod,
					categoryLabel: isTod ? 'TOD development' : 'Non-TOD development',
					importanceNote: isTod
						? 'Assembly Row is one of the clearest alignment cases in the region: dense housing delivered right on top of rapid transit, which is the TOD pattern planners often hope to reproduce.'
						: 'This project helps show that meaningful housing growth can still happen outside the strongest transit geography, which matters for the mismatch argument.',
					score: units + affordableUnits * 3 + (isTod ? 60 : 0)
				};
			})
			.filter(Boolean);

		const exactAssembly = candidates.find((d) => String(d.name || '').toLowerCase() === 'assembly row: block 2');
		if (exactAssembly) return [exactAssembly];

		const looseAssembly = candidates.find((d) =>
			String(d.name || '').toLowerCase().includes('assembly row')
		);
		if (looseAssembly) return [looseAssembly];

		return [];
	});

	const importantDevelopmentExamples = $derived.by(() => {
		if (manualImportantDevelopmentExamples?.length) return manualImportantDevelopmentExamples;
		if (guidedClusterDevelopmentExamples?.length) return guidedClusterDevelopmentExamples;
		return guidedDevelopmentExamples ?? [];
	});

	const guidedStepTenExamples = $derived.by(() => {
		const realByName = new Map((developments ?? []).map((d) => [String(d.name || d.project_name || ''), d]));
		const specs = [
			{
				id: 'assembly-row-block-2',
				label: 'Assembly Row: Block 2',
				sourceName: 'Assembly Row: Block 2',
				categoryLabel: 'Strong TOD example',
				categoryTone: 'tod',
				note:
					'Somerville. Assembly Row is a strong TOD case: dense mixed-use growth delivered right on top of rapid transit, which is the alignment pattern planners often hope to reproduce.',
				fallback: {
					id: 'manual-assembly-row-block-2',
					name: 'Assembly Row: Block 2',
					municipal: 'Somerville',
					hu: 123,
					lon: -71.08045,
					lat: 42.39535,
					nearest_stop_dist_m: 89.44,
					mixed_use: true,
					rdv: true
				},
				manualAffordableLabel: 'No affordable units listed',
				manualAffordabilityNote: 'This filtered MassBuilds record does not list an affordable-unit count for the project.'
			},
			{
				id: 'amaya-suffolk-downs',
				label: '16 Boardman St',
				sourceName: '16 Boardman St',
				categoryLabel: 'TOD example',
				categoryTone: 'tod',
				note:
					'Boston. 16 Boardman St is a real East Boston project in the dataset and works as another TOD case: new housing added very close to rapid transit, which is the kind of alignment transit-oriented policy is meant to encourage.',
				fallback: {
					id: 'manual-amaya-suffolk-downs',
					name: '16 Boardman St',
					municipal: 'Boston',
					hu: 19,
					lon: -71.00884,
					lat: 42.38745,
					nearest_stop_dist_m: 49.69,
					mixed_use: false,
					rdv: false
				},
				manualAffordableLabel: 'Not listed in this record',
				manualAffordabilityNote: 'This project-level record does not list an affordable-unit count.'
			},
			{
				id: 'allston-yards',
				label: '16 Dyer',
				sourceName: '16 Dyer',
				categoryLabel: 'Partial TOD example',
				categoryTone: 'partial',
				note:
					'Boston. 16 Dyer is a real project in the dataset and works as a partial-TOD case: it is near transit, but not in the same way as the strongest flagship TOD examples.',
				fallback: {
					id: 'manual-allston-yards',
					name: '16 Dyer',
					municipal: 'Boston',
					hu: 40,
					lon: -71.07988,
					lat: 42.28356,
					nearest_stop_dist_m: 141.91,
					mixed_use: false,
					rdv: false
				},
				manualAffordableLabel: 'Not listed in this record',
				manualAffordabilityNote: 'This record does not list an affordable-unit count.'
			},
			{
				id: 'weymouth-landing',
				label: 'Mahoney Farm',
				sourceName: 'Mahoney Farm',
				categoryLabel: 'Non-TOD contrast',
				categoryTone: 'nontod',
				note:
					'Sudbury. Mahoney Farm is a real record in the dataset and works as a stronger non-TOD contrast case: housing growth can still happen well outside the strongest transit geography.',
				fallback: {
					id: 'manual-weymouth-landing',
					name: 'Mahoney Farm',
					municipal: 'Sudbury',
					hu: 33,
					lon: -71.43477,
					lat: 42.34893,
					nearest_stop_dist_m: 8128.67,
					mixed_use: false,
					rdv: false
				},
				manualAffordableLabel: 'Not listed in this record',
				manualAffordabilityNote: 'This record does not list an affordable-unit count.'
			},
			{
				id: 'pinehills-phase-1',
				label: 'The Pinehills: Phase 1',
				sourceName: 'The Pinehills: Phase 1',
				categoryLabel: 'Non-TOD contrast',
				categoryTone: 'nontod',
				note:
					'Plymouth. The Pinehills: Phase 1 shows very large-scale housing growth far from strong MBTA access, making the non-TOD side of the regional pattern especially clear.',
				fallback: {
					id: 'manual-pinehills-phase-1',
					name: 'The Pinehills: Phase 1',
					municipal: 'Plymouth',
					hu: 1500,
					lon: -70.59676,
					lat: 41.89025,
					nearest_stop_dist_m: 14196.92,
					mixed_use: false,
					rdv: false
				},
				manualAffordableLabel: '0 listed',
				manualAffordabilityNote: 'This record lists no affordable units.'
			}
		];
		return specs.map((spec) => {
			const real = realByName.get(spec.sourceName) || null;
			const dev = {
				...(real ?? spec.fallback),
				manualAffordableLabel: spec.manualAffordableLabel,
				manualAffordabilityNote: spec.manualAffordabilityNote
			};
			const affordableUnits = developmentAffordableUnitsCapped(dev);
			return {
				id: spec.id,
				label: spec.label,
				categoryLabel: spec.categoryLabel,
				categoryTone: spec.categoryTone,
				note: spec.note,
				dev,
				units: Number(dev.hu) || 0,
				affordableUnits,
				showOnMapDisabled: false
			};
		});
	});
	const guidedStepTenFeatured = $derived(guidedStepTenExamples?.[0] ?? null);

	function inspectGuidedExample(id) {
		if (!id) return;
		zoomToTract(id);
		panelState.selectAll([id]);
		panelState.setLastInteracted(id);
		panelState.setHovered(id);
		window.setTimeout(() => {
			const anchor = tractScreenAnchor(id);
			const fallbackX = typeof window !== 'undefined' ? window.innerWidth * 0.68 : 960;
			const fallbackY = typeof window !== 'undefined' ? window.innerHeight * 0.34 : 360;
			const x = anchor ? anchor.x + 72 : fallbackX;
			const y = anchor ? anchor.y - 18 : fallbackY;
			showTractTooltip(id, x, y, anchor);
		}, 560);
	}

	function inspectGuidedDevelopment(d) {
		if (!d) return;
		activeGuidedDevelopmentKey = developmentKey(d);
		zoomToDevelopment(d);
		window.setTimeout(() => {
			const anchor = developmentScreenAnchor(d);
			const fallbackX = typeof window !== 'undefined' ? window.innerWidth * 0.7 : 980;
			const fallbackY = typeof window !== 'undefined' ? window.innerHeight * 0.38 : 380;
			const x = anchor ? anchor.x + 76 : fallbackX;
			const y = anchor ? anchor.y - 14 : fallbackY;
			showDevelopmentTooltip(d, x, y, anchor);
		}, 640);
	}

	function guidedExampleFocusKey(stage, id) {
		return `${stage}_example:${id}`;
	}

	function guidedProjectFocusKey(stage, id) {
		return `${stage}_project:${id}`;
	}

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
			updateMapHoverCursors();
		}
	});

	$effect(() => {
		void dataKey;
		void revealStage;
		void activeSpotlight;
		void lowIncomeFocusOn;
		void hoveredMismatchCluster;
		void mismatchOutlineMode;
		if (!containerEl || !svgRef) return;
		updateChoropleth({ animate: true, legend: true });
		updateFocusRegion();
		updateDevelopments();
		updateInsightMarkers();
		updateSelection();
		updateMapHoverCursors();
	});

	$effect(() => {
		void panelState.hoveredTract;
		void panelState.selectedTracts;
		void panelState.selectedTracts.size;
		void pinnedTractId;
		void pinnedDevKey;
		if (!containerEl || !svgRef) return;
		updateChoropleth({ animate: false, legend: false });
		updateSelection();
		reorderTractLayerPaths();
		updateMapHoverCursors();
	});

	$effect(() => {
		void guidedMode;
		void guidedMapZoomDeps;
		if (!guidedMode || !svgRef || !zoomBehaviorRef || !projectionRef) return;
		if (revealStage === 0) {
			if (guidedFocusDetail === 'core_access') {
				const focus = tractFeatureByGeoFilter((t) => {
					const lat = Number(t.centlat);
					const lon = Number(t.centlon);
					return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 42.20 && lat <= 42.43 && lon >= -71.17 && lon <= -70.90;
				});
				zoomToFeatureGroup(focus, 7.8);
				return;
			}
			recenterMap();
			return;
		}
		if (revealStage <= 4 || revealStage === 8 || revealStage === 10) {
			recenterMap();
			return;
		}
		if (revealStage === 5) {
			const focus = tractFeatureByGeoFilter((t) => {
				const lat = Number(t.centlat);
				const lon = Number(t.centlon);
				return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 42.30 && lat <= 42.43 && lon >= -71.17 && lon <= -70.98;
			});
			zoomToFeatureGroup(focus, 8.5);
			return;
		}
		if (revealStage === 6) {
			const focus = tractFeatureByGeoFilter((t) => {
				const lat = Number(t.centlat);
				const lon = Number(t.centlon);
				return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 42.20 && lat <= 42.47 && lon >= -71.10 && lon <= -70.90;
			});
			zoomToFeatureGroup(focus, 8.2);
			return;
		}
		if (revealStage === 7) {
			const rowsByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
			const focus = tractFeatureByGeoFilter((t) => {
				const lat = Number(t.centlat);
				const lon = Number(t.centlon);
				const row = rowsByGj.get(t.gisjoin);
				const growth = Number(row?.census_hu_pct_change);
				return Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(growth) && lon <= -71.15 && lon >= -72.2 && lat >= 42.1 && lat <= 42.55 && growth >= 15;
			});
			zoomToFeatureGroup(focus, 7.2);
			return;
		}
		if (revealStage === 9) {
			const rowsByGj = new Map((nhgisRows ?? []).map((r) => [r.gisjoin, r]));
			const focus = tractFeatureByGeoFilter((t) => {
				const lat = Number(t.centlat);
				const lon = Number(t.centlon);
				const row = rowsByGj.get(t.gisjoin);
				const growth = Number(row?.census_hu_pct_change);
				return Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(growth) && lon <= -71.15 && lon >= -72.1 && lat >= 42.1 && lat <= 42.55 && growth >= 10;
			});
			zoomToFeatureGroup(focus, 8.2);
		}
	});

	$effect(() => {
		void revealStage;
		void guidedMode;
		void guidedFocusDetail;
		void guidedContrastFeatured;
		void guidedMismatchFeatured;
		void guidedStepTenFeatured;
		if (!guidedMode) {
			lastAutoFocusedStage = null;
			return;
		}
		const focusKey = `${revealStage}:${guidedFocusDetail ?? 'base'}`;
		if (lastAutoFocusedStage === focusKey) return;
		if (revealStage === 2 && guidedFocusDetail === 'contrast_example' && guidedContrastFeatured?.id) {
			lastAutoFocusedStage = focusKey;
			inspectGuidedExample(guidedContrastFeatured.id);
			return;
		}
		if (revealStage === 2 && guidedFocusDetail?.startsWith('2_example:')) {
			lastAutoFocusedStage = focusKey;
			inspectGuidedExample(guidedFocusDetail.slice('2_example:'.length));
			return;
		}
		if (revealStage === 3 && guidedFocusDetail === 'mismatch_example' && guidedMismatchFeatured?.id) {
			lastAutoFocusedStage = focusKey;
			inspectGuidedExample(guidedMismatchFeatured.id);
			return;
		}
		if (revealStage === 3 && guidedFocusDetail?.startsWith('3_example:')) {
			lastAutoFocusedStage = focusKey;
			inspectGuidedExample(guidedFocusDetail.slice('3_example:'.length));
			return;
		}
		if (revealStage === 9 && guidedFocusDetail === 'project_example' && guidedStepTenFeatured?.dev) {
			lastAutoFocusedStage = focusKey;
			inspectGuidedDevelopment(guidedStepTenFeatured.dev);
			return;
		}
		if (revealStage === 9 && guidedFocusDetail?.startsWith('9_project:')) {
			const example = guidedStepTenExamples.find(
				(item) => item.id === guidedFocusDetail.slice('9_project:'.length)
			);
			lastAutoFocusedStage = focusKey;
			if (example?.dev) inspectGuidedDevelopment(example.dev);
			return;
		}
		lastAutoFocusedStage = focusKey;
	});

	// Track the previous reveal stage so we only react to actual changes,
	// not to other $state dependencies read inside the block.
	let prevRevealStageForPin = $state(0);
	$effect(() => {
		const stage = revealStage;
		if (!guidedMode) { prevRevealStageForPin = stage; return; }
		const stageChanged = stage !== prevRevealStageForPin;
		prevRevealStageForPin = stage;
		if (!stageChanged) return;
		// Clear pinned tract / tooltip when the user scrolls to a new step.
		if (pinnedTractId) {
			pinnedTractId = null;
			pinnedTooltip = null;
			panelState.clearSelection();
		}
		if (pinnedDevKey) {
			pinnedDevKey = null;
			pinnedDevTooltip = null;
		}
		if (pinnedTooltipStage != null) {
			tooltip = { ...tooltip, visible: false, anchorX: null, anchorY: null };
			pinnedTooltipStage = null;
			activeGuidedDevelopmentKey = null;
			panelState.setHovered(null);
		}
		cancelHoverRest();
		const hov = panelState.hoveredTract;
		if (hov && isTractDimmed(hov)) {
			panelState.setHovered(null);
			hoveredMismatchCluster = null;
			tooltip = { ...tooltip, visible: false };
		}
	});

	$effect(() => {
		if (!guidedMode || !containerEl) return;
		const clearGuidedPopupState = () => {
			tooltip = { ...tooltip, visible: false, anchorX: null, anchorY: null };
			pinnedTooltipStage = null;
			activeGuidedDevelopmentKey = null;
			panelState.setHovered(null);
		};
		const maybeCloseGuidedPopup = () => {
			if (pinnedTooltipStage == null || !tooltip.visible) return;
			const rect = containerEl.getBoundingClientRect();
			const mapMostlyOutOfView = rect.bottom < 120 || rect.top > window.innerHeight - 120;
			if (mapMostlyOutOfView) clearGuidedPopupState();
		};
		maybeCloseGuidedPopup();
		window.addEventListener('scroll', maybeCloseGuidedPopup, { passive: true });
		window.addEventListener('resize', maybeCloseGuidedPopup);
		return () => {
			window.removeEventListener('scroll', maybeCloseGuidedPopup);
			window.removeEventListener('resize', maybeCloseGuidedPopup);
		};
	});

	$effect(() => {
		void overlayKey;
		if (!containerEl || !svgRef) return;
		updateOverlays();
	});

	$effect(() => {
		if (stepEls.filter(Boolean).length !== stepContent.length) return;
		let frame = 0;
		const updateStageFromScroll = () => {
			frame = 0;
			const triggerY = window.innerHeight * 0.42;
			let next = 0;
			for (let i = 0; i < stepEls.length; i += 1) {
				const el = stepEls[i];
				if (!el) continue;
				const rect = el.getBoundingClientRect();
				if (rect.top <= triggerY) next = i;
			}
			let nextFocus = null;
			for (const item of focusWaypointEls) {
				if (!item || item.stage !== next) continue;
				const rect = item.node.getBoundingClientRect();
				if (rect.top <= triggerY) nextFocus = item.key;
			}
			if (next !== revealStage) revealStage = next;
			if (nextFocus != guidedFocusDetail) guidedFocusDetail = nextFocus;
		};
		const scheduleUpdate = () => {
			if (frame) return;
			frame = window.requestAnimationFrame(updateStageFromScroll);
		};
		scheduleUpdate();
		window.addEventListener('scroll', scheduleUpdate, { passive: true });
		window.addEventListener('resize', scheduleUpdate);
		return () => {
			if (frame) window.cancelAnimationFrame(frame);
			window.removeEventListener('scroll', scheduleUpdate);
			window.removeEventListener('resize', scheduleUpdate);
		};
	});

	onDestroy(() => {
		cancelHoverRest();
		if (containerEl) d3.select(containerEl).selectAll('*').remove();
		lastStructuralKey = '';
		svgRef = null;
		projectionRef = null;
	});
</script>

<div class="poc-nhgis-map">
	<div class="poc-scrolly">
		<div class="poc-scrolly-map">
			{#if !guidedMode}
			<div class="poc-top-row">
			<!-- <div class="poc-methods poc-methods--lead card-key" role="note" aria-label="TOD definitions">
				<p class="poc-methods__title">Key definitions</p>
				<p class="poc-methods__text">
					<strong>TOD developments</strong> are projects within <strong>{d3.format('.2~f')(panelState.transitDistanceMi ?? 0.5)} miles</strong> of an MBTA stop; all others count as <strong>non-TOD</strong>.
					<strong>TOD-dominated tracts</strong> are places where at least <strong>{d3.format('.0f')((panelState.todFractionCutoff ?? 0.5) * 100)}%</strong> of filtered new units come from TOD projects and housing stock grows by at least <strong>{d3.format('.1f')(panelState.sigDevMinPctStockIncrease ?? 2)}%</strong>.
					<strong>Non-TOD-dominated tracts</strong> clear the same growth threshold but fall below that TOD share.
					<strong>Minimal development</strong> tracts stay below the stock-growth threshold.
				</p>
			</div> -->
			<!-- <div class="poc-methods poc-methods--encoding card-key" role="note" aria-label="Design decisions">
				<p class="poc-methods__title">Why We Designed It This Way</p>
				<ul class="poc-methods__list poc-methods__list--encoding">
					<li>
						<span class="poc-methods__label">One steady map scale:</span>
						We kept the choropleth scale fixed from start to finish so the reader always has the same baseline in view. That way, when outlines, mismatch layers, and project dots appear, they add context instead of changing the meaning of the fill colors.
					</li>
					<li>
						<span class="poc-methods__label">Outlines instead of more fill:</span>
						We used outlines for the tract groups because the fill is already carrying the main growth signal. If we had used another full set of fill colors, the map would have become much harder to read and the central comparison would have gotten muddy.
					</li>
					<li>
						<span class="poc-methods__label">One step at a time:</span>
						The walkthrough builds one layer at a time so each step answers a slightly different question. This slows the reader down in a useful way and makes it easier to see what the cohort outlines, mismatch marks, and project dots each contribute.
					</li>
					<li>
						<span class="poc-methods__label">The main highlights stand out:</span>
						Mismatch areas and project dots use different mark types so they can stand out without taking over the whole map. This lets the story shift attention when needed while still keeping the base geography and tract-level growth visible.
					</li>
					<li>
						<span class="poc-methods__label">Extra detail stays off the map:</span>
						Income, selected-tract details, and comparisons live in side panels and tooltips rather than being encoded directly on the map. That keeps the main view readable while still giving the reader a path to more detail when they want it.
					</li>
				</ul>
			</div> -->
			<div class="poc-methods poc-methods--assumptions card-key" role="note" aria-label="Assumptions used">
				<p class="poc-methods__title">Key definitions</p>
				<ul class="poc-methods__list">
					<li>
						<span class="poc-methods__label">TOD access:</span>
						"Transit access" is defined as being within
						<strong> {d3.format('.2~f')(panelState.transitDistanceMi ?? 0.5)} miles</strong> of an MBTA stop.
					</li>
					<li>
						<span class="poc-methods__label">Tract groupings:</span>
						<ul style="padding-left: 1.5em;">
							<li>
								Minimal Development: All tracts with less than
								<strong> {d3.format('.1f')(panelState.sigDevMinPctStockIncrease ?? 2)}%</strong> housing stock increase.
							</li>
							<li>
								TOD-Dominated: Remaining tracts with more than
								<strong> {d3.format('.0f')((panelState.todFractionCutoff ?? 0.5) * 100)}%</strong> of new units being TOD.
							</li>
							<li>
								Non-TOD-Dominated: Remaining tracts with less than
								<strong> {d3.format('.0f')((panelState.todFractionCutoff ?? 0.5) * 100)}%</strong> of new units being TOD.
							</li>
							<li>
								Ignored: Tan tracts mark places where data is missing or unreliable.
							</li>
						</ul>

						<!-- Tracts are grouped using
						<strong> {d3.format('.1f')(panelState.sigDevMinPctStockIncrease ?? 2)}%</strong> housing stock increase as the significant-development floor and
						<strong> {d3.format('.0f')((panelState.todFractionCutoff ?? 0.5) * 100)}%</strong> TOD share as the TOD-dominated cutoff. -->
					</li>
					<li>
						<span class="poc-methods__label">Aggregation averages:</span>
						Cohort summaries and comparison bars use population-weighted means.
					</li>
				</ul>
			</div>
			<div class="poc-compare card-key" role="region" aria-label="Selected tract comparison chart">
					<div class="poc-compare__head">
						<div>
							<p class="poc-detail__kicker">Selection chart</p>
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
			</div>
			{/if}

			<div class="poc-scrolly-shell">
				<div class="poc-scrolly-left">
					{#if !guidedMode}
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
				</div>

				<div class="poc-insight card-key" role="group" aria-label="Mismatch focus">
					<p class="poc-detail__kicker">Mismatch focus</p>
					<label class="poc-focus-toggle">
						<input type="checkbox" bind:checked={focusLowIncomeTracts} />
						<span>Bring lower-income tracts (&lt;$125k median) forward</span>
					</label>
					<p class="poc-detail__kicker" style="margin-top: 12px">Mismatch outlines</p>
					<div class="poc-mismatch-mode" role="group" aria-label="Which mismatch categories to outline">
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
						Use these controls to isolate one mismatch pattern, highlight lower-income tracts, or jump to a notable example with the red markers.
					</p>
				</div>

				{#if comparisonPairDetails.length > 0}
					<div class="poc-pair card-key" role="region" aria-label="Two-tract side-by-side comparison">
						<div class="poc-detail__head">
							<div>
								<p class="poc-detail__kicker">A/B tract comparison</p>
								<p class="poc-detail__title">Shift-click two tracts to compare them side by side</p>
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
					{/if}

					<div class="map-wrap">
						<div class="map-visual-column">
							<div class="map-left-column">
								<div class="poc-legend-row">
					{#if !guidedMode}
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
					{/if}
					</div>
					</div>

					<div
						class="map-main"
						role="region"
						aria-label="Interactive census tract map"
						onmouseleave={handleOverlayLeave}
					>
						<div class="map-widget">
							{#if !guidedMode}
							<div class="map-widget__controls" role="group" aria-label="Map zoom and reset controls">
								<button class="poc-map-control" type="button" onclick={zoomInMap} aria-label="Zoom in">+</button>
								<button class="poc-map-control" type="button" onclick={zoomOutMap} aria-label="Zoom out">−</button>
								<button class="poc-map-control poc-map-control--wide" type="button" onclick={recenterMap}>Recenter</button>
							</div>
							{/if}
							<div class="map-root" bind:this={containerEl}></div>
						</div>
					{#if !guidedMode && (showCohortOutlines() || showMismatchOutlines() || showDevelopmentDots())}
						<div class="poc-map-key-overlay" role="region" aria-label="Map legend">
							<div
								class="poc-map-key card-key"
							>
								<div
									class="poc-map-key-compact"
									class:poc-map-key-compact--split={revealStage === 1 && showDevelopmentDots() && (showCohortOutlines() || showMismatchOutlines())}
								>
									{#if showCohortOutlines() || showMismatchOutlines()}
										<div class="poc-map-key-col poc-map-key-col--tract">
										{#if showCohortOutlines()}
											<ul class="poc-key-rings">
												<li><span class="poc-k-ring poc-k-ring--tod"></span> TOD-dominated (significant development)</li>
												<li><span class="poc-k-ring poc-k-ring--nontod"></span> Non-TOD-dominated (significant development)</li>
											</ul>
										{/if}
										{#if showMismatchOutlines()}
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
									{/if}
									{#if showDevelopmentDots()}
										<div class="poc-map-key-col poc-map-key-col--dev">
											<p class="poc-key-one poc-key-dev">
												<strong>Developments</strong>
												<span class="poc-key-tract-fill-body">
													<span class="poc-key-tract-fill-line">
														Fill = share of new units that are multi-family. Darker purple fill means a higher multi-family share.
													</span>
													<span
														class="poc-key-tract-bar"
														style="background: linear-gradient(to right, #ffffff, #7c3f98);"
														role="img"
														aria-label="Share of new units that are multi-family: lower toward white, higher toward purple"
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
					{/if}
					{#if activeTooltip.visible}
						<div
							class="map-tooltip"
							bind:this={tooltipEl}
							style:left="{tooltipPosition.left}px"
							style:top="{tooltipPosition.top}px"
						>
							{#if tooltipArrow}
								<span
									class="map-tooltip__arrow map-tooltip__arrow--{tooltipArrow.side}"
									style:left={tooltipArrow.left != null ? `${tooltipArrow.left}px` : undefined}
									style:top={tooltipArrow.top != null ? `${tooltipArrow.top}px` : undefined}
									aria-hidden="true"
								></span>
							{/if}
							<div class="map-tooltip__header">
								<div class="map-tooltip__header-copy">
									{#if activeTooltip.eyebrow}
										<p class="map-tooltip__eyebrow">{activeTooltip.eyebrow}</p>
									{/if}
									<p class="map-tooltip__title">{activeTooltip.title}</p>
								</div>
								{#if activeTooltip.badge}
									<span class="map-tooltip__badge map-tooltip__badge--{activeTooltip.badgeTone}">{activeTooltip.badge}</span>
								{/if}
							</div>
							{#if activeTooltip.primaryRows.length > 0}
								<div
									class="map-tooltip__primary"
									class:map-tooltip__primary--tod={activeTooltip.badgeTone === 'tod'}
									class:map-tooltip__primary--nontod={activeTooltip.badgeTone === 'nontod'}
									class:map-tooltip__primary--minimal={activeTooltip.badgeTone === 'minimal'}
								>
									{#each activeTooltip.primaryRows as row, i (i)}
										<div
											class="map-tooltip__primary-row"
											class:map-tooltip__primary-row--stack={String(row.value ?? '').length > 20}
										>
											<span class="map-tooltip__primary-label">{row.label}</span>
											<span class="map-tooltip__primary-value">{row.value}</span>
											</div>
										{/each}
									</div>
								{/if}
							{#if activeTooltip.secondaryRows.length > 0}
								<div class="map-tooltip__details">
									<p class="map-tooltip__details-label">Details</p>
									<div class="map-tooltip__rows">
										{#each activeTooltip.secondaryRows as row, i (i)}
												<div
													class="map-tooltip__row"
													class:map-tooltip__row--stack={String(row.value ?? '').length > 26}
												>
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
					</div>
					</div>
				</div>

				<aside class="poc-stepper-side" aria-label="Map explanation steps">
					<div class="poc-stepper-head">
						<p class="poc-stepper-inline-kicker">Map walkthrough</p>
						<p class="poc-stepper-inline-hint">When you scroll here, the map adds one layer at a time.</p>
					</div>
					<div class="poc-stepper-inline-rail" aria-label="Map steps">
						{#each stepContent as step, i (i)}
							<section
								use:stepRef={i}
								class="poc-stepper-card"
								class:poc-stepper-card--active={revealStage === i}
								class:poc-stepper-card--dense={guidedMode && (i === 2 || i === 3 || i === 8 || i === 9 || i === 10)}
								class:poc-stepper-card--runway-after={guidedMode && i === 3}
								data-step-index={i}
							>
								<div class="poc-stepper-card-top">
									<span class="poc-stepper-pill-num">{i + 1}</span>
									<div class="poc-stepper-pill-text">
										<span class="poc-stepper-pill-kicker">{step.kicker}</span>
										<span class="poc-stepper-pill-title">{step.title}</span>
									</div>
								</div>
								<p class="poc-stepper-card-body">
									{#if step.bodyHtml}
										{@html step.bodyHtml}
									{:else}
										{step.body}
									{/if}
								</p>
								{#if guidedMode && i === 0}
									<div
										use:focusWaypointRef={{ stage: 0, key: 'core_access' }}
										class="poc-stepper-waypoint"
									>
										<p class="poc-stepper-waypoint__label">Scroll to focus on Boston, Cambridge, Quincy, and Revere.</p>
									</div>
								{/if}
								{#if guidedMode && step.legend}
									<p class="poc-stepper-card-note"><strong>How to read it:</strong> {step.legend}</p>
								{/if}
								{#if guidedMode && step.why}
									<p class="poc-stepper-card-note"><strong>Why it matters:</strong> {step.why}</p>
								{/if}
								{#if guidedMode && i === 2 && guidedContrastExamples.length}
									<div
										use:focusWaypointRef={{ stage: 2, key: 'contrast_example' }}
										class="poc-stepper-waypoint"
									>
										<p class="poc-stepper-waypoint__label">Scroll to focus on tract examples that already show this contrast.</p>
									</div>
									<div class="poc-stepper-examples" aria-label="Example tracts that show the contrast">
										<p class="poc-stepper-examples-title">Example tracts that make the contrast more concrete</p>
										{#each guidedContrastExamples as example (example.id)}
											<div
												use:focusWaypointRef={{ stage: 2, key: guidedExampleFocusKey(2, example.id) }}
												class="poc-stepper-example-wrap"
											>
												<div
													class="poc-stepper-example poc-stepper-example--static"
													class:poc-stepper-example--active={guidedFocusDetail === guidedExampleFocusKey(2, example.id)}
												>
													<div class="poc-stepper-example__head">
														<span class="poc-stepper-example__label">{example.label}</span>
														<span class="poc-stepper-example__cta">Show on map</span>
													</div>
													<p class="poc-stepper-example__note">{example.note}</p>
													<div class="poc-stepper-example__metrics">
														<span><strong>Growth:</strong> {d3.format('.1f')(example.growth)}%</span>
														<span><strong>Transit access:</strong> {example.stops === 0 ? '0 stops' : `${d3.format(',.0f')(example.stops)} stops`}</span>
														{#if example.income != null}
															<span><strong>Median income:</strong> {d3.format('$,.0f')(example.income)}</span>
														{/if}
													</div>
													<div class="poc-stepper-example__actions">
														<button
															type="button"
															class="poc-stepper-example__button"
															onclick={() => inspectGuidedExample(example.id)}
														>
															Show on map
														</button>
													</div>
												</div>
											</div>
										{/each}
									</div>
								{/if}
								{#if guidedMode && i === 3 && guidedMismatchExamples.length}
									<div
										use:focusWaypointRef={{ stage: 3, key: 'mismatch_example' }}
										class="poc-stepper-waypoint"
									>
										<p class="poc-stepper-waypoint__label">Scroll to focus on mismatch tracts marked with red insight markers.</p>
									</div>
									<div class="poc-stepper-examples" aria-label="Mismatch examples highlighted on the map">
										<p class="poc-stepper-examples-title">Examples of tracts where access and growth pull apart</p>
										{#each guidedMismatchExamples as example (example.id)}
											<div
												use:focusWaypointRef={{ stage: 3, key: guidedExampleFocusKey(3, example.id) }}
												class="poc-stepper-example-wrap"
											>
												<div
													class="poc-stepper-example poc-stepper-example--static"
													class:poc-stepper-example--active={guidedFocusDetail === guidedExampleFocusKey(3, example.id)}
												>
													<div class="poc-stepper-example__head">
														<span class="poc-stepper-example__label">{example.label}</span>
														<span
															class="poc-stepper-example__cta"
															class:poc-stepper-example__cta--mismatch-ha={example.kindRank === 0}
															class:poc-stepper-example__cta--mismatch-hg={example.kindRank === 1}
														>
															{example.kind}
														</span>
													</div>
													<p class="poc-stepper-example__note">{example.note}</p>
													<div class="poc-stepper-example__metrics">
														<span><strong>Growth:</strong> {d3.format('.1f')(example.growth)}%</span>
														<span><strong>Transit access:</strong> {example.stops === 0 ? '0 stops' : `${d3.format(',.0f')(example.stops)} stops`}</span>
														{#if example.income != null}
															<span><strong>Median income:</strong> {d3.format('$,.0f')(example.income)}</span>
														{/if}
													</div>
													<div class="poc-stepper-example__actions">
														<button
															type="button"
															class="poc-stepper-example__button"
															onclick={() => inspectGuidedExample(example.id)}
														>
															Show on map
														</button>
													</div>
												</div>
											</div>
										{/each}
									</div>
								{/if}
								{#if guidedMode && i === 8 && guidedDevelopmentExamples.length}
									<div class="poc-stepper-examples" aria-label="Notable TOD and non-TOD developments">
										<p class="poc-stepper-examples-title">Scroll to see examples of individual developments and how they fit this pattern</p>
									</div>
								{/if}
								{#if guidedMode && i === 9 && guidedStepTenExamples.length}
									<div
										use:focusWaypointRef={{ stage: 9, key: 'project_example' }}
										class="poc-stepper-waypoint"
									>
										<p class="poc-stepper-waypoint__label">Scroll to focus on featured development examples.</p>
									</div>
									<div class="poc-stepper-examples" aria-label="Important developments tied to the argument">
										<p class="poc-stepper-examples-title">Important developments that help explain the pattern</p>
										{#each guidedStepTenExamples as example (example.id)}
											<div
												use:focusWaypointRef={{ stage: 9, key: guidedProjectFocusKey(9, example.id) }}
												class="poc-stepper-example-wrap"
											>
												<div
													class="poc-stepper-example poc-stepper-example--static"
													class:poc-stepper-example--active={guidedFocusDetail === guidedProjectFocusKey(9, example.id)}
												>
													<div class="poc-stepper-example__head">
														<span class="poc-stepper-example__label">{example.label}</span>
														<span class="poc-stepper-example__cta" class:poc-stepper-example__cta--tod={example.categoryTone === 'tod'} class:poc-stepper-example__cta--partial={example.categoryTone === 'partial'} class:poc-stepper-example__cta--nontod={example.categoryTone === 'nontod'}>{example.categoryLabel}</span>
													</div>
													<p class="poc-stepper-example__note">{example.note}</p>
													<div class="poc-stepper-example__metrics">
														<span><strong>Total units:</strong> {example.units == null ? '—' : d3.format(',.0f')(example.units)}</span>
														<span><strong>Affordable units:</strong> {example.affordableUnits == null ? 'Not listed' : d3.format(',.0f')(example.affordableUnits || 0)}</span>
													</div>
													<div class="poc-stepper-example__actions">
														<button
															type="button"
															class="poc-stepper-example__button"
															disabled={example.showOnMapDisabled}
															onclick={() => example.dev && inspectGuidedDevelopment(example.dev)}
														>
															Show on map
														</button>
													</div>
												</div>
											</div>
										{/each}
									</div>
								{/if}
								{#if guidedMode && i === 10}
									<div class="poc-stepper-overlay-toggle" aria-label="Choose which outline layer to compare in the lower-income step">
										<p class="poc-stepper-examples-title">Compare the lower-income view with either tract grouping or mismatch outlines</p>
										<div class="poc-stepper-overlay-toggle__buttons" role="group" aria-label="Lower-income outline view">
											<button
												type="button"
												class="poc-stepper-overlay-toggle__btn"
												class:poc-stepper-overlay-toggle__btn--active={guidedLowerIncomeOverlay === 'cohort'}
												onclick={() => (guidedLowerIncomeOverlay = 'cohort')}
											>
												TOD / non-TOD outlines
											</button>
											<button
												type="button"
												class="poc-stepper-overlay-toggle__btn"
												class:poc-stepper-overlay-toggle__btn--active={guidedLowerIncomeOverlay === 'mismatch'}
												onclick={() => (guidedLowerIncomeOverlay = 'mismatch')}
											>
												Mismatch outlines
											</button>
										</div>
										<p class="poc-stepper-card-note">
											{#if guidedLowerIncomeOverlay === 'cohort'}
												<strong>What this shows:</strong> the orange and green outlines compare whether significant development in lower-income tracts has been more TOD-dominated or more non-TOD-dominated.
											{:else}
												<strong>What this shows:</strong> the purple mismatch outlines show where lower-income tracts sit inside the access-versus-growth disconnect, either as high-access/low-growth places or higher-growth/weaker-access places.
											{/if}
										</p>
									</div>
								{/if}
								{#if guidedMode && step.prompt && i !== 2 && i !== 3 && i !== 8 && i !== 9}
									<p class="poc-stepper-card-note"><strong>Try this:</strong> {step.prompt}</p>
								{/if}
							</section>
						{/each}
					</div>
				</aside>
			</div>
			<div class="poc-key-findings card-key" role="note" aria-label="Key findings summary">
				<p class="poc-detail__kicker">Key findings</p>
				<ul class="poc-map-callouts__list">
					{#each keyFindings as c, i (i)}
						<li>{c}</li>
					{/each}
				</ul>
			</div>
			<p class="poc-map-zoom-hint">Scroll through the walkthrough, drag to pan, and scroll or pinch to zoom.</p>
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

	/* Key definitions (left) + selection chart (right) above the scrolly shell to save vertical space. */
	.poc-top-row {
		display: grid;
		gap: 8px 14px;
		align-items: start;
		min-width: 0;
	}

	@media (min-width: 640px) {
		.poc-top-row {
			grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
		}
	}

	.poc-top-row .poc-methods--assumptions {
		margin-bottom: 0;
	}

	.poc-top-row .poc-compare {
		min-width: 0;
	}

	.poc-scrolly-shell {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(220px, 260px);
		gap: 22px;
		align-items: start;
	}

	.poc-scrolly-left {
		display: grid;
		gap: 6px;
		min-width: 0;
		min-height: 0;
		position: sticky;
		top: 10px;
		align-self: start;
		z-index: 1;
	}

	.poc-stepper-side {
		display: grid;
		gap: 12px;
		align-content: start;
		padding-top: 2px;
		min-width: 0;
		position: relative;
		z-index: 1;
	}

	.poc-stepper-head {
		position: sticky;
		top: 16px;
		z-index: 3;
		display: grid;
		gap: 4px;
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--bg-card) 96%, white);
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
		font-size: 0.76rem;
		line-height: 1.4;
		color: var(--text-muted);
	}

	.poc-stepper-inline-rail {
		display: grid;
		gap: 33vh;
		padding-top: 8px;
		/* Extra runway after step 3 so the page does not jump to the next section immediately */
		padding-bottom: calc(57vh + 108px);
		isolation: isolate;
	}

	.poc-stepper-card {
		display: grid;
		align-content: center;
		gap: 12px;
		width: 100%;
		min-height: 84vh;
		padding: 10px 0 0;
		border-left: 2px solid color-mix(in srgb, var(--accent) 16%, var(--border));
		padding-left: 18px;
		border-radius: var(--radius-sm);
		border-top: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
		border-right: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
		border-bottom: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
		background: color-mix(in srgb, var(--bg-card) 97%, white 3%);
		text-align: left;
		color: var(--text);
		opacity: 0.48;
		transform: translateY(14px);
		transition:
			opacity 220ms ease,
			transform 220ms ease,
			border-color 220ms ease;
	}

	.poc-stepper-card--active {
		border-left-color: color-mix(in srgb, var(--accent) 52%, var(--border));
		border-top-color: color-mix(in srgb, var(--accent) 24%, var(--border));
		border-right-color: color-mix(in srgb, var(--accent) 24%, var(--border));
		border-bottom-color: color-mix(in srgb, var(--accent) 24%, var(--border));
		opacity: 1;
		transform: translateY(0);
	}

	.poc-stepper-card--dense {
		align-content: start;
		padding-top: 14px;
	}

	.poc-stepper-card--runway-after {
		margin-bottom: 18vh;
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
		width: 28px;
		height: 28px;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text);
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
		font-size: 0.82rem;
		font-weight: 600;
		line-height: 1.25;
		color: var(--text);
	}

	.poc-stepper-pill-kicker {
		font-size: 0.65rem;
		line-height: 1.25;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.poc-stepper-card-body {
		margin: 0;
		max-width: 22.4ch; /* ~30% narrower than 32ch — more room for the map column */
		font-size: 0.9rem;
		line-height: 1.6;
		color: var(--text-muted);
	}

	.poc-inline-line {
		font-weight: 700;
	}

	.poc-inline-line--red {
		color: #da291c;
	}

	.poc-inline-line--orange {
		color: #ed8b00;
	}

	.poc-inline-line--blue {
		color: #003da5;
	}

	.poc-inline-line--green {
		color: #00843d;
	}

	.poc-inline-line--commuter {
		color: #7c3f98;
	}

	.poc-stepper-card-note {
		margin: 0;
		max-width: 24ch;
		font-size: 0.8rem;
		line-height: 1.55;
		color: var(--text-muted);
	}

	.poc-stepper-card-note strong {
		color: var(--text);
	}

	.poc-stepper-waypoint {
		margin-top: 0.85rem;
		padding: 0.72rem 0.82rem;
		border: 1px dashed color-mix(in srgb, var(--accent) 32%, var(--border));
		border-radius: 14px;
		background: color-mix(in srgb, var(--accent) 6%, var(--bg-card));
	}

	.poc-stepper-waypoint__label {
		margin: 0;
		font-size: 0.78rem;
		font-weight: 700;
		line-height: 1.45;
		color: var(--text);
	}

	.poc-stepper-examples {
		display: grid;
		gap: 1.25rem;
		margin-top: 0.8rem;
	}

	.poc-stepper-example-wrap {
		display: grid;
		gap: 0.4rem;
		min-height: 24vh;
		align-content: start;
	}

	.poc-stepper-overlay-toggle {
		display: grid;
		gap: 0.7rem;
		margin-top: 0.8rem;
		padding: 0.78rem 0.84rem;
		border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));
		border-radius: 14px;
		background: color-mix(in srgb, var(--accent) 4%, var(--bg-card));
	}

	.poc-stepper-overlay-toggle__buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.poc-stepper-overlay-toggle__btn {
		border: 1px solid color-mix(in srgb, var(--border) 90%, var(--text-muted));
		border-radius: 999px;
		background: var(--bg-card);
		color: var(--text);
		padding: 0.42rem 0.72rem;
		font-size: 0.7rem;
		font-weight: 700;
		line-height: 1.2;
		cursor: pointer;
		transition:
			background 120ms ease,
			border-color 120ms ease,
			color 120ms ease,
			transform 120ms ease;
	}

	.poc-stepper-overlay-toggle__btn:hover,
	.poc-stepper-overlay-toggle__btn:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
		background: color-mix(in srgb, var(--accent) 8%, var(--bg-card));
		outline: none;
		transform: translateY(-1px);
	}

	.poc-stepper-overlay-toggle__btn--active {
		border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
		background: color-mix(in srgb, var(--accent) 13%, var(--bg-card));
		color: color-mix(in srgb, var(--accent) 86%, black 14%);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
	}

	.poc-stepper-examples-title {
		margin: 0;
		max-width: 24ch;
		font-size: 0.82rem;
		font-weight: 700;
		line-height: 1.45;
		color: var(--text);
	}

	.poc-stepper-example {
		display: grid;
		gap: 0.42rem;
		width: 100%;
		padding: 0.78rem 0.84rem;
		border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
		border-radius: 14px;
		background: color-mix(in srgb, var(--bg-card) 94%, white 6%);
		text-align: left;
		cursor: pointer;
		transition:
			border-color 120ms ease,
			box-shadow 120ms ease,
			transform 120ms ease,
			opacity 180ms ease,
			filter 180ms ease;
	}

	.poc-stepper-example:hover,
	.poc-stepper-example:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 44%, var(--border));
		box-shadow: 0 8px 18px rgba(18, 30, 51, 0.08);
		transform: translateY(-1px);
	}

	.poc-stepper-example--static {
		cursor: default;
	}

	.poc-stepper-example--static:hover,
	.poc-stepper-example--static:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 22%, var(--border));
		box-shadow: none;
		transform: none;
	}

	.poc-stepper-example--static:not(.poc-stepper-example--active) {
		opacity: 0.48;
		filter: saturate(0.82);
	}

	.poc-stepper-example--active {
		opacity: 1;
		transform: translateY(-2px);
		border-color: color-mix(in srgb, var(--accent) 46%, var(--border));
		box-shadow: 0 10px 24px rgba(18, 30, 51, 0.1);
	}

	.poc-stepper-example__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.6rem;
	}

	.poc-stepper-example__label {
		font-size: 0.84rem;
		font-weight: 700;
		line-height: 1.35;
		color: var(--text);
	}

	.poc-stepper-example__cta {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.poc-stepper-example__cta--mismatch-ha,
	.poc-stepper-example__cta--mismatch-hg {
		display: inline-flex;
		align-items: center;
		padding: 0.28rem 0.5rem;
		border-radius: 999px;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.poc-stepper-example__cta--mismatch-ha {
		color: #5b4bc4;
		background: color-mix(in srgb, #8a78e0 16%, white);
		border: 2px solid #8a78e0;
	}

	.poc-stepper-example__cta--mismatch-hg {
		color: #7b68cc;
		background: color-mix(in srgb, #c4b5f0 16%, white);
		border: 2px dashed #c4b5f0;
	}

	.poc-stepper-example__cta--tod {
		color: var(--accent);
	}

	.poc-stepper-example__cta--partial {
		color: #2563eb;
	}

	.poc-stepper-example__cta--nontod {
		color: var(--warning);
	}

	.poc-stepper-example__note {
		margin: 0;
		max-width: 24ch;
		font-size: 0.77rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.poc-stepper-example__metrics {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.7rem;
		max-width: 25ch;
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.poc-stepper-example__actions {
		display: flex;
		justify-content: flex-start;
		margin-top: 0.1rem;
	}

	.poc-stepper-example__button {
		padding: 0.42rem 0.7rem;
		border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
		border-radius: 999px;
		background: color-mix(in srgb, white 76%, var(--accent) 24%);
		color: var(--accent-strong);
		font-size: 0.74rem;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		transition:
			background 120ms ease,
			border-color 120ms ease,
			transform 120ms ease;
	}

	.poc-stepper-example__button:hover,
	.poc-stepper-example__button:focus-visible {
		background: color-mix(in srgb, white 60%, var(--accent) 40%);
		border-color: color-mix(in srgb, var(--accent) 56%, var(--border));
		transform: translateY(-1px);
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
		gap: 5px;
		margin-bottom: 0;
	}

	.poc-side-cards {
		display: grid;
		gap: 5px;
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

		.poc-control-stack {
			/* Single column: selection chart now lives in ``poc-top-row`` with key definitions. */
			grid-template-columns: 1fr;
			align-items: start;
		}

	}

	@media (max-width: 900px) {
		.poc-scrolly-shell {
			grid-template-columns: 1fr;
			gap: 16px;
		}

		.map-wrap {
			grid-template-columns: 1fr;
		}

		.poc-scrolly-left,
		.map-visual-column {
			gap: 6px;
		}

		.poc-scrolly-left {
			position: relative;
			top: auto;
		}

		.poc-control-stack {
			margin-bottom: 8px;
		}

		.map-left-column {
			position: relative;
			top: auto;
			grid-column: auto;
			grid-row: auto;
		}

		.map-main {
			position: relative;
			top: auto;
			grid-column: auto;
			grid-row: auto;
		}

		.map-widget__controls {
			top: 8px;
			right: 8px;
		}

		.poc-stepper-head {
			position: relative;
			top: auto;
		}

		.poc-stepper-side {
			order: 2;
		}

		.poc-stepper-inline-rail {
			gap: 18px;
		}

		.poc-stepper-card {
			min-height: 0;
			padding-top: 0;
		}
	}

	.poc-transit-field {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-card);
		padding: 0 2px 1px;
		margin: 0;
	}

	.poc-spotlight {
		display: grid;
		gap: 5px;
		align-content: start;
		min-height: 100%;
	}

	.poc-methods {
		display: grid;
		gap: 6px;
	}

	.poc-methods--lead {
		margin-bottom: 6px;
		padding: 10px 12px;
	}

	.poc-methods--encoding {
		margin-bottom: 6px;
		padding: 10px 12px;
		border-color: color-mix(in srgb, var(--border) 92%, var(--text-muted));
	}

	.poc-methods__list--encoding {
		margin-top: 8px;
	}

	.poc-methods__list--encoding li {
		margin-bottom: 10px;
	}

	.poc-methods--assumptions {
		margin-bottom: 8px;
		padding: 10px 12px;
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
		font-size: 0.84rem;
		line-height: 1.48;
		color: var(--text-muted);
	}

	.poc-methods__list {
		margin: 0;
		padding-left: 1.1rem;
		display: grid;
		gap: 0.26rem;
		font-size: 0.76rem;
		line-height: 1.35;
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
		gap: 4px;
	}

	.poc-spotlight__button {
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-card);
		color: var(--text);
		padding: 0.38rem 0.44rem;
		font-size: 0.67rem;
		font-weight: 700;
		line-height: 1.2;
		text-align: left;
		min-height: 48px;
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
		gap: 5px;
		padding: 6px 8px;
		border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));
		border-radius: 12px;
		background: color-mix(in srgb, var(--accent) 5%, var(--bg-card));
	}

	.poc-spotlight__summary-title {
		margin: 0;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--text);
	}

	.poc-spotlight__summary-copy {
		margin: 0;
		font-size: 0.64rem;
		line-height: 1.25;
		color: var(--text-muted);
	}

	.poc-spotlight__stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 5px 8px;
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
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--text);
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

	.poc-detail__btn {
		border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
		color: var(--text);
		padding: 0.26rem 0.52rem;
		font-size: 0.64rem;
		font-weight: 700;
	}

	.poc-detail__btn--ghost {
		border-color: var(--border);
		background: var(--bg-card);
	}

	.poc-detail__summary {
		margin: 0;
		font-size: 0.63rem;
		line-height: 1.22;
		color: var(--text-muted);
	}

	.poc-compare {
		display: grid;
		gap: 6px;
		align-content: start;
		height: 100%;
	}

	.poc-insight {
		display: grid;
		gap: 5px;
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
		gap: 5px;
	}

	.poc-compare__metric-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.poc-compare__tab {
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-card);
		color: var(--text);
		padding: 0.24rem 0.48rem;
		font-size: 0.62rem;
		font-weight: 700;
	}

	.poc-compare__tab--active {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
	}

	.poc-compare__bars {
		display: grid;
		gap: 6px;
	}

	.poc-compare__row {
		display: grid;
		grid-template-columns: minmax(0, 156px) minmax(0, 1fr) auto;
		align-items: center;
		gap: 6px;
		border: 1px solid color-mix(in srgb, var(--accent) 10%, var(--border));
		border-radius: 12px;
		padding: 0.28rem 0.42rem;
		background: color-mix(in srgb, var(--bg-card) 96%, white 4%);
		color: inherit;
		text-align: left;
	}

	.poc-compare__label {
		font-size: 0.66rem;
		font-weight: 700;
		color: var(--text);
	}

	.poc-compare__track {
		display: flex;
		align-items: center;
		height: 10px;
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
		font-size: 0.67rem;
		font-weight: 700;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}


	.poc-transit-legend {
		padding: 0;
		margin-bottom: 0.06rem;
		font-size: 0.55rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		line-height: 1.1;
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
		grid-template-columns: auto 1.5rem 1.5rem;
		column-gap: 0.45rem;
		row-gap: 0;
		align-items: center;
		font-size: 0.58rem;
		line-height: 1.05;
		color: var(--text-muted);
	}

	.poc-t-h {
		text-align: center;
		font-weight: 700;
		font-size: 0.5rem;
		text-transform: uppercase;
		letter-spacing: 0.02em;
		color: var(--text-muted);
		line-height: 1.05;
	}

	.poc-t-l {
		font-weight: 500;
		color: var(--text);
		padding-right: 0.1rem;
		white-space: nowrap;
		line-height: 1.05;
	}

	.poc-t-cell {
		display: flex;
		justify-content: center;
		align-items: center;
		cursor: pointer;
		min-height: 1rem;
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
		padding: 3px 6px;
	}

	.poc-map-key-compact {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 0.61rem;
		line-height: 1.28;
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

		.poc-map-key-compact--split {
			grid-template-columns: 1fr;
		}

		.poc-map-key-col--dev {
			border-left: none;
			padding-left: 0;
			border-top: 1px dashed var(--border);
			padding-top: 8px;
		}

		.poc-map-key-overlay {
			left: 0;
			max-width: 100%;
			max-height: 42%;
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

	.poc-map-key-col--dev:only-child {
		border-left: none;
		padding-left: 0;
	}

	.poc-map-key-col--dev .poc-key-dev {
		padding-top: 0;
		border-top: none;
	}

	.poc-key-one {
		margin: 0;
		display: flex;
		align-items: flex-start;
		gap: 4px;
	}

	.poc-key-tract-fill-body {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
		min-width: 0;
		flex: 1 1 12rem;
	}

	.poc-key-tract-fill-line {
		display: block;
	}

	.poc-key-tract-bar {
		display: block;
		width: 100%;
		min-width: 7rem;
		height: 0.5rem;
		border-radius: 4px;
		border: 1px solid color-mix(in srgb, var(--border) 80%, var(--text-muted));
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
		gap: 2px 8px;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.58rem;
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
		font-size: 0.66rem;
		line-height: 1.16;
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
		gap: 4px;
		margin: 0 0 4px;
	}

	.poc-mismatch-mode__btn {
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--bg-card) 92%, transparent);
		color: var(--text);
		font-size: 0.6rem;
		line-height: 1.25;
		padding: 3px 6px;
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
		background: #ffffff;
	}

	.poc-k-ring--dev-access {
		border-color: #00843d;
		box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.18);
	}

	.poc-k-ring--dev-noaccess {
		border-color: #ed8b00;
	}

	.map-wrap {
		display: grid;
		grid-template-columns: 1fr;
		gap: 10px;
		width: 100%;
		background: transparent;
		align-items: start;
	}

	.map-visual-column {
		display: grid;
		gap: 4px;
		min-width: 0;
		min-height: 0;
	}

	/* Legend + MBTA overlays + map move as one sticky stack so they stay visible while steps scroll */
	.map-left-column {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
		position: relative;
		top: auto;
		align-self: stretch;
		z-index: 1;
	}

	.map-main {
		position: relative;
		top: auto;
		align-self: start;
		z-index: 1;
		min-width: 0;
		display: grid;
		gap: 3px;
		margin-bottom: clamp(4px, 1.25vh, 10px);
	}

	/* Cohort / mismatch / dev keys sit bottom-left on the choropleth, to the right of the in-SVG colorbar. */
	.poc-map-key-overlay {
		position: absolute;
		left: 5.75rem;
		bottom: 0;
		z-index: 3;
		max-width: min(420px, calc(100% - 5.75rem - 0.5rem));
		max-height: min(52%, 320px);
		overflow: hidden auto;
		padding: 0 0 1px 0;
		/* Clicks in this box stop here so the scrollable legend does not move the map. */
	}

	.poc-map-key-overlay .poc-map-key {
		background: color-mix(in srgb, var(--bg-card) 90%, transparent);
		backdrop-filter: blur(4px);
	}

	.poc-map-callouts {
		padding: 4px 6px;
	}

	.poc-key-findings {
		margin-top: 8px;
		padding: 8px 10px;
		border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
		background: color-mix(in srgb, var(--accent) 6%, var(--bg-card));
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
		min-height: 230px;
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

	.map-tooltip__arrow {
		position: absolute;
		width: 12px;
		height: 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		transform: rotate(45deg);
	}

	.map-tooltip__arrow--left {
		left: -7px;
		margin-top: -6px;
		border-top: 0;
		border-right: 0;
	}

	.map-tooltip__arrow--right {
		right: -7px;
		margin-top: -6px;
		border-bottom: 0;
		border-left: 0;
	}

	.map-tooltip__arrow--top {
		top: -7px;
		margin-left: -6px;
		border-right: 0;
		border-bottom: 0;
	}

	.map-tooltip__arrow--bottom {
		bottom: -7px;
		margin-left: -6px;
		border-top: 0;
		border-left: 0;
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
		flex-wrap: wrap;
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
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.map-tooltip__primary-value {
		font-size: 0.86rem;
		font-weight: 700;
		line-height: 1.25;
		text-align: right;
		color: var(--text);
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.map-tooltip__primary-row--stack {
		grid-template-columns: 1fr;
		gap: 3px;
	}

	.map-tooltip__primary-row--stack .map-tooltip__primary-value {
		text-align: left;
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
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.map-tooltip__value {
		color: var(--text);
		font-size: 0.76rem;
		font-weight: 600;
		line-height: 1.35;
		text-align: right;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.map-tooltip__row--stack {
		grid-template-columns: 1fr;
		gap: 2px;
	}

	.map-tooltip__row--stack .map-tooltip__value {
		text-align: left;
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
		fill: color-mix(in srgb, #ef4444 20%, white 80%);
		stroke: color-mix(in srgb, #dc2626 62%, #1f2937);
		stroke-width: 1.1;
		vector-effect: non-scaling-stroke;
	}

	:global(.insight-marker__dot) {
		fill: color-mix(in srgb, #dc2626 88%, #7f1d1d);
		stroke: #fff;
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	:global(.insight-marker:hover .insight-marker__halo) {
		stroke-width: 1.8;
		filter: brightness(1.08);
	}
</style>

<script>
	import { onDestroy } from 'svelte';
	import * as d3 from 'd3';
	import {
		tractData,
		tractGeo,
		developments,
		mbtaStops,
		mbtaLines,
		meta
	} from '$lib/stores/data.svelte.js';
	import {
		buildFilteredData,
		developmentAffordableUnitsCapped,
		developmentMultifamilyShare,
		getNonTodTracts,
		getTodTracts,
		developmentMbtaProximity,
		isDevelopmentTransitAccessible,
		transitDistanceMiToMetres,
		transitModeUiLabel
	} from '$lib/utils/derived.js';
	import { periodCensusBounds } from '$lib/utils/periods.js';
	import {
		MBTA_BLUE,
		MBTA_GREEN,
		MBTA_GREEN_DEV_OUTLINE,
		MBTA_MAP_NEUTRAL,
		MBTA_ORANGE_DEV_OUTLINE,
		MBTA_RED
	} from '$lib/utils/mbtaColors.js';

	let { panelState, domainOverride = null } = $props();

	let containerEl = $state(null);
	let stepperScrollEl = $state(null);
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
	let revealStage = $state(2);

	/* Map canvas + optional left (dev MF) and right (choropleth) legend columns; no extra height below map. */
	const VIRIDIS_LEGEND_COL_W = 34;
	const DEV_LEGEND_COL_W = 40;
	const mapW = 420;
	const mapH = 380;
	/** Left edge of map in SVG px (after optional dev legend column); set in ``rebuildSVG``. */
	let mapCanvasLeft = 0;
	const mapUid = Math.random().toString(36).slice(2, 11);

	/** Choropleth cohort tints: align with policy page / ``--accent`` (TOD) and control slate. */
	const MAP_TOD_COHORT_HEX = '#6c8cff';
	const MAP_CTRL_COHORT_HEX = '#64748b';
	/** Blend target to mute non-cohort tracts when a cohort highlight is active. */
	const MAP_DIM_TOWARD_HEX = '#05070c';

	const stepContent = [
		{
			kicker: 'Step 1',
			title: 'Start with the choropleth',
			body: 'Read the tract-level metric first, without extra overlays competing for attention.'
		},
		{
			kicker: 'Step 2',
			title: 'Add the tract cohorts',
			body: 'Bring in the TOD and comparison tract categories so the cohort geography becomes easier to read.'
		},
		{
			kicker: 'Step 3',
			title: 'Add projects and transit',
			body: 'Overlay developments and MBTA infrastructure to connect tract outcomes back to nearby projects and service.'
		}
	];

	function setRevealStageFromScroll() {
		const el = stepperScrollEl;
		if (!el) return;
		const cards = [...el.querySelectorAll('[data-step-index]')];
		if (cards.length === 0) return;
		const mid = el.scrollTop + el.clientHeight / 2;
		let best = revealStage;
		let bestDist = Infinity;
		for (const card of cards) {
			const idx = Number(card.getAttribute('data-step-index'));
			const center = card.offsetTop + card.offsetHeight / 2;
			const dist = Math.abs(center - mid);
			if (dist < bestDist) {
				best = idx;
				bestDist = dist;
			}
		}
		if (best !== revealStage) revealStage = best;
	}

	function scrollStepIntoView(i, behavior = 'smooth') {
		const el = stepperScrollEl;
		if (!el) return;
		const card = el.querySelector(`[data-step-index="${i}"]`);
		if (!card) return;
		card.scrollIntoView({ block: 'nearest', behavior });
	}

	/**
	 * Linear RGB blend for overlaying cohort highlights on choropleth fills.
	 *
	 * Parameters
	 * ----------
	 * bottom : d3.RgbColor | string
	 *     Existing fill (hex from color scale).
	 * topHex : string
	 *     Overlay color as ``#rrggbb``.
	 * t : number
	 *     Weight on ``topHex`` in ``[0, 1]``.
	 *
	 * Returns
	 * -------
	 * string
	 *     Blended color as hex.
	 */
	function blendHex(bottom, topHex, t) {
		const a = d3.rgb(bottom);
		const b = d3.rgb(topHex);
		return d3.rgb(
			a.r * (1 - t) + b.r * t,
			a.g * (1 - t) + b.g * t,
			a.b * (1 - t) + b.b * t
		).formatHex();
	}

	/**
	 * Whether the project meets the min multifamily % from the filter panel (same rule as
	 * ``filterDevelopments``). Combined with transit distance for ``TOD``-style map styling.
	 */
	function meetsTodMultifamilyFloor(d, ps) {
		const minPct = Math.min(100, Math.max(0, Number(ps.minDevMultifamilyRatioPct) || 0));
		if (minPct <= 0) return true;
		const s = developmentMultifamilyShare(d);
		return s != null && s >= minPct / 100;
	}

	function showTodShadeEffective() {
		return revealStage >= 1 && panelState.showMapTodCohortShade;
	}

	function showCtrlShadeEffective() {
		return revealStage >= 1 && panelState.showMapControlCohortShade;
	}

	function showDevelopmentsEffective() {
		return revealStage >= 2 && panelState.showDevelopments;
	}

	function lineVisibilityEffective() {
		if (revealStage < 2) return { rail: false, commuter_rail: false, bus: false };
		return {
			rail: panelState.showRailLines,
			commuter_rail: panelState.showCommuterRailLines,
			bus: panelState.showBusLines
		};
	}

	function stopVisibilityEffective() {
		if (revealStage < 2) return { rail: false, commuter_rail: false, bus: false };
		return {
			rail: panelState.showRailStops,
			commuter_rail: panelState.showCommuterRailStops,
			bus: panelState.showBusStops
		};
	}

	const structuralKey = $derived(
		JSON.stringify({
			n: tractData.length,
			gf: tractGeo?.features?.length ?? 0,
			ms: mbtaStops.length,
			showDev: showDevelopmentsEffective(),
			rs: revealStage
		})
	);

	const dataKey = $derived(
		JSON.stringify({
			tp: panelState.timePeriod,
			y: panelState.yVar,
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
			domSync: domainOverride ? 'on' : 'off',
			domColor: domainOverride?.colorDomain,
			mapTod: showTodShadeEffective(),
			mapCtrl: showCtrlShadeEffective(),
			showDev: showDevelopmentsEffective(),
			rs: revealStage
		})
	);

	let lastStructuralKey = $state('');
	let svgRef = $state(null);
	let projectionRef = $state(null);

	function isChangeVariable(yBase) {
		return String(yBase).includes('change');
	}

	function stopColor(stop) {
		if (stop.color) return stop.color;
		const m = stop.modes ?? [];
		// Match commuter_rail before rail — ``'commuter_rail'.includes('rail')`` would misclassify.
		if (m.includes('commuter_rail')) return '#a855f7';
		if (m.includes('rail')) return '#3b82f6';
		if (m.includes('bus')) return '#f97316';
		return '#888';
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

	/** Map GTFS route_type to the same mode tokens used in stops. */
	function lineMode(routeType) {
		if (routeType === 0 || routeType === 1) return 'rail';
		if (routeType === 2) return 'commuter_rail';
		if (routeType === 3) return 'bus';
		return 'other';
	}

	function buildTractLookup() {
		const m = new Map();
		for (const t of tractData) {
			if (t.gisjoin && typeof t.gisjoin === 'string' && t.gisjoin.startsWith('G'))
				m.set(t.gisjoin, t);
		}
		return m;
	}

	function rebuildSVG() {
		if (!containerEl) return;
		const root = d3.select(containerEl);
		root.selectAll('*').remove();

		const features = tractGeo?.features ?? [];
		if (features.length === 0) {
			root.append('p').attr('class', 'map-empty').text('Loading map data...');
			return;
		}

		const showDevs = showDevelopmentsEffective();
		mapCanvasLeft = showDevs ? DEV_LEGEND_COL_W : 0;
		const svgW = mapCanvasLeft + mapW + VIRIDIS_LEGEND_COL_W;
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

		const clipId = `map-clip-${mapUid}`;
		svg.append('defs').append('clipPath').attr('id', clipId)
			.append('rect')
			.attr('x', mapCanvasLeft)
			.attr('y', 0)
			.attr('width', mapW)
			.attr('height', mapH);

		svg.append('g').attr('class', 'map-dev-legend-group');

		const mapRoot = svg.append('g').attr('class', 'map-root').attr('clip-path', `url(#${clipId})`);
		const zoomLayer = mapRoot.append('g').attr('class', 'map-zoom-layer');

		// Tract polygons
		zoomLayer.append('g').attr('class', 'tract-layer')
			.selectAll('path.tract-poly')
			.data(features, (d) => d.properties?.gisjoin)
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

		// MBTA lines
		zoomLayer.append('g').attr('class', 'mbta-lines-layer')
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

		// MBTA stops
		const stopG = zoomLayer.append('g').attr('class', 'mbta-stops-layer');
		stopG.selectAll('circle.mbta-stop')
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

		// Development dots layer (initially empty, populated by updateDevelopments)
		zoomLayer.append('g').attr('class', 'dev-dots-layer');

		// Zoom — scale all dot overlays inversely so they stay readable
		const zoom = d3.zoom()
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
			});

		svg.call(zoom).on('dblclick.zoom', null).style('touch-action', 'none');

		// Choropleth legend — placeholder; filled in ``updateChoropleth``
		svg.append('g').attr('class', 'map-legend-group');
	}

	function updateChoropleth() {
		if (!containerEl || !svgRef) return;

		const tp = panelState.timePeriod;
		const yBase = panelState.yVar;
		const yKey = `${yBase}_${tp}`;
		const yLabel = meta.yVariables?.find((v) => v.key === yBase)?.label ?? yBase;

		const { filteredTracts } = buildFilteredData(tractData, developments, panelState);
		const filteredSet = new Set(filteredTracts.map((t) => t.gisjoin));

		const lookup = new Map();
		for (const t of tractData) {
			const id = t.gisjoin;
			if (id == null || typeof id !== 'string' || !id.startsWith('G')) continue;
			const raw = t[yKey];
			if (raw == null) { lookup.set(id, NaN); continue; }
			const v = Number(raw);
			lookup.set(id, Number.isFinite(v) ? v : NaN);
		}

		const values = filteredTracts.map((t) => Number(t[yKey])).filter((v) => Number.isFinite(v));

		const todSet = new Set(getTodTracts(tractData, panelState, developments).map((t) => t.gisjoin));
		const controlSet = new Set(
			getNonTodTracts(tractData, panelState, developments).map((t) => t.gisjoin)
		);
		const showTodShade = showTodShadeEffective();
		const showCtrlShade = showCtrlShadeEffective();

		/** MBTA red (negative) → neutral → MBTA blue (positive). */
		const divergingMap = d3.piecewise(d3.interpolateRgb, [MBTA_RED, MBTA_MAP_NEUTRAL, MBTA_BLUE]);

		let colorScale;
		if (values.length === 0) {
			colorScale = () => 'var(--bg-card)';
		} else if (domainOverride?.colorDomain) {
			const [lo, hi] = domainOverride.colorDomain;
			const maxAbs = Math.max(Math.abs(lo), Math.abs(hi), 1e-9);
			colorScale = d3.scaleDiverging(divergingMap).domain([-maxAbs, 0, maxAbs]).clamp(true);
		} else {
			// Clip colorbar range to exclude >3-sigma outliers
			const mean = d3.mean(values);
			const sd = Math.sqrt(d3.variance(values) ?? 0);
			const clipLo = mean - 3 * sd;
			const clipHi = mean + 3 * sd;
			const clipped = values.filter((v) => v >= clipLo && v <= clipHi);
			const lo = clipped.length > 0 ? d3.min(clipped) : d3.min(values);
			const hi = clipped.length > 0 ? d3.max(clipped) : d3.max(values);
			const maxAbs = Math.max(Math.abs(lo), Math.abs(hi), 1e-9);
			colorScale = d3.scaleDiverging(divergingMap).domain([-maxAbs, 0, maxAbs]).clamp(true);
		}

		const cohortMode = showTodShade || showCtrlShade;

		d3.select(containerEl).selectAll('path.tract-poly')
			.attr('fill', (d) => {
				const id = d.properties?.gisjoin;
				const inFiltered = filteredSet.has(id);
				const v = lookup.get(id);
				const hasData = inFiltered && Number.isFinite(v);
				let fill = hasData ? colorScale(v) : 'var(--bg-card)';
				const inTod = todSet.has(id);
				const inCtrl = controlSet.has(id);
				const cohortLit =
					(showTodShade && inTod) || (showCtrlShade && inCtrl);
				// Cohort map tints: blend with choropleth fill when possible; solid tint when no Y value.
				if (showTodShade && inTod) {
					fill =
						typeof fill === 'string' && fill.startsWith('#')
							? blendHex(fill, MAP_TOD_COHORT_HEX, 0.4)
							: MAP_TOD_COHORT_HEX;
				} else if (showCtrlShade && inCtrl) {
					fill =
						typeof fill === 'string' && fill.startsWith('#')
							? blendHex(fill, MAP_CTRL_COHORT_HEX, 0.4)
							: MAP_CTRL_COHORT_HEX;
				} else if (cohortMode && !cohortLit) {
					// Mute everything that is not a cohort highlight so TOD / control tracts read clearly.
					if (hasData && typeof fill === 'string' && fill.startsWith('#')) {
						fill = blendHex(fill, MAP_DIM_TOWARD_HEX, 0.62);
					} else {
						fill = '#0c0f18';
					}
				}
				return fill;
			})
			.attr('fill-opacity', (d) => {
				const id = d.properties?.gisjoin;
				const inFiltered = filteredSet.has(id);
				const hasData = inFiltered && Number.isFinite(lookup.get(id));
				const inTod = todSet.has(id);
				const inCtrl = controlSet.has(id);
				const cohortLit =
					(showTodShade && inTod) || (showCtrlShade && inCtrl);
				if (!cohortMode) {
					if (cohortLit && !hasData) return 0.88;
					return hasData ? 0.9 : 0.25;
				}
				if (cohortLit && !hasData) return 0.9;
				if (cohortLit && hasData) return 0.94;
				if (!cohortLit && hasData) return 0.38;
				return 0.1;
			});

		// Legend — compact vertical diverging colorbar (red neg. → blue pos.) to the right of the map
		const svg = svgRef;
		const legGroup = svg.select('.map-legend-group');
		legGroup.selectAll('*').remove();
		legGroup.attr('transform', `translate(${mapCanvasLeft + mapW + 3},0)`);

		const titleBlockH = 18;
		const yTitleTop = 2;
		const cohortRows = (showTodShade ? 1 : 0) + (showCtrlShade ? 1 : 0);
		const cohortBlockH = cohortRows > 0 ? cohortRows * 13 + 6 : 0;
		const y0 = yTitleTop + titleBlockH;
		const legBarW = 7;
		const axisPad = 2;
		const legBarH = Math.max(100, mapH - y0 - cohortBlockH - 6);
		const fmtTick = (v) => {
			const n = Number(v);
			if (!Number.isFinite(n)) return '';
			const ax = Math.abs(n);
			if (ax >= 1000 || (ax > 0 && ax < 0.01)) return d3.format('.2~s')(n);
			return d3.format('.2~f')(n);
		};

		const legendG = legGroup.append('g').attr('class', 'map-legend-inner');
		const gradId = `map-grad-${mapUid}`;
		svg.select('defs').selectAll(`#${gradId}`).remove();
		const grad = svg.select('defs').append('linearGradient').attr('id', gradId)
			.attr('x1', '0%').attr('y1', '100%').attr('x2', '0%').attr('y2', '0%');

		const shortYLabel =
			yLabel.length > 22 ? `${yLabel.slice(0, 19)}…` : yLabel;
		legendG.append('text')
			.attr('x', 0)
			.attr('y', yTitleTop + 11)
			.attr('fill', 'var(--text-muted)')
			.attr('font-size', '8px')
			.text(shortYLabel);

		if (values.length > 0 && typeof colorScale.domain === 'function') {
			const domain = colorScale.domain();
			const d0 = domain.length === 3 ? domain[0] : domain[0];
			const d1 = domain.length === 3 ? domain[2] : domain[domain.length - 1];
			const nStops = 48;
			for (let i = 0; i <= nStops; i++) {
				const t = i / nStops;
				const v = d0 + t * (d1 - d0);
				grad.append('stop').attr('offset', `${t * 100}%`).attr('stop-color', colorScale(v));
			}
			legendG.append('rect')
				.attr('x', 0)
				.attr('y', y0)
				.attr('width', legBarW)
				.attr('height', legBarH)
				.attr('rx', 2)
				.attr('fill', `url(#${gradId})`)
				.attr('stroke', 'var(--border)')
				.attr('stroke-width', 0.5);

			const yScale = d3.scaleLinear().domain([d0, d1]).range([y0 + legBarH, y0]);
			legendG.append('g')
				.attr('transform', `translate(${legBarW + axisPad},0)`)
				.call(d3.axisRight(yScale).ticks(4).tickFormat(fmtTick))
				.call((g) => g.selectAll('path,line').attr('stroke', 'var(--border)'))
				.call((g) =>
					g.selectAll('text').attr('fill', 'var(--text-muted)').attr('font-size', '7.5px')
				);
		} else {
			legendG.append('rect')
				.attr('x', 0)
				.attr('y', y0)
				.attr('width', legBarW)
				.attr('height', legBarH)
				.attr('rx', 2)
				.attr('fill', 'var(--bg-card)')
				.attr('stroke', 'var(--border)')
				.attr('stroke-width', 0.5);
		}

		if (showTodShade || showCtrlShade) {
			let cy = y0 + legBarH + 4;
			const cohortG = legendG.append('g').attr('class', 'map-cohort-legend');
			if (showTodShade) {
				cohortG
					.append('rect')
					.attr('x', 0)
					.attr('y', cy)
					.attr('width', 10)
					.attr('height', 10)
					.attr('rx', 2)
					.attr('fill', MAP_TOD_COHORT_HEX)
					.attr('stroke', 'var(--border)')
					.attr('stroke-width', 0.5);
				cohortG
					.append('text')
					.attr('x', 13)
					.attr('y', cy + 9)
					.attr('fill', 'var(--text-muted)')
					.attr('font-size', '7.5px')
					.text('TOD');
				cy += 13;
			}
			if (showCtrlShade) {
				cohortG
					.append('rect')
					.attr('x', 0)
					.attr('y', cy)
					.attr('width', 10)
					.attr('height', 10)
					.attr('rx', 2)
					.attr('fill', MAP_CTRL_COHORT_HEX)
					.attr('stroke', 'var(--border)')
					.attr('stroke-width', 0.5);
				cohortG
					.append('text')
					.attr('x', 13)
					.attr('y', cy + 9)
					.attr('fill', 'var(--text-muted)')
					.attr('font-size', '7.5px')
					.text('non-TOD');
			}
		}

		containerEl.__mapLookup = lookup;
		containerEl.__mapFilteredSet = filteredSet;
		containerEl.__mapYLabel = yLabel;
		containerEl.__mapYKey = yKey;
		containerEl.__mapTodSet = todSet;
		containerEl.__mapControlSet = controlSet;
	}

	/** Update development dots on the map based on showDevelopments toggle + dev filters. */
	function updateDevelopments() {
		if (!containerEl || !svgRef || !projectionRef) return;

		const svg = svgRef;
		const devLeg = svg.select('.map-dev-legend-group');
		devLeg.selectAll('*').remove();

		const devLayer = d3.select(containerEl).select('.dev-dots-layer');
		devLayer.selectAll('*').remove();

		if (!showDevelopmentsEffective()) return;

		const { filteredDevs } = buildFilteredData(tractData, developments, panelState);
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

		const mfInterp = (t) => d3.interpolateRgb('#ffffff', MBTA_GREEN)(Math.min(1, Math.max(0, t)));
		const mfColor = d3.scaleSequential(mfInterp).domain([0, 1]);

		// Left margin: multifamily share colorbar (matches dot fill scale)
		const y0mf = 18;
		const legBarHmf = Math.max(100, mapH - y0mf - 8);
		const legBarWmf = 7;
		const barLeft = 26;
		const gradMfId = `map-dev-mf-grad-${mapUid}`;
		svg.select('defs').selectAll(`#${gradMfId}`).remove();
		const gradMf = svg.select('defs').append('linearGradient').attr('id', gradMfId)
			.attr('x1', '0%').attr('y1', '100%').attr('x2', '0%').attr('y2', '0%');
		for (let i = 0; i <= 48; i++) {
			const t = i / 48;
			gradMf.append('stop').attr('offset', `${t * 100}%`).attr('stop-color', mfInterp(t));
		}
		const mfLegG = devLeg.append('g').attr('class', 'map-dev-legend-inner').attr('transform', 'translate(2,0)');
		mfLegG.append('text')
			.attr('x', 0)
			.attr('y', 11)
			.attr('fill', 'var(--text-muted)')
			.attr('font-size', '8px')
			.text('MF %');
		mfLegG.append('rect')
			.attr('x', barLeft)
			.attr('y', y0mf)
			.attr('width', legBarWmf)
			.attr('height', legBarHmf)
			.attr('rx', 2)
			.attr('fill', `url(#${gradMfId})`)
			.attr('stroke', 'var(--border)')
			.attr('stroke-width', 0.5);
		const yMf = d3.scaleLinear().domain([0, 1]).range([y0mf + legBarHmf, y0mf]);
		mfLegG.append('g')
			.attr('transform', `translate(${barLeft},0)`)
			.call(d3.axisLeft(yMf).ticks(4).tickFormat(d3.format('.0%')))
			.call((g) => g.selectAll('path,line').attr('stroke', 'var(--border)'))
			.call((g) =>
				g.selectAll('text').attr('fill', 'var(--text-muted)').attr('font-size', '7.5px')
			);

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
				strokeWBase: access ? 0.525 : 0.38,
				transitAccessible: access
			};
		});

		devLayer.selectAll('circle.dev-dot')
			.data(glyphData, (d, i) => `${d.gisjoin}-${d.lat}-${d.lon}-${i}`)
			.join('circle')
			.attr('class', 'dev-dot')
			.attr('cx', (d) => projection([d.lon, d.lat])?.[0] ?? -9999)
			.attr('cy', (d) => projection([d.lon, d.lat])?.[1] ?? -9999)
			.attr('r', (d) => d.rBase * invK)
			.attr('fill', (d) =>
				d.mfShare == null || !Number.isFinite(d.mfShare) ? '#475569' : mfColor(d.mfShare)
			)
			.attr('fill-opacity', 0.75)
			.attr('stroke', (d) =>
				d.transitAccessible ? MBTA_GREEN_DEV_OUTLINE : MBTA_ORANGE_DEV_OUTLINE
			)
			.attr('stroke-width', (d) => d.strokeWBase * invK)
			.style('cursor', 'pointer')
			.on('mouseenter', handleDevEnter)
			.on('mousemove', handleMouseMove)
			.on('mouseleave', handleOverlayLeave);
	}

	/** Toggle visibility of MBTA lines and stops based on overlay state. */
	function updateOverlays() {
		if (!containerEl || !svgRef) return;

		const lineVis = lineVisibilityEffective();
		const stopVis = stopVisibilityEffective();

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
		d3.select(containerEl).selectAll('path.tract-poly')
			.attr('stroke', (d) => {
				const id = d.properties?.gisjoin;
				if (id === hoveredId) return '#ffffff';
				if (selectedSet.has(id)) return '#b91c1c';
				return 'var(--border)';
			})
			.attr('stroke-width', (d) => {
				const id = d.properties?.gisjoin;
				if (id === hoveredId) return 1.5;
				if (selectedSet.has(id)) return 1.5;
				return 0.5;
			});
	}

	// ── Event handlers ──

	function handleTractEnter(event, d) {
		const id = d.properties?.gisjoin;
		panelState.setHovered(id);
		const el = containerEl;
		if (!el) return;
		const lookup = el.__mapLookup;
		const yLabel = el.__mapYLabel;
		const v = lookup?.get(id);
		const fmt = d3.format('.2f');
		const fmtInt = d3.format(',.0f');
		const tractLookup = buildTractLookup();
		const t = tractLookup.get(id);
		const county = t?.county;
		const tractPlace = county && String(county) !== 'County Name' ? String(county) : String(id);
		const todSet = containerEl?.__mapTodSet;
		const controlSet = containerEl?.__mapControlSet;
		const badge = todSet?.has(id)
			? 'TOD tract'
			: controlSet?.has(id)
				? 'non-TOD tract'
				: '';
		const badgeTone = todSet?.has(id) ? 'tod' : controlSet?.has(id) ? 'nontod' : 'neutral';
		const primaryRows = [];
		const secondaryRows = [];

		if (t) {
			const tp = panelState.timePeriod;
			const { startY, endY } = periodCensusBounds(tp);

			if (yLabel && lookup) {
				primaryRows.push({ label: yLabel, value: Number.isFinite(v) ? fmt(v) : '\u2014' });
			}

			const pop = t[`pop_${startY}`];
			if (pop != null) secondaryRows.push({ label: `Population (${startY})`, value: fmtInt(pop) });
			const hu = t[`total_hu_${startY}`];
			if (hu != null) secondaryRows.push({ label: `Housing units (${startY})`, value: fmtInt(hu) });
			const huEnd = t[`total_hu_${endY}`];
			if (hu != null && huEnd != null) {
				const diff = huEnd - hu;
				const sign = diff >= 0 ? '+' : '';
				primaryRows.push({ label: 'HU change (census)', value: `${sign}${fmtInt(diff)}` });
			}
			const stopsRaw = Number(t.transit_stops) || 0;
			secondaryRows.push({ label: 'MBTA stops (tract + buffer)', value: String(stopsRaw) });
			const minPct = t[`minority_pct_${startY}`];
			if (minPct != null) primaryRows.push({ label: `Minority share (${startY})`, value: `${fmt(minPct)}%` });
		} else {
			secondaryRows.push({ label: 'Tract data', value: 'No census data for this tract' });
		}

		tooltip = {
			visible: true,
			x: event.clientX,
			y: event.clientY,
			eyebrow: 'Census tract',
			title: county && String(county) !== 'County Name' ? `Tract in ${tractPlace}` : `Tract: ${tractPlace}`,
			badge,
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
		tooltip = { ...tooltip, visible: false };
	}

	function handleTractClick(event, d) {
		event.stopPropagation();
		const id = d.properties?.gisjoin;
		if (id) panelState.toggleTract(id);
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
			{ label: 'Municipality', value: `${d.municipal ?? '—'}` },
			{ label: 'Units', value: `${d.hu ?? '—'}` }
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
			secondaryRows.push({ label: 'Nearest stop', value: '\u2014' });
		}
		secondaryRows.push({ label: `Stops within ${todMi} mi`, value: `${nWithin}` });
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
		tooltip = { ...tooltip, visible: false };
	}

	// ── Effects ──

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

	$effect(() => {
		void structuralKey;
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
		if (!containerEl || !svgRef) return;
		updateChoropleth();
		updateDevelopments();
		updateOverlays();
		updateSelection();
	});

	$effect(() => {
		void panelState.showDevelopments;
		if (!containerEl || !svgRef) return;
		updateDevelopments();
		updateOverlays();
	});

	$effect(() => {
		void overlayKey;
		if (!containerEl || !svgRef) return;
		updateOverlays();
	});

	$effect(() => {
		void stepperScrollEl;
		if (!stepperScrollEl) return;
		requestAnimationFrame(() => {
			scrollStepIntoView(revealStage, 'auto');
		});
	});

	$effect(() => {
		void panelState.hoveredTract;
		void panelState.selectedTracts;
		void panelState.selectedTracts.size;
		if (!containerEl || !svgRef) return;
		updateSelection();
	});

	onDestroy(() => {
		if (containerEl) d3.select(containerEl).selectAll('*').remove();
		lastStructuralKey = '';
		svgRef = null;
		projectionRef = null;
	});
</script>

<div class="map-wrap">
	<div class="map-stepper card-key" aria-label="Map walkthrough">
		<div class="map-stepper__head">
			<p class="map-stepper__kicker">Map walkthrough</p>
			<p class="map-stepper__hint">Scroll this panel to build up context in 3 layers.</p>
		</div>
		<div
			class="map-stepper__rail"
			role="tablist"
			aria-label="Map steps"
			bind:this={stepperScrollEl}
			onscroll={setRevealStageFromScroll}
		>
			{#each stepContent as step, i}
				<article
					class="map-stepper__card"
					class:map-stepper__card--active={revealStage === i}
					data-step-index={i}
					role="tab"
					aria-selected={revealStage === i}
					onclick={() => {
						revealStage = i;
						scrollStepIntoView(i);
					}}
				>
					<div class="map-stepper__card-top">
						<span class="map-stepper__num">{i + 1}</span>
						<div class="map-stepper__card-copy">
							<span class="map-stepper__body-kicker">{step.kicker}</span>
							<span class="map-stepper__title">{step.title}</span>
						</div>
					</div>
					<p class="map-stepper__card-body">{step.body}</p>
				</article>
			{/each}
		</div>
	</div>
	<div class="map-root" bind:this={containerEl}></div>
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

<style>
	.map-wrap {
		position: relative;
		width: 100%;
		background: transparent;
	}

	.card-key {
		border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
		background: color-mix(in srgb, var(--bg-card) 92%, white);
		border-radius: 10px;
		box-shadow: 0 4px 18px rgb(15 23 42 / 0.08);
	}

	.map-stepper {
		position: absolute;
		top: 10px;
		left: 10px;
		z-index: 8;
		display: grid;
		gap: 10px;
		width: min(352px, calc(100% - 20px));
		padding: 13px 14px;
		backdrop-filter: blur(8px);
	}

	.map-stepper__head,
	.map-stepper__body {
		display: grid;
		gap: 2px;
	}

	.map-stepper__kicker,
	.map-stepper__body-kicker {
		margin: 0;
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.map-stepper__hint,
	.map-stepper__body-copy {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.map-stepper__rail {
		display: grid;
		gap: 10px;
		max-height: 292px;
		overflow-y: auto;
		scroll-snap-type: y proximity;
		padding: 2px 4px 12px 1px;
	}

	.map-stepper__card {
		display: grid;
		gap: 10px;
		width: 100%;
		padding: 12px 13px;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--border) 88%, white);
		background: color-mix(in srgb, var(--bg-card) 97%, white);
		box-shadow: 0 2px 10px rgb(15 23 42 / 0.05);
		text-align: left;
		color: var(--text);
		scroll-snap-align: center;
		cursor: pointer;
	}

	.map-stepper__card--active {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
		box-shadow: 0 8px 24px rgb(15 23 42 / 0.09);
	}

	.map-stepper__card-top {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr);
		gap: 10px;
		align-items: start;
	}

	.map-stepper__card-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.map-stepper__num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.82rem;
		font-weight: 700;
	}

	.map-stepper__card--active .map-stepper__num {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, var(--bg-card));
	}

	.map-stepper__title {
		font-size: 0.9rem;
		font-weight: 700;
		line-height: 1.24;
		color: var(--text);
	}

	.map-stepper__card-body {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.52;
		color: var(--text-muted);
	}

	.map-root {
		width: 100%;
		max-width: 100%;
		min-height: 280px;
	}
	:global(.map-empty) {
		margin: 0;
		padding: 16px;
		font-size: 0.875rem;
		color: var(--text-muted);
	}
	.map-tooltip {
		position: fixed;
		z-index: 20;
		max-width: 360px;
		padding: 12px 13px;
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--text);
		pointer-events: none;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 10px 28px rgb(15 23 42 / 0.16);
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

	.map-tooltip__eyebrow,
	.map-tooltip__details-label {
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
		border-color: color-mix(in srgb, #64748b 55%, var(--border));
		background: color-mix(in srgb, #64748b 13%, var(--bg-card));
		color: #526074;
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
		background: color-mix(in srgb, #64748b 10%, var(--bg-card));
		border-color: color-mix(in srgb, #64748b 28%, var(--border));
	}

	.map-tooltip__primary--minimal {
		background: color-mix(in srgb, #94a3b8 10%, var(--bg-card));
		border-color: color-mix(in srgb, #94a3b8 28%, var(--border));
	}

	.map-tooltip__primary-row,
	.map-tooltip__row {
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

	.map-tooltip__details,
	.map-tooltip__rows {
		display: grid;
		gap: 6px;
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

	@media (max-width: 720px) {
		.map-stepper {
			position: relative;
			top: auto;
			left: auto;
			width: 100%;
			margin-bottom: 8px;
			backdrop-filter: none;
		}
	}
</style>

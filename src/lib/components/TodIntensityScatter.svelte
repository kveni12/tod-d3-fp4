<script>
	import { onDestroy } from 'svelte';
	import * as d3 from 'd3';
	import { tractData, developments, meta } from '$lib/stores/data.svelte.js';
	import {
		buildTodAnalysisData,
		classifyTractDevelopment,
		computeWeightedRegression,
		filterPointsTenSigmaMarginals,
		huWeightKey
	} from '$lib/utils/derived.js';
	import { periodCensusBounds } from '$lib/utils/periods.js';
	import { splitChartTitle } from '$lib/utils/chartTitles.js';
	import { niceHousingUnitsLabel } from '$lib/utils/chartFormat.js';
	import {
		MBTA_CHART_NEUTRAL,
		MBTA_GREEN,
		MBTA_ORANGE,
		MBTA_YELLOW
	} from '$lib/utils/mbtaColors.js';

	let {
		panelState,
		domainOverride = null,
		wideLayout = false,
		/** Story embeds: keep the chart readable, hide more technical chart chrome. */
		storyMode = false,
		/** When false, hide the axis-trim checkbox and plot full data extent (POC income/education embeds). */
		showTrimControl = true,
		/**
		 * If set, use this Y metric key instead of ``panelState.yVar`` (map/sidebar can keep a
		 * different choropleth Y). Selection and other filters still come from ``panelState``.
		 */
		yVarOverride = null
	} = $props();

	/**
	 * Clear tract selection for this panel (map + all linked scatters).
	 * Prefer ``PanelState.clearSelection`` so ``lastInteractedGisjoin`` resets with the main app.
	 */
	function clearTractSelection() {
		if (typeof panelState.clearSelection === 'function') {
			panelState.clearSelection();
		} else {
			panelState.selectedTracts = new Set();
		}
	}

	let containerEl = $state(null);
	let tooltip = $state({ visible: false, x: 0, y: 0, lines: [] });

	const marginLeft = 60;
	const marginRightDefault = 14;
	/** Default plot size (square-ish); ``wideLayout`` overrides below in the draw effect. */
	const INNER_W_DEFAULT = 380;
	/** Default inner plot height (1.5× previous 340px for taller charts). */
	const INNER_H_DEFAULT = 510;
	const marginBottom = 52;

	/**
	 * Weighted fit lines: TOD cohort uses a darkened MBTA green (same hue family as dots at high TOD share);
	 * other cohorts stay yellow for contrast.
	 */
	const LINE_TOD = d3.interpolateRgb(MBTA_GREEN, '#071a14')(0.24);
	const LINE_NONTOD = d3.interpolateRgb(MBTA_ORANGE, '#071a14')(0.24);
	const LINE_ALL = MBTA_YELLOW;
	/** Manual selection (map + scatter); distinct from cohort fit lines. */
	const LINE_SELECTED = '#b91c1c';
	/** Minimal-development dots: muted tone between green/orange ramp. */
	const GREY_MINIMAL = '#a8908c';
	const TOD_COLOR_BINS = [0.2, 0.4, 0.6, 0.8];
	const TOD_COLOR_STEPS = [
		MBTA_GREEN,
		d3.interpolateRgb(MBTA_GREEN, MBTA_CHART_NEUTRAL)(0.55),
		MBTA_CHART_NEUTRAL,
		d3.interpolateRgb(MBTA_CHART_NEUTRAL, MBTA_ORANGE)(0.55),
		MBTA_ORANGE
	];

	const plotKey = $derived(
		JSON.stringify({
			tp: panelState.timePeriod,
			y: yVarOverride ?? panelState.yVar,
			n: tractData.length,
			dn: developments.length,
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
			minStops: panelState.minStops,
			trim: panelState.trimOutliers,
			dom: domainOverride?.todIntensity ? 'on' : 'off',
			dx: domainOverride?.todIntensity?.xDomain,
			dy: domainOverride?.todIntensity?.yDomain,
			wl: wideLayout,
			/* Selection drives stroke updates via a separate effect; include here so the selected WLS line redraws. */
			sel: [...panelState.selectedTracts].sort().join('\t')
		})
	);

	let lastPlotKey = $state('');
	/**
	 * Discretized MBTA green–neutral–orange TOD share encoding.
	 *
	 * @param {number | null} todFraction
	 * @returns {string}
	 */
	function colorDiscretizedTod(todFraction) {
		const tf = Number(todFraction);
		if (!Number.isFinite(tf)) return GREY_MINIMAL;
		return d3
			.scaleThreshold()
			.domain(TOD_COLOR_BINS)
			.range(TOD_COLOR_STEPS)(Math.min(1, Math.max(0, tf)));
	}

	$effect(() => {
		void plotKey;
		if (!containerEl) return;
		if (plotKey === lastPlotKey) return;
		lastPlotKey = plotKey;

		const tp = panelState.timePeriod;
		const yBase = yVarOverride ?? panelState.yVar;
		const yKey = `${yBase}_${tp}`;
		const huKey = huWeightKey(tp);
		const hoveredId = panelState.hoveredTract;
		const selectedSet = panelState.selectedTracts;

		const root = d3.select(containerEl);
		root.selectAll('*').remove();

		const { filteredTracts, tractTodMetrics } = buildTodAnalysisData(
			tractData,
			developments,
			panelState
		);

		const sigThr = panelState.sigDevMinPctStockIncrease ?? 2;
		const todCut = Number(panelState.todFractionCutoff);
		const cut = Number.isFinite(todCut) ? Math.min(1, Math.max(0, todCut)) : 0.5;

		/** Wide layout: landscape plot, side legends, regression key in an inset (POC / journalism use). */
		const innerWidth = wideLayout ? 580 : INNER_W_DEFAULT;
		/** Wide layout: inner height 1.5× previous 252px to match default layout scale-up. */
		const innerHeight = wideLayout ? 378 : INNER_H_DEFAULT;
		const legendColW = wideLayout ? 108 : 54;
		const marginRight = wideLayout ? 12 : marginRightDefault;

		/** @type {Array<{ tract: object, x: number, y: number, w: number, classification: string, todFraction: number | null, dotR?: number }>} */
		const allPoints = [];

		for (const t of filteredTracts) {
			const m = tractTodMetrics.get(t.gisjoin);
			if (!m) continue;
			const rawY = t[yKey];
			if (rawY == null) continue;
			const yVal = Number(rawY);
			const xVal = m.pctStockIncrease;
			if (!Number.isFinite(yVal)) continue;
			if (xVal == null || !Number.isFinite(xVal)) continue;

			const w = Math.max(Number(t[huKey]) || 0, 1);
			const cls = classifyTractDevelopment(m, sigThr, cut);
			allPoints.push({
				tract: t,
				x: xVal,
				y: yVal,
				w,
				classification: cls,
				todFraction: m.todFraction
			});
		}

		const minimalPts = allPoints.filter((p) => p.classification === 'minimal');
		const sigPts = allPoints.filter((p) => p.classification !== 'minimal');

		const pointsTodDom = sigPts.filter((p) => p.classification === 'tod_dominated');
		const pointsNonTodDom = sigPts.filter((p) => p.classification === 'nontod_dominated');

		const regTod = filterPointsTenSigmaMarginals(pointsTodDom);
		const regNonTod = filterPointsTenSigmaMarginals(pointsNonTodDom);
		const regAll = filterPointsTenSigmaMarginals([...pointsTodDom, ...pointsNonTodDom]);

		const wRegTod =
			regTod.length >= 2 ? computeWeightedRegression(regTod) : { slope: NaN, intercept: NaN, r2: 0 };
		const wRegNonTod =
			regNonTod.length >= 2
				? computeWeightedRegression(regNonTod)
				: { slope: NaN, intercept: NaN, r2: 0 };
		const wRegAll =
			regAll.length >= 2 ? computeWeightedRegression(regAll) : { slope: NaN, intercept: NaN, r2: 0 };

		const selPts = allPoints.filter((p) => selectedSet.has(p.tract.gisjoin));
		const regSelFiltered = filterPointsTenSigmaMarginals(selPts);
		const wRegSel =
			regSelFiltered.length >= 2
				? computeWeightedRegression(regSelFiltered)
				: { slope: NaN, intercept: NaN, r2: 0 };

		if (allPoints.length === 0) {
			const pe = root.append('p').attr('class', 'scatter-empty');
			pe.text('No tracts with data for this combination (check filters).');
			return;
		}

		const { startY } = periodCensusBounds(tp);
		const yMeta = meta.yVariables?.find((v) => v.key === yBase);
		const yLabel = yMeta?.label ?? yBase;
		const huSrcLabel = panelState.huChangeSource === 'census' ? 'Census' : 'MassBuilds';
		const xLabel = `% housing stock increase (${huSrcLabel})`;

		const wAll = allPoints.map((d) => d.w);
		const wMin = d3.min(wAll) ?? 1;
		const wMax = d3.max(wAll) ?? 1;
		const rScale = d3
			.scaleSqrt()
			.domain(wMin === wMax ? [Math.max(wMin * 0.9, 1), wMax * 1.1 + 1] : [wMin, wMax])
			.range([2.5, 5.2]);
		for (const p of allPoints) p.dotR = rScale(p.w);
		const rMax = rScale(wMax);

		let xDomain;
		let yDomain;
		if (domainOverride?.todIntensity?.xDomain) {
			xDomain = domainOverride.todIntensity.xDomain;
			yDomain = domainOverride.todIntensity.yDomain;
		} else if (panelState.trimOutliers && sigPts.length > 2) {
			// 10σ marginal trim on significant tracts only; ``showTrimControl`` is UI-only.
			const xVals = sigPts.map((d) => d.x);
			const yVals = sigPts.map((d) => d.y);
			const xMu = d3.mean(xVals);
			const yMu = d3.mean(yVals);
			const xSd = Math.sqrt(d3.variance(xVals) || 0);
			const ySd = Math.sqrt(d3.variance(yVals) || 0);
			const xIn = xSd > 0 ? xVals.filter((v) => v >= xMu - 10 * xSd && v <= xMu + 10 * xSd) : xVals;
			const yIn = ySd > 0 ? yVals.filter((v) => v >= yMu - 10 * ySd && v <= yMu + 10 * ySd) : yVals;
			xDomain = xIn.length > 0 ? d3.extent(xIn) : d3.extent(xVals);
			yDomain = yIn.length > 0 ? d3.extent(yIn) : d3.extent(yVals);
		} else {
			const extentFrom = allPoints.length > 0 ? allPoints : sigPts;
			xDomain = d3.extent(extentFrom, (d) => d.x);
			yDomain = d3.extent(extentFrom, (d) => d.y);
		}

		const xScale = d3
			.scaleLinear()
			.domain(xDomain[0] === undefined ? [0, 1] : xDomain)
			.nice()
			.range([0, innerWidth]);
		const yScale = d3
			.scaleLinear()
			.domain(yDomain[0] === undefined ? [0, 1] : yDomain)
			.nice()
			.range([innerHeight, 0]);

		const titleFull = `${yLabel} vs % housing growth (TOD analysis)`;
		const scatterTitleLines = splitChartTitle(titleFull, wideLayout ? 58 : 44);
		const titleAnchorX = marginLeft + innerWidth / 2;
		const firstTitleBaseline = 20;
		/** Stacked fit-line legend above chart (default only); wide layout uses an inset instead. */
		const showSelReg = regSelFiltered.length >= 2;
		const regLegendRows = 3 + (showSelReg ? 1 : 0);
		const regLegendRowH = 28;
		const legendBlockH = wideLayout ? 0 : 6 + regLegendRows * regLegendRowH + 4;
		/** Matches the bottom-right WLS inset in ``wideLayout`` (used to stack the size box above it). */
		const regInsetRowH = 21;
		const regInsetH = 14 + (3 + (showSelReg ? 1 : 0)) * regInsetRowH + 10;
		const sizeBoxPad = 8;
		const sizeBoxHWide = sizeBoxPad + 22 + 6 + 30 + 6 + 14 + sizeBoxPad;

		let sizeLegY0;
		let regLegY0;
		let chartOffsetTop;
		if (wideLayout && !storyMode) {
			chartOffsetTop = firstTitleBaseline + scatterTitleLines.length * 16 + 6;
			sizeLegY0 = 0;
			regLegY0 = 0;
		} else {
			sizeLegY0 = firstTitleBaseline + scatterTitleLines.length * 16 + 6;
			const sizeLegendBlockH = 18 + 2 * rMax + 9 + 4;
			regLegY0 = sizeLegY0 + sizeLegendBlockH + 8;
			chartOffsetTop = regLegY0 + legendBlockH;
		}
		const width = marginLeft + innerWidth + legendColW + marginRight;
		/** Size legend is laid out in the top band (default) or above the WLS inset (wide); no extra bottom pad. */
		const height = chartOffsetTop + innerHeight + marginBottom;

		const svg = root
			.append('svg')
			.attr('viewBox', `0 0 ${width} ${height}`)
			.attr('width', '100%')
			.attr('height', 'auto')
			.attr('preserveAspectRatio', 'xMidYMid meet')
			.style('display', 'block');

		const plotTitle = svg
			.append('text')
			.attr('x', titleAnchorX)
			.attr('y', firstTitleBaseline)
			.attr('text-anchor', 'middle')
			.attr('fill', 'var(--text)')
			.attr('font-size', '13px')
			.attr('font-weight', '600');
		scatterTitleLines.forEach((line, i) => {
			const ts = plotTitle.append('tspan').attr('x', titleAnchorX).text(line);
			if (i > 0) ts.attr('dy', '1.15em');
		});

		if (!wideLayout) {
			const sizeY = sizeLegY0;
			const huFmt0 = d3.format(',.0f');
			const sizeG0 = svg.append('g').attr('class', 'tod-intensity-size-legend').attr('pointer-events', 'none');
			const titleX = marginLeft + innerWidth / 2;
			sizeG0
				.append('text')
				.attr('x', titleX)
				.attr('y', sizeY)
				.attr('text-anchor', 'middle')
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '7.5px')
				.attr('font-weight', '600')
				.text('# of Housing Units');
			sizeG0
				.append('text')
				.attr('x', titleX)
				.attr('y', sizeY + 9)
				.attr('text-anchor', 'middle')
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '6.5px')
				.text(`Dot size ∝ (${startY})`);

			const sizeRowY = sizeY + 18;
			const span = Math.min(132, innerWidth - 36);
			const x0s = marginLeft + (innerWidth - span) / 2;
			const cbColX = marginLeft + innerWidth + 12;
			const sizeSamples0 = [
				{ w: wMin, disp: niceHousingUnitsLabel(wMin) },
				{ w: (wMin + wMax) / 2, disp: niceHousingUnitsLabel((wMin + wMax) / 2) },
				{ w: wMax, disp: niceHousingUnitsLabel(wMax) }
			];
			sizeSamples0.forEach((s, i) => {
				const cx = x0s + (i * span) / 2;
				const rr = rScale(s.w);
				sizeG0
					.append('circle')
					.attr('cx', cx)
					.attr('cy', sizeRowY + rr)
					.attr('r', rr)
					.attr('fill', 'color-mix(in srgb, var(--bg-hover) 85%, var(--text-muted))')
					.attr('stroke', 'var(--border)')
					.attr('stroke-width', 0.6);
				sizeG0
					.append('text')
					.attr('x', cx)
					.attr('y', sizeRowY + rr * 2 + 9)
					.attr('text-anchor', 'middle')
					.attr('fill', 'var(--text-muted)')
					.attr('font-size', '6.5px')
					.text(`${huFmt0(s.disp)}`);
			});

			const miniTop = sizeRowY - 2;
			sizeG0
				.append('rect')
				.attr('x', cbColX)
				.attr('y', miniTop)
				.attr('width', 8)
				.attr('height', 8)
				.attr('rx', 2)
				.attr('fill', GREY_MINIMAL);
			sizeG0
				.append('text')
				.attr('x', cbColX + 11)
				.attr('y', miniTop + 7)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '6.5px')
				.text('Minimal dev. (no fit)');
		}

		const slopeFmt = d3.format('.4f');

		/**
		 * @param {number} rowIdx
		 * @param {string} label
		 * @param {{ slope: number, intercept: number, r2?: number }} reg
		 * @param {string} stroke
		 * @param {string | null} dash
		 * @param {number} nPts
		 * @param {d3.Selection<SVGGElement, unknown, null, undefined>} parent
		 * @param {number} x0
		 * @param {number} y0
		 * @param {number} rowH
		 * @param {number} fsTitle
		 * @param {number} fsSub
		 */
		function addRegLegendRow(
			rowIdx,
			label,
			reg,
			stroke,
			dash,
			nPts,
			parent,
			x0,
			y0,
			rowH,
			fsTitle,
			fsSub
		) {
			const lineLen = wideLayout ? 11 : 15;
			const labelX = wideLayout ? 20 : 26;
			const g = parent
				.append('g')
				.attr('transform', `translate(${x0}, ${y0 + rowIdx * rowH})`);
			const ln = g
				.append('line')
				.attr('x1', 0)
				.attr('y1', 5)
				.attr('x2', lineLen)
				.attr('y2', 5)
				.attr('stroke', stroke)
				.attr('stroke-width', wideLayout ? 2 : 2.4)
				.attr('stroke-linecap', 'round');
			if (dash) ln.attr('stroke-dasharray', dash);
			g.append('text')
				.attr('x', labelX)
				.attr('y', 8)
				.attr('fill', 'var(--text)')
				.attr('font-size', `${fsTitle}px`)
				.attr('font-weight', '600')
				.text(label);
			g.append('text')
				.attr('x', labelX)
				.attr('y', 18)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', `${fsSub}px`)
				.text(
					`Slope ${Number.isFinite(reg.slope) ? slopeFmt(reg.slope) : '—'} · R² ${Number.isFinite(reg.r2) ? reg.r2.toFixed(3) : '—'} · n=${nPts}`
				);
		}

		if (!wideLayout) {
			const regLegend = svg.append('g').attr('class', 'tod-intensity-reg-legend').attr('pointer-events', 'none');
			addRegLegendRow(
				0,
				'TOD-dominated tracts',
				wRegTod,
				LINE_TOD,
				null,
				pointsTodDom.length,
				regLegend,
				marginLeft,
				regLegY0,
				regLegendRowH,
				9,
				7.5
			);
			addRegLegendRow(
				1,
				'non-TOD-dominated (sig.)',
				wRegNonTod,
				LINE_NONTOD,
				null,
				pointsNonTodDom.length,
				regLegend,
				marginLeft,
				regLegY0,
				regLegendRowH,
				9,
				7.5
			);
			addRegLegendRow(
				2,
				'All significant tracts',
				wRegAll,
				LINE_ALL,
				'4 3',
				regAll.length,
				regLegend,
				marginLeft,
				regLegY0,
				regLegendRowH,
				9,
				7.5
			);
			if (showSelReg) {
				addRegLegendRow(
					3,
					'Selected tracts',
					wRegSel,
					LINE_SELECTED,
					null,
					selPts.length,
					regLegend,
					marginLeft,
					regLegY0,
					regLegendRowH,
					9,
					7.5
				);
			}
		}

		const chart = svg.append('g').attr('transform', `translate(${marginLeft},${chartOffsetTop})`);

		chart
			.append('g')
			.attr('transform', `translate(0,${innerHeight})`)
			.call(d3.axisBottom(xScale).ticks(8))
			.call((g) => g.selectAll('path,line').attr('stroke', 'var(--border)'))
			.call((g) => g.selectAll('text').attr('fill', 'var(--text-muted)'));

		chart
			.append('g')
			.call(d3.axisLeft(yScale).ticks(8))
			.call((g) => g.selectAll('path,line').attr('stroke', 'var(--border)'))
			.call((g) => g.selectAll('text').attr('fill', 'var(--text-muted)'));

		chart
			.append('text')
			.attr('x', innerWidth / 2)
			.attr('y', innerHeight + 42)
			.attr('text-anchor', 'middle')
			.attr('fill', 'var(--text-muted)')
			.attr('font-size', '12px')
			.text(xLabel);

		chart
			.append('text')
			.attr('transform', 'rotate(-90)')
			.attr('x', -innerHeight / 2)
			.attr('y', -44)
			.attr('text-anchor', 'middle')
			.attr('fill', 'var(--text-muted)')
			.attr('font-size', '12px')
			.text(yLabel);

		const [d0, d1] = xScale.domain();

		const regG = chart.append('g').attr('class', 'tod-intensity-reg').attr('pointer-events', 'none');

		/**
		 * @param {{ slope: number, intercept: number }} regResult
		 * @param {string} stroke
		 * @param {string | null} dash
		 */
		function drawRegLine(regResult, stroke, dash) {
			if (!Number.isFinite(regResult.slope) || !Number.isFinite(regResult.intercept)) return;
			const ln = regG
				.append('line')
				.attr('x1', xScale(d0))
				.attr('y1', yScale(regResult.slope * d0 + regResult.intercept))
				.attr('x2', xScale(d1))
				.attr('y2', yScale(regResult.slope * d1 + regResult.intercept))
				.attr('stroke', stroke)
				.attr('stroke-width', 2.5)
				.attr('stroke-linecap', 'round');
			if (dash) ln.attr('stroke-dasharray', dash);
		}

		drawRegLine(wRegAll, LINE_ALL, '4 3');
		drawRegLine(wRegNonTod, LINE_NONTOD, null);
		drawRegLine(wRegTod, LINE_TOD, null);
		if (showSelReg) drawRegLine(wRegSel, LINE_SELECTED, null);

		const brush = d3
			.brush()
			.extent([
				[0, 0],
				[innerWidth, innerHeight]
			])
			.on('end', (event) => {
				if (!event.selection) return;
				const [[bx0, by0], [bx1, by1]] = event.selection;
				const xMin = Math.min(xScale.invert(bx0), xScale.invert(bx1));
				const xMax = Math.max(xScale.invert(bx0), xScale.invert(bx1));
				const yMin = Math.min(yScale.invert(by0), yScale.invert(by1));
				const yMax = Math.max(yScale.invert(by0), yScale.invert(by1));
				const next = new Set(panelState.selectedTracts);
				let lastInBrush = /** @type {string | null} */ (null);
				for (const d of allPoints) {
					if (d.x >= xMin && d.x <= xMax && d.y >= yMin && d.y <= yMax) {
						next.add(d.tract.gisjoin);
						lastInBrush = d.tract.gisjoin;
					}
				}
				panelState.selectedTracts = next;
				if (lastInBrush != null) panelState.setLastInteracted(lastInBrush);
				brushG.call(brush.move, null);
			});

		const brushG = chart.append('g').attr('class', 'scatter-brush').call(brush);
		brushG.selectAll('.selection').attr('stroke', 'var(--accent)').attr('fill', 'var(--accent)');
		brushG.select('.overlay').attr('cursor', 'crosshair');

		const fmt = d3.format('.2f');
		const huFmt = d3.format(',.0f');

		function bindDotInteractions(selection) {
			selection
				.style('cursor', 'pointer')
				.on('mouseenter', function (event, d) {
					panelState.setHovered(d.tract.gisjoin);
					const name =
						d.tract.county && String(d.tract.county) !== 'County Name'
							? String(d.tract.county)
							: d.tract.gisjoin;
					const lines = [
						{ bold: true, text: name },
						{ bold: false, text: `${xLabel}: ${fmt(d.x)}` },
						{ bold: false, text: `${yLabel}: ${fmt(d.y)}` },
						{ bold: false, text: `HU (${startY}): ${huFmt(d.w)}` },
						{
							bold: false,
							text: `Class: ${d.classification.replace(/_/g, ' ')}`
						}
					];
					if (d.todFraction != null && Number.isFinite(d.todFraction)) {
						lines.push({ bold: false, text: `TOD share: ${d3.format('.0%')(d.todFraction)}` });
					}
					tooltip = { visible: true, x: event.clientX, y: event.clientY, lines };
				})
				.on('mousemove', (event) => {
					tooltip = { ...tooltip, x: event.clientX, y: event.clientY };
				})
				.on('mouseleave', () => {
					panelState.setHovered(null);
					tooltip = { ...tooltip, visible: false };
				})
				.on('click', (event, d) => {
					event.stopPropagation();
					panelState.toggleTract(d.tract.gisjoin);
				});
		}

		// Minimal development (grey) first
		chart
			.append('g')
			.attr('class', 'tod-intensity-minimal')
			.selectAll('circle')
			.data(minimalPts, (d) => d.tract.gisjoin)
			.join('circle')
			.attr('cx', (d) => xScale(d.x))
			.attr('cy', (d) => yScale(d.y))
			.attr('r', (d) => d.dotR ?? 3)
			.attr('fill', GREY_MINIMAL)
			.attr('opacity', 0.45)
			.attr('stroke', (d) => (selectedSet.has(d.tract.gisjoin) ? LINE_SELECTED : 'none'))
			.attr('stroke-width', 1.5)
			.call(bindDotInteractions);

		chart
			.append('g')
			.attr('class', 'tod-intensity-sig')
			.selectAll('circle')
			.data(sigPts, (d) => d.tract.gisjoin)
			.join('circle')
			.attr('cx', (d) => xScale(d.x))
			.attr('cy', (d) => yScale(d.y))
			.attr('r', (d) => d.dotR ?? 4)
			.attr('fill', (d) => colorDiscretizedTod(d.todFraction))
			.attr('opacity', 0.88)
			.attr('stroke', (d) => (selectedSet.has(d.tract.gisjoin) ? LINE_SELECTED : '#475569'))
			.attr('stroke-width', (d) => (selectedSet.has(d.tract.gisjoin) ? 2 : 0.5))
			.call(bindDotInteractions);

		if (wideLayout) {
			/* Same vertical extent as ``regInsetH`` / size box stacking above. */
			const rowH = regInsetRowH;
			const insetH = regInsetH;
			/* Narrower than before (~30% less width) so the plot has more room. */
			const insetW = Math.min(232, innerWidth * 0.4) * 0.7;
			const insetG = chart
				.append('g')
				.attr('class', 'tod-intensity-reg-inset')
				.attr('pointer-events', 'none')
				.attr('transform', `translate(${innerWidth - insetW - 6}, ${innerHeight - insetH - 6})`);
			insetG
				.append('rect')
				.attr('width', insetW)
				.attr('height', insetH)
				.attr('rx', 4)
				.attr('fill', 'var(--bg-card)')
				.attr('fill-opacity', 0.94)
				.attr('stroke', 'var(--border)')
				.attr('stroke-width', 0.75);
			insetG
				.append('text')
				.attr('x', 6)
				.attr('y', 11)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '7px')
				.attr('font-weight', '600')
				.text('Best-fit (weighted)');
			addRegLegendRow(
				0,
				'TOD-dominated',
				wRegTod,
				LINE_TOD,
				null,
				pointsTodDom.length,
				insetG,
				6,
				14,
				rowH,
				7.5,
				6
			);
			addRegLegendRow(
				1,
				'non-TOD (sig.)',
				wRegNonTod,
				LINE_NONTOD,
				null,
				pointsNonTodDom.length,
				insetG,
				6,
				14,
				rowH,
				7.5,
				6
			);
			addRegLegendRow(
				2,
				'All significant',
				wRegAll,
				LINE_ALL,
				'4 3',
				regAll.length,
				insetG,
				6,
				14,
				rowH,
				7.5,
				6
			);
			if (showSelReg) {
				addRegLegendRow(
					3,
					'Selected',
					wRegSel,
					LINE_SELECTED,
					null,
					selPts.length,
					insetG,
					6,
					14,
					rowH,
					7.5,
					6
				);
			}

			/** Dot-size card: inside the plot, above the WLS inset (same right margin as inset); avoids the TOD color column. */
			const wMidWide = (wMin + wMax) / 2;
			const sizeSamplesWide = [
				{ w: wMin, disp: niceHousingUnitsLabel(wMin) },
				{ w: wMidWide, disp: niceHousingUnitsLabel(wMidWide) },
				{ w: wMax, disp: niceHousingUnitsLabel(wMax) }
			];
			const boxPad = sizeBoxPad;
			const sizeBoxW = legendColW;
			const sizeBoxH = sizeBoxHWide;
			const sizeBoxX = innerWidth - sizeBoxW - 6;
			const sizeBoxY = innerHeight - insetH - 6 - 8 - sizeBoxH;
			const sizeGwide = chart
				.append('g')
				.attr('class', 'tod-intensity-size-legend')
				.attr('pointer-events', 'none')
				.attr('transform', `translate(${sizeBoxX},${sizeBoxY})`);
			sizeGwide
				.append('rect')
				.attr('x', 0)
				.attr('y', 0)
				.attr('width', sizeBoxW)
				.attr('height', sizeBoxH)
				.attr('rx', 4)
				.attr('fill', 'var(--bg-card)')
				.attr('fill-opacity', 0.94)
				.attr('stroke', 'var(--border)')
				.attr('stroke-width', 0.75);
			const innerXw = boxPad;
			let tyw = boxPad + 9;
			sizeGwide
				.append('text')
				.attr('x', innerXw)
				.attr('y', tyw)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '7.5px')
				.attr('font-weight', '600')
				.text('Dot size (population)');
			tyw += 11;
			sizeGwide
				.append('text')
				.attr('x', innerXw)
				.attr('y', tyw)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '6.5px')
				.text(`Area ∝ housing units (${startY})`);
			const sizeRowYw = tyw + 8;
			const innerWw = sizeBoxW - 2 * boxPad;
			const colWw = innerWw / 3;
			sizeSamplesWide.forEach((s, i) => {
				const cx = innerXw + colWw * i + colWw / 2;
				const rr = rScale(s.w);
				sizeGwide
					.append('circle')
					.attr('cx', cx)
					.attr('cy', sizeRowYw + rr)
					.attr('r', rr)
					.attr('fill', 'color-mix(in srgb, var(--bg-hover) 85%, var(--text-muted))')
					.attr('stroke', 'var(--border)')
					.attr('stroke-width', 0.6);
				sizeGwide
					.append('text')
					.attr('x', cx)
					.attr('y', sizeRowYw + rr * 2 + 8)
					.attr('text-anchor', 'middle')
					.attr('fill', 'var(--text-muted)')
					.attr('font-size', '6.5px')
					.attr('font-variant-numeric', 'tabular-nums')
					.text(`${huFmt(s.disp)}`);
			});
			const miniYw = sizeRowYw + 36;
			sizeGwide
				.append('rect')
				.attr('x', innerXw)
				.attr('y', miniYw)
				.attr('width', 8)
				.attr('height', 8)
				.attr('rx', 2)
				.attr('fill', GREY_MINIMAL);
			const miniLabelw = sizeGwide
				.append('text')
				.attr('x', innerXw + 12)
				.attr('y', miniYw + 7)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '6.5px');
			miniLabelw.append('tspan').text('Minimal development');
			miniLabelw
				.append('tspan')
				.attr('x', innerXw + 12)
				.attr('dy', '1.1em')
				.text('(grey, no WLS fit)');
		}

		if (!storyMode) {
			const cbG = svg
				.append('g')
				.attr('class', 'tod-intensity-colorbar')
				.attr('transform', `translate(${marginLeft + innerWidth + 12}, ${chartOffsetTop})`)
				.attr('pointer-events', 'none');

			cbG
				.append('text')
				.attr('x', 0)
				.attr('y', -11)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '8px')
				.attr('font-weight', '600')
				.text('TOD share (bins)');

			const swatchH = innerHeight / TOD_COLOR_STEPS.length;
			const swatchW = 11;
			const todLabels = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'];
			TOD_COLOR_STEPS.forEach((color, i) => {
				const y0 = i * swatchH;
				cbG
					.append('rect')
					.attr('x', 0)
					.attr('y', y0)
					.attr('width', swatchW)
					.attr('height', swatchH)
					.attr('fill', color)
					.attr('stroke', 'var(--border)')
					.attr('stroke-width', 0.35);
				cbG
					.append('text')
					.attr('x', swatchW + 6)
					.attr('y', y0 + swatchH / 2)
					.attr('dy', '0.35em')
					.attr('fill', 'var(--text-muted)')
					.attr('font-size', '8px')
					.text(todLabels[i]);
			});

			cbG
				.append('text')
				.attr('x', 0)
				.attr('y', innerHeight + 14)
				.attr('fill', 'var(--accent)')
				.attr('font-size', '7px')
				.text(`TOD cut: ${d3.format('.0%')(cut)}`);
		}

	});

	$effect(() => {
		void panelState.hoveredTract;
		void panelState.selectedTracts;
		if (!containerEl) return;
		const root = d3.select(containerEl);
		const hoveredId = panelState.hoveredTract;
		const selectedSet = panelState.selectedTracts;
		root.selectAll('.tod-intensity-minimal circle, .tod-intensity-sig circle').each(function () {
			const el = d3.select(this);
			const d = el.datum();
			const gj = d?.tract?.gisjoin;
			const h = gj && gj === hoveredId;
			const sel = gj && selectedSet.has(gj);
			el.attr('opacity', h ? 1 : d?.classification === 'minimal' ? 0.45 : 0.88);
			if (d?.classification === 'minimal') {
				el.attr('stroke', sel ? LINE_SELECTED : 'none').attr('stroke-width', sel ? 2 : 0);
			} else {
				el.attr('stroke', sel ? LINE_SELECTED : '#475569').attr('stroke-width', sel ? 2 : 0.5);
			}
		});
	});

	onDestroy(() => {
		if (containerEl) d3.select(containerEl).selectAll('*').remove();
	});
</script>

<div class="tod-intensity-wrap" class:wide={wideLayout}>
	<div class="tod-intensity-toolbar">
		{#if showTrimControl}
			<label class="trim-check">
				<input type="checkbox" bind:checked={panelState.trimOutliers} />
				<span>Trim axes (exclude &gt;10σ on significant tracts)</span>
			</label>
		{/if}
		{#if !storyMode}
			<button
				type="button"
				class="scatter-clear-sel"
				disabled={panelState.selectedTracts.size === 0}
				onclick={clearTractSelection}
				aria-label="Clear selected tracts from the map and charts"
			>
				Clear selection
			</button>
		{/if}
	</div>
	<div bind:this={containerEl} class="tod-intensity-chart"></div>
	{#if tooltip.visible}
		<div
			class="scatter-tooltip"
			style:left="{tooltip.x + 12}px"
			style:top="{tooltip.y + 12}px"
			role="tooltip"
		>
			{#each tooltip.lines as L (L.text)}
				<div class:tooltip-bold={L.bold}>{L.text}</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.tod-intensity-wrap {
		position: relative;
		min-width: 0;
	}

	.tod-intensity-wrap.wide {
		width: 100%;
	}

	.tod-intensity-wrap.wide :global(.tod-intensity-chart svg) {
		max-width: 100%;
	}

	.tod-intensity-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.tod-intensity-toolbar .scatter-clear-sel {
		margin-left: auto;
	}

	.scatter-clear-sel {
		font-size: 0.75rem;
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-card);
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
	}

	.scatter-clear-sel:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}

	.scatter-clear-sel:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.tod-intensity-chart {
		/* 1.5× previous 120px; keeps container floor proportional to taller SVG */
		min-height: 180px;
	}

	.trim-check {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-bottom: 6px;
		cursor: pointer;
	}

	.trim-check input {
		accent-color: var(--accent);
	}

	:global(.scatter-empty) {
		font-size: 0.875rem;
		color: var(--text-muted);
		padding: 12px 0;
	}

	.scatter-tooltip {
		position: fixed;
		z-index: 50;
		pointer-events: none;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 8px 10px;
		font-size: 0.75rem;
		box-shadow: var(--shadow);
		max-width: 280px;
	}

	.tooltip-bold {
		font-weight: 700;
		margin-bottom: 4px;
	}
</style>

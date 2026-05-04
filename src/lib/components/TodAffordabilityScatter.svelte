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
	import { MBTA_BLUE, MBTA_GREEN } from '$lib/utils/mbtaColors.js';

	/** Stock-Δ colour ramp low end: white → ``MBTA_BLUE`` (sequential). */
	const STOCK_COLOR_LO = '#ffffff';

	let {
		panelState,
		domainOverride = null,
		/** Story embeds: keep the chart readable, hide more technical chart chrome. */
		storyMode = false,
		/** When false, hide the trim/selection toolbar (compact embeds, e.g. main story). */
		showTrimControl = true,
		/**
		 * If set, use this Y metric key instead of ``panelState.yVar`` (e.g. playground shows a
		 * single affordability plot while the choropleth uses another Y from the same panel).
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
	const marginRight = 14;
	/** Space for vertical stock-% colorbar. */
	const LEGEND_COL_W = 54;
	const marginBottom = 52;
	const innerWidth = 380;
	/** 70% of prior 340px default for a slightly shorter afford. plot. */
	const innerHeight = 238;

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
			dom: domainOverride?.todAffordability ? 'on' : 'off',
			dx: domainOverride?.todAffordability?.xDomain,
			dy: domainOverride?.todAffordability?.yDomain,
			sel: [...panelState.selectedTracts].sort().join('\t')
		})
	);

	let lastPlotKey = $state('');
	const plotUid = `ta-${Math.random().toString(36).slice(2, 9)}`;

	/** Manual selection (map + scatter); matches ``TodIntensityScatter`` cohort styling. */
	const LINE_SELECTED = '#b91c1c';
	/** Main WLS fit for TOD-dominated tracts: darkened MBTA green (matches ``TodIntensityScatter`` LINE_TOD). */
	const LINE_FIT = d3.interpolateRgb(MBTA_GREEN, '#071a14')(0.24);

	function readableYLabel(yBase, fallback) {
		if (yBase === 'median_income_change_pct') return 'Median income change (%)';
		if (yBase === 'bachelors_pct_change') return "Change in bachelor's degree share (pp)";
		return fallback;
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

		const root = d3.select(containerEl);
		root.selectAll('*').remove();

		const { filteredTracts, tractTodMetrics } = buildTodAnalysisData(
			tractData,
			developments,
			panelState
		);

		const sigThr = panelState.sigDevMinPctStockIncrease ?? 2;
		const todCut = panelState.todFractionCutoff ?? 0.5;

		/** @type {Array<{ tract: object, x: number, y: number, w: number, stockPct: number, dotR?: number }>} */
		const points = [];

		for (const t of filteredTracts) {
			const m = tractTodMetrics.get(t.gisjoin);
			if (!m) continue;
			if (classifyTractDevelopment(m, sigThr, todCut) !== 'tod_dominated') continue;
			const aff = m.todAffordableFraction;
			if (aff == null || !Number.isFinite(aff)) continue;
			const rawY = t[yKey];
			if (rawY == null) continue;
			const yVal = Number(rawY);
			if (!Number.isFinite(yVal)) continue;
			const xVal = aff * 100;
			const w = Math.max(Number(t[huKey]) || 0, 1);
			const stockPct = m.pctStockIncrease;
			points.push({
				tract: t,
				x: xVal,
				y: yVal,
				w,
				stockPct: Number.isFinite(stockPct) ? stockPct : 0
			});
		}

		if (points.length === 0) {
			root
				.append('p')
				.attr('class', 'scatter-empty')
				.text('No TOD-dominated tracts with affordable TOD data for this combination.');
			return;
		}

		const selectedSet = panelState.selectedTracts;
		const selPts = points.filter((p) => selectedSet.has(p.tract.gisjoin));
		const regSelPts = filterPointsTenSigmaMarginals(selPts);
		const wRegSel =
			regSelPts.length >= 2
				? computeWeightedRegression(regSelPts)
				: { slope: NaN, intercept: NaN, r2: 0 };
		const showSelReg = regSelPts.length >= 2;

		const regPts = filterPointsTenSigmaMarginals(points);
		const wls =
			regPts.length >= 2 ? computeWeightedRegression(regPts) : { slope: NaN, intercept: NaN, r2: 0 };
		const lowN = points.length < 10;

		const { startY } = periodCensusBounds(tp);
		const yMeta = meta.yVariables?.find((v) => v.key === yBase);
		const yLabel = readableYLabel(yBase, yMeta?.label ?? yBase);
		const xLabel = 'Affordable share of TOD units (%)';
		const huSrcLabel = panelState.huChangeSource === 'census' ? 'Census' : 'MassBuilds';

		const wAll = points.map((d) => d.w);
		const wMin = d3.min(wAll) ?? 1;
		const wMax = d3.max(wAll) ?? 1;
		const rScale = d3
			.scaleSqrt()
			.domain(wMin === wMax ? [Math.max(wMin * 0.9, 1), wMax * 1.1 + 1] : [wMin, wMax])
			.range([2.5, 5.2]);
		for (const p of points) p.dotR = rScale(p.w);

		let xDomain;
		let yDomain;
		if (domainOverride?.todAffordability?.xDomain) {
			xDomain = domainOverride.todAffordability.xDomain;
			yDomain = domainOverride.todAffordability.yDomain;
		} else if (panelState.trimOutliers && points.length > 2) {
			const xVals = points.map((d) => d.x);
			const yVals = points.map((d) => d.y);
			const xMu = d3.mean(xVals);
			const yMu = d3.mean(yVals);
			const xSd = Math.sqrt(d3.variance(xVals) || 0);
			const ySd = Math.sqrt(d3.variance(yVals) || 0);
			const xIn = xSd > 0 ? xVals.filter((v) => v >= xMu - 10 * xSd && v <= xMu + 10 * xSd) : xVals;
			const yIn = ySd > 0 ? yVals.filter((v) => v >= yMu - 10 * ySd && v <= yMu + 10 * ySd) : yVals;
			xDomain = xIn.length > 0 ? d3.extent(xIn) : d3.extent(xVals);
			yDomain = yIn.length > 0 ? d3.extent(yIn) : d3.extent(yVals);
		} else {
			xDomain = d3.extent(points, (d) => d.x);
			yDomain = d3.extent(points, (d) => d.y);
		}

		const stockVals = points.map((d) => d.stockPct);
		// Colorbar uses a trimmed quantile range so a few extreme stock-Δ tracts do not flatten
		// the ramp; fills clamp to the ends (true values stay in the tooltip).
		const sortedStock = Float64Array.from(stockVals).sort();
		const nStock = sortedStock.length;
		let cDomLo = sortedStock[0] ?? 0;
		let cDomHi = sortedStock[Math.max(0, nStock - 1)] ?? 1;
		if (nStock >= 5) {
			const qLo = d3.quantileSorted(sortedStock, 0.05);
			const qHi = d3.quantileSorted(sortedStock, 0.95);
			if (Number.isFinite(qLo) && Number.isFinite(qHi) && qLo < qHi) {
				cDomLo = qLo;
				cDomHi = qHi;
			}
		}
		if (!Number.isFinite(cDomLo) || !Number.isFinite(cDomHi) || cDomLo >= cDomHi) {
			const cMin = d3.min(stockVals) ?? 0;
			const cMax = d3.max(stockVals) ?? 1;
			cDomLo = cMin;
			cDomHi = cMax === cMin ? cMin + 1e-6 : cMax;
		}
		const cHi = cDomHi === cDomLo ? cDomLo + 1e-6 : cDomHi;
		// Sequential white (low stock Δ) → MBTA blue (high).
		const colorScale = d3
			.scaleSequential(d3.interpolateRgb(STOCK_COLOR_LO, MBTA_BLUE))
			.domain([cDomLo, cHi]);
		const colorForStock = (v) => colorScale(Math.min(cHi, Math.max(cDomLo, v)));

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

		const viewerTitle =
			yBase === 'median_income_change_pct'
				? 'Income change vs affordable share in TOD-heavy tracts'
				: yBase === 'bachelors_pct_change'
					? "Bachelor's degree change vs affordable share in TOD-heavy tracts"
					: `${yLabel} vs affordable share in TOD-heavy tracts`;
		const titleFull = viewerTitle;
		const scatterTitleLines = splitChartTitle(titleFull, 42);
		const titleAnchorX = marginLeft + innerWidth / 2;
		const firstTitleBaseline = 18;
		const regLegendRowH = 28;
		/* Extra vertical space when the selected-tracts WLS caption is shown below the main WLS legend. */
		const regLegendBlockH = regLegendRowH + (lowN ? 12 : 0) + (showSelReg ? 22 : 0) + 4;
		const chartOffsetTop = firstTitleBaseline + scatterTitleLines.length * 16 + regLegendBlockH + 8;
		const width = marginLeft + innerWidth + LEGEND_COL_W + marginRight;
		const height = chartOffsetTop + innerHeight + marginBottom + 44;

		const svg = root
			.append('svg')
			.attr('viewBox', `0 0 ${width} ${height}`)
			.attr('width', '100%')
			.attr('height', 'auto')
			.attr('preserveAspectRatio', 'xMidYMid meet')
			.style('display', 'block');

		const stockSpan = Math.max(1e-9, cHi - cDomLo);
		const gradId = `aff-stock-grad-${plotUid}`;
		const defs = svg.append('defs');
		const lg = defs
			.append('linearGradient')
			.attr('id', gradId)
			.attr('x1', '0%')
			.attr('y1', '100%')
			.attr('x2', '0%')
			.attr('y2', '0%');
		const nGradStops = 14;
		for (let i = 0; i <= nGradStops; i++) {
			const u = i / nGradStops;
			const v = cDomLo + u * stockSpan;
			lg.append('stop')
				.attr('offset', `${u * 100}%`)
				.attr('stop-color', colorScale(v));
		}

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

		const regLegY0 = firstTitleBaseline + scatterTitleLines.length * 16 + 8;
		if (!storyMode) {
			const slopeFmt = d3.format('.4f');
			const wlsLegend = svg.append('g').attr('class', 'tod-aff-wls-legend').attr('pointer-events', 'none');
			const wlsRow = wlsLegend.append('g').attr('transform', `translate(${marginLeft}, ${regLegY0})`);
			wlsRow
				.append('line')
				.attr('x1', 0)
				.attr('y1', 5)
				.attr('x2', 18)
				.attr('y2', 5)
				.attr('stroke', LINE_FIT)
				.attr('stroke-width', 2.4)
				.attr('stroke-linecap', 'round');
			wlsRow
				.append('text')
				.attr('x', 34)
				.attr('y', 8)
				.attr('fill', 'var(--text)')
				.attr('font-size', '9px')
				.attr('font-weight', '600')
				.text('WLS fit (weighted by housing units)');
			wlsRow
				.append('text')
				.attr('x', 34)
				.attr('y', 19)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '7.5px')
				.text(
					`Slope ${Number.isFinite(wls.slope) ? slopeFmt(wls.slope) : '—'} · R² ${Number.isFinite(wls.r2) ? wls.r2.toFixed(3) : '—'} · n=${points.length}`
				);
			if (lowN) {
				wlsLegend
					.append('text')
					.attr('x', marginLeft + 34)
					.attr('y', regLegY0 + 26)
					.attr('fill', 'var(--accent)')
					.attr('font-size', '7px')
					.text('Low sample size — interpret slope cautiously.');
			}

			if (showSelReg) {
				const selLeg = wlsLegend.append('g').attr('transform', `translate(${marginLeft}, ${regLegY0 + (lowN ? 38 : 26)})`);
				selLeg
					.append('line')
					.attr('x1', 0)
					.attr('y1', 5)
					.attr('x2', 18)
					.attr('y2', 5)
					.attr('stroke', LINE_SELECTED)
					.attr('stroke-width', 2.4)
					.attr('stroke-linecap', 'round');
				selLeg
					.append('text')
					.attr('x', 34)
					.attr('y', 8)
					.attr('fill', 'var(--text)')
					.attr('font-size', '9px')
					.attr('font-weight', '600')
					.text('Selected tracts (WLS)');
				selLeg
					.append('text')
					.attr('x', 34)
					.attr('y', 19)
					.attr('fill', 'var(--text-muted)')
					.attr('font-size', '7.5px')
					.text(
						`Slope ${Number.isFinite(wRegSel.slope) ? slopeFmt(wRegSel.slope) : '—'} · R² ${Number.isFinite(wRegSel.r2) ? wRegSel.r2.toFixed(3) : '—'} · n=${selPts.length}`
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

		if (regPts.length >= 2 && Number.isFinite(wls.slope) && Number.isFinite(wls.intercept)) {
			chart
				.append('line')
				.attr('x1', xScale(d0))
				.attr('y1', yScale(wls.slope * d0 + wls.intercept))
				.attr('x2', xScale(d1))
				.attr('y2', yScale(wls.slope * d1 + wls.intercept))
				.attr('stroke', LINE_FIT)
				.attr('stroke-width', 2.5)
				.attr('stroke-linecap', 'round')
				.attr('pointer-events', 'none');
		}

		if (showSelReg && Number.isFinite(wRegSel.slope) && Number.isFinite(wRegSel.intercept)) {
			chart
				.append('line')
				.attr('x1', xScale(d0))
				.attr('y1', yScale(wRegSel.slope * d0 + wRegSel.intercept))
				.attr('x2', xScale(d1))
				.attr('y2', yScale(wRegSel.slope * d1 + wRegSel.intercept))
				.attr('stroke', LINE_SELECTED)
				.attr('stroke-width', 2.5)
				.attr('stroke-linecap', 'round')
				.attr('pointer-events', 'none');
		}

		const fmt = d3.format('.2f');
		const huFmt = d3.format(',.0f');

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
				for (const d of points) {
					if (d.x >= xMin && d.x <= xMax && d.y >= yMin && d.y <= yMax) {
						next.add(d.tract.gisjoin);
						lastInBrush = d.tract.gisjoin;
					}
				}
				panelState.selectedTracts = next;
				if (lastInBrush != null) panelState.setLastInteracted(lastInBrush);
				brushG.call(brush.move, null);
			});

		const brushG = chart.append('g').call(brush);
		brushG.selectAll('.selection').attr('stroke', 'var(--accent)').attr('fill', 'var(--accent)');
		brushG.select('.overlay').attr('cursor', 'crosshair');

		chart
			.append('g')
			.selectAll('circle')
			.data(points, (d) => d.tract.gisjoin)
			.join('circle')
			.attr('class', 'tod-aff-dot')
			.attr('cx', (d) => xScale(d.x))
			.attr('cy', (d) => yScale(d.y))
			.attr('r', (d) => d.dotR ?? 4)
			.attr('fill', (d) => colorForStock(d.stockPct))
			.attr('opacity', 0.92)
			.attr('stroke', (d) => (selectedSet.has(d.tract.gisjoin) ? LINE_SELECTED : '#1e293b'))
			.attr('stroke-width', (d) => (selectedSet.has(d.tract.gisjoin) ? 2 : 0.35))
			.style('cursor', 'pointer')
			.on('mouseenter', function (event, d) {
				panelState.setHovered(d.tract.gisjoin);
				const name =
					d.tract.county && String(d.tract.county) !== 'County Name'
						? String(d.tract.county)
						: d.tract.gisjoin;
				tooltip = {
					visible: true,
					x: event.clientX,
					y: event.clientY,
					lines: [
						{ bold: true, text: name },
						{ bold: false, text: `${xLabel}: ${fmt(d.x)}%` },
						{ bold: false, text: `${yLabel}: ${fmt(d.y)}` },
						{ bold: false, text: `Stock increase (${huSrcLabel}): ${fmt(d.stockPct)}%` },
						{ bold: false, text: `HU (${startY}): ${huFmt(d.w)}` }
					]
				};
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

		if (!storyMode) {
			const cbW = 11;
			const cbG = svg
				.append('g')
				.attr('class', 'tod-aff-colorbar')
				.attr('transform', `translate(${marginLeft + innerWidth + 12}, ${chartOffsetTop})`)
				.attr('pointer-events', 'none');

			cbG
				.append('text')
				.attr('x', 0)
				.attr('y', -11)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '8px')
				.attr('font-weight', '600')
				.text('Stock Δ (colour)');

			cbG
				.append('rect')
				.attr('x', 0)
				.attr('y', 0)
				.attr('width', cbW)
				.attr('height', innerHeight)
				.attr('rx', 2)
				.attr('fill', `url(#${gradId})`)
				.attr('stroke', 'var(--border)')
				.attr('stroke-width', 0.5);

			const stockAxis = d3.scaleLinear().domain([cDomLo, cHi]).range([innerHeight, 0]);
			cbG
				.append('g')
				.attr('transform', `translate(${cbW + 4}, 0)`)
				.call(
					d3
						.axisRight(stockAxis)
						.ticks(5)
						.tickFormat((d) => `${d3.format('.0f')(d)}%`)
				)
				.call((g) => g.selectAll('path,line').attr('stroke', 'var(--border)'))
				.call((g) => g.selectAll('text').attr('fill', 'var(--text-muted)').attr('font-size', '8px'));

			cbG
				.append('text')
				.attr('x', 0)
				.attr('y', innerHeight + 14)
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '7px')
				.text(`(${huSrcLabel})`);

			const sizeY = chartOffsetTop + innerHeight + 48;
			const sizeG = svg.append('g').attr('class', 'tod-aff-size-legend').attr('pointer-events', 'none');

			const wMid = (wMin + wMax) / 2;
			const sizeSamples = [
				{ w: wMin, disp: niceHousingUnitsLabel(wMin) },
				{ w: wMid, disp: niceHousingUnitsLabel(wMid) },
				{ w: wMax, disp: niceHousingUnitsLabel(wMax) }
			];
			const titleX = marginLeft + innerWidth / 2;
			sizeG
				.append('text')
				.attr('x', titleX)
				.attr('y', sizeY)
				.attr('text-anchor', 'middle')
				.attr('fill', 'var(--text-muted)')
				.attr('font-size', '7.5px')
				.attr('font-weight', '600')
				.text('# of Housing Units');
			sizeG
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
			sizeSamples.forEach((s, i) => {
				const cx = x0s + (i * span) / 2;
				const rr = rScale(s.w);
				sizeG
					.append('circle')
					.attr('cx', cx)
					.attr('cy', sizeRowY + rr)
					.attr('r', rr)
					.attr('fill', 'color-mix(in srgb, var(--bg-hover) 85%, var(--text-muted))')
					.attr('stroke', 'var(--border)')
					.attr('stroke-width', 0.6);
				sizeG
					.append('text')
					.attr('x', cx)
					.attr('y', sizeRowY + rr * 2 + 9)
					.attr('text-anchor', 'middle')
					.attr('fill', 'var(--text-muted)')
					.attr('font-size', '6.5px')
					.text(`${huFmt(s.disp)}`);
			});
		}
	});

	$effect(() => {
		void panelState.hoveredTract;
		void panelState.selectedTracts;
		if (!containerEl) return;
		const root = d3.select(containerEl);
		const hoveredId = panelState.hoveredTract;
		const selectedSet = panelState.selectedTracts;
		root.selectAll('.tod-aff-dot').each(function () {
			const el = d3.select(this);
			const d = el.datum();
			const gj = d?.tract?.gisjoin;
			const h = gj && gj === hoveredId;
			const sel = gj && selectedSet.has(gj);
			el.attr('opacity', h ? 1 : 0.92);
			el.attr('stroke', sel ? LINE_SELECTED : '#1e293b').attr('stroke-width', sel ? 2 : 0.35);
		});
	});

	onDestroy(() => {
		if (containerEl) d3.select(containerEl).selectAll('*').remove();
	});
</script>

<div class="tod-aff-wrap">
	{#if showTrimControl}
		<div class="tod-aff-toolbar">
			<label class="trim-check">
				<input type="checkbox" bind:checked={panelState.trimOutliers} />
				<span>Trim axes (exclude &gt;10σ)</span>
			</label>
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
	{/if}
	<div bind:this={containerEl} class="tod-aff-chart"></div>
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
	.tod-aff-wrap {
		position: relative;
		min-width: 0;
	}

	.tod-aff-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.tod-aff-toolbar .scatter-clear-sel {
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

	.tod-aff-chart {
		min-height: 100px;
	}

	.trim-check {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.75rem;
		color: var(--text-muted);
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

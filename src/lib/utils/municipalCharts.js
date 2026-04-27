/**
 * Municipal D3 chart render functions — extracted from static/municipal/index.html.
 *
 * Each function accepts an explicit DOM element, data arrays, a state object,
 * and (where needed) a callbacks object ``{ onSelectionChange }`` so the
 * Svelte caller can trigger a reactive redraw.
 */
import * as d3 from 'd3';
import { normalize } from './municipalModel.js';
import { createMapZoomLayer } from './mapZoom.js';

/* ── Shared constants & helpers ──────────────────────── */

const fmtInt = d3.format(',');
const fmtPct = d3.format('.0%');
const fmtPct1 = d3.format('.1%');
const incomePalette = ['#edf4ff', '#bfd6f6', '#6fa8dc', '#2f6ea6', '#003da5'];
const affordableColor = d3
	.scaleThreshold()
	.domain([0.05, 0.1, 0.2, 0.35])
	.range(incomePalette);

export function makeTooltip(root) {
	return root.append('div').attr('class', 'tooltip');
}

export function positionTooltip(root, tooltip, event) {
	const rect = root.node().getBoundingClientRect();
	let x = event.clientX - rect.left + 14;
	let y = event.clientY - rect.top + 14;
	const node = tooltip.node();
	if (node) {
		const tw = node.offsetWidth || 0;
		const th = node.offsetHeight || 0;
		if (x + tw > rect.width - 10) x = Math.max(8, x - tw - 28);
		if (y + th > rect.height - 10) y = Math.max(8, y - th - 28);
	}
	tooltip.style('left', `${x}px`).style('top', `${y}px`);
}

export function addHtmlLegend(root, items) {
	const legend = root.append('div').attr('class', 'legend').style('margin-bottom', '10px');
	items.forEach((item) => {
		const entry = legend.append('span').attr('class', 'legend-item');
		if (item.type === 'line') {
			entry
				.append('span')
				.style('width', '18px')
				.style('height', '0')
				.style('border-top', `3px solid ${item.color}`)
				.style('display', 'inline-block');
		} else if (item.type === 'outline') {
			entry
				.append('span')
				.style('width', '12px')
				.style('height', '12px')
				.style('border-radius', '999px')
				.style('border', `2px solid ${item.color}`)
				.style('background', item.fill || 'transparent')
				.style('display', 'inline-block');
		} else {
			entry.append('span').attr('class', 'swatch').style('background', item.color || '#999');
		}
		entry.append('span').text(item.label);
	});
	return legend;
}

export function addRampLegend(root, labelLeft, labelRight, colors) {
	const legend = root.append('div').attr('class', 'legend').style('margin-bottom', '10px');
	const scale = legend.append('span').attr('class', 'legend-scale');
	scale.append('span').text(labelLeft);
	const ramp = scale.append('span').attr('class', 'legend-ramp');
	colors.forEach((color) => ramp.append('span').style('background', color));
	scale.append('span').text(labelRight);
	return legend;
}

export function linearRegression(points) {
	const valid = points.filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y));
	if (valid.length < 2) return null;
	const meanX = d3.mean(valid, (d) => d.x);
	const meanY = d3.mean(valid, (d) => d.y);
	const numerator = d3.sum(valid, (d) => (d.x - meanX) * (d.y - meanY));
	const denominator = d3.sum(valid, (d) => (d.x - meanX) ** 2);
	if (!denominator) return null;
	const slope = numerator / denominator;
	const intercept = meanY - slope * meanX;
	return { slope, intercept };
}

function buildNiceSizeLegendValues(maxValue) {
	if (!Number.isFinite(maxValue) || maxValue <= 0) return [100, 500, 1000];
	const rough = [0.25, 0.6, 1].map((p) => maxValue * p);
	return rough.map((value) => {
		if (value <= 100) return Math.max(10, Math.round(value / 10) * 10);
		if (value <= 500) return Math.max(50, Math.round(value / 50) * 50);
		if (value <= 2000) return Math.max(100, Math.round(value / 100) * 100);
		return Math.max(500, Math.round(value / 500) * 500);
	});
}

/* ── Summary updater ─────────────────────────────────── */

/**
 * Return computed summary values (no DOM writes — let Svelte bind them).
 */
export function computeMuniSummary(visibleRows, active, projectRows, state) {
	const units = d3.sum(projectRows, (d) => d.units);
	const affordableUnits = d3.sum(projectRows, (d) => d.affordableUnits);
	const todUnits = d3.sum(
		projectRows.filter((d) => d.hasDistance && d.distance <= state.threshold),
		(d) => d.units
	);
	const selection = active.length ? active : visibleRows;
	const avgIncome = d3.mean(selection, (d) => d.under125) || 0;
	const avgAffordable =
		d3.sum(selection, (d) => d.affordableUnits) /
		Math.max(1, d3.sum(selection, (d) => d.units));
	const todDominantCount = selection.filter((d) => d.dominant === 'tod').length;
	return {
		muniCount: visibleRows.length,
		totalUnits: Math.round(units),
		affordableShare: units ? affordableUnits / units : 0,
		todShare: units ? todUnits / units : 0,
		avgIncome,
		avgAffordable,
		todDominantCount,
		selectionCount: selection.length
	};
}

/* ── Scatter ─────────────────────────────────────────── */

export function renderMuniScatter(el, allRows, domainRows, state, callbacks) {
	const root = d3.select(el);
	root.selectAll('*').remove();
	if (!allRows.length) {
		root.append('div').attr('class', 'empty').text('No municipalities match the current filters.');
		return;
	}

	const visibleTotalUnits = Math.max(1, d3.sum(allRows, (d) => d.units));
	const domainTotalUnits = Math.max(1, d3.sum(domainRows, (d) => d.units));
	const yAccessor =
		state.growthScale === 'share'
			? (d) => (d.units / visibleTotalUnits) * 100
			: (d) => d.units;
	const yDomainAccessor =
		state.growthScale === 'share'
			? (d) => (d.units / domainTotalUnits) * 100
			: (d) => d.units;
	const yLabel =
		state.growthScale === 'share'
			? 'Share of visible-window growth (%)'
			: 'New units added in selected years';

	const width = root.node().clientWidth || 800;
	const height = 460;
	const margin = { top: 20, right: 20, bottom: 54, left: 66 };
	const innerW = width - margin.left - margin.right;
	const innerH = height - margin.top - margin.bottom;
	const unitValues = domainRows.map(yDomainAccessor).filter(Number.isFinite).sort(d3.ascending);
	const affordableValues = domainRows
		.map((d) => d.affordableUnits)
		.filter(Number.isFinite)
		.sort(d3.ascending);
	const yMax =
		state.growthScale === 'share'
			? 100
			: Math.max(1, d3.quantile(unitValues, 0.98) || d3.max(unitValues) || 1);
	const rMax = Math.max(
		1,
		d3.quantile(affordableValues, 0.98) || d3.max(affordableValues) || 1
	);

	const x = d3
		.scaleLinear()
		.domain(d3.extent(domainRows, (d) => d.under125))
		.nice()
		.range([0, innerW]);
	const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]).clamp(true);
	const r = d3.scaleSqrt().domain([0, rMax]).range([5, 22]).clamp(true);
	const sizeLegendVals = [...new Set(buildNiceSizeLegendValues(rMax))];

	const sizeLegend = root
		.append('div')
		.attr('class', 'chart-note')
		.style('display', 'flex')
		.style('align-items', 'center')
		.style('gap', '16px')
		.style('flex-wrap', 'wrap')
		.style('margin-top', '4px')
		.style('margin-bottom', '10px');

	sizeLegend.append('span').style('font-weight', '600').text('Point size = affordable units added');
	const sizeItems = sizeLegend.append('div').style('display', 'flex').style('gap', '18px').style('align-items', 'flex-end');
	for (const v of sizeLegendVals) {
		const item = sizeItems.append('div').style('display', 'grid').style('justify-items', 'center').style('gap', '4px');
		item
			.append('span')
			.style('display', 'inline-block')
			.style('width', `${Math.max(8, r(v) * 2)}px`)
			.style('height', `${Math.max(8, r(v) * 2)}px`)
			.style('border-radius', '999px')
			.style('background', '#9fb6d8')
			.style('border', '2px solid #5e6573');
		item.append('span').text(d3.format(',.0f')(v));
	}

	const dominantLegend = addHtmlLegend(root, [
		{ type: 'outline', color: 'var(--accent)', fill: '#ffffff', label: 'TOD-dominant municipality' },
		{ type: 'outline', color: 'var(--warning)', fill: '#ffffff', label: 'Non-TOD-dominant municipality' },
		{ type: 'outline', color: '#b7b0a3', fill: '#ffffff', label: 'No units yet in current window' }
	]);
	addRampLegend(root, 'Lower affordable share', 'Higher affordable share', incomePalette);

	root
		.append('div')
		.attr('class', 'chart-note')
		.style('margin-bottom', '10px')
		.text(
			state.growthScale === 'share'
				? 'The dashed gray lines mark the regional averages on each axis. Use them to see which municipalities sit above or below the typical lower-income share and the typical share of visible-window growth.'
				: `The dashed gray lines mark the regional averages on each axis. The chart is zoomed to the main municipal range through about ${d3.format(',.0f')(yMax)} units.`
		);

	const svg = root.append('svg').attr('viewBox', `0 0 ${width} ${height}`);
	const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

	const tooltip = makeTooltip(root);

	g.append('g')
		.attr('transform', `translate(0,${innerH})`)
		.call(d3.axisBottom(x).ticks(6).tickFormat((d) => `${d}%`));
	g.append('g')
		.call(
			d3
				.axisLeft(y)
				.ticks(6)
				.tickFormat(state.growthScale === 'share' ? (d) => `${d}%` : d3.format('~s'))
		);

	g.append('text')
		.attr('x', innerW / 2)
		.attr('y', innerH + 42)
		.attr('text-anchor', 'middle')
		.attr('fill', '#5e6573')
		.text('Households under $125k');
	g.append('text')
		.attr('transform', 'rotate(-90)')
		.attr('x', -innerH / 2)
		.attr('y', -46)
		.attr('text-anchor', 'middle')
		.attr('fill', '#5e6573')
		.text(yLabel);

	const avgX = d3.mean(domainRows, (d) => d.under125) || 0;
	const avgY = d3.mean(domainRows, yDomainAccessor) || 0;
	g.append('line')
		.attr('x1', x(avgX)).attr('x2', x(avgX))
		.attr('y1', 0).attr('y2', innerH)
		.attr('stroke', '#b7b0a3').attr('stroke-dasharray', '5 4');
	g.append('line')
		.attr('x1', 0).attr('x2', innerW)
		.attr('y1', y(avgY)).attr('y2', y(avgY))
		.attr('stroke', '#b7b0a3').attr('stroke-dasharray', '5 4');

	if (state.showTrendline) {
		const regression = linearRegression(allRows.map((d) => ({ x: d.under125, y: yAccessor(d) })));
		if (regression) {
			const xDomain = x.domain();
			const trendPoints = xDomain.map((xVal) => ({
				x: xVal,
				y: regression.slope * xVal + regression.intercept
			}));
			const trendLine = d3
				.line()
				.x((d) => x(d.x))
				.y((d) => y(Math.max(0, Math.min(yMax, d.y))));

			g.append('path')
				.datum(trendPoints)
				.attr('fill', 'none')
				.attr('stroke', '#374151')
				.attr('stroke-width', 2)
				.attr('stroke-dasharray', '8 5')
				.attr('opacity', 0.8)
				.attr('d', trendLine);

			g.append('text')
				.attr('x', innerW - 8)
				.attr('y', 16)
				.attr('text-anchor', 'end')
				.attr('fill', '#374151')
				.attr('font-size', 11)
				.attr('font-weight', 700)
				.text('Best-fit trend');
		}
	}

	g.selectAll('circle')
		.data(allRows, (d) => d.municipality)
		.join('circle')
		.attr('cx', (d) => x(d.under125))
		.attr('cy', (d) => y(yAccessor(d)))
		.attr('r', (d) => r(d.affordableUnits))
		.attr('fill', (d) => affordableColor(d.affordableShare))
		.attr('fill-opacity', (d) =>
			state.selected.size && !state.selected.has(d.municipality) ? 0.28 : 0.9
		)
		.attr('stroke', (d) =>
			d.dominant === 'tod'
				? 'var(--accent)'
				: d.dominant === 'nonTod'
					? 'var(--warning)'
					: '#b7b0a3'
		)
		.attr('stroke-width', (d) => (state.selected.has(d.municipality) ? 3.4 : 2.3))
		.style('cursor', 'pointer')
		.on('click', (event, d) => {
			event.stopPropagation();
			if (state.selected.has(d.municipality)) state.selected.delete(d.municipality);
			else state.selected.add(d.municipality);
			callbacks.onSelectionChange();
		})
		.on('mouseenter', function (event, d) {
			d3.select(this).attr('stroke-width', 3);
			tooltip
				.style('opacity', 1)
				.html(
					`<strong>${d.municipality}</strong><br/>` +
						`Households under $125k: ${d.under125.toFixed(1)}%<br/>` +
						`New units: ${fmtInt(Math.round(d.units))}<br/>` +
						`${state.growthScale === 'share' ? `Share of visible-window growth: ${((d.units / visibleTotalUnits) * 100).toFixed(1)}%<br/>` : ''}` +
						`Affordable share: ${fmtPct1(d.affordableShare)}<br/>` +
						`TOD share: ${fmtPct1(d.todShare)}<br/>` +
						`Zoning profile: ${d.zoningBin}`
				);
			positionTooltip(root, tooltip, event);
		})
		.on('mousemove', (event) => positionTooltip(root, tooltip, event))
		.on('mouseleave', function () {
			d3.select(this).attr('stroke-width', (d) =>
				state.selected.has(d.municipality) ? 3.4 : 2.3
			);
			tooltip.style('opacity', 0);
		});

	// Callout annotations
	const calloutCandidates = [
		{
			label: 'High vulnerability + high growth',
			row: allRows
				.filter((d) => d.under125 >= avgX && yAccessor(d) >= avgY)
				.sort((a, b) => d3.descending(a.units, b.units))[0],
			dx: 12,
			dy: -14
		},
		{
			label: 'Higher-income capture',
			row: allRows
				.filter((d) => d.under125 < avgX && yAccessor(d) >= avgY)
				.sort((a, b) => d3.descending(a.units, b.units))[0],
			dx: -12,
			dy: -16
		},
		{
			label: 'High vulnerability, low affordability',
			row: allRows
				.filter((d) => d.under125 >= avgX && d.units > 0)
				.sort((a, b) =>
					d3.descending(
						(a.under125 / 100) * a.units * (1 - a.affordableShare),
						(b.under125 / 100) * b.units * (1 - b.affordableShare)
					)
				)[0],
			dx: 12,
			dy: 20
		}
	].filter((d) => d.row);

	const usedNames = new Set();
	calloutCandidates.forEach((callout) => {
		if (usedNames.has(callout.row.municipality)) return;
		usedNames.add(callout.row.municipality);
		const cx = x(callout.row.under125);
		const cy = y(yAccessor(callout.row));
		const labelX = Math.max(54, Math.min(innerW - 54, cx + callout.dx));
		const labelY = Math.max(18, Math.min(innerH - 10, cy + callout.dy));

		g.append('line')
			.attr('x1', cx).attr('x2', labelX)
			.attr('y1', cy).attr('y2', labelY)
			.attr('stroke', '#6b7280')
			.attr('stroke-width', 1.1)
			.attr('stroke-dasharray', '3 3');

		g.append('text')
			.attr('x', labelX + (callout.dx < 0 ? -2 : 2))
			.attr('y', labelY - 4)
			.attr('text-anchor', callout.dx < 0 ? 'end' : 'start')
			.attr('fill', '#374151')
			.attr('font-size', 11)
			.attr('font-weight', 700)
			.text(callout.row.municipality);

		g.append('text')
			.attr('x', labelX + (callout.dx < 0 ? -2 : 2))
			.attr('y', labelY + 10)
			.attr('text-anchor', callout.dx < 0 ? 'end' : 'start')
			.attr('fill', '#6b7280')
			.attr('font-size', 10)
			.text(callout.label);
	});

	svg.on('click', () => {
		state.selected.clear();
		callbacks.onSelectionChange();
	});
}

/* ── Choropleth ──────────────────────────────────────── */

export function renderMuniChoropleth(el, allRows, domainRows, muniGeo, state, callbacks) {
	const root = d3.select(el);
	root.selectAll('*').remove();
	if (!muniGeo?.features?.length || !allRows.length) {
		root.append('div').attr('class', 'empty').text('No municipal map data available.');
		return;
	}

	const width = root.node().clientWidth || 520;
	const height = 340;
	const metricConfig = {
		units: { label: 'New units in current window', get: (d) => d.units, fmt: d3.format(',.0f') },
		affordableUnits: { label: 'Affordable units in current window', get: (d) => d.affordableUnits, fmt: d3.format(',.0f') },
		under125: { label: 'Households under $125k', get: (d) => d.under125 / 100, fmt: d3.format('.0%') },
		high125: { label: 'Households $125k+', get: (d) => d.high125 / 100, fmt: d3.format('.0%') },
		affordableShare: { label: 'Affordable share', get: (d) => d.affordableShare, fmt: d3.format('.0%') },
		todShare: { label: 'TOD share of units', get: (d) => d.todShare, fmt: d3.format('.0%') }
	}[state.mapMetric];

	const byMunicipality = new Map(allRows.map((d) => [normalize(d.municipality), d]));
	const domainValues = domainRows.map(metricConfig.get).filter(Number.isFinite).sort(d3.ascending);
	const colorDomain =
		state.mapMetric === 'affordableShare' || state.mapMetric === 'todShare'
			? [0, 1]
			: [0, d3.quantile(domainValues, 0.98) || d3.max(domainValues) || 1];
	const color = d3.scaleQuantize().domain(colorDomain).range(incomePalette);

	const mapLegend = addRampLegend(root, 'Lower', `Higher ${metricConfig.label.toLowerCase()}`, incomePalette);
	mapLegend
		.append('span')
		.attr('class', 'legend-item')
		.html('<span class="swatch" style="background:#e7e0d5;"></span>No visible data');

	const projection = d3.geoIdentity().reflectY(true).fitSize([width, height], muniGeo);
	const path = d3.geoPath(projection);
	const svg = root
		.append('svg')
		.attr('viewBox', `0 0 ${width} ${height}`)
		.attr('width', '100%')
		.attr('height', 'auto')
		.attr('preserveAspectRatio', 'xMidYMid meet')
		.style('display', 'block')
		.style('touch-action', 'none');
	const zoomLayer = createMapZoomLayer(svg, width, height, { maxScale: 20 });
	const tooltip = makeTooltip(root);

	zoomLayer
		.selectAll('path')
		.data(muniGeo.features)
		.join('path')
		.attr('vector-effect', 'non-scaling-stroke')
		.attr('d', path)
		.transition()
		.duration(250)
		.attr('fill', (d) => {
			const row = byMunicipality.get(
				normalize(d.properties?.municipal || d.properties?.municipality || '')
			);
			return row ? color(metricConfig.get(row)) : '#e7e0d5';
		})
		.selection()
		.attr('stroke', (d) => {
			const muni = normalize(d.properties?.municipal || d.properties?.municipality || '');
			const row = byMunicipality.get(muni);
			return row && state.selected.has(row.municipality) ? '#111827' : '#f8f4ed';
		})
		.attr('stroke-width', (d) => {
			const muni = normalize(d.properties?.municipal || d.properties?.municipality || '');
			const row = byMunicipality.get(muni);
			return row && state.selected.has(row.municipality) ? 2.4 : 1;
		})
		.style('cursor', 'pointer')
		.on('click', (event, d) => {
			event.stopPropagation();
			const row = byMunicipality.get(
				normalize(d.properties?.municipal || d.properties?.municipality || '')
			);
			if (!row) return;
			if (state.selected.has(row.municipality)) state.selected.delete(row.municipality);
			else state.selected.add(row.municipality);
			callbacks.onSelectionChange();
		})
		.on('mouseenter', (event, d) => {
			const row = byMunicipality.get(
				normalize(d.properties?.municipal || d.properties?.municipality || '')
			);
			if (!row) return;
			tooltip
				.style('opacity', 1)
				.html(
					`<strong>${row.municipality}</strong><br/>` +
						`${metricConfig.label}: ${metricConfig.fmt(metricConfig.get(row))}<br/>` +
						`Households under $125k: ${row.under125.toFixed(1)}%<br/>` +
						`Affordable share: ${fmtPct1(row.affordableShare)}`
				);
			positionTooltip(root, tooltip, event);
		})
		.on('mousemove', (event) => positionTooltip(root, tooltip, event))
		.on('mouseleave', () => tooltip.style('opacity', 0));

	svg.on('click', () => {
		state.selected.clear();
		callbacks.onSelectionChange();
	});

	root
		.append('p')
		.attr('class', 'mpc-map-zoom-hint')
		.text('Scroll or pinch to zoom · drag to pan · double-click to reset');
}

/* ── Timeline ────────────────────────────────────────── */

export function renderMuniTimeline(el, projectRows, state) {
	const root = d3.select(el);
	root.selectAll('*').remove();
	if (!projectRows.length) {
		root.append('div').attr('class', 'empty').text('Select a municipality or change filters to see yearly production.');
		return;
	}

	addHtmlLegend(root, [
		{ color: '#d5b08c', label: 'New units by year' },
		{ type: 'line', color: '#17316f', label: 'Affordable share' }
	]);

	const series = d3.range(state.yearStart, state.yearEnd + 1).map((year) => {
		const rows = projectRows.filter((d) => d.year === year);
		const units = d3.sum(rows, (d) => d.units);
		const affordableUnits = d3.sum(rows, (d) => d.affordableUnits);
		return { year, units, affordableShare: units ? affordableUnits / units : 0 };
	});

	const width = root.node().clientWidth || 520;
	const height = 340;
	const margin = { top: 18, right: 46, bottom: 40, left: 50 };
	const innerW = width - margin.left - margin.right;
	const innerH = height - margin.top - margin.bottom;
	const svg = root.append('svg').attr('viewBox', `0 0 ${width} ${height}`);
	const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

	const x = d3.scaleBand().domain(series.map((d) => d.year)).range([0, innerW]).padding(0.18);
	const yScale = d3.scaleLinear().domain([0, d3.max(series, (d) => d.units) || 1]).nice().range([innerH, 0]);
	const y2 = d3.scaleLinear().domain([0, Math.max(0.35, d3.max(series, (d) => d.affordableShare) || 0)]).nice().range([innerH, 0]);

	g.append('g')
		.attr('transform', `translate(0,${innerH})`)
		.call(
			d3
				.axisBottom(x)
				.tickValues(
					series
						.filter((_, i) => i % Math.max(1, Math.ceil(series.length / 7)) === 0)
						.map((d) => d.year)
				)
		);
	g.append('g').call(d3.axisLeft(yScale).ticks(5).tickFormat(d3.format('~s')));
	g.append('g')
		.attr('transform', `translate(${innerW},0)`)
		.call(d3.axisRight(y2).ticks(4).tickFormat(d3.format('.0%')));

	g.selectAll('rect')
		.data(series)
		.join('rect')
		.attr('x', (d) => x(d.year))
		.attr('y', (d) => yScale(d.units))
		.attr('width', x.bandwidth())
		.attr('height', (d) => innerH - yScale(d.units))
		.attr('fill', '#d5b08c');

	const line = d3
		.line()
		.x((d) => x(d.year) + x.bandwidth() / 2)
		.y((d) => y2(d.affordableShare));
	g.append('path')
		.datum(series)
		.attr('fill', 'none')
		.attr('stroke', '#17316f')
		.attr('stroke-width', 2.5)
		.attr('d', line);
}

/* ── Composition (TOD vs non-TOD) ────────────────────── */

export function renderMuniComposition(el, projectRows, state) {
	const root = d3.select(el);
	root.selectAll('*').remove();
	if (!projectRows.length) {
		root.append('div').attr('class', 'empty').text('Change filters to see TOD vs non-TOD composition over time.');
		return;
	}

	addHtmlLegend(root, [
		{ color: 'var(--accent)', label: 'TOD units' },
		{ color: 'var(--warning)', label: 'Non-TOD units' }
	]);

	const series = d3.range(state.yearStart, state.yearEnd + 1).map((year) => {
		const rows = projectRows.filter((d) => d.year === year);
		const todUnits = d3.sum(
			rows.filter((d) => d.hasDistance && d.distance <= state.threshold),
			(d) => d.units
		);
		const total = d3.sum(rows, (d) => d.units);
		return {
			year,
			todShare: total ? todUnits / total : 0,
			nonTodShare: total ? 1 - todUnits / total : 0,
			total
		};
	});

	const latest = [...series].reverse().find((d) => d.total > 0);
	if (latest) {
		root
			.append('div')
			.attr('class', 'chart-note')
			.style('margin-bottom', '8px')
			.text(
				`${latest.year}: ${d3.format('.0%')(latest.todShare)} TOD / ${d3.format('.0%')(latest.nonTodShare)} non-TOD`
			);
	}

	const width = root.node().clientWidth || 520;
	const height = 340;
	const margin = { top: 18, right: 20, bottom: 40, left: 52 };
	const innerW = width - margin.left - margin.right;
	const innerH = height - margin.top - margin.bottom;
	const svg = root.append('svg').attr('viewBox', `0 0 ${width} ${height}`);
	const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
	const x = d3.scaleBand().domain(series.map((d) => d.year)).range([0, innerW]).padding(0.16);
	const yScale = d3.scaleLinear().domain([0, 1]).range([innerH, 0]);

	g.append('g')
		.attr('transform', `translate(0,${innerH})`)
		.call(
			d3
				.axisBottom(x)
				.tickValues(
					series
						.filter((_, i) => i % Math.max(1, Math.ceil(series.length / 7)) === 0)
						.map((d) => d.year)
				)
		);
	g.append('g').call(d3.axisLeft(yScale).ticks(5).tickFormat(d3.format('.0%')));

	const bars = g
		.selectAll('.composition-year')
		.data(series)
		.join('g')
		.attr('class', 'composition-year')
		.attr('transform', (d) => `translate(${x(d.year)},0)`);

	bars
		.append('rect')
		.attr('x', 0)
		.attr('y', (d) => yScale(d.todShare))
		.attr('width', x.bandwidth())
		.attr('height', (d) => yScale(0) - yScale(d.todShare))
		.attr('fill', 'var(--accent)')
		.attr('rx', 4);

	bars
		.append('rect')
		.attr('x', 0)
		.attr('y', (d) => yScale(1))
		.attr('width', x.bandwidth())
		.attr('height', (d) => yScale(d.todShare) - yScale(1))
		.attr('fill', 'var(--warning)')
		.attr('rx', 4);
}

/* ── Ranked growth ───────────────────────────────────── */

export function renderMuniRankedGrowth(el, allRows) {
	const root = d3.select(el);
	root.selectAll('*').remove();
	const rows = allRows
		.filter((d) => d.units > 0)
		.sort((a, b) => d3.descending(a.units, b.units))
		.slice(0, 8);

	if (!rows.length) {
		root.append('div').attr('class', 'empty').text('No municipal growth to rank in the current window.');
		return;
	}

	addRampLegend(root, 'Lower affordable share', 'Higher affordable share', incomePalette);

	const width = root.node().clientWidth || 720;
	const height = 340;
	const margin = { top: 16, right: 54, bottom: 30, left: 128 };
	const innerW = width - margin.left - margin.right;
	const innerH = height - margin.top - margin.bottom;
	const svg = root.append('svg').attr('viewBox', `0 0 ${width} ${height}`);
	const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
	const yBand = d3.scaleBand().domain(rows.map((d) => d.municipality)).range([0, innerH]).padding(0.22);
	const x = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.units) || 1]).nice().range([0, innerW]);

	g.append('g').call(d3.axisLeft(yBand).tickSize(0));
	g.append('g')
		.attr('transform', `translate(0,${innerH})`)
		.call(d3.axisBottom(x).ticks(5).tickFormat(d3.format('~s')));

	g.selectAll('rect')
		.data(rows)
		.join('rect')
		.attr('x', 0)
		.attr('y', (d) => yBand(d.municipality))
		.attr('width', (d) => x(d.units))
		.attr('height', yBand.bandwidth())
		.attr('rx', 6)
		.attr('fill', (d) => affordableColor(d.affordableShare))
		.attr('stroke', (d) => (d.dominant === 'tod' ? 'var(--accent)' : 'var(--warning)'))
		.attr('stroke-width', 1.6);

	g.selectAll('text.value')
		.data(rows)
		.join('text')
		.attr('class', 'value')
		.attr('x', (d) => x(d.units) + 8)
		.attr('y', (d) => yBand(d.municipality) + yBand.bandwidth() / 2 + 4)
		.attr('fill', '#4b5563')
		.attr('font-size', 10)
		.text((d) => `${fmtInt(Math.round(d.units))} units`);
}

/* ── Affordability composition ───────────────────────── */

export function renderMuniAffordabilityComposition(el, projectRows, state) {
	const root = d3.select(el);
	root.selectAll('*').remove();
	if (!projectRows.length) {
		root.append('div').attr('class', 'empty').text('Change filters to see affordable vs market-rate composition over time.');
		return;
	}

	addHtmlLegend(root, [
		{ color: '#17316f', label: 'Affordable units' },
		{ color: '#d5b08c', label: 'Market-rate units' }
	]);

	const series = d3.range(state.yearStart, state.yearEnd + 1).map((year) => {
		const rows = projectRows.filter((d) => d.year === year);
		const total = d3.sum(rows, (d) => d.units);
		const affordableUnits = d3.sum(rows, (d) => d.affordableUnits);
		return {
			year,
			affordableShare: total ? affordableUnits / total : 0,
			marketShare: total ? 1 - affordableUnits / total : 0,
			total
		};
	});

	const latest = [...series].reverse().find((d) => d.total > 0);
	if (latest) {
		root
			.append('div')
			.attr('class', 'chart-note')
			.style('margin-bottom', '8px')
			.text(
				`${latest.year}: ${d3.format('.0%')(latest.affordableShare)} affordable / ${d3.format('.0%')(latest.marketShare)} market-rate`
			);
	}

	const width = root.node().clientWidth || 720;
	const height = 340;
	const margin = { top: 18, right: 20, bottom: 40, left: 52 };
	const innerW = width - margin.left - margin.right;
	const innerH = height - margin.top - margin.bottom;
	const svg = root.append('svg').attr('viewBox', `0 0 ${width} ${height}`);
	const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
	const x = d3.scaleBand().domain(series.map((d) => d.year)).range([0, innerW]).padding(0.16);
	const yScale = d3.scaleLinear().domain([0, 1]).range([innerH, 0]);

	g.append('g')
		.attr('transform', `translate(0,${innerH})`)
		.call(
			d3
				.axisBottom(x)
				.tickValues(
					series
						.filter((_, i) => i % Math.max(1, Math.ceil(series.length / 7)) === 0)
						.map((d) => d.year)
				)
		);
	g.append('g').call(d3.axisLeft(yScale).ticks(5).tickFormat(d3.format('.0%')));

	const bars = g
		.selectAll('.afford-year')
		.data(series)
		.join('g')
		.attr('class', 'afford-year')
		.attr('transform', (d) => `translate(${x(d.year)},0)`);

	bars
		.append('rect')
		.attr('x', 0)
		.attr('y', (d) => yScale(d.affordableShare))
		.attr('width', x.bandwidth())
		.attr('height', (d) => yScale(0) - yScale(d.affordableShare))
		.attr('fill', '#17316f')
		.attr('rx', 4);

	bars
		.append('rect')
		.attr('x', 0)
		.attr('y', (d) => yScale(1))
		.attr('width', x.bandwidth())
		.attr('height', (d) => yScale(d.affordableShare) - yScale(1))
		.attr('fill', '#d5b08c')
		.attr('rx', 4);
}

export function renderMuniAffordableTrend(el, projectRows, state) {
	const root = d3.select(el);
	root.selectAll('*').remove();
	if (!projectRows.length) {
		root.append('div').attr('class', 'empty').text('Change filters to see affordable-share trends over time.');
		return;
	}

	const baseSeries = d3.range(state.yearStart, state.yearEnd + 1).map((year) => {
		const rows = projectRows.filter((d) => d.year === year);
		const total = d3.sum(rows, (d) => d.units);
		const affordableUnits = d3.sum(rows, (d) => d.affordableUnits);
		return {
			year,
			total,
			affordableShare: total ? affordableUnits / total : 0
		};
	});

	const series = baseSeries.map((d, i, arr) => {
		const window = arr.slice(Math.max(0, i - 1), Math.min(arr.length, i + 2)).filter((v) => v.total > 0);
		return {
			...d,
			smoothedShare: window.length ? d3.mean(window, (v) => v.affordableShare) : d.affordableShare
		};
	});

	const latest = [...series].reverse().find((d) => d.total > 0);
	if (latest) {
		root
			.append('div')
			.attr('class', 'chart-note')
			.style('margin-bottom', '8px')
			.text(`${latest.year}: ${d3.format('.0%')(latest.affordableShare)} of new units are listed as affordable`);
	}

	const width = root.node().clientWidth || 720;
	const height = 320;
	const margin = { top: 18, right: 28, bottom: 40, left: 54 };
	const innerW = width - margin.left - margin.right;
	const innerH = height - margin.top - margin.bottom;
	const svg = root.append('svg').attr('viewBox', `0 0 ${width} ${height}`);
	const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
	const x = d3.scaleLinear().domain(d3.extent(series, (d) => d.year)).range([0, innerW]);
	const yMax = Math.max(0.4, d3.max(series, (d) => d.smoothedShare || 0) || 0.4);
	const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]);

	g.append('line')
		.attr('x1', 0)
		.attr('x2', innerW)
		.attr('y1', y(0.2))
		.attr('y2', y(0.2))
		.attr('stroke', '#b8b2a7')
		.attr('stroke-width', 1.2)
		.attr('stroke-dasharray', '5 4');

	g.append('text')
		.attr('x', innerW)
		.attr('y', y(0.2) - 8)
		.attr('text-anchor', 'end')
		.attr('fill', '#6b7280')
		.attr('font-size', 11)
		.text('20% reference line');

	g.append('g')
		.attr('transform', `translate(0,${innerH})`)
		.call(d3.axisBottom(x).ticks(6).tickFormat(d3.format('d')));

	g.append('g')
		.call(d3.axisLeft(y).ticks(5).tickFormat(d3.format('.0%')));

	const area = d3
		.area()
		.x((d) => x(d.year))
		.y0(innerH)
		.y1((d) => y(d.smoothedShare))
		.curve(d3.curveMonotoneX);

	const line = d3
		.line()
		.x((d) => x(d.year))
		.y((d) => y(d.smoothedShare))
		.curve(d3.curveMonotoneX);

	g.append('path')
		.datum(series)
		.attr('fill', '#d9d7f8')
		.attr('opacity', 0.8)
		.attr('d', area);

	g.append('path')
		.datum(series)
		.attr('fill', 'none')
		.attr('stroke', '#6f58c9')
		.attr('stroke-width', 3)
		.attr('d', line);

	g.selectAll('.afford-dot')
		.data(series.filter((d) => d.total > 0))
		.join('circle')
		.attr('class', 'afford-dot')
		.attr('cx', (d) => x(d.year))
		.attr('cy', (d) => y(d.affordableShare))
		.attr('r', 3.25)
		.attr('fill', '#6f58c9')
		.attr('opacity', 0.45);

	if (latest) {
		g.append('circle')
			.attr('cx', x(latest.year))
			.attr('cy', y(latest.smoothedShare))
			.attr('r', 5)
			.attr('fill', '#6f58c9');

		g.append('text')
			.attr('x', x(latest.year))
			.attr('y', y(latest.smoothedShare) - 12)
			.attr('text-anchor', 'middle')
			.attr('fill', '#1f2430')
			.attr('font-size', 11)
			.attr('font-weight', 700)
			.text(d3.format('.0%')(latest.affordableShare));
	}
}

/* ── Growth capture ──────────────────────────────────── */

export function renderMuniGrowthCapture(el, projectRows, domainRows, state) {
	const root = d3.select(el);
	root.selectAll('*').remove();
	if (!projectRows.length || !domainRows.length) {
		root.append('div').attr('class', 'empty').text('Change filters to compare where growth is landing.');
		return;
	}

	const vulnerabilityMedian = d3.median(domainRows, (d) => d.under125) || 0;
	const highVulnerability = new Set(
		domainRows.filter((d) => d.under125 >= vulnerabilityMedian).map((d) => d.municipality)
	);
	const totalUnits = d3.sum(projectRows, (d) => d.units) || 0;
	const highUnits = d3.sum(
		projectRows.filter((d) => highVulnerability.has(d.municipality)),
		(d) => d.units
	);
	const lowUnits = Math.max(0, totalUnits - highUnits);
	const highShare = totalUnits ? highUnits / totalUnits : 0;
	const lowShare = totalUnits ? lowUnits / totalUnits : 0;

	root
		.append('div')
		.attr('class', 'chart-note')
		.style('margin-bottom', '8px')
		.text(
			`${fmtPct(highShare)} of selected-period units landed in higher-vulnerability municipalities, versus ${fmtPct(lowShare)} in lower-vulnerability municipalities.`
		);

	addHtmlLegend(root, [
		{ color: 'var(--accent)', label: 'Higher-vulnerability municipalities' },
		{ color: 'var(--blue-5)', label: 'Lower-vulnerability municipalities' }
	]);

	const width = Math.max(320, root.node().clientWidth || 520);
	const height = 320;
	const margin = { top: 18, right: 20, bottom: 30, left: 20 };
	const innerW = width - margin.left - margin.right;
	const innerH = height - margin.top - margin.bottom;
	const svg = root.append('svg').attr('viewBox', `0 0 ${width} ${height}`);
	const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
	const cols = 10;
	const rows = 10;
	const cell = Math.min(innerW / cols, innerH / rows);
	const dotR = Math.max(8, Math.min(13, cell * 0.34));
	const gridW = cell * cols;
	const gridH = cell * rows;
	const offsetX = (innerW - gridW) / 2;
	const offsetY = 14;
	const highDots = Math.round(highShare * 100);
	const dots = d3.range(100).map((i) => ({
		i,
		group: i < highDots ? 'high' : 'low',
		col: i % cols,
		row: rows - 1 - Math.floor(i / cols)
	}));

	g.selectAll('.growth-capture-dot')
		.data(dots)
		.join('circle')
		.attr('class', 'growth-capture-dot')
		.attr('cx', (d) => offsetX + d.col * cell + cell / 2)
		.attr('cy', (d) => offsetY + d.row * cell + cell / 2)
		.attr('r', dotR)
		.attr('fill', (d) => (d.group === 'high' ? 'var(--accent)' : 'var(--blue-5)'))
		.attr('opacity', 0.95)
		.append('title')
		.text((d) =>
			d.group === 'high'
				? 'Unit share: higher-vulnerability municipality'
				: 'Unit share: lower-vulnerability municipality'
		);

	g.append('text')
		.attr('x', innerW * 0.25)
		.attr('y', offsetY + gridH + 22)
		.attr('text-anchor', 'middle')
		.attr('fill', 'var(--accent)')
		.attr('font-size', 14)
		.attr('font-weight', 700)
		.text(`${fmtPct(highShare)} high-vulnerability`);

	g.append('text')
		.attr('x', innerW * 0.75)
		.attr('y', offsetY + gridH + 22)
		.attr('text-anchor', 'middle')
		.attr('fill', 'var(--blue-5)')
		.attr('font-size', 14)
		.attr('font-weight', 700)
		.text(`${fmtPct(lowShare)} lower-vulnerability`);
}

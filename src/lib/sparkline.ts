/**
 * SVG sparkline generator (server-rendered, no client JS).
 * Returns an SVG string ready to embed.
 */
export function sparkline(
  points: [string, number][],
  opts: { width?: number; height?: number; stroke?: string; fill?: string; showDots?: boolean } = {}
): string {
  const { width = 90, height = 28, stroke = '#658246', fill = '#84a06433', showDots = false } = opts;
  if (!points || points.length < 2) {
    return `<svg viewBox="0 0 ${width} ${height}" class="inline-block"><text x="${width/2}" y="${height/2}" text-anchor="middle" font-size="9" fill="#aaa">—</text></svg>`;
  }
  const xs = points.map((_, i) => i);
  const ys = points.map(p => p[1]);
  const xMin = 0, xMax = Math.max(1, xs[xs.length - 1]);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yRange = yMax - yMin || 1;
  const pad = 2;
  const sx = (x: number) => pad + (x - xMin) / (xMax - xMin || 1) * (width - pad * 2);
  const sy = (y: number) => height - pad - (y - yMin) / yRange * (height - pad * 2);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(xs[i]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  const area = `${path} L${sx(xs[xs.length - 1]).toFixed(1)},${(height - pad).toFixed(1)} L${sx(xs[0]).toFixed(1)},${(height - pad).toFixed(1)} Z`;

  const dots = showDots ? points.map((p, i) => `<circle cx="${sx(xs[i]).toFixed(1)}" cy="${sy(p[1]).toFixed(1)}" r="1.5" fill="${stroke}"/>`).join('') : '';

  return `<svg viewBox="0 0 ${width} ${height}" class="inline-block align-middle">
    <path d="${area}" fill="${fill}" stroke="none"/>
    <path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;
}

/** Full curve with axis, labels, and dots — for /animales/[id] */
export function bigChart(
  points: [string, number][],
  opts: { width?: number; height?: number } = {}
): string {
  const { width = 720, height = 280 } = opts;
  if (!points || points.length < 2) return `<div class="text-stone-400 text-sm">No hay suficientes pesajes</div>`;

  const padL = 48, padR = 16, padT = 16, padB = 36;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const ts = points.map(p => +new Date(p[0]));
  const ys = points.map(p => p[1]);
  const tMin = Math.min(...ts), tMax = Math.max(...ts);
  const yMin = Math.floor(Math.min(...ys) - 5);
  const yMax = Math.ceil(Math.max(...ys) + 5);
  const sx = (t: number) => padL + (t - tMin) / (tMax - tMin || 1) * innerW;
  const sy = (y: number) => padT + (1 - (y - yMin) / (yMax - yMin || 1)) * innerH;

  // y-axis ticks
  const yTicks = 4;
  const yLines: string[] = [];
  const yLabels: string[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const y = yMin + (yMax - yMin) * i / yTicks;
    const py = sy(y);
    yLines.push(`<line x1="${padL}" y1="${py.toFixed(1)}" x2="${width - padR}" y2="${py.toFixed(1)}" stroke="#e7e5e4" stroke-width="1"/>`);
    yLabels.push(`<text x="${padL - 6}" y="${(py + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#78716c">${Math.round(y)}</text>`);
  }
  // x-axis labels: first and last
  const fmt = (t: number) => {
    const d = new Date(t);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
  };

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(+new Date(p[0])).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  const area = `${path} L${sx(tMax).toFixed(1)},${(padT + innerH).toFixed(1)} L${sx(tMin).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  const dots = points.map(p => {
    const x = sx(+new Date(p[0])).toFixed(1);
    const y = sy(p[1]).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="3" fill="#658246" stroke="white" stroke-width="1.5"><title>${fmt(+new Date(p[0]))} · ${p[1]} kg</title></circle>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" class="w-full h-auto">
    ${yLines.join('')}
    ${yLabels.join('')}
    <path d="${area}" fill="#84a06433"/>
    <path d="${path}" fill="none" stroke="#658246" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
    <text x="${padL}" y="${height - 10}" font-size="10" fill="#78716c">${fmt(tMin)}</text>
    <text x="${width - padR}" y="${height - 10}" text-anchor="end" font-size="10" fill="#78716c">${fmt(tMax)}</text>
    <text x="${padL - 38}" y="${padT + innerH/2}" font-size="10" fill="#78716c" transform="rotate(-90 ${padL - 38} ${padT + innerH/2})" text-anchor="middle">peso (kg)</text>
  </svg>`;
}

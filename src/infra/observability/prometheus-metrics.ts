import type { Labels, Metrics } from '../../domain/contracts';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

function key(labels: Labels | undefined): string {
  if (labels === undefined) return '';
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
}

export class PrometheusMetrics implements Metrics {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();

  increment(name: string, labels?: Labels, value = 1): void {
    const series = this.series(this.counters, name);
    const k = key(labels);
    series.set(k, (series.get(k) ?? 0) + value);
  }

  setGauge(name: string, value: number, labels?: Labels): void {
    this.series(this.gauges, name).set(key(labels), value);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const series = this.series(this.histograms, name);
    const k = key(labels);
    const h = series.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((bound, i) => {
      if (value <= bound) h.buckets[i] = (h.buckets[i] ?? 0) + 1;
    });
    h.sum += value;
    h.count += 1;
    series.set(k, h);
  }

  counter(name: string, labels?: Labels): number {
    const series = this.counters.get(name);
    if (series === undefined) return 0;
    const wanted = Object.entries(labels ?? {}).map(([k, v]) => `${k}="${v}"`);
    let total = 0;
    for (const [k, v] of series) {
      if (wanted.every((w) => k.includes(w))) total += v;
    }
    return total;
  }

  render(): string {
    const lines: string[] = [];
    const fmt = (name: string, k: string, v: number) => `${name}${k ? `{${k}}` : ''} ${v}`;
    for (const [name, series] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [k, v] of series) lines.push(fmt(name, k, v));
    }
    for (const [name, series] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [k, v] of series) lines.push(fmt(name, k, v));
    }
    for (const [name, series] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [k, h] of series) {
        const prefix = k ? `${k},` : '';
        BUCKETS.forEach((bound, i) => lines.push(`${name}_bucket{${prefix}le="${bound}"} ${h.buckets[i] ?? 0}`));
        lines.push(`${name}_bucket{${prefix}le="+Inf"} ${h.count}`);
        lines.push(fmt(`${name}_sum`, k, h.sum));
        lines.push(fmt(`${name}_count`, k, h.count));
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private series<T>(store: Map<string, Map<string, T>>, name: string): Map<string, T> {
    let series = store.get(name);
    if (series === undefined) {
      series = new Map();
      store.set(name, series);
    }
    return series;
  }
}

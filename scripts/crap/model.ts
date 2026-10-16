export type CoverageUnit = {
  start: number;
  end: number;
  line?: number;
  count: number;
};

export type FunctionMetric = {
  id: string;
  name: string;
  file: string;
  start: number;
  end: number;
  complexity: number;
  coverage: number;
  crap: number;
  executableStatements: number;
  coveredStatements: number;
  fingerprint: string;
  identity: string;
};

export function crapScore(complexity: number, coverage: number): number {
  const bounded = Math.max(0, Math.min(1, coverage));
  return complexity ** 2 * (1 - bounded) ** 3 + complexity;
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

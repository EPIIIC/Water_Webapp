import { Matrix, SingularValueDecomposition } from 'ml-matrix';

export function checkSignalQuality(signalWindow: Float64Array | number[], fs: number): boolean {
  const N = signalWindow.length;
  
  // Calculate autocorr[0] for signal energy
  let autocorr0 = 0;
  for (let i = 0; i < N; i++) {
    autocorr0 += signalWindow[i] * signalWindow[i];
  }

  const minLag = Math.floor(fs * 60.0 / 220.0); // Max HR 220 bpm
  const maxLag = Math.floor(fs * 60.0 / 40.0);  // Min HR 40 bpm

  let maxPeakVal = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < N; lag++) {
    let sum = 0;
    for (let i = 0; i < N - lag; i++) {
      sum += signalWindow[i] * signalWindow[i + lag];
    }
    if (sum > maxPeakVal) {
      maxPeakVal = sum;
    }
  }

  // Valid if the peak in the HR range is at least 10% of the signal energy
  return maxPeakVal > 0.1 * autocorr0;
}

export function musicHrEstimation(signalWindow: Float64Array | number[], fs: number, p = 27): number {
  const N = signalWindow.length;
  if (N <= p) return NaN;

  const cols = N - p + 1;
  const X = new Matrix(p, cols);
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < cols; j++) {
      X.set(i, j, signalWindow[i + j]);
    }
  }

  const XT = X.transpose();
  const R = X.mmul(XT).mul(1 / (N - p));

  const svd = new SingularValueDecomposition(R);
  const U = svd.leftSingularVectors;

  const Un = U.subMatrix(0, p - 1, 2, p - 1);
  const Un_rows = p;
  const Un_cols = Un.columns;
  
  // Extract to flat Float64Array for fast access
  const Un_arr = new Float64Array(Un_rows * Un_cols);
  for (let r = 0; r < Un_rows; r++) {
    for (let c = 0; c < Un_cols; c++) {
      Un_arr[r * Un_cols + c] = Un.get(r, c);
    }
  }

  let maxPseudo = -Infinity;
  let peakIdx = -1;
  const numFreqs = 200;
  const freqs = new Float64Array(numFreqs);
  for (let i = 0; i < numFreqs; i++) {
    freqs[i] = 0.5 + (3.66 - 0.5) * i / (numFreqs - 1);
  }

  // Pre-calculate cos and sin
  const cosTheta = new Float64Array(numFreqs * p);
  const sinTheta = new Float64Array(numFreqs * p);
  for (let f = 0; f < numFreqs; f++) {
    for (let k = 0; k < p; k++) {
      const theta = 2 * Math.PI * freqs[f] * k / fs;
      const idx = f * p + k;
      cosTheta[idx] = Math.cos(theta);
      sinTheta[idx] = Math.sin(theta);
    }
  }

  for (let f = 0; f < numFreqs; f++) {
    let den_f = 0;
    const f_offset = f * p;
    for (let col = 0; col < Un_cols; col++) {
      let proj_real = 0;
      let proj_imag = 0;
      for (let k = 0; k < p; k++) {
        const un_val = Un_arr[k * Un_cols + col];
        const idx = f_offset + k;
        proj_real += cosTheta[idx] * un_val;
        proj_imag -= sinTheta[idx] * un_val;
      }
      den_f += proj_real * proj_real + proj_imag * proj_imag;
    }
    const pseudo = 1.0 / (den_f + 1e-10);
    if (pseudo > maxPseudo) {
      maxPseudo = pseudo;
      peakIdx = f;
    }
  }

  return freqs[peakIdx] * 60.0;
}

export function detrend(signal: Float64Array | number[]): Float64Array {
  const N = signal.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < N; i++) {
    sumX += i;
    sumY += signal[i];
    sumXY += i * signal[i];
    sumXX += i * i;
  }
  const m = (N * sumXY - sumX * sumY) / (N * sumXX - sumX * sumX);
  const c = (sumY - m * sumX) / N;

  const detrended = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    detrended[i] = signal[i] - (m * i + c);
  }
  return detrended;
}

export function std(signal: Float64Array | number[]): number {
  const N = signal.length;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += signal[i];
  const mean = sum / N;
  let sumSq = 0;
  for (let i = 0; i < N; i++) sumSq += Math.pow(signal[i] - mean, 2);
  return Math.sqrt(sumSq / N);
}

export function mean(signal: Float64Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i];
  return sum / signal.length;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

type PulseIntervalSeries = {
  intervalsMs: number[];
  valid: boolean[];
  artifactRatio: number;
  coverageSeconds: number;
};

export type PpgRmssdQuality = 'initial' | 'stabilizing' | 'stable';

export type PpgRmssdResult = {
  rmssdMs: number;
  validIntervalCount: number;
  successivePairCount: number;
  coverageSeconds: number;
  artifactRatio: number;
  quality: PpgRmssdQuality;
};

function detectPulseFiducials(
  signal: Float64Array | number[],
  timeSeconds: Float64Array | number[],
  fs: number,
  polarity: 1 | -1,
): number[] {
  const n = signal.length;
  const slope = new Float64Array(n);
  const slopeValues = new Array<number>(Math.max(0, n - 2));

  for (let i = 1; i < n - 1; i++) {
    const value = polarity * (signal[i + 1] - signal[i - 1]) * 0.5;
    slope[i] = value;
    slopeValues[i - 1] = value;
  }

  const slopeMedian = median(slopeValues);
  const absoluteDeviations = slopeValues.map(value => Math.abs(value - slopeMedian));
  const robustSigma = 1.4826 * median(absoluteDeviations);
  if (!Number.isFinite(robustSigma) || robustSigma <= 0) return [];

  // A robust, amplitude-independent threshold. The refractory interval below
  // removes secondary PPG features such as the dicrotic notch.
  const threshold = slopeMedian + 0.5 * robustSigma;
  const minDistanceSamples = Math.max(1, Math.floor(fs * 60 / 220));
  const candidates: { index: number; strength: number }[] = [];

  for (let i = 2; i < n - 2; i++) {
    const value = slope[i];
    if (value < threshold || value <= slope[i - 1] || value < slope[i + 1]) continue;

    const last = candidates[candidates.length - 1];
    if (last && i - last.index < minDistanceSamples) {
      if (value > last.strength) candidates[candidates.length - 1] = { index: i, strength: value };
    } else {
      candidates.push({ index: i, strength: value });
    }
  }

  return candidates.map(({ index }) => {
    // Parabolic interpolation reduces the 10 ms quantisation error at 100 Hz.
    const y1 = slope[index - 1];
    const y2 = slope[index];
    const y3 = slope[index + 1];
    const denominator = y1 - 2 * y2 + y3;
    const offsetSamples = denominator === 0
      ? 0
      : Math.max(-0.5, Math.min(0.5, 0.5 * (y1 - y3) / denominator));
    return timeSeconds[index] + offsetSamples / fs;
  });
}

function evaluatePulseIntervals(fiducials: number[]): PulseIntervalSeries | null {
  if (fiducials.length < 3) return null;

  const intervalsMs = new Array<number>(fiducials.length - 1);
  const physiological = new Array<boolean>(intervalsMs.length);
  const minIntervalMs = 60_000 / 220;
  const maxIntervalMs = 60_000 / 40;

  for (let i = 0; i < intervalsMs.length; i++) {
    const interval = (fiducials[i + 1] - fiducials[i]) * 1000;
    intervalsMs[i] = interval;
    physiological[i] = interval >= minIntervalMs && interval <= maxIntervalMs;
  }

  const valid = new Array<boolean>(intervalsMs.length).fill(false);
  for (let i = 0; i < intervalsMs.length; i++) {
    if (!physiological[i]) continue;

    const local = intervalsMs
      .slice(Math.max(0, i - 5), Math.min(intervalsMs.length, i + 6))
      .filter((_, localIndex) => physiological[Math.max(0, i - 5) + localIndex]);
    const localMedian = median(local);
    const localMad = median(local.map(value => Math.abs(value - localMedian)));
    const localIqr = quantile(local, 0.75) - quantile(local, 0.25);
    // IQR keeps legitimate alternating respiratory variation from being
    // rejected when MAD collapses to zero, while isolated peak-detection
    // errors still fall outside the local distribution.
    const toleranceMs = Math.max(0.2 * localMedian, 3 * 1.4826 * localMad, 1.5 * localIqr);
    valid[i] = Math.abs(intervalsMs[i] - localMedian) <= toleranceMs;
  }

  const validCount = valid.filter(Boolean).length;
  return {
    intervalsMs,
    valid,
    artifactRatio: 1 - validCount / intervalsMs.length,
    coverageSeconds: fiducials[fiducials.length - 1] - fiducials[0],
  };
}

/**
 * Estimates ultra-short, PPG-derived pulse-rate variability using RMSSD.
 *
 * RMSSD = sqrt(mean((NN[i + 1] - NN[i])^2)).
 *
 * PPG pulse intervals are not ECG R-R intervals, so this result is a PRV
 * surrogate. The function intentionally returns null instead of a number when
 * the record is incomplete or contains enough gaps/artifacts to bias RMSSD.
 */
export function ppgRmssdAnalysis(
  signalWindow: Float64Array | number[],
  timeSeconds: Float64Array | number[],
  fs: number,
): PpgRmssdResult | null {
  if (signalWindow.length !== timeSeconds.length) return null;

  let firstFiniteIndex = 0;
  while (
    firstFiniteIndex < signalWindow.length &&
    (!Number.isFinite(signalWindow[firstFiniteIndex]) || !Number.isFinite(timeSeconds[firstFiniteIndex]))
  ) {
    firstFiniteIndex++;
  }

  const signal = Array.from(signalWindow).slice(firstFiniteIndex);
  const time = Array.from(timeSeconds).slice(firstFiniteIndex);
  const n = signal.length;
  if (n < 3) return null;

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(signal[i]) || !Number.isFinite(time[i])) return null;
  }

  const observedDuration = time[n - 1] - time[0];
  const expectedDuration = (n - 1) / fs;
  if (observedDuration <= 0) return null;

  const missingFraction = Math.max(0, observedDuration - expectedDuration) / observedDuration;
  if (missingFraction > 0.05) return null;
  if (!checkSignalQuality(signal, fs)) return null;

  const positive = evaluatePulseIntervals(detectPulseFiducials(signal, time, fs, 1));
  const negative = evaluatePulseIntervals(detectPulseFiducials(signal, time, fs, -1));
  const candidates = [positive, negative].filter((candidate): candidate is PulseIntervalSeries => candidate !== null);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.artifactRatio !== b.artifactRatio) return a.artifactRatio - b.artifactRatio;
    return b.coverageSeconds - a.coverageSeconds;
  });
  const best = candidates[0];

  // RMSSD becomes mathematically available once three valid pulse fiducials
  // provide two consecutive intervals. Keep physiological/artifact screening,
  // but do not delay an otherwise computable value.
  const validIntervalCount = best.valid.filter(Boolean).length;
  if (validIntervalCount < 2 || best.artifactRatio > 0.2) return null;

  let squaredDifferenceSum = 0;
  let successivePairCount = 0;
  for (let i = 1; i < best.intervalsMs.length; i++) {
    if (!best.valid[i - 1] || !best.valid[i]) continue;
    const difference = best.intervalsMs[i] - best.intervalsMs[i - 1];
    squaredDifferenceSum += difference * difference;
    successivePairCount++;
  }

  if (successivePairCount < 1) return null;
  const rmssd = Math.sqrt(squaredDifferenceSum / successivePairCount);
  if (!Number.isFinite(rmssd)) return null;

  const quality: PpgRmssdQuality = best.coverageSeconds < 10
    ? 'initial'
    : best.coverageSeconds < 25 || best.artifactRatio > 0.1
      ? 'stabilizing'
      : 'stable';

  return {
    rmssdMs: rmssd,
    validIntervalCount,
    successivePairCount,
    coverageSeconds: best.coverageSeconds,
    artifactRatio: best.artifactRatio,
    quality,
  };
}

export function ppgRmssdEstimation(
  signalWindow: Float64Array | number[],
  timeSeconds: Float64Array | number[],
  fs: number,
): number | null {
  return ppgRmssdAnalysis(signalWindow, timeSeconds, fs)?.rmssdMs ?? null;
}

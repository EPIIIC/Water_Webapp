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

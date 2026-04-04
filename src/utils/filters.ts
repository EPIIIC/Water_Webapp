import Fili from 'fili';

export class FilterChain {
  hpFilter: any = null;
  lpFilter: any = null;
  hpCutoff: number | null;
  lpCutoff: number | null;
  fs: number;
  order: number;

  constructor(hpCutoff: number | null, lpCutoff: number | null, fs: number = 100, order: number = 2) {
    this.hpCutoff = hpCutoff;
    this.lpCutoff = lpCutoff;
    this.fs = fs;
    this.order = order;
    
    const iirCalculator = new Fili.CalcCascades();
    
    if (hpCutoff !== null) {
      const hpCoefs = iirCalculator.highpass({
        order: order,
        characteristic: 'butterworth',
        Fs: fs,
        Fc: hpCutoff
      });
      this.hpFilter = new Fili.IirFilter(hpCoefs);
    }
    
    if (lpCutoff !== null) {
      const lpCoefs = iirCalculator.lowpass({
        order: order,
        characteristic: 'butterworth',
        Fs: fs,
        Fc: lpCutoff
      });
      this.lpFilter = new Fili.IirFilter(lpCoefs);
    }
  }

  process(chunk: number[] | Float64Array): number[] {
    let result = Array.from(chunk);
    if (this.hpFilter) {
      result = this.hpFilter.multiStep(result);
    }
    if (this.lpFilter) {
      result = this.lpFilter.multiStep(result);
    }
    return result;
  }
}

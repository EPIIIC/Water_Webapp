declare module 'fili' {
  export class CalcCascades {
    highpass(params: any): any;
    lowpass(params: any): any;
  }
  export class IirFilter {
    constructor(coefs: any);
    multiStep(data: number[] | Float64Array): number[];
  }
}

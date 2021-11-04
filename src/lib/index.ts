import HLC from './hybridLogicalClock'

const localHlc = new HLC('my-client', new Date().getTime());

export { localHlc, HLC };

import HLC from './hybridLogicalClock'

const getCurrentTime = () => Math.floor(Date.now() / 1000)
const localHlc = new HLC('my-client', getCurrentTime())

export { localHlc, getCurrentTime, HLC };

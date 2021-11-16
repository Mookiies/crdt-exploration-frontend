/**
 * This implementation of the [Hybric Logical Clocks][1] paper was very much based
 * on [this go implementation][2]
 *
 * [1]: https://muratbuffalo.blogspot.com/2014/07/hybrid-logical-clocks.html
 * [2]: https://raw.githubusercontent.com/jaredly/hybrid-logical-clocks-example/master/src/hlc.js
 */

const VERSION = 'v01'

export default class HybridLogicalClock {
  readonly node: string;
  ts: number;
  count: number;

  constructor(node: string, now: number, count = 0) {
    this.node = node;
    this.ts = now;
    this.count = count;
  }

  pack() {
    return (
      this.ts.toString(36).padStart(15, '0') +
      ':' +
      this.count.toString(36).padStart(5, '0') +
      ':' +
      this.node +
      ':' +
      VERSION
    );
  }

  static unpack(serialized: string) {
    if(!this.isValidFormat(serialized)) {
     throw new Error(`String: ${serialized} not a valid HLC`)
    }
    const [ts, count, node] = serialized.split(':');
    return new HybridLogicalClock(node, parseInt(ts, 36), parseInt(count, 36));
  }

  static isValidFormat(serialized: any) {
    return typeof serialized === 'string' && serialized.match(/[A-Za-z0-9]{15}:[A-Za-z0-9]{5}:.*:v01/)
    // TODO improve regex to user the VERSION  constant
  }

  compare(other: HybridLogicalClock) {
    if (this.ts === other.ts) {
      if (this.count === other.count) {
        if (this.node === other.node) {
          return 0;
        }
        return this.node < other.node ? -1 : 1;
      }
      return this.count - other.count;
    }
    return this.ts - other.ts;
  }

  increment(now: number): HybridLogicalClock {
    if (now > this.ts) {
      this.ts = now;
      this.count = 0;
      return this;
    }

    this.count += 1;
    return this;
  }

  receive(remote: HybridLogicalClock, now: number): HybridLogicalClock { //TODO add default for now
    if (now > this.ts && now > remote.ts) {
      this.ts = now;
      this.count = 0;
      return this;
    }

    if (this.ts === remote.ts) {
      this.count = Math.max(this.count, remote.count) + 1;
    } else if (this.ts > remote.ts) {
      this.count += 1;
    } else {
      this.ts = remote.ts;
      this.count = remote.count + 1;
    }

    return this;
  }

  validate(now: number, maxDrift: number = 60 * 1000) {
    if (this.count > Math.pow(36,5)) {
      return 'counter-overflow';
    }
    // if a timestamp is more than 1 minute off from our local wall clock, something has gone horribly wrong.
    if (Math.abs(this.ts - now) > maxDrift) {
      return 'clock-off';
    }
    return null;
  };

}

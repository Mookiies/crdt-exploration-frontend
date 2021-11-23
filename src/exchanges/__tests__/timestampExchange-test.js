import {cloneDeep} from 'lodash';


import {injectTimestampVariables, traverseAndUpdateHlc} from '../timestampExchange';
import {getCurrentTime, HLC} from '../../lib';

jest
  .useFakeTimers('modern')
  .setSystemTime(new Date('2020-01-01').getTime());

describe('timestampsExchange', () => {

  describe('injectingTimestamps', () => {
    const mockTimestamp = 'mockTimestamp'

    it('fills nested fields', () => {
      const source = {
        one: {
          existing: 123,
          other: null,
          undi: undefined,
          array: [{ }, { a: 1}],
          two: {
            three: {  }
          },
          two_two: {
            three: {  }
          }
        }
      }

      const fieldsToFill = {
        one: {
          _timestamped: ['existing', 'other', 'undi'],
          two: {
            _timestamped: ['three'],
            three: {  }
          },
          two_two: {
            three: {  }
          }
        }
      }

      const expected = {
        "one": {
          "existing": 123,
          "other": null,
          array: [{ }, { a: 1}],
          "timestamps": {
            "existing": "mockTimestamp",
            "other": "mockTimestamp",
            "undi": "mockTimestamp"
          },
          "two": {
            "three": {},
            "timestamps": {
              "three": "mockTimestamp"
            }
          },
          "two_two": {
            "three": {}
          }
        }
      }

      const res = injectTimestampVariables(source, fieldsToFill, mockTimestamp);
      expect(res).toEqual(expected)
    });

    it('does not add timestamps if they key does not exist on source', () => {
      const source = {
        one: {
          one: 1,
          two: 2
        }
      }

      const fieldsToFill = {
        one: {
          _timestamped: ['x', 'y', 'z'],
          two: {
            _timestamped: ['one'],
          },
        }
      }

      const expected = {
        one: {
          one: 1,
          two: 2
        }
      }

      const res = injectTimestampVariables(source, fieldsToFill, mockTimestamp);
      expect(res).toEqual(expected)
    })

    it('returns same object if no fills', () => {
      const source = {
        one: {
          existing: 123,
          other: null,
          undi: undefined,
          two: {
            three: {}
          },
          two_two: {
            three: {}
          }
        }
      }


      const res = injectTimestampVariables(source, { }, mockTimestamp);
      expect(res).toEqual(source)
      expect(res).not.toBe(source)
    })

    it('does not mutate the source object', () => {
      const source = {
        arr: [
          { one: 1 },
          { one: 1 },
        ],
        one: {
          one: 1,
          two: 2
        }
      }

      const fieldsToFill = {
        arr: {
          _timestamped: ['one'],
        },
        one: {
          _timestamped: ['one', 'two'],
        }
      }

      const expected = {
        arr: [
          { one: 1,
            timestamps: {
              one: mockTimestamp,
            },
          },
          { one: 1,
            timestamps: {
              one: mockTimestamp,
            },
          },
        ],
        one: {
          timestamps: {
            one: mockTimestamp,
            two: mockTimestamp
          },
          one: 1,
          two: 2
        }
      }

      const res = injectTimestampVariables(source, fieldsToFill, mockTimestamp);
      expect(res).toEqual(expected)
      expect(res).not.toBe(source)
      expect(res).not.toEqual(source)
    });

    it('does works on nested arrays', () => {
      const source = {
        inspectionsInput: {
          name: 'name',
          other: 'other',
          areas: [
            {
              name: 'area - 1',
              other: 'other',
              items: [
                {
                  name: 'item - 1',
                  other: 'other',
                },
                {
                  name: 'item - 2',
                  other: 'other',
                }
              ]
            },
            {
              name: 'area - 2',
              other: 'other',
              items: [
                {
                  name: 'item - 3',
                  other: 'other',
                },
                {
                  name: 'item - 4',
                  other: 'other',
                }
              ]
            }
          ]
        }
      }

      const toTimestamp = {
        inspectionsInput: {
          _timestamped: ['name', 'other'],
          areas: {
            _timestamped: ['name', 'other'],
            items: {
              _timestamped: ['name', 'other'],
            }
          }
        }
      };

      const expected = {
        inspectionsInput: {
          name: 'name',
          other: 'other',
          timestamps: {
            name: mockTimestamp,
            other: mockTimestamp,
          },
          areas: expect.arrayContaining([
            {
              name: 'area - 1',
              other: 'other',
              timestamps: {
                name: mockTimestamp,
                other: mockTimestamp,
              },
              items: expect.arrayContaining([
                {
                  name: 'item - 1',
                  other: 'other',
                  timestamps: {
                    name: mockTimestamp,
                    other: mockTimestamp,
                  },
                },
                {
                  name: 'item - 2',
                  other: 'other',
                  timestamps: {
                    name: mockTimestamp,
                    other: mockTimestamp,
                  },
                }
              ])
            },
            {
              name: 'area - 2',
              other: 'other',
              timestamps: {
                name: mockTimestamp,
                other: mockTimestamp,
              },
              items: expect.arrayContaining([
                {
                  name: 'item - 3',
                  other: 'other',
                  timestamps: {
                    name: mockTimestamp,
                    other: mockTimestamp,
                  },
                },
                {
                  name: 'item - 4',
                  other: 'other',
                  timestamps: {
                    name: mockTimestamp,
                    other: mockTimestamp,
                  },
                }
              ])
            }
          ])
        }
      }

      const res = injectTimestampVariables(source, toTimestamp, mockTimestamp);
      expect(res).toEqual(expected)
    });

    it('supports undefined config', () => {
      const source = {
        one: 1
      }


      const res = injectTimestampVariables(source, undefined, mockTimestamp);
      expect(res).toEqual(source)
      expect(res).not.toBe(source)
    })

    it('supports handles empty objects', () => {
      const res = injectTimestampVariables({}, undefined, mockTimestamp);
      expect(res).toEqual({})
    })

    it('can handle unknown keys in config', () => {
      const source = {
        one: 1,
        two: {
          three: 3,
        }
      }

      const toTimestamp = {
        _timestamped: ['what'],
        error: {
          test: 123,
        },
        lol: 1,
      }


      const res = injectTimestampVariables(source, toTimestamp, mockTimestamp);
      expect(res).toEqual(source)
      expect(res).not.toBe(source)
    })
    // More test cases
    // just top level stuff
    // super nested???
  })

  describe('parseAndUpdateHlc', () => {
    const now = getCurrentTime();
    const node = 'node';
    let localHlc;

    const timestampKey = 'timestamps';

    beforeEach(() => {
      localHlc = new HLC(node, now);
    })

    it('updates hlc from nested object', () => {
      const biggerTs = new HLC(node, now + 80000)
      const data = {
        extra: {},
        one: {
          two: {
            timestamps: {
              a: biggerTs.pack(),
              b: biggerTs.pack()
            }
          }
        }
      }

      const dataCopy = cloneDeep(data)
      traverseAndUpdateHlc(data, localHlc, timestampKey);

      expect(localHlc.compare(new HLC(node, now))).toBeGreaterThan(0)
      expect(localHlc.compare(biggerTs)).toBeGreaterThan(0)
      expect(localHlc.count).toEqual(1)

      expect(data).toEqual(dataCopy)
    });

    it('updates timestamp from nested array', () => {
      const biggerTs = new HLC(node, now + 80000)
      const data = {
        extra: {},
        one: [
          {
            timestamps: {
              a: biggerTs.pack()
            }
          }
        ]
      }

      const dataCopy = cloneDeep(data)
      traverseAndUpdateHlc(data, localHlc, timestampKey);

      expect(localHlc.compare(new HLC(node, now))).toBeGreaterThan(0)
      expect(localHlc.compare(biggerTs)).toBeGreaterThan(0)

      expect(data).toEqual(dataCopy)
    });

    it('does not bump timestamp from older timestamps', () => {
      const olderTS = new HLC(node, 0);
      const data = {
        timestamps: {
          a: olderTS.pack()
        }
      }

      traverseAndUpdateHlc(data, localHlc, timestampKey);

      expect(localHlc.compare(new HLC(node, now))).toEqual(0)
    })

    it('handles other datatypes', () => {
      const data = {
        a: undefined,
        b: null,
        c: new Date(),
        d: {
          timestamps: null
        },
        e: {
          timestamps: { }
        },
        f: {
          timestamps: []
        },
        g: {
          timestamps: localHlc.pack(),
        },
        timestamps: {
          a: null,
          b: 1,
          c: 'bad bad string',
          d: '12345678987654:almostreal:node:xasdf`23'
        }
      }

      const dataCopy = cloneDeep(data);
      traverseAndUpdateHlc(data, localHlc, timestampKey);

      expect(localHlc.compare(new HLC(node, now))).toEqual(0)
      expect(data).toEqual(dataCopy)
    })

    it('works with other timestamp keys', () => {
      const biggerTs = new HLC(node, now + 80000)
      const data = {
        other: {
          a: biggerTs.pack()
        }
      }

      traverseAndUpdateHlc(data, localHlc, 'other');

      expect(localHlc.compare(new HLC(node, now))).toBeGreaterThan(0)
      expect(localHlc.compare(biggerTs)).toBeGreaterThan(0)
    })

    it('does not take node from winning ts', () => {
      const biggerTs = new HLC('other_node', now + 80000)
      const data = {
        timestamps: {
          a: biggerTs.pack()
        }
      }

      traverseAndUpdateHlc(data, localHlc, timestampKey);

      expect(localHlc.compare(new HLC(node, now))).toBeGreaterThan(0)
      expect(localHlc.compare(biggerTs)).toBeGreaterThan(0)
      expect(localHlc.node).toEqual(node)
    })
  })
});

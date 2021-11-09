import { injectTimestampVariables } from '../timestampInjector';

describe('injectTimestampVariables', () => {

  const mockTimestamp = 'mockTimestamp'

  it('fills nested fields', () => {
    const source = {
      one: {
        existing: 123,
        other: null,
        undi: undefined,
        array: [{ }, { a: 1}],
        two: {
          three: {
          }
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
          three: {
          }
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
        "timestampsAttributes": {
          "existing": "mockTimestamp",
          "other": "mockTimestamp",
          "undi": "mockTimestamp"
        },
        "two": {
          "three": {},
          "timestampsAttributes": {
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
          timestampsAttributes: {
            one: mockTimestamp,
          },
        },
        { one: 1,
          timestampsAttributes: {
            one: mockTimestamp,
          },
        },
      ],
      one: {
        timestampsAttributes: {
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
        timestampsAttributes: {
          name: mockTimestamp,
          other: mockTimestamp,
        },
        areas: expect.arrayContaining([
          {
            name: 'area - 1',
            other: 'other',
            timestampsAttributes: {
              name: mockTimestamp,
              other: mockTimestamp,
            },
            items: expect.arrayContaining([
              {
                name: 'item - 1',
                other: 'other',
                timestampsAttributes: {
                  name: mockTimestamp,
                  other: mockTimestamp,
                },
              },
              {
                name: 'item - 2',
                other: 'other',
                timestampsAttributes: {
                  name: mockTimestamp,
                  other: mockTimestamp,
                },
              }
            ])
          },
          {
            name: 'area - 2',
            other: 'other',
            timestampsAttributes: {
              name: mockTimestamp,
              other: mockTimestamp,
            },
            items: expect.arrayContaining([
              {
                name: 'item - 3',
                other: 'other',
                timestampsAttributes: {
                  name: mockTimestamp,
                  other: mockTimestamp,
                },
              },
              {
                name: 'item - 4',
                other: 'other',
                timestampsAttributes: {
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
});

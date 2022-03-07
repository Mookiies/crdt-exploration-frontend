import { mergeWithTimestamps } from '../crdtExchange';
import { cloneDeep} from "lodash";

describe('mergeWithTimestamps', () => {
  it('merges nested structures correctly', () => {
    const newerValue = 'newer-value';
    const olderValue = 'older-value';
    const unchangedValue = 'unchanged-value';
    const newerTimestamp = '200000000000000:00000:my-client:v01';
    const olderTimestamp = '10000000000000:00000:my-client:v01';
    const unchangedTimestamp = '00000000000000:00000:my-client:v01'

    const newPatch = {
      inspection: {
        name: newerValue,
        note: olderValue,
        timestamps: {
          name: newerTimestamp,
          note: olderTimestamp,
        },
        areas: [
          {
            uuid: '1234',
            name: newerValue,
            note: olderValue,
            timestamps: {
              name: newerTimestamp,
              note: olderTimestamp,
            },
            items: [
              {
                uuid: '1234',
                name: newerValue,
                note: olderValue,
                timestamps: {
                  name: newerTimestamp,
                  note: olderTimestamp,
                },
              },
            ]
          },
        ]
      }
    }

    const existingPatch = {
      inspection: {
        name: olderValue,
        note: newerValue,
        other: unchangedValue,
        timestamps: {
          name: olderTimestamp,
          note: newerTimestamp,
          other: unchangedTimestamp,
        },
        areas: [
          {
            uuid: '1234',
            name: olderValue,
            note: newerValue,
            other: unchangedValue,
            timestamps: {
              name: olderTimestamp,
              note: newerTimestamp,
              other: unchangedTimestamp,
            },
            items: [
              {
                uuid: '1234',
                name: olderValue,
                note: newerValue,
                other: unchangedValue,
                timestamps: {
                  name: olderTimestamp,
                  note: newerTimestamp,
                  other: unchangedTimestamp,
                }
              },
              {
                uuid: 'unchanged-item',
                name: unchangedValue,
                note: unchangedValue,
                other: unchangedValue,
                timestamps: {
                  name: unchangedValue,
                  note: unchangedValue,
                  other: unchangedTimestamp,
                },
              },
            ]
          },
        ]
      }
    }

    const expected = {
      inspection: {
        name: newerValue,
        note: newerValue,
        other: unchangedValue,
        timestamps: {
          name: newerTimestamp,
          note: newerTimestamp,
          other: unchangedTimestamp,
        },
        areas: [
          {
            uuid: '1234',
            name: newerValue,
            note: newerValue,
            other: unchangedValue,
            timestamps: {
              name: newerTimestamp,
              note: newerTimestamp,
              other: unchangedTimestamp,
            },
            items: [
              {
                uuid: '1234',
                name: newerValue,
                note: newerValue,
                other: unchangedValue,
                timestamps: {
                  name: newerTimestamp,
                  note: newerTimestamp,
                  other: unchangedTimestamp,
                },
              },
              {
                uuid: 'unchanged-item',
                name: unchangedValue,
                note: unchangedValue,
                other: unchangedValue,
                timestamps: {
                  name: unchangedValue,
                  note: unchangedValue,
                  other: unchangedTimestamp,
                },
              },
            ]
          },
        ]
      }
    }

    expect(mergeWithTimestamps(newPatch, existingPatch)).toEqual(expected);
  })

  it('merges correctly without timestamps', () => {
    const input = {
      value: 'input',
      arr: [
        { uuid: 1, other: 'input' }
      ]
    }

    const existingPatch = {
      value: 'existingPatch',
      arr: [
        { uuid: 1, other: 'existingPatch' },
        { uuid: 2, other: 'existingPatch' }
      ]
    }

    const expected = {
      value: 'input',
      arr: [
        { uuid: 1, other: 'input' },
        { uuid: 2, other: 'existingPatch' }
      ]
    }
    expect(mergeWithTimestamps(existingPatch, input)).toEqual(expected);
  })

  it('handles timestamp ties correctly', () => {
    const newPatchValue = 'newPatch-value';
    const existingPatchValue = 'existingPatch-value';
    const timestamp = '200000000000000:00000:my-client:v01';

    const newPatch = {
      name: newPatchValue,
      note: newPatchValue,
      timestamps: {
        name: timestamp,
        note: timestamp,
      },
    };

    const existingPatch = {
      name: existingPatchValue,
      note: existingPatchValue,
      timestamps: {
        name: timestamp,
        note: timestamp,
      },
    };

    expect(mergeWithTimestamps(existingPatch, newPatch)).toEqual(newPatch)
  })

  it('does not mutate source', () => {
    const newPatch = {
      one: 'new value',
    }

    const existingPatch = {
      one: {
        two: 'three'
      }
    };

    const newPatchCopy = cloneDeep(newPatch);
    const existingPatchCopy = cloneDeep(existingPatch);

    mergeWithTimestamps(existingPatch, newPatch);
    mergeWithTimestamps(newPatch, existingPatch);
    expect(existingPatch).toEqual(existingPatchCopy);
    expect(newPatch).toEqual(newPatchCopy);
  })

  it('supports null input', () => {
    const existingPatch = {
      one: 1,
      two: {
        two: 2
      }
    };

    const existingPatchCopy = cloneDeep(existingPatch);

    expect(mergeWithTimestamps(existingPatch, null)).toEqual(existingPatchCopy);
    expect(mergeWithTimestamps(null, existingPatch)).toEqual(existingPatchCopy);
    expect(mergeWithTimestamps(null, null)).toEqual({});
  })

  // TODO currently unsupported to have non uuid array data
  it.skip('can handle non uuid array data', () => {
    const newPatch = {
      arr: [1,2,3,4],
    }

    const existingPatch = {
      arr: [7,8,9]
    }

    expect(mergeWithTimestamps(existingPatch, newPatch)).toEqual(null)
  })
})

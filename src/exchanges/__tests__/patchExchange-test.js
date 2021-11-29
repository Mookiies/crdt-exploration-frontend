import { mergeExisting } from '../patchExchange';


describe('patchExchange', () => {

  describe('mergeExisting', () => {
    it('merges nested structures correctly', () => {
      const variablesInput = {
        inspectionsInput: {
          inspection: {
            name: 'updated',
            other: 'same as input',
            nested_same: {
              same: 123,
            },
            areas: [
              {
                name: 'updated',
                other: 'updated',
                uuid: '1234',
                items: [
                  {
                    uuid: '1234',
                    name: 'updated',
                  },
                  {
                    uuid: 'same-as-input',
                    name: 'value: same as input'
                  },
                ]
              },
            ]
          }
        }
      }

      const cacheRead = {
        data: {
          inspection: {
            __typename: 'Inspection',
            name: 'SHOULD GET CHANGED',
            note: '_____',
            other: 'same as input',
            nested_same: {
              same: 123,
            },
            timestamps: {
              __typename: 'InspectionsTimestamp',
              name: '_____',
              note: '_____',
            },
            areas: [
              {
                name: 'THIS SHOULD GET CHANGED',
                uuid: '1234',
                other: 'THIS SHOULD GET CHANGED',
                __typename: 'Area',
                timestamps: {
                  name: '_____',
                  note: '_____',
                  __typename: 'AreasTimestamp',
                },
                items: [
                  {
                    __typename: 'Item',
                    uuid: '1234',
                    name: 'THIS SHOULD GET CHANGED',
                  },
                  {
                    __typename: 'Item',
                    uuid: '000',
                    name: '_____'
                  },
                  {
                    __typename: 'Item',
                    uuid: 'same-as-input',
                    name: 'value: same as input'
                  }
                ]
              },
            ]
          }
        }
      }

      const expected = {
        inspection: {
          name: 'updated',
          note: '_____',
          other: 'same as input',
          nested_same: {
            same: 123,
          },
          timestamps: {
            name: '_____',
            note: '_____',
          },
          areas: [
            {
              name: 'updated',
              uuid: '1234',
              other: 'updated',
              timestamps: {
                name: '_____',
                note: '_____',
              },
              items: [
                {
                  uuid: '1234',
                  name: 'updated',
                },
                {
                  uuid: '000',
                  name: '_____'
                },
                {
                  uuid: 'same-as-input',
                  name: 'value: same as input'
                }
              ]
            },
          ]
        }
      }

      expect(mergeExisting(cacheRead.data, variablesInput.inspectionsInput)).toEqual(expected);
    })

    it('does not mutate source', () => {
      const vars = {
        one: 'new value',
      }

      const one = { two: 'three'}
      const cache = {
        one
      };

      expect(mergeExisting(cache, vars)).toEqual({ one: 'new value'})
      expect(cache).toEqual({one: { two: 'three' }});
      expect(cache.one).toBe(one);
    })

    it('does good job with null input', () => {
      const cache = {
        one: 1,
        two: {
          two: 2
        }
      };

      expect(mergeExisting(cache, null)).toEqual(cache);
    })
  })

})

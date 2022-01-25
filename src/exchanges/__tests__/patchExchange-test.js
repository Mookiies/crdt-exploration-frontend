import {
  gql,
  createClient,
} from '@urql/core';
import { pipe, map, makeSubject, tap, publish } from 'wonka';


import {mergeOptimisticIntoServer, mergeWithTimestamps, OPTIMISTIC_STATE_KEY, patchExchange} from '../patchExchange';
import {PROCESSED_OPERATION_KEY} from '../patchExchange';
import { cloneDeep} from "lodash";

const mutationOne = gql` 
  mutation updateAuthor ($author: AuthorInput!) {
    updateAuthor (author: $author) {
      id
      name
    }
  }
`;

const mutationOneData = {
  __typename: 'Mutation',
  updateAuthor: {
    __typename: 'Author',
    id: '123',
    name: 'Author',
  },
};

const dispatchDebug = jest.fn();

describe('patchExchange', () => {
  let client, op, ops$, next, variables;
  beforeEach(() => {
    client = createClient({ url: 'http://0.0.0.0' });

    variables = {
      authorInput: {
        author: {
          name: 'new name'
        }
      }
    };

    op = client.createRequestOperation('mutation', {
      key: 1,
      query: mutationOne,
      variables,
    });

    ({ source: ops$, next } = makeSubject());
  });

  it('merges server result with variables and inject optimistic variables', () => {
    const result = jest.fn();
    const response = jest.fn(
      (forwardOp) => {
        return {operation: forwardOp, data: mutationOneData};
      }
    );
      const forward = ops$ => {
        return pipe(ops$, map(response));
      };

      const cacheRes = {
        data: {
          author: {
            name: 'old name',
            alias: 'stored alias'
          }
        }
      };

      const options = {
        updateAuthor: {
          existingData: () => ({
            optimisticRes: cloneDeep(cacheRes),
            serverRes: cloneDeep(cacheRes)
          }),
          variablePath: 'authorInput'
        },
      };

      pipe(
        patchExchange(options)({
          forward,
          client,
          dispatchDebug,
        })(ops$),
        tap(result),
        publish
      );

      next(op);

      const expectedInputPatch = {
        author: {
          alias: 'stored alias',
          name: 'new name'
        }
      };
      expect(response).toHaveBeenCalledTimes(1);
      expect(response.mock.calls[0][0].variables).toEqual({
        [OPTIMISTIC_STATE_KEY]: expectedInputPatch,
        authorInput: expectedInputPatch
      });
      expect(response.mock.calls[0][0].context).toMatchObject({ [PROCESSED_OPERATION_KEY]: true })

      expect(result).toHaveBeenCalledTimes(1);
      expect(result.mock.calls[0][0]).toEqual({
        data: mutationOneData,
        error: undefined,
        extensions: undefined,
        operation: expect.any(Object),
      });
    });

  it('does not change operations that do not have config', () => {
    const result = jest.fn();
    const response = jest.fn(
      (forwardOp) => {
        return { operation: forwardOp, data: mutationOneData };
      }
    );
    const forward = ops$ => {
      return pipe(ops$, map(response));
    };

    const options = {
      randomMutation: {
        existingData: () => ({
          data: {
            author: {
              name: 'old name',
              alias: 'stored alias'
            }
          }
        }),
        variablePath: 'authorInput'
      },
    };

    pipe(
      patchExchange(options)({
        forward,
        client,
        dispatchDebug,
      })(ops$),
      tap(result),
      publish
    );

    next(op);

    expect(response).toHaveBeenCalledTimes(1);
    expect(response.mock.calls[0][0].variables).toEqual({
      authorInput: {
        author: {
          name: 'new name'
        }
      }
    });
    expect(response.mock.calls[0][0].context[PROCESSED_OPERATION_KEY]).not.toBeDefined();

    expect(result).toHaveBeenCalledTimes(1);
    expect(result.mock.calls[0][0]).toEqual({
      data: mutationOneData,
      error: undefined,
      extensions: undefined,
      operation: expect.any(Object),
    });
  })

  it('does not process already processed mutations', () => {
    op = client.createRequestOperation('mutation', {
      key: 1,
      query: mutationOne,
      variables: {
        authorInput: {
          author: {
            name: 'new name'
          }
        }
      }
    }, {
      [PROCESSED_OPERATION_KEY]: true,
    });

    const result = jest.fn();
    const response = jest.fn(
      (forwardOp) => {
        return {operation: forwardOp, data: mutationOneData};
      }
    );
    const forward = ops$ => {
      return pipe(ops$, map(response));
    };

    const options = {
      updateAuthor: {
        existingData: () => ({
          data: {
            author: {
              name: 'old name',
              alias: 'stored alias'
            }
          }
        }),
        variablePath: 'authorInput'
      },
    };

    pipe(
      patchExchange(options)({
        forward,
        client,
        dispatchDebug,
      })(ops$),
      tap(result),
      publish
    );

    next(op);

    expect(response).toHaveBeenCalledTimes(1);
    expect(response.mock.calls[0][0].variables).toEqual({
      authorInput: {
        author: {
          name: 'new name'
        }
      }
    });

    expect(result).toHaveBeenCalledTimes(1);
  })

  it('can handle no existing data for a mutation', () => {
    const result = jest.fn();
    const response = jest.fn(
      (forwardOp) => {
        return {operation: forwardOp, data: mutationOneData};
      }
    );
    const forward = ops$ => {
      return pipe(ops$, map(response));
    };

    const options = {
      updateAuthor: {
        existingData: () => ({
          optimisticRes: null,
          serverRes: null
        }),
        variablePath: 'authorInput'
      },
    };

    pipe(
      patchExchange(options)({
        forward,
        client,
        dispatchDebug,
      })(ops$),
      tap(result),
      publish
    );

    next(op);

    expect(response).toHaveBeenCalledTimes(1);
    expect(response.mock.calls[0][0].variables).toEqual({
      [OPTIMISTIC_STATE_KEY]: {
        author: {
          name: 'new name'
        }
      },
      authorInput: {
        author: {
          name: 'new name'
        }
      }
    });
    expect(response.mock.calls[0][0].context).toMatchObject({ [PROCESSED_OPERATION_KEY]: true })

    expect(result).toHaveBeenCalledTimes(1);
  });
})

describe('merges', () => {
  describe('mergeWithTimestamps', () => {
    it('merges nested structures correctly', () => {
      const newerValue = 'newer-value';
      const olderValue = 'older-value';
      const unchangedValue = 'unchanged-value';
      const newerTimestamp = '200000000000000:00000:my-client:v01';
      const olderTimestamp = '10000000000000:00000:my-client:v01';
      const unchangedTimestamp = '00000000000000:00000:my-client:v01'

      const variablesInput = {
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

      const cacheRead = {
        inspection: {
          __typename: 'Inspection',
          name: olderValue,
          note: newerValue,
          other: unchangedValue,
          timestamps: {
            __typename: 'InspectionsTimestamp',
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
                __typename: 'AreasTimestamp',
                name: olderTimestamp,
                note: newerTimestamp,
                other: unchangedTimestamp,
              },
              items: [
                {
                  __typename: 'Item',
                  uuid: '1234',
                  name: olderValue,
                  note: newerValue,
                  other: unchangedValue,
                  timestamps: {
                    __typename: 'ItemsTimestamp',
                    name: olderTimestamp,
                    note: newerTimestamp,
                    other: unchangedTimestamp,
                  }
                },
                {
                  __typename: 'Item',
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

      expect(mergeWithTimestamps(cacheRead, variablesInput)).toEqual(expected);
    })

    it('merges correctly without timestamps', () => {
      const input = {
        value: 'input',
        arr: [
          { uuid: 1, other: 'input' }
        ]
      }

      const cache = {
        value: 'cache',
        arr: [
          { uuid: 1, other: 'cache' },
          { uuid: 2, other: 'cache' }
        ]
      }

      const expected = {
        value: 'input',
        arr: [
          { uuid: 1, other: 'input' },
          { uuid: 2, other: 'cache' }
        ]
      }
      expect(mergeWithTimestamps(cache, input)).toEqual(expected);
    })

    it('handles timestamp ties correctly', () => {
      const varsValue = 'vars-value';
      const cacheValue = 'cache-value';
      const timestamp = '200000000000000:00000:my-client:v01';

      const vars = {
        name: varsValue,
        note: varsValue,
        timestamps: {
          name: timestamp,
          note: timestamp,
        },
      };

      const cache = {
        name: cacheValue,
        note: cacheValue,
        timestamps: {
          name: timestamp,
          note: timestamp,
        },
      };

      expect(mergeWithTimestamps(cache, vars)).toEqual(vars)
    })

    // TODO is this a problem?
    it.skip('can handle non uuid array data', () => {
      const vars = {
        arr: [1,2,3,4],
      }

      const cache = {
        arr: [7,8,9]
      }

      expect(mergeExisting(cache, vars, false)).toEqual(null)
    })
  });

  describe('mergeOptimisticIntoServer', () => {
    it('removes extra array items', () => {
      const server = {
        arr: [
          {
            uuid: '1',
            name: 'one'
          }
        ]
      }

      const optimistic = {
        arr: [
          {
            uuid: '1',
            name: 'SHOULD NOT SHOW UP'
          },
          {
            uuid:'2',
            name: 'SHOULD NOT SHOW UP'
          }
        ]
      }

      expect(mergeOptimisticIntoServer(optimistic, server)).toEqual(server)
    })

    it('removes nested array items', () => {
      const server = {
        arr: [
          {
            uuid: '1',
            name: 'one',
            arr2: [
              {
                uuid: '1'
              }
            ]
          }
        ]
      }

      const optimistic = {
        arr: [
          {
            uuid: '1',
            name: 'SHOULD NOT SHOW UP',
            arr2: [
              {
                uuid: '3',
                level2: 'THIS SHOULD NOT SHOW UP'
              }
            ]
          },
          {
            uuid:'2',
            name: 'SHOULD NOT SHOW UP',
            arr2: [
              {
                uuid: '8',
                level2: 'THIS SHOULD NOT SHOW UP'
              }
            ]
          }
        ]
      }

      const expected = cloneDeep(server)

      expect(mergeOptimisticIntoServer(optimistic, server)).toEqual(expected)
    })

    it('combines and merges properties', () => {
      const server = {
        value1: 'server',
        value2: 'server'
      }

      const optimistic = {
        value1: 'optimistic',
        value3: 'optimistic',
      }

      const expected = {
        value1: 'server',
        value2: 'server',
        value3: 'optimistic'
      }

      expect(mergeOptimisticIntoServer(optimistic, server)).toEqual(expected)
    })

    it('combines and merges nested properties', () => {
      const server = {
        value1: 'server',
        arr: [
          {
            uuid: '1',
            arrValue1: 'serer'
          }
        ]
      };

      const optimistic = {
        value1: 'optimistic',
        arr: [
          {
            uuid: '1',
            arrValue1: 'optimistic',
            arrValue2: 'optimistic'
          },
          {
            uuid:'2',
            arrValue1: 'SHOULD NOT SHOW UP'
          }
        ]
      }

      const expected = {
        value1: 'server',
        arr: [
          {
            uuid: '1',
            arrValue1: 'serer',
            arrValue2: 'optimistic'
          }
        ]
      };

      expect(mergeOptimisticIntoServer(optimistic, server)).toEqual(expected)
    })

    it('merges based on server results not timestamps', () => {
      const newerValue = 'newer-value';
      const olderValue = 'older-value';
      const newerTimestamp = '200000000000000:00000:my-client:v01';
      const olderTimestamp = '10000000000000:00000:my-client:v01';

      const server = {
        value1: olderValue,
        value2: olderValue,
        timestamps: {
          value1: olderTimestamp,
          value2: olderTimestamp
        }
      }

      const optimistic = {
        value1: newerValue,
        value2: newerValue,
        timestamps: {
          value1: newerTimestamp,
          value2: newerTimestamp
        }
      }

      const expected = cloneDeep(server)

      expect(mergeOptimisticIntoServer(optimistic, server)).toEqual(expected)
    })
  })

  it('does not mutate source', () => {
    const vars = {
      one: 'new value',
    }

    const cache = {
      one: {
        two: 'three'
      }
    };

    const varsCopy = cloneDeep(vars);
    const cacheCopy = cloneDeep(cache);

    mergeWithTimestamps(cache, vars);
    mergeWithTimestamps(vars, cache);
    expect(cache).toEqual(cacheCopy);
    expect(vars).toEqual(varsCopy);

    mergeOptimisticIntoServer(cache, vars);
    mergeOptimisticIntoServer(vars, cache);
    expect(cache).toEqual(cacheCopy);
    expect(vars).toEqual(varsCopy);
  })

  it('handles with null input', () => {
    const cache = {
      one: 1,
      two: {
        two: 2
      }
    };

    const cacheCopy = cloneDeep(cache);

    expect(mergeWithTimestamps(cache, null)).toEqual(cacheCopy);
    expect(mergeWithTimestamps(null, cache)).toEqual(cacheCopy);

    expect(mergeOptimisticIntoServer(cache, null)).toEqual(cacheCopy);
    expect(mergeOptimisticIntoServer(null, cache)).toEqual(cacheCopy);
  })

  it('filters typenames', () => {
    const vars = {
      one: 1,
      two: {
        __typename: 'type',
        two: 2
      }
    }

    const cache = {
      one: 1,
      two: {
        __typename: 'type',
        two: 2
      }
    }

    const expected = {
      one: 1,
      two: {
        two: 2
      }
    }

    expect(mergeWithTimestamps(cache, vars)).toEqual(expected);
    expect(mergeOptimisticIntoServer(cache, vars)).toEqual(expected);
  })
})

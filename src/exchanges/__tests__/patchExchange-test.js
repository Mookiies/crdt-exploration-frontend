import {
  gql,
  createClient,
} from '@urql/core';
import { pipe, map, makeSubject, tap, publish } from 'wonka';


import { mergeExisting, patchExchange } from '../patchExchange';
import {PROCESSED_OPERATION_KEY} from '../patchExchange';

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
  let client, op, ops$, next;
  beforeEach(() => {
    client = createClient({ url: 'http://0.0.0.0' });
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
    });

    ({ source: ops$, next } = makeSubject());
  });

  it('calls mergeExisting and uses that result', () => {
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
            alias: 'stored alias',
            name: 'new name'
          }
        }
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
        existingData: () => null,
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
    expect(response.mock.calls[0][0].context).toMatchObject({ [PROCESSED_OPERATION_KEY]: true })

    expect(result).toHaveBeenCalledTimes(1);
  });
})

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
});

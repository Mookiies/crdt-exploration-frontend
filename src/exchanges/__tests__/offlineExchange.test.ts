import {
  gql,
  createClient,
  ExchangeIO,
  Operation,
  OperationResult,
  formatDocument,
} from '@urql/core';

import { pipe, map, makeSubject, tap, publish } from 'wonka';
import { offlineExchange } from '../graphcache/src';
import {GraphQLError} from 'graphql';

const mutationOne = gql`
  mutation {
    updateAuthor {
      id
      name
    }
  }
`;

const mutationTwo = gql` 
  mutation ($name: string) {
    updateAuthor (name: $name) {
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

const queryOne = gql`
  query {
    authors {
      id
      name
      __typename
    }
  }
`;

const queryOneData = {
  __typename: 'Query',
  authors: [
    {
      id: '123',
      name: 'Me',
      __typename: 'Author',
    },
  ],
};

const dispatchDebug = jest.fn();

describe('storage', () => {
  const storage = {
    onOnline: jest.fn(),
    writeData: jest.fn(),
    writeMetadata: jest.fn(),
    readData: jest.fn(),
    readMetadata: jest.fn(),
  };

  it('should read the metadata and dispatch operations on initialization', () => {
    const client = createClient({ url: 'http://0.0.0.0' });
    const reexecuteOperation = jest
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(() => undefined);
    const op = client.createRequestOperation('mutation', {
      key: 1,
      query: mutationOne,
      variables: {},
    });

    const response = jest.fn(
      (forwardOp: Operation): OperationResult => {
        expect(forwardOp.key).toBe(op.key);
        return { operation: forwardOp, data: mutationOneData };
      }
    );

    const { source: ops$ } = makeSubject<Operation>();
    const result = jest.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response));

    storage.readData.mockReturnValueOnce({ then: () => undefined });
    storage.readMetadata.mockReturnValueOnce({ then: cb => cb([op]) });
    reexecuteOperation.mockImplementation(() => undefined);

    jest.useFakeTimers();
    pipe(
      offlineExchange({ storage, persistedContext: [], isRetryableError: () => false, })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );
    jest.runAllTimers();

    expect(storage.readMetadata).toBeCalledTimes(1);
    expect(reexecuteOperation).toBeCalledTimes(1);
    expect(reexecuteOperation).toBeCalledWith({
      ...op,
      key: expect.any(Number),
    });
  });
});

describe('offline', () => {
  const storage = {
    onOnline: jest.fn(),
    writeData: jest.fn(),
    writeMetadata: jest.fn(),
    readData: jest.fn(),
    readMetadata: jest.fn(),
  };

  it('should intercept errored mutations', () => {
    const onlineSpy = jest.spyOn(navigator, 'onLine', 'get');

    const client = createClient({ url: 'http://0.0.0.0' });
    const queryOp = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
    });

    const mutationOp = client.createRequestOperation('mutation', {
      key: 2,
      query: mutationOne,
      variables: {},
    }, {
      key1: 'key1 data',
      key2: 'key2 data',
      key3: 'key3 data',
    });

    const response = jest.fn(
      (forwardOp: Operation): OperationResult => {
        if (forwardOp.key === queryOp.key) {
          onlineSpy.mockReturnValueOnce(true);
          return { operation: forwardOp, data: queryOneData };
        } else {
          onlineSpy.mockReturnValueOnce(false);
          return {
            operation: forwardOp,
            // @ts-ignore
            error: { networkError: new Error('failed to fetch'), graphQLErrors: [] },
          };
        }
      }
    );

    const { source: ops$, next } = makeSubject<Operation>();
    const result = jest.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response));

    storage.readData.mockReturnValueOnce({ then: () => undefined });
    storage.readMetadata.mockReturnValueOnce({ then: () => undefined });
    storage.writeMetadata.mockReturnValueOnce({ then: () => undefined });

    pipe(
      offlineExchange({
        storage,
        persistedContext: ['key1', 'key2'],
        isRetryableError: () => true,
        optimistic: {
          updateAuthor: () => ({
            id: '123',
            name: 'URQL',
            __typename: 'Author',
          }),
        },
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(queryOp);
    expect(result).toBeCalledTimes(1);
    expect(result.mock.calls[0][0].data).toMatchObject(queryOneData);

    next(mutationOp);
    expect(result).toBeCalledTimes(1);
    expect(storage.writeMetadata).toBeCalledTimes(1);
    expect(storage.writeMetadata).toHaveBeenCalledWith([
      {
        query: `mutation {
  updateAuthor {
    id
    name
    __typename
  }
}`,
        variables: {},
        context: {
          key1: 'key1 data',
          key2: 'key2 data',
        },
      },
    ]);

    next(queryOp);
    expect(result).toBeCalledTimes(2);
    expect(result.mock.calls[1][0].data).toMatchObject({
      authors: [{ id: '123', name: 'URQL', __typename: 'Author' }],
    });
  });

  it('should intercept errored queries', async () => {
    const client = createClient({ url: 'http://0.0.0.0' });
    const onlineSpy = jest
      .spyOn(navigator, 'onLine', 'get')
      .mockReturnValueOnce(false);

    const queryOp = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
    });

    const response = jest.fn(
      (forwardOp: Operation): OperationResult => {
        onlineSpy.mockReturnValueOnce(false);
        return {
          operation: forwardOp,
          // @ts-ignore
          error: { networkError: new Error('failed to fetch'), graphQLErrors: [] },
        };
      }
    );

    const { source: ops$, next } = makeSubject<Operation>();
    const result = jest.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response));

    storage.readData.mockReturnValueOnce({ then: () => undefined });
    storage.readMetadata.mockReturnValueOnce({ then: () => undefined });
    storage.writeMetadata.mockReturnValueOnce({ then: () => undefined });

    pipe(
      offlineExchange({
        storage,
        persistedContext: [],
        isRetryableError: () => true,
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(queryOp);

    expect(result).toBeCalledTimes(1);
    expect(response).toBeCalledTimes(1);

    expect(result.mock.calls[0][0]).toEqual({
      data: null,
      error: undefined,
      extensions: undefined,
      operation: expect.any(Object),
    });

    expect(result.mock.calls[0][0]).toHaveProperty(
      'operation.context.meta.cacheOutcome',
      'miss'
    );
  });

  it('should flush the queue when we become online', () => {
    let flush: () => {};
    storage.onOnline.mockImplementation(cb => {
      flush = cb;
    });

    const onlineSpy = jest.spyOn(navigator, 'onLine', 'get');

    const client = createClient({ url: 'http://0.0.0.0' });
    const reexecuteOperation = jest
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(() => undefined);

    const mutationOp = client.createRequestOperation('mutation', {
      key: 1,
      query: mutationOne,
      variables: {},
    });

    const response = jest.fn(
      (forwardOp: Operation): OperationResult => {
        onlineSpy.mockReturnValueOnce(false);
        return {
          operation: forwardOp,
          // @ts-ignore
          error: { networkError: new Error('failed to fetch'), graphQLErrors: [] },
        };
      }
    );

    const { source: ops$, next } = makeSubject<Operation>();
    const result = jest.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response));

    storage.readData.mockReturnValueOnce({ then: () => undefined });
    storage.readMetadata.mockReturnValueOnce({ then: () => undefined });
    storage.writeMetadata.mockReturnValueOnce({ then: () => undefined });

    pipe(
      offlineExchange({
        storage,
        persistedContext: [],
        isRetryableError: () => true,
        optimistic: {
          updateAuthor: () => ({
            id: '123',
            name: 'URQL',
            __typename: 'Author',
          }),
        },
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(mutationOp);
    expect(storage.writeMetadata).toBeCalledTimes(1);
    expect(storage.writeMetadata).toHaveBeenCalledWith([
      {
        query: `mutation {
  updateAuthor {
    id
    name
    __typename
  }
}`,
        variables: {},
        context: {},
      },
    ]);

    flush!();
    expect(reexecuteOperation).toHaveBeenCalledTimes(1);
    expect((reexecuteOperation.mock.calls[0][0] as any).key).toEqual(1);
    expect((reexecuteOperation.mock.calls[0][0] as any).query).toEqual(
      formatDocument(mutationOp.query)
    );
  });

  it('should retry other optimistic mutations when an un-retryable error occurs', () => {
    const onlineSpy = jest.spyOn(navigator, 'onLine', 'get');

    const client = createClient({ url: 'http://0.0.0.0' });
    const queryOp = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
    });

    const reexecuteOperation = jest
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(() => undefined);

    const validMutationOp = client.createRequestOperation('mutation', {
      key: 2,
      query: mutationTwo,
      variables: {
        name: 'name vars'
      },
    });

    const failMutationOp = client.createRequestOperation('mutation', {
      key: 3,
      query: mutationOne,
      variables: {},
    });

    const response = jest.fn(
      (forwardOp: Operation): OperationResult => {
        if (forwardOp.key === queryOp.key) {
          onlineSpy.mockReturnValueOnce(true);
          return { operation: forwardOp, data: queryOneData };
        } else if (forwardOp.key === failMutationOp.key) {
          onlineSpy.mockReturnValueOnce(true);
          return {
            operation: forwardOp,
            error: {
              name: 'error name',
              message: 'error message',
              graphQLErrors: [new GraphQLError('big bad error')]
            }
          }
        } else {
          onlineSpy.mockReturnValueOnce(false);
          return {
            operation: forwardOp,
            // @ts-ignore
            error: { networkError: new Error('failed to fetch'), graphQLErrors: [] },
          };
        }
      }
    );

    const { source: ops$, next } = makeSubject<Operation>();
    const result = jest.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response));

    storage.readData.mockReturnValueOnce({ then: () => undefined });
    storage.readMetadata.mockReturnValueOnce({ then: () => undefined });
    storage.writeMetadata.mockReturnValue({ then: () => undefined });

    pipe(
      offlineExchange({
        storage,
        persistedContext: [],
        isRetryableError: (res) => res.operation.key !== failMutationOp.key,
        optimistic: {
          updateAuthor: () => ({
            id: '123',
            name: 'URQL',
            __typename: 'Author',
          }),
        },
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(validMutationOp);
    expect(result).toBeCalledTimes(0);
    expect(storage.writeMetadata).toBeCalledTimes(1);
    expect(storage.writeMetadata).toHaveBeenCalledWith([
      {
        query: `mutation ($name: string) {
  updateAuthor(name: $name) {
    id
    name
    __typename
  }
}`,
        variables: {
          name: 'name vars'
        },
        context: {}
      },
    ]);

    next(failMutationOp);
    expect(result).toBeCalledTimes(2);
    expect(result.mock.calls[0][0].operation).toMatchObject({
      kind: 'teardown',
      key: validMutationOp.key
    })
    expect(result.mock.calls[1][0]).toMatchObject({
      operation: {
        key: failMutationOp.key,
        kind: 'mutation',
      },
      error: {
        name: 'error name',
        graphQLErrors: expect.any(Array),
      },
    })
    expect(reexecuteOperation).toHaveBeenCalledTimes(1);
    expect((reexecuteOperation.mock.calls[0][0] as any).key).toEqual(validMutationOp.key);
    expect((reexecuteOperation.mock.calls[0][0] as any).variables).toEqual(validMutationOp.variables);
    expect((reexecuteOperation.mock.calls[0][0] as any).query).toEqual(
      formatDocument(validMutationOp.query)
    );
    expect(storage.writeMetadata).toBeCalledTimes(3);
    // TODO how could I set this up so that the optimistic result is still the same after rexecuteOperation
    // would need to have some way of getting rexecuteOperation to actually do something :(
    // currently this last write metadata call is just to be used as the clear of the flush queue

    next(queryOp);
    expect(result).toBeCalledTimes(3);
    expect(result.mock.calls[2][0].data).toMatchObject(queryOneData);
  });

  it('does not re-execute mutations that have successfully returned', () => {
    let flush: () => {};
    storage.onOnline.mockImplementation(cb => {
      flush = cb;
    });

    const client = createClient({ url: 'http://0.0.0.0' });
    const reexecuteOperation = jest
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(() => undefined);

    const mutationOp = client.createRequestOperation('mutation', {
      key: 1,
      query: mutationOne,
      variables: {},
    });

    const response = jest.fn(
      (forwardOp: Operation): OperationResult => {
        return { operation: forwardOp, data: mutationOneData };
      }
    );

    const { source: ops$, next } = makeSubject<Operation>();
    const result = jest.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response));

    storage.readData.mockReturnValueOnce({ then: () => undefined });
    storage.readMetadata.mockReturnValueOnce({ then: () => undefined });
    storage.writeMetadata.mockReturnValueOnce({ then: () => undefined });

    pipe(
      offlineExchange({
        storage,
        persistedContext: [],
        isRetryableError: () => true,
        optimistic: {
          updateAuthor: () => ({
            id: '123',
            name: 'URQL',
            __typename: 'Author',
          }),
        },
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(mutationOp);
    expect(storage.writeMetadata).toBeCalledTimes(2);
    expect(storage.writeMetadata).toHaveBeenCalledWith([
      {
        query: `mutation {
  updateAuthor {
    id
    name
    __typename
  }
}`,
        variables: {},
        context: {},
      },
    ]);
    expect(storage.writeMetadata).toHaveBeenCalledWith([]);

    flush!();
    expect(reexecuteOperation).toHaveBeenCalledTimes(0);
  })
});

// persisted context test
// [x] only chooses keys that come in config

// Change to inflightOperations (can probably combine some of these)
// [x] updating metadata when a mutation hasn't failed yet (how does this work with next being sync and all that jazz)
// [x] deleted from inflight when a valid mutaion comes back
// [kinda] deleted when it's an unretryable error - (kinda b/c only loosely tested because re-execute doesn't do anything
// [x] persisted if it's an error that can be retried

// Retries
// [x] - basic case for a queued up mutation and a retry
// [kinda] - multiple stacked mutations (kinda b/c one test with a fail)
// [] - returned optimistic results from mutations
// [] -

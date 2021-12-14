import {pipe, merge, makeSubject, share, filter, tap} from 'wonka';
import {print, SelectionNode} from 'graphql';

import {
  Operation,
  Exchange,
  ExchangeIO,
  CombinedError,
  createRequest,
  makeOperation,
} from '@urql/core';

import {
  getMainOperation,
  getFragments,
  isInlineFragment,
  isFieldNode,
  shouldInclude,
  getSelectionSet,
  getName,
} from './ast';

import {
  SerializedRequest,
  OptimisticMutationConfig,
  Variables,
  CacheExchangeOpts,
} from './types';

import { pick } from 'lodash';

import { makeDict } from './helpers/dict';
import { cacheExchange } from './cacheExchange';
import { toRequestPolicy } from './helpers/operation';
import type {OperationResult} from 'urql';

/** Determines whether a given query contains an optimistic mutation field */
const isOptimisticMutation = <T extends OptimisticMutationConfig>(
  config: T,
  operation: Operation
) => {
  const vars: Variables = operation.variables || makeDict();
  const fragments = getFragments(operation.query);
  const selections = [...getSelectionSet(getMainOperation(operation.query))];

  let field: void | SelectionNode;
  while ((field = selections.pop())) {
    if (!shouldInclude(field, vars)) {
      continue;
    } else if (!isFieldNode(field)) {
      const fragmentNode = !isInlineFragment(field)
        ? fragments[getName(field)]
        : field;
      if (fragmentNode) selections.push(...getSelectionSet(fragmentNode));
    } else if (config[getName(field)]) {
      return true;
    }
  }

  return false;
};

export const isOfflineError = (error: undefined | CombinedError) =>
  error &&
  error.networkError &&
  !error.response &&
  ((typeof navigator !== 'undefined' && navigator.onLine === false) ||
    /request failed|failed to fetch|network\s?error/i.test(
      error.networkError.message
    ));

export const isDeadlockMutation = (error: undefined | CombinedError) => {
  const deadlockRegex = /deadlock/i;
  return error && error.graphQLErrors.some(e=> e.message.match(deadlockRegex))
}

export const offlineExchange = <C extends Partial<CacheExchangeOpts> & {
  persistedContext: Array<string>,
  isRetryableError: (res: OperationResult) => boolean
}>(
  opts: C
): Exchange => input => {
  const { storage, persistedContext, isRetryableError } = opts;

  if (
    storage &&
    storage.onOnline &&
    storage.readMetadata &&
    storage.writeMetadata
  ) {
    const { forward: outerForward, client, dispatchDebug } = input;
    const { source: reboundOps$, next } = makeSubject<Operation>();
    const optimisticMutations = opts.optimistic || {};
    const inFlightOperations = new Map<number, Operation>();

    const updateMetadata = () => {
      const requests: SerializedRequest[] = [];
      for (const operation of inFlightOperations.values()) {
        if (operation.kind === 'mutation') {
          requests.push({
            query: print(operation.query),
            variables: operation.variables,
            context: pick(operation.context, persistedContext),
          });
        }
      }
      storage.writeMetadata!(requests);
    };

    let isFlushingQueue = false;
    const flushQueue = () => {
      // TODO have a retry mode for doing optimistic mutations, another for doing failures?
      if (!isFlushingQueue) {
        isFlushingQueue = true;

        for (const operation of inFlightOperations.values()) {
          if (operation.kind === 'mutation') {
            next(makeOperation('teardown', operation));
          }
        }

        for (const operation of inFlightOperations.values())
          client.reexecuteOperation(operation);

        inFlightOperations.clear();
        isFlushingQueue = false;
        updateMetadata();
      }
    };

    const isUnretryableOptimisticMutation = (res: OperationResult) => {
      const { operation, error } = res;
      return operation.kind === 'mutation' &&
        isOptimisticMutation(optimisticMutations, operation) &&
        error &&
        !isRetryableError(res)
    }

    const forward: ExchangeIO = ops$ => {
      return pipe(
        outerForward(
          pipe(
            ops$,
            tap((op) => {
              if (op.kind === 'mutation' && isOptimisticMutation(optimisticMutations, op)) {
                inFlightOperations.set(op.key, op)
                updateMetadata();
              }
            }),
          )
        ),
        filter((res) => {
          // Testing for retrying this deadlock stuff (not permanent solution)
          // This is in place because when we hit an retryable error we do not immediately flush-queue (that's un-retryable errors)
          const { error, operation } = res;
          if (isDeadlockMutation(error)) {
            console.log('deadlock mutation hit, retry that op');
            // flushQueue();
            client.reexecuteOperation(operation);
            return false;
          }
          return true;
        }),
        filter(res => {
          // Don't let optimistic mutations that should be retried make it to graphcache and clear optimistic layer
          if (
            res.operation.kind === 'mutation' &&
            res.error &&
            isOptimisticMutation(optimisticMutations, res.operation) &&
            isRetryableError(res)
          ) {
            return false;
          }

          return true;
        }),
        tap(res => {
          // Handle valid responses from optimistic mutations. Delete from inFlightOperations
          if(res.operation.kind === 'mutation' && isOptimisticMutation(optimisticMutations, res.operation) && !res.error) {
           inFlightOperations.delete(res.operation.key);
           updateMetadata();
          }
        }),
        tap((res) => {
          // Handle optimistic mutation that is non-retryable. Replay mutations to restore optimistic layer
          if (isUnretryableOptimisticMutation(res)) {
            inFlightOperations.delete(res.operation.key);
            flushQueue();
          }
        }),
      );
    };

    storage.onOnline(flushQueue);
    storage.readMetadata().then(mutations => {
      if (mutations) {
        for (let i = 0; i < mutations.length; i++) {
          const operation = client.createRequestOperation(
            'mutation',
            createRequest(mutations[i].query, mutations[i].variables),
            mutations[i].context,
          );
          inFlightOperations.set(operation.key, operation)
        }

        flushQueue();
      }
    });

    const cacheResults$ = cacheExchange(opts)({
      client,
      dispatchDebug,
      forward,
    });

    return ops$ => {
      const sharedOps$ = share(ops$);
      const opsAndRebound$ = merge([reboundOps$, sharedOps$]);

      return pipe(
        cacheResults$(opsAndRebound$),
        filter(res => {
          if (res.operation.kind === 'query' && isOfflineError(res.error)) {
            next(toRequestPolicy(res.operation, 'cache-only'));
            inFlightOperations.set(res.operation.key, res.operation);
            return false;
          }

          return true;
        }),
      );
    };
  }

  return cacheExchange(opts)(input);
};

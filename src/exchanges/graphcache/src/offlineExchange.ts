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

const isOfflineError = (error: undefined | CombinedError) =>
  error &&
  error.networkError &&
  !error.response &&
  ((typeof navigator !== 'undefined' && navigator.onLine === false) ||
    /request failed|failed to fetch|network\s?error/i.test(
      error.networkError.message
    ));

export const offlineExchange = <C extends Partial<CacheExchangeOpts> & { persistedContext: Array<string>}>(
  opts: C
): Exchange => input => {
  const { storage, persistedContext } = opts;

  /*
  TODO list
  [] - replace failed queue with the inFlightOperations queue (rename to pending queue)
        this is going to be non-optimal because we'll be resending (that's fine solve later)
        can persist operations right away
   */

  if (
    storage &&
    storage.onOnline &&
    storage.readMetadata &&
    storage.writeMetadata
  ) {
    const { forward: outerForward, client, dispatchDebug } = input;
    const { source: reboundOps$, next } = makeSubject<Operation>();
    const optimisticMutations = opts.optimistic || {};
    const failedQueue: Operation[] = [];
    const inFlightOperations = new Map<number, Operation>();

    const updateMetadata = () => {
      const requests: SerializedRequest[] = [];
      for (let i = 0; i < failedQueue.length; i++) {
        const operation = failedQueue[i];
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
      if (!isFlushingQueue) {
        isFlushingQueue = true;

        for (let i = 0; i < failedQueue.length; i++) {
          const operation = failedQueue[i];
          if (operation.kind === 'mutation') {
            next(makeOperation('teardown', operation));
          }
        }

        for (let i = 0; i < failedQueue.length; i++)
          client.reexecuteOperation(failedQueue[i]);

        failedQueue.length = 0;
        isFlushingQueue = false;
        updateMetadata();
      }
    };

    /*
    TODO Determining if operation is a failures
    - network errors should never count (unless their status codes are something we know is doomed)
    - graphql errors are less likely to be recoverable
    - should there be one config that is passed in as config
    shouldReplay: op => true || false

    [] - Operations can have cache results while still in flight
    [] - Operations can have errors but also have data --> should we support this?
     */
    const isRetryableError = (res) => {
      return isOfflineError(res.error);
    }

    // TODO use thie logic
    const isUnretryableOptimisticMutation = (res) => {
      const { operation } = res;
      return operation.kind === 'mutation' && isOptimisticMutation(optimisticMutations, operation) && res.error && !isRetryableError(res.operation)
    }

    const forward: ExchangeIO = ops$ => {
      return pipe(
        outerForward(
          pipe(
            ops$,
            tap((op) => {
              if (op.kind === 'mutation' && isOptimisticMutation(optimisticMutations, op)) {
                inFlightOperations.set(op.key, op)
              }
            }),
          )
        ),
        filter(res => {
          if (
            res.operation.kind === 'mutation' &&
            isRetryableError(res) &&
            isOptimisticMutation(optimisticMutations, res.operation)
          ) {
            failedQueue.push(res.operation);
            // TODO we are only saving data on failures (this could be issue)?
            updateMetadata();
            return false;
          }

          return true;
        }),
        tap(res => {
          if(res.operation.kind === 'mutation' && isOptimisticMutation(optimisticMutations, res.operation) && !res.error) {
            console.log('delete valid response', res)
           inFlightOperations.delete(res.operation.key);
          }
        }),
        tap((res) => {
          // TODO use isUnretryableOptimisticMutation
          if (isOptimisticMutation(optimisticMutations, res.operation) && res.error) {
            // Handle genuine failure for optimisic and replay operations
            inFlightOperations.delete(res.operation.key);

            for (const op of inFlightOperations.values()) {
              next(makeOperation('teardown', op));
            }
            for (const op of inFlightOperations.values()) {
              console.log('retry this', op);
              inFlightOperations.delete(op.key);
              // TODO later consider not re-excuting because some request may already be outstanding
              client.reexecuteOperation(op)
            }

            //   const x = inFlightOperations.
            //   for (let i = 0; i < failedQueue.length; i++) {
            //     const operation = failedQueue[i];
            //     if (operation.kind === 'mutation') {
            //       next(makeOperation('teardown', operation));
            //     }
            //   }
            //
            //   for (let i = 0; i < failedQueue.length; i++)
            //     client.reexecuteOperation(failedQueue[i]);
          }
        }),
      );
    };

    storage.onOnline(flushQueue);
    storage.readMetadata().then(mutations => {
      if (mutations) {
        for (let i = 0; i < mutations.length; i++) {
          failedQueue.push(
            client.createRequestOperation(
              'mutation',
              createRequest(mutations[i].query, mutations[i].variables),
              mutations[i].context,
            )
          );
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
            failedQueue.push(res.operation);
            return false;
          }

          return true;
        }),
        // tap((res) => {
        //   console.log('offlineExchange tap', res.operation.key, res, inFlightOperations)
        // })
      );
    };
  }

  return cacheExchange(opts)(input);
};

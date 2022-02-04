import type { Source } from 'wonka';
import {fromArray, interval, pipe, makeSubject, map, merge, mergeMap, share, filter, subscribe, tap} from 'wonka';
import {print, SelectionNode } from 'graphql';

import type { Client } from 'urql';

import {
  Operation,
  Exchange,
  ExchangeIO,
  CombinedError,
  createRequest,
  makeOperation,
  getOperationName,
  makeResult,
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

import { cloneDeep, isArray, values, keyBy, mergeWith, uniq, filter as lFilter } from 'lodash';

import { makeDict } from './helpers/dict';
import { cacheExchange } from './cacheExchange';
import { toRequestPolicy } from './helpers/operation';
import type {OperationResult} from 'urql';

function getUniqueListBy<T, K extends keyof T>(arr: T[], key: K) {
  return [...new Map(arr.map(item => [item[key], item])).values()]
}

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
  return error && error.graphQLErrors.some(e=> e.message.match(deadlockRegex));
};

/**
 * Returns the value associated with the *more recent* timestamp. Null is considered older than any timestamp.
 *
 * Returns undefined when both timestamps are falsy.
 *
 * @param ts1 timestamp associated with value 1
 * @param ts2 timestamp associated with value 2
 * @param value1 value 1
 * @param value2 value 2
 */
 const compareTs = (ts1: string | null, ts2: string | null, value1: any, value2: any) => {
  if (!ts1 && !ts2) {
    return undefined;
  }
  if (!ts1) {
    return value2;
  }
  if (!ts2) {
    return value1;
  }
  const compareRes = ts1.localeCompare(ts2);
  if (compareRes <= 0) {
    return value2;
  }
  return value1;
}

const mergeWithTimestampsCustomizer = (value: any, srcValue: any, key: string, object: any, source: any): any => {
  if (isArray(value)) {
    return values(mergeWith(keyBy(value, 'uuid'), keyBy(srcValue, 'uuid'), mergeWithTimestampsCustomizer));
  }

  if(object?.timestamps?.[key] || source?.timestamps?.[key]) {
    return compareTs(object?.timestamps?.[key], source?.timestamps?.[key], value, srcValue);
  }

  // TODO way to standadize this key
  // TODO perf. opti. does this need to get cloned?
  if (key === 'timestamps') {
    return mergeWith(cloneDeep(value), cloneDeep(srcValue), (v, srcV) => {
      return compareTs(v, srcV, v, srcV);
    })
  }
}

const mergeOptimisticIntoServerCustomizer = (value: any, srcValue: any, key: string, object: any, source: any): any => {
  if (isArray(value)) {
    const v = keyBy(value, 'uuid');
    const srcValues = keyBy(srcValue, 'uuid');
    const removedExtras = lFilter(v, (val => {
      return srcValues[val.uuid]
    }));
    return values(mergeWith(keyBy(removedExtras, 'uuid'), srcValues, mergeOptimisticIntoServerCustomizer));
  }
}

const mergeWithTimestamps = (existing: any, newValues: any) => {
  return mergeWith(cloneDeep(existing), cloneDeep(newValues), mergeWithTimestampsCustomizer);
}

const isCrdtOperation = (operation: Operation) => {
  const operationName = getOperationName(operation.query)!;
  return ['GetInspections', 'CreateOrUpdateInspection'].includes(operationName);
}

const isQueryDependentOnMutation = (query: QueryOperation, mutation: MutationOperation) => {
  const isInspectionsList = getOperationName(query.query) === 'GetInspections';
  const isSameInspectionUuid =
    query.variables?.inspectionInput?.inspection?.uuid === mutation.variables?.inspectionInput?.inspection?.uuid;
  console.log('isQueryDependentOnMutation', isInspectionsList, isSameInspectionUuid, query, mutation);

  return isInspectionsList || (isSameInspectionUuid && !!isSameInspectionUuid);
};

interface QueryOperation extends Operation {
  kind: 'query';
}

interface MutationOperation extends Operation {
  kind: 'mutation';
}

interface CoalescedMutationOperation extends MutationOperation {
  context: MutationOperation['context'] & {
    crdtMeta: {
      originalMutations: MutationOperation['key'][];
    };
  }
}

interface MutationOperationResult extends OperationResult {
  operation: MutationOperation;
}

interface MutationOperationCoalescedResult extends MutationOperationResult {
  operation: CoalescedMutationOperation;
}

class CrdtMutations {
  #client: Client;
  #next: (op: Operation) => void;

  #mutations = new Map<MutationOperation['key'], MutationOperation>();
  #queries = new Map<QueryOperation['key'], QueryOperation>();

  #unsubscribe: null | (() => void) = null;

  constructor(client: Client, next: (op: Operation) => void, flushInterval = 500) {
    this.#client = client;
    this.#next = next;
  }

  addMutation(mutation: MutationOperation) {
    this.#mutations.set(mutation.key, mutation);

    const dependentQueries = this.collectDependentQueries(mutation);
    for (const dependentQuery of dependentQueries) {
      this.#client.reexecuteOperation(dependentQuery);
    }

    if (!this.#unsubscribe) {
      this.#unsubscribe = pipe(
        interval(10000),
        subscribe((n) => {
          console.log(`processing mutations ${n}...`);
          this.sendMutations();
        }),
      ).unsubscribe;
    }
    return this;
  }

  addQuery(query: QueryOperation) {
    this.#queries.set(query.key, query);

    return this;
  }

  teardown(operation: Operation) {
    this.#queries.delete(operation.key);
    this.removeMutation(operation);

    return this;
  }

  applyCoalescedResult(mutationResult: MutationOperationCoalescedResult) {
    // this.removeMutation(mutationResult.operation);
    const originalMutations = mutationResult.operation.context.crdtMeta.originalMutations.map(key => {
      return this.#mutations.get(key);
    }).filter((m): m is MutationOperation => !!m);

    const dependentQueries = getUniqueListBy(
        originalMutations.map(mutation => this.removeMutation(mutation))
        .flat()
        .filter((q): q is QueryOperation => !!q),
      'key'
    );

    console.log('applyCoalescedResult', mutationResult, originalMutations, dependentQueries);

    for (const dependentQuery of dependentQueries) {
      this.#client.reexecuteOperation(dependentQuery);
    }

    const syntheticMutationResults = originalMutations.map(mutation => {
      return makeResult(mutation, mutationResult);
    });

    return syntheticMutationResults;
  }

  patchResult() {

  }

  sendMutations() {
    // TODO limp mode - don't coalesce
    const [firstMutation] = this.#mutations.values();
    const likeMutations = Array.from(this.likeMutations(firstMutation));

    const coalescedVariables = likeMutations.reduce<MutationOperation['variables']>((merged, mutation) => mergeWithTimestamps(merged, mutation.variables), {});

    const coalescedMutation = this.#client.createRequestOperation(
      'mutation',
      createRequest(firstMutation.query, coalescedVariables),
      {
        crdtMeta: {
          originalMutations: likeMutations.map(m => m.key),
        }
      }
    );

    this.#next(coalescedMutation);

    // for (const mutation of this.#mutations.values()) {
    //   const coelesedMutation = makeOperation(mutation.kind, mutation, {
    //     ...mutation.context,
    //     crdtMeta: {
    //       ...mutation.context.crdtMeta,
    //       originalMutations: [mutation.key],
    //     },
    //   });
    //   this.#next(coelesedMutation);
    // }
  }

  *likeMutations(mutation: MutationOperation, predicate?: (m1: MutationOperation, m2: MutationOperation) => boolean) {
    // TODO: more robust matching up between mutations
    // what if context is different? etc
    predicate = predicate || ((m1, m2) => {
      const matchingMutationName = getOperationName(m1.query) === getOperationName(m2.query);
      const matchingUuid = m1.variables.inspectionInput.inspection.uuid === m2.variables.inspectionInput.inspection.uuid;

      return matchingMutationName && matchingUuid;
    });

    for (const v of this.#mutations.values()) {
      if (predicate(mutation, v)) {
        yield v;
      }
    }
  }

  mutations() {
    return Array.from(this.#mutations.values());
  }

  private removeMutation(mutation: Operation) {
    const dependentQueries = this.collectDependentQueries(mutation as MutationOperation);
    this.#mutations.delete(mutation.key)

    if (this.#mutations.size === 0 && this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }

    return dependentQueries;
  }

  private collectDependentQueries(mutation: MutationOperation) {
    let dependentQueries: QueryOperation[] = [];
    if (this.#mutations.has(mutation.key)) {
      for (const query of this.#queries.values()) {
        if (isQueryDependentOnMutation(query, mutation as MutationOperation)) {
          dependentQueries.push(query);
        }
      }
    }

    return dependentQueries;
  }
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
    const failedQueries: Operation[] = [];

    // const inFlightQueries = new Map<Operation['key'], Operation>();
    // const crdtMutations = new Map<Operation['key'], Operation>();
    const crdtMutations = new CrdtMutations(client, next);

    let isFlushingFailedQueries = false;
    const flushFailedQueries = () => {
      if (!isFlushingFailedQueries) {
        isFlushingFailedQueries = true;

        for (let i = 0; i < failedQueries.length; i++) {
          const operation = failedQueries[i];
          if (operation.kind === 'mutation') {
            next(makeOperation('teardown', operation));
          }
        }

        for (let i = 0; i < failedQueries.length; i++)
          client.reexecuteOperation(failedQueries[i]);

        failedQueries.length = 0;
        isFlushingFailedQueries = false;
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
      return outerForward(ops$);
    };

    storage.onOnline(flushFailedQueries);
    storage.readMetadata().then(mutations => {
      if (mutations) {
        // TODO: restore mutations

        // for (let i = 0; i < mutations.length; i++) {
        //   const operation = client.createRequestOperation(
        //     'mutation',
        //     createRequest(mutations[i].query, mutations[i].variables),
        //     mutations[i].context,
        //   );
        //   inFlightQueries.set(operation.key, operation)
        // }

        // flushQueue();
      }
    });

    const cacheResults$ = cacheExchange(opts)({
      client,
      dispatchDebug,
      forward,
    });

    return ops$ => {
      const sharedOps$ = pipe(
        ops$,
        share,
      );

      const crdtOperations$ = pipe(
        sharedOps$,
        filter(operation => {
          return isCrdtOperation(operation);
        }),
        tap(operation => {
          switch (operation.kind) {
            case 'query':
              crdtMutations.addQuery(operation as QueryOperation);
              break;
            case 'teardown':
              // TODO: teardowns for mutations? can they happen? when?
              crdtMutations.teardown(operation);
              break;
            }
        }),
        filter(operation => {
          if (operation.kind === 'mutation') {
            crdtMutations.addMutation(operation as MutationOperation);
            return false;
          }

          return true;
        })
      );

      const nonCrdtOperations$ = pipe(
        sharedOps$,
        filter(operation => {
          return !isCrdtOperation(operation);
        }),
        tap(operation => {

        }),
      );

      const opsAndRebound$ = merge([reboundOps$, crdtOperations$, nonCrdtOperations$]);

      const removeOfflineResultsAndReexecuteCacheOnly = (res: OperationResult) => {
        if (res.operation.kind === 'query' && isOfflineError(res.error)) {
          next(toRequestPolicy(res.operation, 'cache-only'));
          failedQueries.push(res.operation);
          return false;
        }

        return true;
      }

      const results$ = pipe(
        pipe(
          opsAndRebound$,
          tap((operation) => {
            console.log('opsandrebound', operation, crdtMutations.mutations());
          }),
          cacheResults$,
        ),
        filter(removeOfflineResultsAndReexecuteCacheOnly),
        mergeMap(result => {
          // TODO check that result mutation is a coalesced result (crdtMeta.originalMutations)
          if (result.operation.kind === 'mutation' && isCrdtOperation(result.operation)) {
            return fromArray(crdtMutations.applyCoalescedResult(result as MutationOperationCoalescedResult));
          } else if (result.operation.kind === 'query' && isCrdtOperation(result.operation)) {
            // TODO: patch result data
            const patchedResult = crdtMutations.patchResult(result);
            console.log('patching result...', result, patchedResult);
            return fromArray([result]);
          }

          return fromArray([result]);
        }),
      );

      return results$;
    };
  }

  return cacheExchange(opts)(input);
};

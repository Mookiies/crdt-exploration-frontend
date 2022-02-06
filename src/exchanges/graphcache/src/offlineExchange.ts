import type { Source } from 'wonka';
import {fromArray, interval, pipe, makeSubject, map, merge, mergeMap, share, filter, subscribe, tap} from 'wonka';
import { buildSchema, getOperationAST, getDirectiveValues, SelectionNode, visit } from 'graphql';

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

  if (object?.timestamps?.[key] || source?.timestamps?.[key]) {
    return compareTs(object?.timestamps?.[key], source?.timestamps?.[key], value, srcValue);
  }

  // TODO way to standadize this key
  if (key === 'timestamps') {
    return mergeWith({}, value, srcValue, (v, srcV) => {
      return compareTs(v, srcV, v, srcV);
    });
  }
}

const mergeWithTimestamps = (existing: any, newValues: any) => {
  return mergeWith({}, existing, newValues, mergeWithTimestampsCustomizer);
}

const isCrdtOperation = (operation: Operation) => {
  const operationName = getOperationName(operation.query)!;
  return ['GetInspection', 'GetInspections', 'CreateOrUpdateInspection'].includes(operationName);
}

const isQueryDependentOnMutation = (query: QueryOperation, mutation: MutationOperation) => {
  const isInspectionsList = getOperationName(query.query) === 'GetInspections';
  const isSameInspectionUuid =
    getOperationName(query.query) === 'GetInspection'
    && query.variables?.inspectionInput?.inspection?.uuid === mutation.variables?.inspectionInput?.inspection?.uuid;
  console.log('isQueryDependentOnMutation', isInspectionsList, isSameInspectionUuid, query, mutation);

  return isInspectionsList || isSameInspectionUuid;
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

interface QueryOperationResult extends OperationResult {
  operation: QueryOperation;
}

type CrdtPatch = {
  key: {
    __typename: string;
    id: string;
  };
  data: any;
};

type PatchExtractor = (mutation: MutationOperation) => CrdtPatch[];

type PatchExtractorConfig = Partial<Record<string, PatchExtractor>>;

type QueryUpdater = (result: QueryOperationResult, patches: CrdtPatch[]) => {
  result: OperationResult;
  patches: CrdtPatch[];
};

type QueryUpdaterConfig = Partial<Record<string, QueryUpdater>>;

function isMutationOperationResult(result: OperationResult): result is MutationOperationResult {
  return result.operation.kind === 'mutation';
}

function isMutationOperationCoalescedResult(result: OperationResult): result is MutationOperationCoalescedResult {
  return isMutationOperationResult(result)
    && Array.isArray(result.operation.context?.crdtMeta?.originalMutations);
}

function isQueryOperationResult(result: OperationResult): result is QueryOperationResult {
  return result.operation.kind === 'query';
}

class CrdtPatchApplier {
  #patches = new Map<string, CrdtPatch>();

  add(newPatch: CrdtPatch) {
    const key = JSON.stringify(newPatch.key);
    let patch = this.#patches.get(key);
    if (patch) {
      patch.data = mergeWithTimestamps(patch.data, newPatch.data) as CrdtPatch['data'];
    } else {
      patch = cloneDeep(newPatch);
    }

    this.#patches.set(key, patch);

    return patch;
  }

  get(key: CrdtPatch['key']) {
    return this.#patches.get(JSON.stringify(key));
  }

  clear() {
    return this.#patches.clear();
  }

  patches() {
    return Array.from(this.#patches.values());
  }
}

const patchExtractor: PatchExtractorConfig = {
  CreateOrUpdateInspection: (mutation) => {
    const __typename = 'Inspection';
    const id = mutation.variables.inspectionInput.inspection.uuid;
    return [{
      key: {
        __typename,
        id,
      },
      data: mutation.variables.inspectionInput.inspection,
    }];
  },
};

const queryUpdater: QueryUpdaterConfig = {
  GetInspections: (result, patches) => {
    const crdtPatchApplier = new CrdtPatchApplier();

    // todo: Don't loop through all inspections - only add those which are in patches
    result?.data?.allInspections?.forEach((inspection: any) => {
      crdtPatchApplier.add({
        key: {
          __typename: 'Inspection',
          id: inspection.uuid,
        },
        data: inspection,
      })
    });

    patches.forEach(patch => {
      crdtPatchApplier.add(patch);
    });

    return {
      result: makeResult(result.operation, {
        ...result,
        data: {
          allInspections: crdtPatchApplier.patches().map(crdtPatch => crdtPatch.data),
        },
      }),
      patches: crdtPatchApplier.patches(),
    };
  },
};

// CrdtMutations -> CrdtManager
// create CrdtObject which has a view over an iterable in manager
// each one manages its own queue
// manager has a callback to remove it from a set (or weakset?) when there's nothing left in its view
// view could have options to combine across all, or skip different ones
// could spawn a max number of uploads from central manager

class CrdtMutations {
  #client: Client;
  #next: (op: Operation) => void;

  #mutations = new Map<MutationOperation['key'], MutationOperation>();
  #queries = new Map<QueryOperation['key'], QueryOperation>();

  #optimisticState = new CrdtPatchApplier();
  #unsubscribe: null | (() => void) = null;

  constructor(client: Client, next: (op: Operation) => void, flushInterval = 500) {
    this.#client = client;
    this.#next = next;
  }

  // TODO allow adding mutations in bulk so we can update optimistic state and execute dependent queries only once
  addMutation(mutation: MutationOperation) {
    this.#mutations.set(mutation.key, mutation);

    this.updateOptimisticState([mutation]);

    const dependentQueries = this.collectDependentQueries(mutation);
    for (const dependentQuery of dependentQueries) {
      this.#client.reexecuteOperation(dependentQuery);
    }

    if (!this.#unsubscribe) {
      this.#unsubscribe = pipe(
        interval(5000),
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
    if (this.#mutations.has(operation.key)) {
      this.removeMutations([operation as MutationOperation], true);
    }

    return this;
  }

  applyResult(result: OperationResult) {
    if (isMutationOperationCoalescedResult(result)) {
      return this.applyCoalescedMutation(result);
    } else if (isQueryOperationResult(result)) {
      return this.applyQuery(result);
    }

    return [result];
  }

  private applyCoalescedMutation(mutationResult: MutationOperationCoalescedResult) {
    // TODO check the result, success, fail? mark if so

    const originalMutations = mutationResult.operation.context.crdtMeta.originalMutations.map(key => {
      return this.#mutations.get(key);
    }).filter((m): m is MutationOperation => !!m);

    this.removeMutations(originalMutations, false);

    const syntheticMutationResults = originalMutations.map(mutation => {
      return makeResult(mutation, mutationResult);
    });

    return syntheticMutationResults;
  }

  private applyQuery(originalResult: QueryOperationResult) {
    const operationName = getOperationName(originalResult.operation.query);
    if (operationName && queryUpdater[operationName]) {
      const { result, patches } = queryUpdater[operationName]!(originalResult as QueryOperationResult, this.#optimisticState.patches());

      // use the patches of the query to update our own optimistic state
      // since we could get a server result that has newer things that just the inputs of our mutations
      patches.forEach(p => this.#optimisticState.add(p));

      return [result];
    } else {
      console.warn('Could not patch optimistic state on result', originalResult);
    }

    return [originalResult];
  }

  sendMutations() {
    // TODO limp mode - don't coalesce
    const [firstMutation] = this.mutations;
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
  }

  *likeMutations(mutation: MutationOperation, predicate?: (m1: MutationOperation, m2: MutationOperation) => boolean) {
    // TODO: more robust matching up between mutations
    // what if context is different? etc
    predicate = predicate || ((m1, m2) => {
      const matchingMutationName = getOperationName(m1.query) === getOperationName(m2.query);
      const matchingUuid = m1.variables.inspectionInput.inspection.uuid === m2.variables.inspectionInput.inspection.uuid;

      return matchingMutationName && matchingUuid;
    });

    for (const v of this.mutations) {
      if (predicate(mutation, v)) {
        yield v;
      }
    }
  }

  get mutations() {
    return Array.from(this.#mutations.values());
  }

  private removeMutations(mutations: MutationOperation[], resetOptimisticState: boolean) {
    const dependentQueries = getUniqueListBy(
        mutations.map(mutation => {
          const deleted = this.#mutations.delete(mutation.key);

          if (deleted) {
            return this.collectDependentQueries(mutation as MutationOperation);
          } else {
            return [];
          }
        })
        .flat(),
      'key'
    );

    if (this.#mutations.size === 0 && this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }

    // TODO: only remove optimistic state that's absolutely necessary by the mutation key
    if (resetOptimisticState) {
      this.#optimisticState.clear();
    }

    // TODO: we actually should update using a) all the entities we affected by deleting them
    // or b) just re-run all of them
    this.updateOptimisticState(this.mutations);

    for (const dependentQuery of dependentQueries) {
      this.#client.reexecuteOperation(dependentQuery);
    }
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

  private updateOptimisticState(mutations: MutationOperation[]) {
    mutations.forEach(mutation => {
      const operationName = getOperationName(mutation.query);
      if (operationName && patchExtractor[operationName]) {
        patchExtractor[operationName]!(mutation).forEach(patch => this.#optimisticState.add(patch));
      } else {
        console.warn('Could not extract patch information from mutation', mutation);
      }
    });
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
            console.log('opsandrebound', operation, crdtMutations.mutations, getOperationAST(operation.query), getSelectionSet(getOperationAST(operation.query)));
          }),
          cacheResults$,
        ),
        filter(removeOfflineResultsAndReexecuteCacheOnly),
        mergeMap(result => {
          if (isCrdtOperation(result.operation)) {
            return fromArray(crdtMutations.applyResult(result));
          }

          return fromArray([result]);
        }),
      );

      return results$;
    };
  }

  return cacheExchange(opts)(input);
};

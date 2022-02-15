import type { Draft, Immutable } from 'immer';
import type { Client, CombinedError, Exchange, Operation, OperationResult, RequestPolicy } from 'urql';

import { print } from 'graphql';
import {
  createRequest,
  makeOperation,
  getOperationName,
  makeResult,
} from '@urql/core';
import { enableMapSet, produce } from 'immer';
import { buffer, filter, fromArray, fromPromise, interval, makeSubject, merge, mergeMap, pipe, share, skipUntil, subscribe, tap } from 'wonka';

import { get as lGet, isArray, values, keyBy, mergeWith, set as lSet } from 'lodash';
import type { DefaultStorage } from './graphcache/src/default-storage'; // TODO: Import from @urql package

enableMapSet();

const toRequestPolicy = (
  operation: Operation,
  requestPolicy: RequestPolicy
): Operation => {
  return makeOperation(operation.kind, operation, {
    ...operation.context,
    requestPolicy,
  });
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

export type CrdtExchangeOpts =  {
  isRetryableError: (res: OperationResult) => boolean;
  storage: DefaultStorage,
}

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
    return;
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

const mergeWithTimestampsCustomizer = (targetValue: any, srcValue: any, key: string, target: any, source: any): any => {
  // TODO: way to standardize uuid key
  if (isArray(targetValue)) {
    return values(mergeWith(keyBy(targetValue, 'uuid'), keyBy(srcValue, 'uuid'), mergeWithTimestampsCustomizer));
  }

  if (target?.timestamps?.[key] || source?.timestamps?.[key]) {
    return compareTs(target?.timestamps?.[key], source?.timestamps?.[key], targetValue, srcValue);
  }

  // TODO: way to standardize timestamps key
  if (key === 'timestamps') {
    return mergeWith({}, targetValue, srcValue, (v, srcV) => {
      return compareTs(v, srcV, v, srcV);
    });
  }
}

const mergeWithTimestamps = (existing: any, newValues: any) => {
  return mergeWith({}, existing, newValues, mergeWithTimestampsCustomizer);
}

// TODO: use config information to infer this
const isCrdtOperation = (operation: Operation) => {
  const operationName = getOperationName(operation.query)!;
  return ['GetInspection', 'GetInspections', 'CreateOrUpdateInspection'].includes(operationName);
}

const isQueryDependentOnMutation = (query: QueryOperation, mutation: MutationOperation) => {
  const isInspectionsList = getOperationName(query.query) === 'GetInspections';
  const isSameInspectionUuid =
    getOperationName(query.query) === 'GetInspection'
    && query.variables?.inspectionInput?.inspection?.uuid === mutation.variables?.inspectionInput?.inspection?.uuid;
  //console.log('isQueryDependentOnMutation', isInspectionsList, isSameInspectionUuid, query, mutation);

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

type CrdtObjectPatch = {
  key: {
    __typename: string;
    id: string;
  };
  data: { [k: string]: unknown };
};

type CrdtMutationConfig = {
  key: CrdtObjectPatch['key'];
  path: string;
}

type PatchExtractor = (mutation: MutationOperation) => CrdtMutationConfig;

type PatchExtractorConfig = Partial<Record<string, PatchExtractor>>;

type QueryUpdater = (result: QueryOperationResult, patches: MergedCrdtObjectStore) => {
  result: OperationResult;
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

function serializeCrdtKey(key: CrdtObjectPatch['key']) {
  return `${key.__typename}:${key.id}` as CrdtObjectKey<string, string>;
}

type CrdtObjectKey<Typename extends string, ID extends string> = `${Typename}:${ID}`;

type MergedCrdtObjectStore = Immutable<Map<CrdtObjectKey<string, string>, CrdtObjectPatch['data']>>;

const applyCrdtPatch = produce((draft: Draft<MergedCrdtObjectStore>, newPatch: CrdtObjectPatch) => {
  const key = serializeCrdtKey(newPatch.key);
  let patch = draft.get(key);
  if (patch) {
    patch = mergeWithTimestamps(patch, newPatch.data) as CrdtObjectPatch['data'];
  } else {
    patch = newPatch.data;
  }

  draft.set(key, patch);
});

// TODO: better naming, allow as an option
const patchExtractor: PatchExtractorConfig = {
  CreateOrUpdateInspection: (mutation) => {
    const __typename = 'Inspection';
    const id = mutation.variables.inspectionInput.inspection.uuid;
    return {
      key: {
        __typename,
        id,
      },
      path: 'inspectionInput.inspection',
    };
  },
};

// TODO: better naming, allow as an option
// handle GetInspection
// this doesn't handle fields that need a default, for instance, areas[n].items = []
const queryUpdater: QueryUpdaterConfig = {
  GetInspections: (result, mergedCrdtStore) => {
    let patchedCrdtStore = mergedCrdtStore;
    let remainingInspections = new Set(patchedCrdtStore.keys());

    const patchedInspections = result?.data?.allInspections?.map((inspection: any) => {
      const key = {
        __typename: 'Inspection',
        id: inspection.uuid,
      };
      const serializedKey = serializeCrdtKey(key);

      if (mergedCrdtStore.has(serializedKey)) {
        remainingInspections.delete(serializedKey);
        patchedCrdtStore = applyCrdtPatch(patchedCrdtStore, {
          key,
          data: inspection
        });
        return patchedCrdtStore.get(serializedKey);
      } else {
        return inspection;
      }
    }) ?? [];

    const newInspections = [];
    for (const remainingInspection of remainingInspections) {
      if (!remainingInspection.startsWith('Inspection:')) {
        break;
      }

      const inspection = patchedCrdtStore.get(remainingInspection);
      inspection && newInspections.push(inspection);
    }

    return {
      result: makeResult(result.operation, {
        ...result,
        data: {
          ...result.data,
          allInspections: [...newInspections, ...patchedInspections],
        },
      }),
    };
  },
};

class CrdtManager {
  #client: Client;
  #next: (op: Operation) => void;
  #options: CrdtExchangeOpts;
  #storage: DefaultStorage;

  #mutations = new Map<MutationOperation['key'], MutationOperation>();
  #queries = new Map<QueryOperation['key'], QueryOperation>();

  #optimisticState: MergedCrdtObjectStore = new Map();
  #unsubscribe: null | (() => void) = null;

  hydration: Promise<void>;

  constructor(client: Client, next: (op: Operation) => void, options: CrdtExchangeOpts) {
    this.#client = client;
    this.#next = next;
    this.#options = options;
    this.#storage = options.storage;

    this.hydration = this.#storage.readMetadata!().then(mutations => {
      if (mutations) {
        mutations.forEach((mutation) => {
          const mutationOperation =
            this.#client.createRequestOperation(
              'mutation',
              createRequest(mutation.query, mutation.variables)
            ) as MutationOperation;
          this.#mutations.set(
            mutationOperation.key,
            mutationOperation,
          );
          this._addMutation(mutationOperation);
        });
      }
    })
  }

  addMutation(mutation: MutationOperation) {
    this.#mutations.set(mutation.key, mutation);
    this.persistMutations();

    this._addMutation(mutation);
  }

  private persistMutations() {
    console.log('persistMutations');
    const mutationOps = Array.from(this.#mutations.values());

    const persistedMutations = mutationOps.map((mut) => {
      return {
        query: print(mut.query),
        variables: mut.variables,
      }
    });
    this.#storage.writeMetadata!(persistedMutations);
  }

  // TODO allow adding mutations in bulk so we can update optimistic state and execute dependent queries only once
  _addMutation(mutation: MutationOperation) {

    this.updateOptimisticState([mutation]);

    const dependentQueries = new Set<QueryOperation>();
    this.collectDependentQueries(dependentQueries, mutation);
    for (const dependentQuery of dependentQueries) {
      this.#client.reexecuteOperation(toRequestPolicy(dependentQuery, 'cache-first'));
    }

    if (!this.#unsubscribe) {
      this.#unsubscribe = pipe(
        interval(10000),
        subscribe((n) => {
          ////console.log(`processing mutations ${n}...`);
          // TODO: we should send at a more rapid pace when stuck doing only one mutation a time
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
      this.removeMutations([operation as MutationOperation]);
    }

    return this;
  }

  applyResult(result: OperationResult) {
    if (isMutationOperationResult(result)) {
      return this.applyMutation(result);
    } else if (isQueryOperationResult(result)) {
      return this.applyQuery(result);
    }

    return [result];
  }

  private applyMutation(mutationResult: MutationOperationResult) {
    // TODO:
    // * Better types?
    // * Improve flow control
    // * We can "coalesce" one mutation that then fails, but it takes a retry a second time to recognize that
    //   because originalMutations exists with a size of 1
    // * Potential optimization: if a previously failedInCoalescing mutation then permanently fails, we may be
    //   able to re-mark the mutations after that as being good, with the idea that only one permanent failure is more likely
    if (mutationResult.error) {
      const isRetryableError = this.#options.isRetryableError(mutationResult);
      const hasFailedBefore = !!mutationResult.operation.context?.crdtMeta?.failedInCoalescing;

      if (isRetryableError) {
        return [];
      } else if (!isRetryableError && isMutationOperationCoalescedResult(mutationResult)) {
        const originalMutations = mutationResult.operation.context.crdtMeta.originalMutations.map(key => {
          return this.#mutations.get(key);
        }).filter((m): m is MutationOperation => !!m);

        for (const originalMutation of originalMutations) {
          this.#mutations.set(originalMutation.key, makeOperation(originalMutation.kind, originalMutation, {
            ...originalMutation.context,
            crdtMeta: {
              ...originalMutation.context.crdtMeta,
              // TODO: this key naming/value. should we keep counter?
              failedInCoalescing: true,
            }
          }) as MutationOperation);
        }

        return [];
      } else if (!isRetryableError && hasFailedBefore) {
        this.removeMutations([mutationResult.operation]);

        return [mutationResult];
      }
    } else if (isMutationOperationCoalescedResult(mutationResult)) {
      const originalMutations = mutationResult.operation.context.crdtMeta.originalMutations.map(key => {
        return this.#mutations.get(key);
      }).filter((m): m is MutationOperation => !!m);

      this.removeMutations(originalMutations);

      const syntheticMutationResults = originalMutations.map(mutation => {
        return makeResult(mutation, mutationResult);
      });

      return syntheticMutationResults;
    }

    // failedInCoalescing with no error
    this.removeMutations([mutationResult.operation]);

    return [mutationResult];
  }

  private applyQuery(originalResult: QueryOperationResult) {
    const operationName = getOperationName(originalResult.operation.query);
    if (operationName && queryUpdater[operationName]) {
      const { result } = queryUpdater[operationName]!(originalResult as QueryOperationResult, this.#optimisticState);

      return [result];
    } else {
      ////console.warn('Could not patch optimistic state on result', originalResult);
    }

    return [originalResult];
  }

  sendMutations() {
    ////console.log(performance.now(), 'sendMutations begin');
    const [firstMutation] = this.#mutations.values();

    // TODO: better types?
    if (firstMutation.context?.crdtMeta?.failedInCoalescing) {
      this.#next(firstMutation);
    } else {
      const likeMutations = Array.from(this.likeMutations(firstMutation));

      // const coalescedVariables = likeMutations.reduce<MutationOperation['variables']>((merged, mutation) => mergeWithTimestamps(merged, mutation.variables), {});
      let coalescedVariables: MergedCrdtObjectStore = new Map();
      let variables = {};
      const coalesce = (mutation: MutationOperation, mutationConfig: CrdtMutationConfig) => {
        const data = lGet(mutation.variables, mutationConfig.path);
        coalescedVariables = applyCrdtPatch(coalescedVariables, { key: mutationConfig.key, data });
        lSet(variables, mutationConfig.path, coalescedVariables.get(serializeCrdtKey(mutationConfig.key)));
      }

      const operationName = getOperationName(firstMutation.query);
      if (operationName && patchExtractor[operationName]) {
        const mutationConfig = patchExtractor[operationName]!(firstMutation);
        for (const likeMutation of likeMutations) {
          coalesce(likeMutation, mutationConfig);
        }
      }

      const coalescedMutation = this.#client.createRequestOperation(
        'mutation',
        createRequest(firstMutation.query, variables),
        {
          ...firstMutation.context,
          crdtMeta: {
            ...firstMutation.context.crdtMeta,
            originalMutations: likeMutations.map(m => m.key),
          }
        }
      );

      this.#next(coalescedMutation);
    }

    //console.log(performance.now(), 'sendMutations end');
  }

  *likeMutations(mutation: MutationOperation, maxMutations: number = 25, predicate?: (m1: MutationOperation, m2: MutationOperation) => boolean) {
    // TODO: more robust matching up between mutations
    // what if context is different? etc
    predicate = predicate ?? ((m1, m2) => {
      const m1name = getOperationName(m1.query)
          , m2name = getOperationName(m2.query);

      const matchingMutationName = m1name === m2name;
      let matchingUuid = false;

      if (m1name && m2name && patchExtractor[m1name] && patchExtractor[m2name]) {
        const m1config = patchExtractor[m1name]!(m1);
        const m2config = patchExtractor[m2name]!(m2);

        matchingUuid = m1config.key.__typename === m2config.key.__typename
          && m1config.key.id === m2config.key.id;
      } else {
        //console.warn(`Could not extract mutation information from ${m1name} or ${m2name} mutations`, m1, m2);
      }

      return matchingMutationName && matchingUuid;
    });

    let size = 0;
    for (const v of this.#mutations.values()) {
      if (predicate(mutation, v) && size < maxMutations) {
        size++;
        yield v;
      }
    }
  }

  private removeMutations(mutations: MutationOperation[]) {
    const dependentQueries = new Set<QueryOperation>();
    for (const mutation of mutations) {
      const deleted = this.#mutations.delete(mutation.key);

      if (deleted) {
        this.collectDependentQueries(dependentQueries, mutation);
      }
    }
    this.persistMutations();

    if (this.#mutations.size === 0 && this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }

    // TODO: for performance we could delete and recalculate only the entities affected by removed mutations
    this.#optimisticState = produce(this.#optimisticState, draft => draft.clear());
    this.updateOptimisticState(this.#mutations.values());

    for (const dependentQuery of dependentQueries) {
      this.#client.reexecuteOperation(toRequestPolicy(dependentQuery, 'cache-first'));
    }
  }

  private collectDependentQueries(dependentQueries: Set<QueryOperation>, mutation: MutationOperation) {
    for (const query of this.#queries.values()) {
      if (isQueryDependentOnMutation(query, mutation)) {
        dependentQueries.add(query);
      }
    }
  }

  private updateOptimisticState(mutations: Iterable<MutationOperation>) {
    for (const mutation of mutations) {
      const operationName = getOperationName(mutation.query);
      if (operationName && patchExtractor[operationName]) {
        const mutationConfig = patchExtractor[operationName]!(mutation);

        const data = lGet(mutation.variables, mutationConfig.path) as CrdtObjectPatch['data'];
        this.#optimisticState = applyCrdtPatch(this.#optimisticState, { key: mutationConfig.key, data });
      } else {
        //console.warn(`Could not extract patch information from ${operationName} mutation`, mutation);
      }
    }
  }
}

export const crdtExchange = <C extends CrdtExchangeOpts>(
  opts: C
): Exchange => input => {
  const { forward, client } = input;
  const { source: reboundOps$, next } = makeSubject<Operation>();

  const crdtManager = new CrdtManager(client, next, opts);

  return ops$ => {
    const sharedOps$ = share(ops$);

    const crdtOperations$ = pipe(
      sharedOps$,
      filter(operation => {
        return isCrdtOperation(operation);
      }),
      // tap(_ => //console.log(performance.now(), 'crdtOperations begin')),
      share,
    );

    const crdtMutations$ = pipe(
      // Buffer CRDT Mutations until the crdtManager is rehydrated.
      merge([
        pipe(
          crdtOperations$,
          filter(operation => operation.kind === 'mutation'),
          buffer(fromPromise(crdtManager.hydration)),
          mergeMap(fromArray),
        ),
        pipe(
          crdtOperations$,
          filter(operation => operation.kind === 'mutation'),
          skipUntil(fromPromise(crdtManager.hydration)),
        )
      ]),
      tap(operation => crdtManager.addMutation(operation as MutationOperation)),
      // tap(_ => //console.log(performance.now(), 'crdtOperations end')),
      filter(_ => false),
    );

    const crdtNonMutations$ = pipe(
      crdtOperations$,
      filter(operation => operation.kind !== 'mutation'),
      tap(operation => {
        switch (operation.kind) {
          case 'query':
            crdtManager.addQuery(operation as QueryOperation);
            break;
          case 'teardown':
            // TODO: teardowns for mutations? can they happen? when?
            crdtManager.teardown(operation);
            break;
        }
        //console.log(performance.now(), 'crdtOperations end');
      }),
    )

    const nonCrdtOperations$ = pipe(
      sharedOps$,
      filter(operation => {
        return !isCrdtOperation(operation);
      }),
    );

    const opsAndRebound$ = merge([reboundOps$, crdtMutations$, crdtNonMutations$, nonCrdtOperations$]);

    const results$ = pipe(
      pipe(
        opsAndRebound$,
        tap((operation) => {
          //console.log(performance.now(), 'opsandrebound', operation, crdtManager);
        }),
        forward,
      ),
      mergeMap(result => {
        if (isCrdtOperation(result.operation)) {
          //console.log(performance.now(), 'results begin');
          const results = crdtManager.applyResult(result);
          //console.log(performance.now(), 'results end', result, results);
          return fromArray(results);
        }

        return fromArray([result]);
      }),
    );

    return results$;
  };
};

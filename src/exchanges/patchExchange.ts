import type {Exchange, Operation, Client} from 'urql';

import {filter, merge, pipe, map, share, tap} from 'wonka';
import {makeOperation} from '@urql/core';
import {cloneDeep, isArray, values, keyBy, mergeWith, get, set, filter as lFilter} from 'lodash';
import {OperationResult} from '@urql/core/dist/types/types';
import {getOperationName} from './utils';

export type PatchExchangeOpts = {
  [key: string]: MutationConfig;
};

export type MutationConfig = {
  existingData: (operation: Operation, client: Client) => {
    serverRes: OperationResult | null,
    optimisticRes: OperationResult | null
  };
  variablePath: string;
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
    return undefined
  }
  if (!ts1) {
    return value2
  }
  if (!ts2) {
    return value1
  }
  const compareRes = ts1.localeCompare(ts2);
  if (compareRes <= 0) {
    return value2
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

/**
 * Filter out any __typename fields. These can arise from results of a read query.
 *
 * @param toFilter
 */
const filterTypenames = (toFilter: any): any => {
  const serialized = JSON.stringify(toFilter, (key, value) => {
    if (key === '__typename') {
      return undefined;
    }

    return value;
  })

  return JSON.parse(serialized)
}

// TODO docs for this function
export const mergeWithTimestamps = (existing: any, newValues: any) => {
  const res = mergeWith(cloneDeep(existing), cloneDeep(newValues), mergeWithTimestampsCustomizer);

  return filterTypenames(res);
}

// TODO docs
// Always merge based on timestamps: (use timestamps if present)
// For arrays
// Remove things from existing if not present in new values (for arrays)
// Merge existing and new values
export const mergeOptimisticIntoServer = (optimistic: any, server: any) => {
  const res = mergeWith(cloneDeep(optimistic), cloneDeep(server), mergeOptimisticIntoServerCustomizer);

  return filterTypenames(res);
}

export const PROCESSED_OPERATION_KEY = '_patched';
export const OPTIMISTIC_STATE_KEY = '_optimistic';

/**
 * Merges current cache state with operation variables to create an mutation that is a whole patch. Allows for operations
 * to be sent with only changed variables, but for resulting mutation to contain those omitted variables.
 *
 * TODO add notes about different behavior for optimistic and server behavior (and assumptions here around data requirements)
 *
 * TODO add notes about how it changes operation (new variables, injected artificial variables, context [and extra on this for persistance])
 *
 * TODO mention assumption built into how arrays are handeled
 */
export const patchExchange = (options: PatchExchangeOpts): Exchange => ({
                                                                          forward,
                                                                          client,
                                                                          dispatchDebug,
                                                                        }) => {
  const patchVariables = (operation: Operation): Operation => {
    const operationName = getOperationName(operation);
    if (!(operationName && options[operationName])) {
      return operation;
    }
    const opConfig = options[operationName];

    const { serverRes, optimisticRes } = opConfig.existingData(operation, client);

    // Combine server and optimistic. Cache wins to allow patch to be minimal set of changes
    // TODO there should be docs about why second cache and why merging is done the way that it is
    // TODO could also make this alot smarter with some sort of schema awareness for required fields...
    const mergedState = mergeOptimisticIntoServer(optimisticRes?.data, serverRes?.data)

    const { variables } = operation;
    const mergeRes = mergeWithTimestamps(mergedState, get(variables, opConfig.variablePath))

    // This assumes that the optimistic layer is going to contain all the server data. This should be true
    // but if for some reason it is not this may send incomplete expected optimistic state if optimisticRes.data
    // is missing properties.
    const optimisticState = mergeWithTimestamps(optimisticRes?.data, get(variables, opConfig.variablePath));

    set(variables, opConfig.variablePath, mergeRes)

    return makeOperation(operation.kind, {...operation, variables: variables}, {
      ...operation.context,
      [PROCESSED_OPERATION_KEY]: true,
      [OPTIMISTIC_STATE_KEY]: optimisticState,
    });
  }

  // Inject extra variable for optimistic state. This is so that graphcache's optimistic config gets what the optimistic
  // layer should look like. (variables are changes + server state, with minimal optimistic)
  const injectOptimisticIntoVariables = (operation: Operation): Operation => {
    if (operation.kind !== 'mutation') {
      return operation;
    }

    const variables = {
    ...operation.variables,
    ...(operation.context[OPTIMISTIC_STATE_KEY] && {[OPTIMISTIC_STATE_KEY]: operation.context[OPTIMISTIC_STATE_KEY]})
    };

    return makeOperation(operation.kind, {
      ...operation,
      variables,
    },
    operation.context)
  }

  return (operations$) => {
    const shared$ = pipe(operations$, share);
    const isMutationToProcess = (op: Operation) => op.kind === 'mutation' && !op.context[PROCESSED_OPERATION_KEY]
    const mutations$ = pipe(
      shared$,
      filter(isMutationToProcess),
      map(patchVariables)
    );
    const rest$ = pipe(
      shared$,
      filter((op) => !isMutationToProcess(op)),
    );

    const merged$ = pipe(
      merge([mutations$, rest$]),
      map(injectOptimisticIntoVariables),
      tap(op => console.log('afterInject', op))
    )

    return pipe(merged$, forward);
  };
};

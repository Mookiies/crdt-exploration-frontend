import type {Exchange, Operation} from 'urql';

import {filter, merge, pipe, map, share} from 'wonka';
import {makeOperation} from '@urql/core';
import {cloneDeep, isArray, values, keyBy, mergeWith} from 'lodash';

export type PatchExchangeOpts = {

};

export const mergeExisting = (existing: any, newValues: any) => {
  const customizer = (objValue: any, srcValue: any) => {
    if (isArray(objValue)) {
      // @ts-ignore
      return values(mergeWith(keyBy(objValue, 'uuid'), keyBy(srcValue, 'uuid')));
      // return objValue.concat(srcValue);
    }
  }

  return mergeWith(cloneDeep(existing), cloneDeep(newValues), customizer)
}

export const patchExchange = (options: PatchExchangeOpts): Exchange => ({
                                                                                                  forward,
                                                                                                  client,
                                                                                                  dispatchDebug,
                                                                                                }) => {
  const patchVariables = (operation: Operation): Operation => {
    const existingDataConfig = operation.context.existingDataConfig;

    const existingData = client.readQuery(existingDataConfig?.query, existingDataConfig?.variables);

    const { variables } = operation;

    const mergeRes = mergeExisting(existingData?.data, variables.inspectionInput)

    return makeOperation(operation.kind, {...operation, variables: { inspectionInput: mergeRes }}, {
      ...operation.context,
    });
  }

  return (operations$) => {
    const shared$ = pipe(operations$, share);
    const mutations$ = pipe(
      shared$,
      filter((op) => op.kind === 'mutation'),
      map(patchVariables)
    );
    const rest$ = pipe(
      shared$,
      filter((op) => op.kind !== 'mutation'),
    );


    return pipe(merge([mutations$, rest$]), forward);
  };
};

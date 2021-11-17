import type {Exchange, Operation, Client} from 'urql';

import {filter, merge, pipe, map, share} from 'wonka';
import {makeOperation} from '@urql/core';
import {cloneDeep, isArray, values, keyBy, mergeWith, get, set} from 'lodash';
import {OperationResult} from '@urql/core/dist/types/types';
import {getOperationName} from './utils';

export type PatchExchangeOpts = {
  [key: string]: MutationConfig;
};

export type MutationConfig = {
  existingData: (operation: Operation, client: Client) => OperationResult | null;
  variablePath: string;
}

export const mergeExisting = (existing: any, newValues: any) => {
  // TODO Safety for dealing with undefined??

  const customizer = (objValue: any, srcValue: any): any => {
    if (isArray(objValue)) {
      return values(mergeWith(keyBy(objValue, 'uuid'), keyBy(srcValue, 'uuid'), customizer));
    }
  }

  return mergeWith(cloneDeep(existing), cloneDeep(newValues), customizer)
}

export const PROCESSED_OPERATION_KEY = '_patched';

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

    const existingData = opConfig.existingData(operation, client);
    const { variables } = operation;
    const mergeRes = mergeExisting(existingData?.data, get(variables, opConfig.variablePath))
    const newVariables = set(variables, opConfig.variablePath, mergeRes)

    return makeOperation(operation.kind, {...operation, variables: newVariables}, {
      ...operation.context,
      [PROCESSED_OPERATION_KEY]: true,
    });
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


    return pipe(merge([mutations$, rest$]), forward);
  };
};

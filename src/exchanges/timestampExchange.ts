import type {Exchange, Operation, OperationResult} from 'urql';

import {filter, merge, pipe, tap, map, share} from 'wonka';
import {makeOperation} from '@urql/core';
import {isEmpty, cloneDeep} from 'lodash';

import { HLC } from '../lib';
import {getOperationName, isObject} from './utils';

export type TimestampInjectorExchangeOpts = {
  localHlc: HLC;
  fillConfig?: any;
};

// TODO don't think these types really good enough
interface TimestampBase {
  [key: string]: TimestampsConfig;
}

type TimestampsObj = TimestampBase & {
  _timestamped?: string[]
}

type TimestampsConfig = TimestampsObj | undefined;

export const generateTimestamps = (source: any, config: any, timestamp: string) => {
  if (!config) {
    return {};
  }

  const timestampsToFill = config._timestamped
  if (!timestampsToFill) {
    return {};
  }

  const results: { [key: string]: string } = {};
  timestampsToFill.forEach((key: any) => {
    key in source && (results[key] = timestamp)
  })

  return isEmpty(results) ? {} : {timestamps: {...results}};
}

export const fillMeIn = (source: any, config: any, timestamp: string) => {
  if (Array.isArray(source)) {
    source.forEach(value => {
      fillMeIn(value, config, timestamp);
    })
  }

  if (!isObject(source)) {
    return source;
  }

  const levelResult = source;

  const filledResults = generateTimestamps(source, config, timestamp);
  Object.assign(levelResult, filledResults);

  const keys = Object.keys(source);
  keys.forEach(key => {
    const nextSource = source[key];
    const nextValues = config && config[key];
    Object.assign(levelResult, {[key]: fillMeIn(nextSource, nextValues, timestamp)})
  })

  return levelResult;
}

export const injectTimestampVariables = (variables: any, config: any, timestamp: string) => {
  const sourceCopy = cloneDeep(variables);
  return fillMeIn(sourceCopy, config, timestamp);
}

export const traverseAndUpdateHlc = (data: any, hlc: HLC, timestampsKey: string) => {
  if (!data) {
    return;
  }

  if (Array.isArray(data)) {
    data.forEach(value => traverseAndUpdateHlc(value, hlc, timestampsKey))
  }

  if (!isObject(data)) {
    return;
  }

  const keys = Object.keys(data);
  keys.forEach(key => {
    if (key === timestampsKey) {
      updateHLCPerObjectField(data[key], hlc);
    } else {
      traverseAndUpdateHlc(data[key], hlc, timestampsKey)
    }
  })

}

export const updateHLCPerObjectField = (data: { [key: string]: string; }, hlc: HLC) => {
  if (!isObject(data)) {
    return;
  }

  Object.values(data).forEach(value => {
    if (!HLC.isValidFormat(value)) {
      return;
    }

    const valueHlc = HLC.unpack(value);
    valueHlc.compare(hlc) >= 0 && hlc.receive(valueHlc, new Date().getTime())
  })
}

export const PROCESSED_OPERATION_KEY = '_timestamped';

export const timestampExchange = (options: TimestampInjectorExchangeOpts): Exchange => ({
                                                                                                  forward,
                                                                                                  client,
                                                                                                  dispatchDebug,
                                                                                                }) => {
  const { localHlc, fillConfig } = options;

  const injectTimestamp = (operation: Operation): Operation => {
    const packedTs = localHlc.increment(new Date().getTime()).pack();

    const operationName = getOperationName(operation);
    if (!(operationName && fillConfig[operationName])) {
      return operation;
    }

    const variables = operation.variables;
    const newVariables = injectTimestampVariables(variables, fillConfig[operationName], packedTs);

    return makeOperation(operation.kind, {...operation, variables: newVariables}, {
      ...operation.context,
      [PROCESSED_OPERATION_KEY]: true
    });
  }

  const updateHlc = (result: OperationResult) => {
    if (result.operation.kind === 'teardown' || result.operation.context.meta?.cacheOutcome === 'hit' || !result.data) {
      // TODO how to initialize HLC to max value?
      // Store in storage outside exchange and passed in (how would it get saved? built into class? wrapped?) -- storage adapter
      // Have it parse and update if it's the first time that an operation is seen but is a cache hit (could have potentially outdated things
      return;
    }

    traverseAndUpdateHlc(result.data, localHlc, 'timestamps'); //TODO key from config
  }

  return (operations$) => {
    const shared$ = pipe(operations$, share);
    const isMutationToProcess = (op: Operation) => op.kind === 'mutation' && !op.context[PROCESSED_OPERATION_KEY]
    const mutations$ = pipe(
      shared$,
      filter(isMutationToProcess),
      map(injectTimestamp),
    );
    const rest$ = pipe(
      shared$,
      filter((op) => !isMutationToProcess(op)),
    );


    return pipe(merge([mutations$, rest$]), forward, tap(updateHlc));
  };
};

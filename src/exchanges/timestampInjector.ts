import type {Exchange, Operation, OperationResult} from 'urql';

import {filter, merge, pipe, tap, map, share} from 'wonka';
import {makeOperation, createRequest} from '@urql/core';
import {isEmpty, cloneDeep} from 'lodash';
import { HLC } from '../lib';

export type TimestampInjectorExchangeOpts = {
  localHlc: HLC;
  fillConfig?: any;
};

// let fillMeInFields = {
//     inspectionInput: {
//       inspection: {
//         _required: ['name', 'areas'],
//         _timestamped: ['name'],
//         areas: {
//           _required: ['name', 'items'],
//           items: {
//             _required: ['name', 'position']
//           }
//         }
//     }
//   }
// }

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

  return isEmpty(results) ? {} : {timestampsAttributes: {...results}};
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

export const isObject = (data: any) => typeof data === 'object' && data !== null

export const timestampInjectorExchange = (options: TimestampInjectorExchangeOpts): Exchange => ({
                                                                                                  forward,
                                                                                                  client,
                                                                                                  dispatchDebug,
                                                                                                }) => {
  const { localHlc, fillConfig } = options;

  const injectTimestamp = (operation: Operation): Operation => {
    const packedTs = localHlc.increment(new Date().getTime()).pack();

    const variables = operation.variables;
    const newVariables = injectTimestampVariables(variables, fillConfig, packedTs);

    return makeOperation(operation.kind, {...operation, variables: newVariables}, {
      ...operation.context,
    });
  }

  const updateHlc = (result: OperationResult) => {
    if (result.operation.kind === 'teardown' || result.operation.context.meta?.cacheOutcome === 'hit' || !result.data) {
      // TODO how to initialize HLC to max value?
      // Store in storage outside exchange and passed in (how would it get saved? built into class? wrapped?)
      // Have it parse and update if it's the first time that an operation is seen but is a cache hit (could have potentially outdated things
      return;
    }


    console.log('updateHLC::before', localHlc.pack())

    traverseAndUpdateHlc(result.data, localHlc, 'timestamps'); //TODO key from config

    console.log('updateHLC::after', localHlc.pack())

  }

  return (operations$) => {
    // TODO only split off what's needed
    const shared$ = pipe(operations$, share);
    const queries$ = pipe(
      shared$,
      filter((op) => op.kind === 'query'),
    );
    const mutations$ = pipe(
      shared$,
      filter((op) => op.kind === 'mutation'),
      map(injectTimestamp)
    );
    const other$ = pipe(
      shared$,
      filter((op) => op.kind !== 'mutation' && op.kind !== 'query'),
    );


    return pipe(merge([mutations$, queries$, other$]), forward, tap(updateHlc));
  };
};

import type { Exchange, Operation } from 'urql';

import { filter, merge, pipe, tap, map, share } from 'wonka';
import { makeOperation } from '@urql/core';
import { isEmpty, cloneDeep } from 'lodash';
import type HybridLogicalClock from '../lib/hybridLogicalClock';

export type TimestampInjectorExchangeOpts = {
  localHlc: HybridLogicalClock;
  fillConfig?: TimestampsConfig;
};
//
// let timestampedFields = {
//   ...operation.context,
//   timestamped: {
//     inspectionInput: {
//       inspection: {
//         timestampsAttributes: ['name', 'note'],
//         areas: {
//           timestampsAttributes: ['name', 'position'],
//         }
//       }
//     }
//   }
// }

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
// const generateTimestampedVariables = (contextMapping, variables) => {
//
// }

interface TimestampBase {
  [key: string]: TimestampsConfig;
}

type TimestampsObj = TimestampBase & {
  _timestamped?: string[]
}

type TimestampsConfig = TimestampsObj | undefined;

export const generateTimestamps = (source: any, values: TimestampsConfig, timestamp: string) => {
  if (!values) {
    return {};
  }

  const timestampsToFill = values._timestamped
  if (!timestampsToFill) {
    return {};
  }

  const results: { [key: string]: string } = {};
  timestampsToFill.forEach(key => {
    key in source && (results[key] = timestamp)
  })

  return isEmpty(results) ? {} : { timestampsAttributes: { ...results } };
}

export const fillMeIn = (source: any, values: TimestampsConfig, timestamp: string) => {
  if (Array.isArray(source)) {
    source.forEach(value => {
      fillMeIn(value, values, timestamp);
    })
  }

  if (typeof source !== 'object' || source === null) {
    return source;
  }

  const levelResult = source;

  const filledResults = generateTimestamps(source, values, timestamp);
  Object.assign(levelResult, filledResults);

  const keys = Object.keys(source);
  keys.forEach(key => {
    const nextSource = source[key];
    const nextValues = values && values[key];
    Object.assign(levelResult, { [key]: fillMeIn(nextSource, nextValues, timestamp) })
  })

  return levelResult;
}

export const injectTimestampVariables = (source: any, values: TimestampsConfig, timestamp: string) => {
  const sourceCopy = cloneDeep(source);
  return fillMeIn(sourceCopy, values, timestamp);
}

export const timestampInjectorExchange = (options: TimestampInjectorExchangeOpts): Exchange => ({
                                                                                       forward,
                                                                                       client,
                                                                                       dispatchDebug,
                                                                                     }) => {
  const timestampToInject = options.localHlc;

  const injectTimestamp = (operation: Operation): Operation => {
    const packedTs = timestampToInject.increment(new Date().getTime()).pack();


    const inspection = operation.variables.inspectionInput.inspection;
    const newInspection = { ...inspection, timestampsAttributes: { name: packedTs, note: packedTs, test: 12345 }}
    const newVariables = {
      inspectionInput: {
        inspection: newInspection
      }
    }

    return makeOperation(operation.kind, {...operation, variables: newVariables}, {
      ...operation.context,
    });
  }

  return (operations$) => {
    const shared$ = pipe(operations$, share);
    const queries$ = pipe(
      shared$,
      filter((op) => op.kind === 'query'),
      // TODO process every supported query and call recieve on localHLC for each timestamp (maybe only recieve when greater so as not to balloon count artificially)
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

    const forwarded$ = pipe(merge([mutations$, queries$, other$]), forward);

    return merge([forwarded$]);
  };
};

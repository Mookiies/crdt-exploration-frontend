import type { Exchange, Operation } from 'urql';

import { filter, merge, pipe, tap, map, share } from 'wonka';
import { makeOperation } from '@urql/core';
import type HybridLogicalClock from '../lib/hybridLogicalClock';

export type TimestampInjectorExchange = {
  localHlc: HybridLogicalClock;
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

export const timestampInjectorExchange = (options: TimestampInjectorExchange): Exchange => ({
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

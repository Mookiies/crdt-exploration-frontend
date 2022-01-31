import type { Exchange, ExchangeIO, Operation, OperationResult } from 'urql';
import { publish, Source } from 'wonka';

import { filter, merge, pipe, makeSubject, map, share, subscribe, tap } from 'wonka';
import {makeOperation} from '@urql/core';
import {cloneDeep, isArray, values, keyBy, mergeWith, get, set} from 'lodash';
import {getOperationName} from './utils';
import { actions, assign, createMachine, forwardTo, interpret, spawn, t } from 'xstate';

const { send, respond } = actions;

export type MachineExchangeOpts = {
};

export const mergeExisting = (existing: any, newValues: any) => {

  const customizer = (objValue: any, srcValue: any): any => {
    if (isArray(objValue)) {
      return values(mergeWith(keyBy(objValue, 'uuid'), keyBy(srcValue, 'uuid'), customizer));
    }
  }

  const res = mergeWith(cloneDeep(existing), cloneDeep(newValues), customizer)

  // Filter out any __typename fields. These can arise from results of a read query
  const serialized = JSON.stringify(res, (key, value) => {
    if (key === '__typename') {
      return undefined;
    }

    return value;
  })

  return JSON.parse(serialized)
}

export const PROCESSED_OPERATION_KEY = '_patched';

enum States {
  IDLE = 'idle'
}

enum Events {
  OPERATION = 'op',
  OPERATION_RESULT = 'res',
  SET_OPERATION_RESULT = 'set_res'
}

/*
How to handle queries:

    X    G
-->Q|-->Q|
<--*|<--R|

We need to forward the query to graphcache.
The result must be syncronously merged with optimistic state.
We have to keep track of original operations because any future mutations need to issue a new result.

Teardowns:


How to handle mutations:

    X    G
-->M|-->M|
<--*|<--R|



*/

const createExchangeMachine = (operations$: Source<Operation>, forward: ExchangeIO) => {
  const { source: results$, next } = makeSubject<Operation>();

  const resultMachine = createMachine({
    context: {
      currentResult: null,
    },
    initial: 'IDLE',
    states: {
      IDLE: {
        on: {
          [Events.OPERATION_RESULT]: {
            actions: [
              assign((ctx, ev) => {
                console.log('resultMachine assign');
                return { currentResult: ev.result };
              }),
              respond((ctx, ev) => {
                console.log('resultMachine respond');
                return { type: Events.SET_OPERATION_RESULT, result: ctx.currentResult };
              }),
            ]
          },
        }
      }
    }
  });

  return [createMachine({
    type: 'parallel',
    context: {
      currentOperation: null,
      currentResult: null,
    },
    schema: {
      context: t<{
        currentOperation: null | Operation,
        currentResult: null | OperationResult,
        activeOperations: Map<Operation['key'], Operation>,
      }>(),
      events: t<{ type: Events.OPERATION, operation: Operation } | { type: Events.OPERATION_RESULT, result: OperationResult }>(),
    },
    states: {
      operations: {
        initial: States.IDLE,
        states: {
          [States.IDLE]: {
            on: {
              [Events.OPERATION]: {
                actions: [
                  (ctx, ev) => {
                    console.log(performance.now(), 'xstate 1 got OPERATION', ctx, ev);
                  },
                  (ctx, ev) => {
                    console.log(performance.now(), 'xstate 2 got OPERATION', ctx, ev);
                  },
                  (ctx, ev) => {
                    console.log(performance.now(), 'xstate 3 got OPERATION', ctx, ev);
                  },
                  (ctx, ev) => {
                    console.log(performance.now(), 'xstate 4 got OPERATION', ctx, ev);
                    // next(ev.operation);
                  },
                  assign((ctx, ev) =>  {
                    console.log('xstate ASSIGN OP', ctx, ev)
                    return {
                      currentOperation: ev.operation,
                    };
                  }),
                ]
              }
            }
          }
        },
      },
      results: {
        initial: States.IDLE,
        states: {
          [States.IDLE]: {
            on: {
              [Events.OPERATION_RESULT]: {
                actions: [
                  (ctx, ev) => {
                    // console.log(performance.now(), 'xstate 1 got RESULT', ctx, ev);
                  },
                  assign((ctx, ev) => {
                    const m = spawn(resultMachine);
                    console.log('xstate ASSIGN spawn', ctx, ev, m);
                    return {
                      resultMachine: m,
                    };
                  }),
                  send((_, ev) => ev, { to: (ctx) => ctx.resultMachine }),
                ]
              },
              [Events.SET_OPERATION_RESULT]: {
                actions: [
                  assign((ctx, ev) => {
                    console.log('xstate ASSIGN result', ctx, ev)
                    return {
                      currentResult: ev.result,
                    };
                  }),
                ]
              }
            }
          }
        },
      }
    },
    // on: {
    //   [Events.OPERATION]: {
    //     actions: (ctx, ev) => {
    //       console.log(performance.now(), 'xstate global got OPERATION', ctx, ev);
    //       next(ev.operation);
    //     },
    //   }
    // }
  }), results$] as const;
};

export const machineExchange = (options: MachineExchangeOpts): Exchange => ({
                                                                          forward,
                                                                          client,
                                                                          dispatchDebug,
                                                                        }) => {
  return (operations$) => {
    const sharedOps$ = share(operations$);
    const [machine, results$] = createExchangeMachine(sharedOps$, forward);

    const service = interpret(machine).onTransition((state, event) => {
      console.log(performance.now(), 'machine transitioned', state, event);
    });

    service.start();

    return pipe(
      sharedOps$,
      map((operation) => {
        // console.log(performance.now(), 'machineExchange op', operation);
        const s = service.send({ type: Events.OPERATION, operation });
        // console.log(performance.now(), 'machineExchange op after send', s);
        return s.context.currentOperation;
      }),
      forward,
      map((result) =>  {
        const s = service.send({ type: Events.OPERATION_RESULT, result });
        // console.log(performance.now(), 'machineExchange result after send', s);
        return s.context.currentResult;
      })
    );

    // return pipe(
    //   results$,
    //   forward,
    // )

    // return pipe(
    //   operations$,
    //   tap((operation) => {
    //     console.log(performance.now(), 'machineExchange op', operation);
    //     service.send({ type: Events.OPERATION, operation });
    //   }),
    //   forward
    // );
  };
};

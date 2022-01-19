import type {Exchange, Operation, Client} from 'urql';

import {filter, merge, pipe, map, share, tap} from 'wonka';
import {ExchangeIO, makeOperation} from '@urql/core';
import {cloneDeep, isArray, values, keyBy, mergeWith, get, set} from 'lodash';
import {OperationResult} from '@urql/core/dist/types/types';
import {getOperationName} from './utils';
import {cacheExchange} from '@urql/exchange-graphcache';
import {makeDefaultStorage} from "./graphcache/src/default-storage";

export const serverCacheExchange = (options: any): Exchange => ({
                                                               forward,
                                                               client,
                                                               dispatchDebug,
                                                           }) => {
    const storage = makeDefaultStorage({
        idbName: 'servercache', // The name of the IndexedDB database
        maxAge: 7, // The maximum age of the persisted data in days
    });

    const cacheResults$ = cacheExchange({ storage })({
        client,
        dispatchDebug,
        forward,
    });

    return ops$ => {
        const shared$ = pipe(ops$, share);
        const sendToCache$ = pipe(
            shared$,
            filter((op) => {
                return !op.context.test;
            }),
            tap(op => console.log('sending to cache', op))
        )

        const skipCache$ = pipe(
            shared$,
            filter((op) => {
                return op.context.test;
            }),
            tap(op => console.log('skipping cache', op))
        )

        const merged$ = merge([cacheResults$(sendToCache$), forward(skipCache$)])

        return pipe(
            merged$,
            tap(res => console.log('results out of exchange:', res))
        )
    }


    // const shared$ = share(operations$);
    // const mutations$ = pipe(
    //     shared$,
    //     filter(() => {
    //         console.log('filtering here before L2 cache')
    //         return true
    //     }),
    // );
    // const rest$ = pipe(
    //     shared$,
    //     filter((op) => false),
    // );
    //
    // const x = cacheResults$(mutations$);
    //
    // const merged$ = merge([])
    //
    // return pipe(
    //     operations$,
    //     filter(() => {
    //         console.log('filtering here before L2 cache')
    //     });
    // )
};

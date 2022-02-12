import React from 'react';
import { createClient, dedupExchange, fetchExchange, OperationResult, Provider } from 'urql';
import { offlineExchange } from '@urql/exchange-graphcache';
import { Main } from './components'
import { makeDefaultStorage } from './exchanges/graphcache/src/default-storage';
import { requestPolicyExchange } from '@urql/exchange-request-policy';

import {
  crdtExchange,
  timestampExchange,
  TIMESTAMPS_PROCESSED_OPERATION_KEY
} from './exchanges';
import { localHlc } from './lib';
import { getAllInspectionsQuery, getSingleInspectionQuery } from './components/Main';
import { keyBy, merge, values } from 'lodash';
import { isDeadlockMutation, isOfflineError } from './exchanges/crdtExchange';

// Used so that the list of inspections is updated when a new inspection is created
const updates = {
  Mutation: {
    // @ts-ignore
    createOrUpdateInspection({createOrUpdateInspection}: any, args, cache, _info) {
      if (!createOrUpdateInspection) {
        return;
      }

      // To support offline deletions then all queries need to be affected here (invalidate is done only on real result)
      // Currently missing the single query update
      if (createOrUpdateInspection.inspection === null) { //inspection deleted
        const uuid = args.input.inspection.uuid;

        cache.updateQuery({query: getAllInspectionsQuery}, (data: any) => {
          const allInspections = data?.allInspections || [];
          const filtered = allInspections.filter((inspection: any) => inspection.uuid !== uuid)
          return { allInspections: filtered }
        });
        return;
      }

      // @ts-ignore
      cache.updateQuery({query: getAllInspectionsQuery}, data => {
        const allInspections = data?.allInspections || [];
        // TODO might need to be mergeWith with customizer
        const merged = merge(
          keyBy(allInspections, 'uuid'),
          { [createOrUpdateInspection.inspection.uuid]: createOrUpdateInspection.inspection }
        )
        const newList = values(merged);

        return { allInspections: newList };
      });
    },
  },
};

// Used so that the cache can do a `readQuery` and know how to resolve a query for a single inspection it hasn't seen yet.
const resolvers = {
  Query: {
    // @ts-ignore
    inspection: (_, args) => {
      return { __typename: 'Inspection', uuid: args.uuid }
    },
  },
};

const persistedContext = [
  TIMESTAMPS_PROCESSED_OPERATION_KEY
];

/*
TODO Determining if operation is a failures
- network errors should never count (unless their status codes are something we know is doomed)
- graphql errors are less likely to be recoverable
- should there be one config that is passed in as config
shouldReplay: op => true || false

[] - Operations can have cache results while still in flight
[] - Operations can have errors but also have data --> should we support this?
 */
const isRetryableError = (res: OperationResult): boolean => {
  // TODO what is ts's problem with this being boolean | undefined???
  // TODO implement
  return !!isOfflineError(res.error) || !!isDeadlockMutation(res.error);
}

const storage = makeDefaultStorage({
  idbName: 'graphcache-v3', // The name of the IndexedDB database
  maxAge: 7, // The maximum age of the persisted data in days
});

const offlineCache = offlineExchange({
  storage,
  keys: {
    // @ts-ignore
    Inspection: data => data.uuid,
    // @ts-ignore
    Area: data => data.uuid,
    // @ts-ignore
    Item: data => data.uuid,
    // @ts-ignore
    InspectionsTimestamp: data => null,
    // todo don't have typename from server from timestamps
    // @ts-ignore
    AreasTimestamp: () => null
  },
  resolvers,
  updates,
});

const timestampsConfig = {
  "CreateOrUpdateInspection": {
    inspectionInput: {
      inspection: {
        _timestamped: ['name', 'note'],
        areas: {
          _timestamped: ['name', 'position'],
          items: { },
        }
      }
    }
  }
}

const incompleteMutationsStore = makeDefaultStorage({
  idbName: 'incompleteMutations-v1', // The name of the IndexedDB database
  maxAge: 0, // Never expire these
});

const client = createClient({
  url: 'http://localhost:3000/graphql',
  exchanges: [
    dedupExchange,
    requestPolicyExchange({
      ttl: 5 * 60 * 1000
    }),
    timestampExchange({ localHlc, fillConfig: timestampsConfig }),
    // TODO: this should take options to configure how to get variables and how to patch queries with optimistic state
    crdtExchange({
      isRetryableError,
      storage: incompleteMutationsStore,
    }),
    offlineCache,
    fetchExchange
  ]
});

const App = () => (
  <Provider value={client}>
    <Main />
  </Provider>
);

export default App;

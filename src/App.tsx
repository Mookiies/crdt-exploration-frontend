import React from 'react';
import {createClient, Provider, dedupExchange, fetchExchange, OperationResult} from 'urql';
import { offlineExchange } from './exchanges/graphcache/src';
import { Main } from './components'
import {makeDefaultStorage} from './exchanges/graphcache/src/default-storage';
import {requestPolicyExchange} from '@urql/exchange-request-policy';
import {timestampExchange, patchExchange, PATCH_PROCESSED_OPERATION_KEY, TIMESTAMPS_PROCESSED_OPERATION_KEY} from './exchanges';
import { localHlc } from './lib';
import type {PatchExchangeOpts} from './exchanges/patchExchange'; // TODO export
import {getSingleInspectionQuery, getAllInspectionsQuery} from './components/Main';
import {merge, values, keyBy, cloneDeep} from 'lodash';
import {isOfflineError} from './exchanges/graphcache/src/offlineExchange';


// Used so that the list of inspections is updated when a new inspection is created
const updates = {
  Mutation: {
    // @ts-ignore
    createOrUpdateInspection({createOrUpdateInspection}: any, _args, cache, _info) {
      if (!createOrUpdateInspection) {
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

const optimistic = {
  // This function should do a better job of making sure that all required feilds are present
  // null !== undefined (ex not sending position will cause errors here)
  // @ts-ignore
  createOrUpdateInspection:  (variables, cache, info) => {
    const copy = cloneDeep(variables);

    const inspection = {
      ...copy.input.inspection,
      __typename: 'Inspection',
    }
    inspection.timestamps.__typename = 'InspectionsTimestamp'

    // @ts-ignore
    inspection.areas = inspection.areas.map((area) => {
      // @ts-ignore
      area.items = area.items?.map(item => ({
        ...item,
        __typename: 'Item'
      })) || []
      // @ts-ignore
      area.timestamps.__typename = 'AreasTimestamp'; //TODO get rid of timestamps typename

      area.position = area.position || null;
      return {
        ...area,
        __typename: 'Area'
      }
    })

    const res = {
      __typename: 'CreateOrUpdateInspectionPayload',
      success: false,
      errors: [],
      inspection
    }

    console.log('optimistic: createOrUpdateInspection result', res)

    return res;
  }
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
  PATCH_PROCESSED_OPERATION_KEY,
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
  return !!isOfflineError(res.error);
}
const storage = makeDefaultStorage({
  idbName: 'graphcache-v3', // The name of the IndexedDB database
  maxAge: 7, // The maximum age of the persisted data in days
});
const cache = offlineExchange({
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
  optimistic,
  persistedContext,
  isRetryableError,
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

const mergeConfig: PatchExchangeOpts = {
  "CreateOrUpdateInspection": {
    existingData: (operation, client) => {
     const vars = {
       inspectionUuid: operation.variables.inspectionInput.inspection.uuid
     };

     return client.readQuery(getSingleInspectionQuery, vars);
    },
    variablePath: 'inspectionInput', // add some notes about using lodash get and set
  }
}


const client = createClient({
  url: 'http://localhost:3000/graphql',
  exchanges: [
    dedupExchange,
    timestampExchange({ localHlc, fillConfig: timestampsConfig }),
    patchExchange(mergeConfig),
    requestPolicyExchange({}),
    cache,
    fetchExchange
  ]
});

const App = () => (
  <Provider value={client}>
    <Main />
  </Provider>
);

export default App;

/*
Problems with the current solution:

- Bad data gets into cache all subsequent mutations are going to get populated with that data as well. (not an isolated delta)
- Had to copy over graphcache (could limit to just offlineExchange)
-
 */

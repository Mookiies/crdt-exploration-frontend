import React from 'react';
import {createClient, dedupExchange, fetchExchange, OperationResult, Provider} from 'urql';
import {offlineExchange} from './exchanges/graphcache/src';
import {Main} from './components'
import {makeDefaultStorage} from './exchanges/graphcache/src/default-storage';
import {requestPolicyExchange} from '@urql/exchange-request-policy';
import {
  PATCH_PROCESSED_OPERATION_KEY,
  patchExchange,
  timestampExchange,
  TIMESTAMPS_PROCESSED_OPERATION_KEY
} from './exchanges';
import {localHlc} from './lib';
import type {PatchExchangeOpts} from './exchanges/patchExchange'; // TODO export
import {getAllInspectionsQuery, getSingleInspectionQuery} from './components/Main';
import {cloneDeep, keyBy, merge, values} from 'lodash';
import {isDeadlockMutation, isOfflineError} from './exchanges/graphcache/src/offlineExchange';
import {cacheExchange} from "@urql/exchange-graphcache";
import {OPTIMISTIC_STATE_KEY} from "./exchanges/patchExchange";


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

const optimistic = {
  // TODO undefined is not a valid value for absence. So absent variables need to be replaced by null.
  // This function should do a better job of making sure that all required fields are present
  // null !== undefined (ex not sending position will cause errors here)
  // @ts-ignore
  createOrUpdateInspection:  (variables, cache, info) => {
    // Using cache to resolve this doesn't work because for whatever reason urql does not call our custom resolver function
    // this makes it so that we cannot resolve new single inspection queries to get expected optimistic layer.
    // ie. cache.readQuery({ query: getSingleInspectionQuery, variables: {...}) does not work

    // Since patches coming in are based on server data so variables cannot simply be used to determine what the current optimistic
    // state should be. As a workaround an extra variable to inform this optimistic function of expected state is used
    const copy = cloneDeep(info.variables[OPTIMISTIC_STATE_KEY]);

    const inspection = {
      name: null,
      note: null,
      ...copy.inspection,
      timestamps: {
        name: null,
        note: null,
        ...copy.inspection.timestamps,
      },
      __typename: 'Inspection',
    }
    if (inspection._deleted) {
      return {
        __typename: 'CreateOrUpdateInspectionPayload',
        success: false,
        errors: [],
        inspection: null,
      };
    }
    inspection.timestamps.__typename = 'InspectionsTimestamp'

    // @ts-ignore
    inspection.areas = inspection.areas?.filter(area => !area._deleted).map((area) => {
      // @ts-ignore
      area.items = area.items?.filter(item => !item._deleted).map(item => ({
        ...item,
        __typename: 'Item'
      })) || []
      // @ts-ignore
      area.timestamps.__typename = 'AreasTimestamp'; //TODO get rid of timestamps typename

      return {
        position: null,
        name: null,
        ...area,
        timestamps: {
          position: null,
          name: null,
          ...area.timestamps,
        },
        __typename: 'Area'
      }
    })

    const res = {
      __typename: 'CreateOrUpdateInspectionPayload',
      success: false,
      errors: [],
      inspection
    }

    // console.log('optimistic: createOrUpdateInspection result', res)

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
  TIMESTAMPS_PROCESSED_OPERATION_KEY,
  OPTIMISTIC_STATE_KEY
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
const keys = {
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
};
const cache = offlineExchange({
  storage,
  keys,
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

     // TODO make exchange deal with this double query stuff
     const serverRes = client.readQuery(getSingleInspectionQuery, vars, {
       skipOffline: true,
       requestPolicy: 'cache-only',
     });

     const optimisticRes = client.readQuery(getSingleInspectionQuery, vars);

     return { serverRes, optimisticRes }
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
    requestPolicyExchange({
      shouldUpgrade: op => !op.context.skipOffline,
    }),
    cache,
    cacheExchange({ storage, keys, resolvers, updates }),
    fetchExchange
  ]
});

const App = () => (
  <Provider value={client}>
    <Main />
  </Provider>
);

export default App;

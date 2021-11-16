import React from 'react';
import { createClient, Provider, dedupExchange, fetchExchange } from 'urql';
import { offlineExchange } from '@urql/exchange-graphcache';
import { Main } from './components'
import {makeDefaultStorage} from '@urql/exchange-graphcache/default-storage';
import {requestPolicyExchange} from '@urql/exchange-request-policy';
import {timestampExchange, patchExchange} from './exchanges';
import { localHlc } from './lib';
import type {PatchExchangeOpts} from './exchanges/patchExchange';
import {getSingleInspectionQuery, getAllInspectionsQuery} from './components/Main';
import {merge, values, keyBy, cloneDeep} from 'lodash';


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
        const { allInspections } = data;
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
  // @ts-ignore
  createOrUpdateInspection:  (variables, cache, info) => {
    console.log('optimistic: createOrUpdateInspection', variables)
    const copy = cloneDeep(variables);

    const inspection = {
      ...copy.input.inspection,
      __typename: 'Inspection',
    }
    inspection.name = inspection.name + ' - optimistic'
    inspection.note = inspection.note + ' - optimistic'
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

      area.name = area.name + ' - optimistic'
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

     // TODO stacking???
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

// Replays
// - how to persist what mutations have been played & therefore need to get replayed
// - handling legit errors -- only clearing mutations from cache)
// - do stacked mutations have a problem with getting filled with old data (shouldn't because timestamps are from old cache too)
// - - What about edits that haven't hit the server yet? Existing data won't be in cache...

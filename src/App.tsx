import React from 'react';
import { createClient, Provider, dedupExchange, fetchExchange } from 'urql';
import { offlineExchange } from '@urql/exchange-graphcache';
import { Main } from './components'
import {makeDefaultStorage} from '@urql/exchange-graphcache/default-storage';
import {requestPolicyExchange} from '@urql/exchange-request-policy';
import {timestampExchange, patchExchange} from './exchanges';
import { localHlc } from './lib';
import type {PatchExchangeOpts} from './exchanges/patchExchange';
import {getSingleInspectionQuery} from './components/Main';


const resolvers = {
  Query: {
    // @ts-ignore
    inspection: (_, args) => {
      console.log('resolver', _, args)
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
    // @ts-ignore
    AreasTimestamp: () => null
  },
  resolvers,
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

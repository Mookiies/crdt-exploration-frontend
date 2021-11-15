import React from 'react';
import { createClient, Provider, dedupExchange, fetchExchange } from 'urql';
import { offlineExchange } from '@urql/exchange-graphcache';
import { Main } from './components'
import {makeDefaultStorage} from '@urql/exchange-graphcache/default-storage';
import {requestPolicyExchange} from '@urql/exchange-request-policy';
import {timestampInjectorExchange} from './exchanges/timestampInjector';
import { localHlc } from './lib';

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
  }
});

const fillConfig = {
    inspectionInput: {
      inspection: {
        // _required: ['name', 'areas'],
        _timestamped: ['name', 'note'],
        areas: {
          _timestamped: ['name', 'position'],
          // _required: ['name', 'items'],
          itemsAttributes: {
            _required: ['name', 'position']
          }
        }
    }
  }
}

const client = createClient({
  url: 'http://localhost:3000/graphql',
  exchanges: [dedupExchange, timestampInjectorExchange({ localHlc, fillConfig }), requestPolicyExchange({}), cache, fetchExchange]
});

const App = () => (
  <Provider value={client}>
    <Main />
  </Provider>
);

export default App;

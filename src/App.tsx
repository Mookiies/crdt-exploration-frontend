import React from 'react';
import { createClient, Provider, dedupExchange, fetchExchange } from 'urql';
import { offlineExchange } from '@urql/exchange-graphcache';
import { Main } from './components'
import {makeDefaultStorage} from '@urql/exchange-graphcache/default-storage';
import {requestPolicyExchange} from '@urql/exchange-request-policy';
import {timestampExchange, patchExchange} from './exchanges';
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

const timestampsConfig = {
  // TODO would be better to base this off of mutation name not just variable name
    inspectionInput: {
      inspection: {
        _timestamped: ['name', 'note'],
        areas: {
          _timestamped: ['name', 'position'],
          itemsAttributes: {
            // _required: ['name', 'position']
          }
        }
     }
    }
}

// const mergeConfig = {
//   createOrUpdate: {
//     variableName: 'inspectionInput',
//     query: getSingleInspectionQuery,
//     variables: (mutationInput) => {
//       return {
//         inspectionUuid: mutationInput.inspection.uuid,
//       }
//     }
//   }
// }


const client = createClient({
  url: 'http://localhost:3000/graphql',
  exchanges: [
    dedupExchange,
    timestampExchange({ localHlc, fillConfig: timestampsConfig }),
    patchExchange({}),
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

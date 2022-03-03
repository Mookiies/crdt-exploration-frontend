import {map, pipe, tap, publish, makeSubject} from "wonka";
import {crdtExchange} from "../crdtExchange";
import {createClient, gql} from "@urql/core";
import {composeExchanges} from "urql";
import {timestampExchange} from "../timestampExchange";
import {getCurrentTime, HLC} from "../../lib";
import {keyBy, merge, values} from "lodash";
import {offlineExchange} from "@urql/exchange-graphcache";
// import { timestampsConfig as fillConfig } from '../../App'
// TODO copied this over manually because indexdb not being defined casued problems

import { cloneDeep } from "lodash";

const fillConfig = {
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

// TODO offlineExchange config should be imported not copied over (indexedDb thing)
const updates = {
    Mutation: {
        // @ts-ignore
        createOrUpdateInspection({createOrUpdateInspection}, args, cache, _info) {
            if (!createOrUpdateInspection) {
                return;
            }

            // To support offline deletions then all queries need to be affected here (invalidate is done only on real result)
            // Currently missing the single query update
            if (createOrUpdateInspection.inspection === null) { //inspection deleted
                const uuid = args.input.inspection.uuid;

                cache.updateQuery({query: getAllInspectionsQuery}, (data) => {
                    const allInspections = data?.allInspections || [];
                    const filtered = allInspections.filter((inspection) => inspection.uuid !== uuid)
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
const resolvers = {
    Query: {
        // @ts-ignore
        inspection: (_, args) => {
            return { __typename: 'Inspection', uuid: args.uuid }
        },
    },
};
const keys =  {
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

jest
    .useFakeTimers('modern')
    .setSystemTime(new Date('2020-01-01').getTime());

const now = getCurrentTime();
const node = 'node';
const futureHlc = new HLC('other_node', now + 1000);
const _expectedHlc = new HLC(node, now, 0).increment(now).pack()


const dispatchDebug = jest.fn();

// TODO should be importing the queries and re-writing them
const CreateOrUpdateInspection = gql`
  mutation CreateOrUpdateInspection(
    $inspectionInput: CreateOrUpdateInspectionInput!
  ) {
    createOrUpdateInspection(input: $inspectionInput) {
      success
      errors
      inspection {
        uuid
        name
        note
        timestamps {
          name
          note
        }
        areas {
          uuid
          name
          position
          timestamps {
            name
            position
          }
          items {
            uuid
            name
          }
        }
      }
    }
  }
`;
const getAllInspectionsQuery = gql`query GetInspections {
  allInspections {
    name
    uuid
    note
    timestamps {
      name
      note
    }
    areas {
      name
      position
      uuid
      timestamps {
        name
        position
      }
      items {
        uuid
        name
        note
        flagged
      }
    }
  }
}`

const inspectionUpdate = {
    uuid: "723e4551-dc09-40ad-88c0-b32e6acc1707",
    name: "updatedName",
    note: "updatedNote",
};
const inspectionUpdateTimestamps = {
    timestamps: {
        name: _expectedHlc,
        note: _expectedHlc,
    }
}
const timestampedInspectionUpdate = {
    ...inspectionUpdate,
    ...inspectionUpdateTimestamps
}
const inspectionUpdateResultQuery = cloneDeep(timestampedInspectionUpdate)
inspectionUpdateResultQuery.areas = [];

const inspectionUpdateResultMutation = cloneDeep(inspectionUpdateResultQuery);
inspectionUpdateResultMutation.__typename = "Inspection";
inspectionUpdateResultMutation.timestamps.__typename = "InspectionsTimestamp";

// underscore indicates expected data to be used for assertions
const COUInspection1 = {
    query: CreateOrUpdateInspection,
    variables: {
        inspectionInput: {
            inspection: inspectionUpdate
        },
    },
    serverCreateResult: {
        createOrUpdateInspection: {
            inspection: inspectionUpdateResultMutation,
        }
    },
    _timestampedVariables: {
        inspectionInput: {
            inspection: timestampedInspectionUpdate
        },
    }
};
const AllInspections = {
    query: getAllInspectionsQuery,
    _emptyArrayResult: {
        allInspections: []
    },
    _emptyWithOptimisticResult: {
        allInspections: [inspectionUpdateResultQuery]
    },
}

const nonCrdtMutationQuery = gql` 
  mutation UpdateAuthor ($author: AuthorInput!) {
    updateAuthor (author: $author) {
      id
      name
    }
  }
`;

const nonCrdtMutationData = {
    __typename: 'Mutation',
    updateAuthor: {
        __typename: 'Author',
        id: '123',
        name: 'Me',
    },
};


describe('crdtExchange', () => {
    let client, ops$, next;
    let localHlc;
    let nonCrdtMutation, COInspection1Mutation;
    let getAllInspectionsQuery;
    const isRetryableError = jest.fn(() => true);

    beforeEach(() => {
        localHlc = new HLC(node, now);

        client = createClient({ url: 'http://0.0.0.0' });
        ({ source: ops$, next } = makeSubject());
        nonCrdtMutation = client.createRequestOperation('mutation', {
            key: 1,
            query: nonCrdtMutationQuery,
            variables: {
                authorInput: {
                    author: {
                        name: 'new name'
                    }
                }
            }
        });

        COInspection1Mutation = client.createRequestOperation('mutation', {
            key: 2,
            query: COUInspection1.query,
            variables: COUInspection1.variables
        })

        getAllInspectionsQuery = client.createRequestOperation('query', {
            key: 3,
            query: AllInspections.query
        })

    })

    it('forwards non crdt operations', () => {
        // TODO this test kinda sucks -_______-
        const result = jest.fn();
        const response = jest.fn(
            (forwardOp) => {
                expect(forwardOp.key).toBe(nonCrdtMutation.key);
                return { operation: forwardOp, data: nonCrdtMutationData };
            }
        )
        const forward = ops$ => {
            return pipe(ops$, map(response));
        };

        const crdtExchangeInstance = crdtExchange({
            isRetryableError
        });

        const timestampExchangeInstance = timestampExchange({
            localHlc,
            fillConfig,
        });

        const composedExchange = composeExchanges([timestampExchangeInstance, crdtExchangeInstance]);

        pipe(
            composedExchange({
                forward,
                client,
                dispatchDebug
            })(ops$),
            tap(result),
            publish
        );

        next(nonCrdtMutation);

        expect(response).toHaveBeenCalledTimes(1);
        expect(result).toHaveBeenCalledTimes(1);
        expect(result.mock.calls[0][0].data).toBe(nonCrdtMutationData)
    })

    it('create new inspection and updates queries', () => {
        const result = jest.fn(); // operationResults
        const response = jest.fn( // operations after exchanges
            (forwardOp) => {
                expect(forwardOp.key).not.toBe(nonCrdtMutation.key); // Checks that the crdtExchange is making new operation
                if (forwardOp.kind === 'query') {
                    return { operation: forwardOp, data: null }; // query never getting server data
                } else {
                    return { operation: forwardOp, data: COUInspection1.serverCreateResult };
                }
            }
        )
        const forward = ops$ => {
            return pipe(ops$, map(response));
        };

        const crdtExchangeInstance = crdtExchange({
            isRetryableError
        });

        const timestampExchangeInstance = timestampExchange({
            localHlc,
            fillConfig,
        });

        // TODO missing storage...
        const offlineExchangeInstance = offlineExchange({
            keys,
            resolvers,
            updates
        })

        const composedExchange = composeExchanges([timestampExchangeInstance, crdtExchangeInstance, offlineExchangeInstance]);

        pipe(
            composedExchange({
                forward,
                client,
                dispatchDebug
            })(ops$),
            tap(result),
            publish
        );

        next(getAllInspectionsQuery)
        next(COInspection1Mutation)

        expect(response).toHaveBeenCalledTimes(1);
        expect(result).toHaveBeenCalledTimes(2);

        // response - 0: query getting sent all the way through the exchanges
        expect(response.mock.calls[0][0].context.requestPolicy).toEqual('cache-first');
        // result - 0: first result from the query (nothing in cache)
        expect(result.mock.calls[0][0].data).toEqual(AllInspections._emptyArrayResult)

        // result - 1: optimistically updated query from crdtExchange
        // no response call because `cache-only` request-policy swallows query event sent from crdtExchange
        expect(result.mock.calls[1][0].data).toEqual(AllInspections._emptyWithOptimisticResult)
        expect(result.mock.calls[1][0]).toHaveProperty(
            'operation.context.meta.cacheOutcome',
            'miss'
        );

        jest.runAllTimers(); // Trigger crdtExchange interval for sending mutations

        expect(response).toHaveBeenCalledTimes(2);
        expect(result).toHaveBeenCalledTimes(4);

        // response - 1: mutation getting sent out of the crdtExchange
        expect(response.mock.calls[1][0].kind).toEqual('mutation');
        expect(response.mock.calls[1][0].variables).toEqual(COUInspection1._timestampedVariables);

        // result - 2: crdtExchange trigger query update (crdtExchange no longer responsible for filling in data)
        expect(result.mock.calls[2][0].operation.kind).toEqual('query');
        expect(result.mock.calls[2][0].data).toEqual(AllInspections._emptyWithOptimisticResult)

        // result - 3: result from mutation forwarded through exchanges
        expect(result.mock.calls[3][0].operation.kind).toEqual('mutation');
        expect(result.mock.calls[3][0].data).toEqual(COUInspection1.serverCreateResult);
    })

    // Look at   it('writes queries to the cache', () => { from cacheExchange tests for good example
    /* Test Wishlist
    - Non-crdt operations work as expected (queries and mutations. Maaaybe teardowns)
    - Create case where there's nothing in cache
    - Case where there's something in cache
    - Updating multiple queries at once
    - Complicated single query case
        - timestamps added
        - mutation sent
        - queries updated immediately
        - mutation result received and queries updated again (with server result [extra changes])

    - Coalesced mutation
        - timestamps added
        - mutations are batched together and sent to

    - Retryable errors

    - Change but the server result comes back null
     *
     */
})

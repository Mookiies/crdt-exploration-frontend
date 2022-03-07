import {map, pipe, tap, publish, makeSubject} from "wonka";
import {crdtExchange} from "../crdtExchange";
import {createClient, gql} from "@urql/core";
import {composeExchanges} from "urql";
import {timestampExchange} from "../timestampExchange";
import {getCurrentTime, HLC} from "../../lib";
import {keyBy, merge, values} from "lodash";
import {offlineExchange} from "@urql/exchange-graphcache";
import { cloneDeep } from "lodash";

// TODO this section should get swapped to imports
// ===================================================
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
// ===================================================

const resetJestTime = () => {
    jest.useFakeTimers('modern')
        .setSystemTime(new Date('2020-01-01').getTime());
}
resetJestTime();

const now = getCurrentTime();
const node = 'node';
const futureHlc = new HLC('other_node', now + 1000);
const _expectedBaseHlc = new HLC(node, now, 0).increment(now).pack()

const dispatchDebug = jest.fn();

const inspectionUUID = "723e4551-dc09-40ad-88c0-b32e6acc1707";
const inspectionCreateBase = {
    uuid: inspectionUUID,
    name: "newName",
    note: "newNote",
};
const inspectionCreateTimestampsBase = {
    timestamps: {
        name: _expectedBaseHlc,
        note: _expectedBaseHlc,
    }
}
const timestampedInspectionCreateBase = {
    ...inspectionCreateBase,
    ...inspectionCreateTimestampsBase
}
const inspectionCreateQueryResult = cloneDeep(timestampedInspectionCreateBase)
inspectionCreateQueryResult.areas = [];

const inspectionCreateMutationResult = cloneDeep(inspectionCreateQueryResult);
inspectionCreateMutationResult.__typename = "Inspection";
inspectionCreateMutationResult.timestamps.__typename = "InspectionsTimestamp";

// underscore indicates expected data to be used for assertions
const createInspection = {
    query: CreateOrUpdateInspection,
    variables: {
        inspectionInput: {
            inspection: inspectionCreateBase
        },
    },
    serverCreateResult: {
        createOrUpdateInspection: {
            inspection: inspectionCreateMutationResult,
        }
    },
    _timestampedVariables: {
        inspectionInput: {
            inspection: timestampedInspectionCreateBase
        },
    }
};

const inspectionUpdateBase = {
    uuid: inspectionUUID,
    name: "updatedName",
}
const inspectionUpdateQueryResult = cloneDeep(inspectionCreateQueryResult);
inspectionUpdateQueryResult.name = "updatedName";
inspectionUpdateQueryResult.timestamps.name = expect.any(String);

const inspectionUpdateMutationResult = cloneDeep(inspectionUpdateQueryResult);
inspectionUpdateMutationResult.__typename = "Inspection";
inspectionUpdateMutationResult.timestamps.__typename = "InspectionsTimestamp";

const coalescedVariables = cloneDeep(timestampedInspectionCreateBase);
coalescedVariables.name = "updatedName";
coalescedVariables.timestamps.name = expect.any(String);

const updateInspection = {
    query: CreateOrUpdateInspection,
    variables: {
        inspectionInput: {
            inspection: inspectionUpdateBase,
        }
    },
    serverUpdateResult: {
        createOrUpdateInspection: {
            inspection: inspectionUpdateMutationResult,
        }
    },
    _coalescedVariables: {
        inspectionInput: {
            inspection: coalescedVariables
        }
    }
};

const AllInspections = {
    query: getAllInspectionsQuery,
    _emptyArrayResult: {
        allInspections: []
    },
    _createResult: {
        allInspections: [inspectionCreateQueryResult]
    },
    _updateResult: {
        allInspections: [inspectionUpdateQueryResult]
    }
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
    let nonCrdtMutation, createInspectionMutation, updateInspectionMutation;
    let getAllInspectionsQuery;
    let timestampExchangeInstance, crdtExchangeInstance, offlineExchangeInstance, composedExchange;
    const isRetryableError = jest.fn(() => true); // TODO import this from whereever this gets defined
    const [getAllInspectionsQueryKey, nonCrdtMutationKey, createInspectionMutationKey, updateInspectionMutationKey] = [0,1,2,3]

    beforeEach(() => {
        resetJestTime();
        localHlc = new HLC(node, now);

        client = createClient({ url: 'http://0.0.0.0' });
        ({ source: ops$, next } = makeSubject());
        nonCrdtMutation = client.createRequestOperation('mutation', {
            key: nonCrdtMutationKey,
            query: nonCrdtMutationQuery,
            variables: {
                authorInput: {
                    author: {
                        name: 'new name'
                    }
                }
            }
        });

        createInspectionMutation = client.createRequestOperation('mutation', {
            key: createInspectionMutationKey,
            query: createInspection.query,
            variables: createInspection.variables
        })

        updateInspectionMutation = client.createRequestOperation('mutation', {
            key: updateInspectionMutationKey,
            query: updateInspection.query,
            variables: updateInspection.variables,
        })

        getAllInspectionsQuery = client.createRequestOperation('query', {
            key: getAllInspectionsQueryKey,
            query: AllInspections.query
        })

       crdtExchangeInstance = crdtExchange({
            isRetryableError
        });

        timestampExchangeInstance = timestampExchange({
            localHlc,
            fillConfig,
        });

        // TODO missing storage...
        offlineExchangeInstance = offlineExchange({
            keys,
            resolvers,
            updates
        })

        composedExchange = composeExchanges([timestampExchangeInstance, crdtExchangeInstance, offlineExchangeInstance]);
    })

    it('forwards non crdt operations', () => {
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
                    return { operation: forwardOp, data: createInspection.serverCreateResult };
                }
            }
        )
        const forward = ops$ => {
            return pipe(ops$, map(response));
        };

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
        next(createInspectionMutation)

        expect(response).toHaveBeenCalledTimes(1);
        expect(result).toHaveBeenCalledTimes(2);

        // response - 0: query getting sent all the way through the exchanges
        expect(response.mock.calls[0][0].context.requestPolicy).toEqual('cache-first');
        // result - 0: first result from the query (nothing in cache)
        expect(result.mock.calls[0][0].data).toEqual(AllInspections._emptyArrayResult)

        // result - 1: optimistically updated query from crdtExchange
        // no response call because `cache-only` request-policy swallows query event sent from crdtExchange
        expect(result.mock.calls[1][0].data).toEqual(AllInspections._createResult)
        expect(result.mock.calls[1][0]).toHaveProperty(
            'operation.context.meta.cacheOutcome',
            'miss'
        );

        jest.runAllTimers(); // Trigger crdtExchange interval for sending mutations

        expect(response).toHaveBeenCalledTimes(2);
        expect(result).toHaveBeenCalledTimes(4);

        // response - 1: mutation getting sent out of the crdtExchange
        expect(response.mock.calls[1][0].kind).toEqual('mutation');
        expect(response.mock.calls[1][0].variables).toEqual(createInspection._timestampedVariables);

        // result - 2: crdtExchange trigger query update (crdtExchange no longer responsible for filling in data)
        expect(result.mock.calls[2][0].operation.kind).toEqual('query');
        expect(result.mock.calls[2][0].data).toEqual(AllInspections._createResult)

        // result - 3: result from mutation forwarded through exchanges
        expect(result.mock.calls[3][0].operation.kind).toEqual('mutation');
        expect(result.mock.calls[3][0].data).toEqual(createInspection.serverCreateResult);
    })

    it('combines optimistic mutations with cache results for queries', () => {
        const result = jest.fn(); // operationResults
        const response = jest.fn( // operations after exchanges
            (forwardOp) => {
                expect(forwardOp.key).not.toBe(nonCrdtMutation.key); // Checks that the crdtExchange is making new operation
                if (forwardOp.kind === 'query') {
                    return { operation: forwardOp, data: null }; // query never getting server data
                } else {
                    return { operation: forwardOp, data: createInspection.serverCreateResult };
                }
            }
        )
        const forward = ops$ => {
            return pipe(ops$, map(response));
        };

        pipe(
            composedExchange({
                forward,
                client,
                dispatchDebug
            })(ops$),
            tap(result),
            publish
        );

        next(createInspectionMutation)
        jest.runAllTimers(); // Setup cache -- trigger mutations in crdtExchange
        jest.clearAllMocks()

        next(getAllInspectionsQuery)
        expect(response).toHaveBeenCalledTimes(0); // query not sent from cache b/c cache-first request-policy
        expect(result).toHaveBeenCalledTimes(1);
        expect(result.mock.calls[0][0].data).toEqual(AllInspections._createResult)

        jest.clearAllMocks();
        next(updateInspectionMutation)

        // optimistically updated queries
        expect(response).toHaveBeenCalledTimes(0);
        expect(result).toHaveBeenCalledTimes(1);
        expect(result.mock.calls[0][0].data).toEqual(AllInspections._updateResult)
    })

    it('coalesces mutations', () => {
        const result = jest.fn(); // operationResults
        const response = jest.fn( // operations after exchanges
            (forwardOp) => {
                expect(forwardOp.key).not.toBe(nonCrdtMutation.key); // Checks that the crdtExchange is making new operation
                if (forwardOp.kind === 'query') {
                    return { operation: forwardOp, data: null }; // query never getting server data
                } else {
                    return { operation: forwardOp, data: updateInspection.serverUpdateResult };
                }
            }
        )
        const forward = ops$ => {
            return pipe(ops$, map(response));
        };

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
        next(createInspectionMutation)
        next(updateInspectionMutation)

        expect(response).toHaveBeenCalledTimes(1); // query sent through cache exchange
        expect(result).toHaveBeenCalledTimes(3);
        expect(result.mock.calls[0][0].data).toEqual(AllInspections._emptyArrayResult)
        expect(result.mock.calls[1][0].data).toEqual(AllInspections._createResult)
        expect(result.mock.calls[2][0].data).toEqual(AllInspections._updateResult)

        jest.clearAllMocks();
        jest.runAllTimers();

        expect(response).toHaveBeenCalledTimes(1); // mutation sent because of timer
        expect(result).toHaveBeenCalledTimes(3);

        expect(response.mock.calls[0][0].variables).toEqual(updateInspection._coalescedVariables)
        expect(response.mock.calls[0][0].context.crdtMeta).toEqual({ originalMutations: [createInspectionMutationKey, updateInspectionMutationKey] })

        expect(result.mock.calls[0][0].data).toEqual(AllInspections._updateResult);

        // Original mutations are sent the appropriate response
        expect(result.mock.calls[1][0].data).toEqual(updateInspection.serverUpdateResult);
        expect(result.mock.calls[2][0].data).toEqual(updateInspection.serverUpdateResult);
        expect(result.mock.calls[1][0].operation.key).not.toBe(result.mock.calls[2][0].operation.key);
        expect([updateInspectionMutationKey, createInspectionMutationKey]).toContain(result.mock.calls[1][0].operation.key);
        expect([updateInspectionMutationKey, createInspectionMutationKey]).toContain(result.mock.calls[2][0].operation.key);
    })

    it('re-trys errors from failed mutations that can be retried', () => {

    })

    it('removes mutation from optimistic state on unretryable errors', () => {

    })

    // Look at   it('writes queries to the cache', () => { from cacheExchange tests for good example
    /* Test Wishlist
    [-] Non-crdt operations work as expected (queries and mutations. Maaaybe teardowns)
    [x] Create case where there's nothing in cache
    [x] Case where there's something in cache
    [] Case where's there persisted cache???
    [] Updating multiple queries at once
    [] Server response doesn't match with sent variables
        - timestamps added
        - mutation sent
        - queries updated immediately
        - mutation result received and queries updated again (with server result [extra changes])

    [] Coalesced mutation
        - timestamps added
        - mutations are batched together and sent to

    [] Retryable errors
    [] Un-retryable errors

    [] Change but the server result comes back null
     *
     */
})

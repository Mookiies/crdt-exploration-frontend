import React, {useState} from 'react';
import {useMutation, useQuery} from 'urql';

export const getAllInspectionsQuery = `query GetInspections {
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

export const getSingleInspectionQuery = `
query GetInspection($inspectionUuid: String!) {
  inspection(uuid: $inspectionUuid) {
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
}
`;

const UpdateInspection = `
mutation CreateOrUpdateInspection($inspectionInput: CreateOrUpdateInspectionInput!) {
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

// @ts-ignore
const generateVariable = (opts) => {
  const area = {
    ...(opts.areaName && {name: opts.areaName}),
    ...(opts.areaPosition && {position: opts.areaPosition}),
    ...(opts.areaUuid && {uuid: opts.areaUuid}),
  }
  const areas = area.position || area.name ? [area] : []

  return {
    "inspectionInput": {
      "inspection": {
        ...(opts.inspectionName && { name: opts.inspectionName}),
        ...(opts.inspectionNote && { note: opts.inspectionNote}),
        ...(opts.inspectionUuid && { uuid: opts.inspectionUuid}),
        areas
      }
    },
  }
}

const SingleInspection = ({ inspectionUuid }: { inspectionUuid: string}) => {
  const [result, reexecuteQuery] = useQuery({
    query: getSingleInspectionQuery,
    variables: {
      inspectionUuid
    }
  });

  const refresh = () => {
    // Refetch the query and skip the cache
    reexecuteQuery({ requestPolicy: 'network-only' });
  };

  const {data, fetching, error} = result;


  if (fetching) return <p>Loading...</p>;
  if (error) return <p>Oh no... {error.message}</p>;
  if (!data) return <p>Zoinks! No Data!</p>

  return (
    <div style={{backgroundColor: 'lightyellow'}}>
      Single Result:
      <Inspection inspection={data.inspection} />
      <button onClick={refresh}>Refresh Single Query</button>
    </div>
  );
}

const Main = () => {
  // eslint-disable-next-line
  const [result, reexecuteQuery] = useQuery({
    query: getAllInspectionsQuery,
  });

  const {data, fetching, error} = result;

  const [showSingle, setShowSingle] = useState<boolean>(false);
  const [inspectionUuid, setInspectionUuid] = useState<string>('');
  const toggleShowSingle = React.useCallback(() => {
    setShowSingle(v => !v);
  }, []);


  if (fetching || !data) return <p>Loading...</p>;
  if (error) return <p>Oh no... {error.message}</p>;

  return (
    <div style={{padding: '1rem'}}>
      <label>
        Inspection uuid for single query:
        <input type="text" placeholder={'set uuid'} onChange={e => setInspectionUuid(e.target.value)}/>
      </label>
      <button onClick={toggleShowSingle}>Show Single Inspection</button>
      {(showSingle && inspectionUuid) && <SingleInspection inspectionUuid={inspectionUuid} />}

      Query Result:
      {data.allInspections.map((inspection: any) => (<Inspection inspection={inspection} key={inspection.uuid} />))}
      <UpdateOrCreateInspection/>

    </div>
  );
}

const UpdateOrCreateInspection = () => {
  const [updateInspectionResult, updateInspection] = useMutation(UpdateInspection);

  const [inspectionName, setInspectionName] = useState<string | undefined>(undefined);
  const [inspectionNote, setInspectionNote] = useState<string | undefined>(undefined);
  const [inspectionUuid, setInspectionUuid] = useState<string>('');
  const [areaName, setAreaName] = useState<string | undefined>(undefined);
  const [areaPosition, setAreaPosition] = useState<number | undefined>(undefined);
  const [areaUuid, setAreaUuid] = useState<string>('');

  const variables = generateVariable({
    inspectionName,
    inspectionNote,
    inspectionUuid,
    areaName,
    areaPosition,
    areaUuid,
  });
  const submit = (event: any) => {
    event.preventDefault();
    updateInspection(variables).then(result => {
      console.log('mutation result', result)
    });
  };

  return (
    <div style={{backgroundColor: 'lavender'}}>
      <form onSubmit={submit}>
        <label>
          Inspection name:
          <input type="text" placeholder={'setInspectionName'} onChange={e => setInspectionName(e.target.value)}/>
        </label>
        <label>
          Inspection note
          <input type="text" placeholder={'setInspectionNote'} onChange={e => setInspectionNote(e.target.value)}/>
        </label>
        <label>
          inspection UUID
          <input value={inspectionUuid} type="text" placeholder={'setInspectionUuid'} onChange={e => setInspectionUuid(e.target.value)}/>
        </label>

        <label>
          Area Name
          <input type="text" placeholder={'setAreaName'} onChange={e => setAreaName(e.target.value)}/>
        </label>
        <label>
          Area Position
          <input type="number" placeholder={'setAreaPosition'} onChange={e => setAreaPosition(e.target.valueAsNumber)}/>
        </label>
        <label>
          Area UUID
          <input value={areaUuid} type="text" placeholder={'setAreaUuid'} onChange={e => setAreaUuid(e.target.value)}/>
        </label>
        <input type="submit" value="Send mutation" />
      </form>
      <br/>
      Mutation Result:
      <pre>{JSON.stringify(updateInspectionResult.data, undefined, 2)}</pre>
      Errors:
      <pre  style={{backgroundColor: 'lightsalmon'}}>{JSON.stringify(updateInspectionResult.error, undefined, 2)}</pre>
      Sent Variables:
      <pre style={{backgroundColor: 'lightskyblue'}}>{JSON.stringify(updateInspectionResult.operation?.variables, undefined, 2)}</pre>
    </div>
  )
}

const Inspection = ({inspection}: any) => {
  // eslint-disable-next-line
  const [updateInspectionResult, updateInspection] = useMutation(UpdateInspection);

  const deleteInspection = () => {
    const variables = {
      "inspectionInput": {
        "inspection": {
          uuid: inspection.uuid,
          _deleted: true,
        }
      },
    }
    updateInspection(variables).then(result => {
      console.log('delete result', result)
    });
  };

  return <div style={{border: '2px solid red', margin: '.5rem .5rem'}}>
    <div><strong>{inspection.uuid}</strong></div>
    <div>Name: <strong>{inspection.name}</strong> -- {inspection.timestamps.name}</div>
    <div>Note: <strong>{inspection.note}</strong> -- {inspection.timestamps.note}</div>
    {inspection.areas.map((area: any) => <Area area={area} key={area.uuid} inspectionUuid={inspection.uuid}/>)}
    <button onClick={deleteInspection}>Delete Inspection</button>
  </div>
};


const Area = ({ area, inspectionUuid }: any) => {
  // eslint-disable-next-line
  const [updateInspectionResult, updateInspection] = useMutation(UpdateInspection);

  const deleteArea = () => {
    const variables = {
      "inspectionInput": {
        "inspection": {
          uuid: inspectionUuid,
          areas: [
            {
              _deleted: true,
              uuid: area.uuid,
            }
          ]
        }
      },
    }
    updateInspection(variables).then(result => {
      console.log('delete result', result)
    });
  };

  return <div style={{border: '2px solid green', margin: '.1rem'}}>
    <div>{area.uuid}</div>
    <div>Name: <strong>{area.name}</strong> -- {area.timestamps.name}</div>
    <div>Position: <strong>{area.position + ''}</strong> -- {area.timestamps.position}</div>
    {area.items.map((item: any) => <Item item={item} key={item.uuid}/>)}
    <button onClick={deleteArea}>Delete Area</button>
  </div>
}

const Item = ({ item }: any) => (
  <div style={{ border: '2px solid blue', margin: '.1rem'}}>
    <pre>{JSON.stringify(item, undefined, 2)}</pre>
  </div>
)
export default Main;

/*
TODO List -- whole project

- [x] Add HLC implementation
- [x] Maintain a local max HLC (done with exchange)
- [x] Send timestamps along with requests (use exchange to post-fill local-HLC)

- [x] Sending timestamps based on congiuration/context
- [x] Sending updated timestamp only if field has changed (if variable present will timestamp it)

- [x] updating local HLC on recieve mutation or query results
- [(no?)] do we need to do any merging on the client for timestamp comparisons

- [kinda] base configurations on mutation name (kinda b/c should be on actual schema name not custom one)

- [x] rename so input and output types are the same (timestampsAttribute, areaAttributes, itemsAttributes)
- [x] Sending whole patch

- [x] persiting way to not re-process mutations in timestamps and patchinggraphcache
- [x] stacking mutations (replaying mutations that would get cleared by failures)

- [x] using same time ruby vs js

- [] initializing hlc to max value (persisted)
- [kinda] deletions (kinda b/c hacky server impl.)
  - <x> allow deletions
  - <x> fix server so that inspections can be deleted
  - <x> fix zombie areas being created
  - <x> soft deletions
- [] error handling (re-retryable vs not)
- [] tests
   - <x> for each individual exchange
   - <> create end to end with all our exchanges in order
   - <> things arriving out of order

- [] validate timestamps???
- [] DSL'ing the timestamp stuff in ruby
- [] Better implementation for soft deletions in Ruby?

Non-MVP TODOs
- [] batching/throttling requests
- [] not resending mutations when one fails
- [] resending same mutation multiple times (inFlightOperations from offlineExchange)
- [] are inspections (or other data) getting cleared from optimistic layer and retried going to cause UI problems
 */

/*
- better implementation of soft deletions all the way through for create and update
 */

/*
TODO deadlocks -- (kinda solved by replaying deadlocked mutations [ideally would be a server side fix]--still janky)
STR deadlock
1. create inspections
2. create a bunch of areas
3. delete those areas

O:
- some mutations fail with a deadlock error
- cache doevs not stay in the desired state [optimistic seems to be get overridden (delete part other changes still valid)]
 */


/*
 TODO Cache invalidation problem -- (kinda solved see below)

Online  -- solved by cache.invalidate call only for non-optimistic null returning results in updates.
Offline -- old query still shows up with all areas. (need to write updater for all queries)

STR
1. Create an inspection
2. Create a bunch of areas for said inspection
3. Delete Inspection
4. Preform single query for said inspection

O:
See inspections + all of it's areas

When looking at cache these things are not getting deleted.
Calling cache.invalidate is breaking the list of whole inspections
Query for individual inspection is returning null, but the end result given by hook is cache value???
 */

// TODO
// examine cache on deletions
// -- How manually do we have to do cache invalidation  (stuff stays around after deletions by create/update)
// improve ruby soft deletion code
// -- How to handle changes to deleted things


/*
Current Dirty Hacks in Play
- re-querying for return value of mutation (rails)
- spam replaying results caused by deadlocks (in offlineExchange)
 */

/*
Delete an inspectoin
Whole list of inspections cleared
 */

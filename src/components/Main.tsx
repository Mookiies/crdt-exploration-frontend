import { isEmpty } from 'lodash';
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

const SingleInspection = ({ inspectionUuid = 'cf4f5f36-63fc-4fa8-a945-2afcf1e593fa' }) => {
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

  return (
    <div style={{backgroundColor: 'lightyellow'}}>
      Single Result:
      <pre>{JSON.stringify(data.inspection, undefined, 2)}</pre>
    </div>
  );
}

const Main = () => {
  const [result, reexecuteQuery] = useQuery({
    query: getAllInspectionsQuery,
  });

  const {data, fetching, error} = result;

  const [showSingle, setShowSingle] = useState<boolean>(false);
  const toggleShowSingle = React.useCallback(() => {
    setShowSingle(v => !v);
  }, []);


  if (fetching || !data) return <p>Loading...</p>;
  if (error) return <p>Oh no... {error.message}</p>;

  return (
    <div style={{padding: '1rem'}}>
      Query Result:
      {data.allInspections.map((inspection: any) => (<Inspection inspection={inspection} key={inspection.uuid} />))}
      <UpdateOrCreateInspection/>

      <button onClick={toggleShowSingle}>Show single query</button>
      {showSingle && <SingleInspection />}
    </div>
  );
}

const UpdateOrCreateInspection = () => {
  const [updateInspectionResult, updateInspection] = useMutation(UpdateInspection);

  const [inspectionName, setInspectionName] = useState<string | undefined>(undefined);
  const [inspectionNote, setInspectionNote] = useState<string | undefined>(undefined);
  const [inspectionUuid, setInspectionUuid] = useState<string>('cf4f5f36-63fc-4fa8-a945-2afcf1e593fa');
  const [areaName, setAreaName] = useState<string | undefined>(undefined);
  const [areaPosition, setAreaPosition] = useState<number | undefined>(undefined);
  const [areaUuid, setAreaUuid] = useState<string>('2fe8d6d4-425f-478e-bf47-cac59ba3ca12');

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

const Inspection = ({ inspection }: any) => (
  <div style={{ border: '2px solid red', margin: '.5rem .5rem'}}>
    <div><strong>{inspection.uuid}</strong></div>
    <div>Name: <strong>{inspection.name}</strong> -- {inspection.timestamps.name}</div>
    <div>Note: <strong>{inspection.note}</strong> -- {inspection.timestamps.note}</div>
    {inspection.areas.map((area: any) => <Area area={area} key={area.uuid} /> )}
  </div>
);

const Area = ({ area, inspectionUuid }: any) => {
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
- [] initializing hlc to max value (persisted)
- [] deletions
- [x] stacking mutations (replaying mutations that would get cleared by failures)
- [] error handling (re-retryable vs not)
- [] tests
   - <x> for each individual exchange
   - <> create end to end with all our exchanges in order
   - <> things arriving out of order

- [] validate timestamps???
- [x] using same time ruby vs js
- [] DSL'ing the timestamp stuff in ruby

Non-MVP TODOs
- [] batching/throttling requests
- [] not resending mutations when one fails
- [] resending same mutation multiple times (inFlightOperations from offlineExchange)
- [] are inspections (or other data) getting cleared from optimistic layer and retried going to cause UI problems
 */

/*
TODO Problems to discuss
- deletions ordering causing resurections, should we just go ahead and do soft deletions (or cook up some other solution)?
- ideas on how to setup optimistic mutations so that default values are always present.
  - add some config so that things that are missing actually end up being null instead of undefined
  or
  - if something is missing just return null from the optimistic update and do nothing
 */

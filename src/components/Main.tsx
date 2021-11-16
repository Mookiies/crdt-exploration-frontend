import React, {useState} from 'react';
import {useMutation, useQuery} from 'urql';

const getAllInspectionsQuery = `query GetInspections {
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
  return {
    "inspectionInput": {
      "inspection": {
        ...(opts.inspectionName && { name: opts.inspectionName}),
        ...(opts.inspectionNote && { note: opts.inspectionNote}),
        ...(opts.inspectionUuid && { uuid: opts.inspectionUuid}),
        "areas": [
          {
            ...(opts.areaName && {name: opts.areaName}),
            ...(opts.areaPosition && {position: opts.areaPosition}),
            ...(opts.areaUuid && {uuid: opts.areaUuid}),
          }
        ]
      }
    }
  }
}

const SingleInspection = ({ inspectionUuid = 'cf4f5f36-63fc-4fa8-a945-2afcf1e593fa' }) => {
  const [result, reexecuteQuery] = useQuery({
    query: getSingleInspectionQuery,
    variables: {
      inspectionUuid
    }
  });

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


  if (fetching) return <p>Loading...</p>;
  if (error) return <p>Oh no... {error.message}</p>;

  return (
    <div style={{padding: '1rem'}}>
      Query Result:
      <pre>{JSON.stringify(data.allInspections, undefined, 2)}</pre>
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
  const [areaUuid, setAreaUuid] = useState<string>('6b215ee8-c6ee-4f74-b5fa-6fae0205107d');

  const variables = generateVariable({
    inspectionName,
    inspectionNote,
    inspectionUuid,
    areaName,
    areaPosition,
    areaUuid,
  });
  const submit = () => {
    updateInspection(variables).then(result => {
      console.log('mutation result', result)
    });
  };

  return (
    <div style={{backgroundColor: 'lavender'}}>
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
      <button onClick={submit}>Send mutation</button>
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

export default Main;

/*
TODO List

- [x] Add HLC implementation
- [x] Maintain a local max HLC (done with exchange)
- [x] Send timestamps along with requests (use exchange to post-fill local-HLC)

- [x] Sending timestamps based on congiuration/context
- [kinda] Sending updated timestamp only if field has changed

- [x] updating local HLC on recieve mutation or query results
- [(no?)] do we need to do any merging on the client for timestamp comparisons

- [x] base configurations on mutation name

- [x] rename so input and output types are the same (timestampsAttribute, areaAttributes, itemsAttributes)
- [] deletions

- [x] Sending whole patch


- [] stacking mutations (replaying mutations that would get cleared by failures)
- [] error handling

- [] validate timestamps???
 */

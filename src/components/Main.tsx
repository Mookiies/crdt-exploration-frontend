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

const getSingleInspectionQuery = `
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
        name: opts.inspectionName || "default",
        note: opts.inspectionNote || "default",
        "uuid": opts.inspectionUuid || "cf4f5f36-63fc-4fa8-a945-2afcf1e593fa",
        "areasAttributes": [
          {
            "name": opts.areaName || "default",
            "uuid": opts.areaUuid || "2fe8d6d4-425f-478e-bf47-cac59ba3ca1d",
            "position": opts.areaPosition || 0,
            "itemsAttributes": [
              {
                "name": "item",
                "uuid": "c2863915-c860-47f9-9efd-eb18bf7b7b64"
              },
              {
                "uuid": "2f603a34-a494-4097-a653-e6fb9436b946",
                "name": "item"
              }
            ]
          },
          {
            "name": "area",
            "uuid": "6b215ee8-c6ee-4f74-b5fa-6fae0205107d"
          },
          {
            "name": "yezzir",
            "uuid": "698d57a1-a95a-421d-998e-f51c76c6cb9f"
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
  const [inspectionUuid, setInspectionUuid] = useState<string | undefined>(undefined);
  const [areaName, setAreaName] = useState<string | undefined>(undefined);
  const [areaPosition, setAreaPosition] = useState<number | undefined>(undefined);
  const [areaUuid, setAreaUuid] = useState<string | undefined>(undefined);

  const variables = generateVariable({
    inspectionName,
    inspectionNote,
    inspectionUuid,
    areaName,
    areaPosition,
    areaUuid,
  });
  const submit = () => {
    updateInspection(variables,{
      existingDataConfig: {
        query: getSingleInspectionQuery,
        variables: {
          inspectionUuid: 'cf4f5f36-63fc-4fa8-a945-2afcf1e593fa'
        }
      }
    }).then(result => {
      console.log('mutation result', result)
    });
  };

  return (
    <div style={{backgroundColor: 'lavender'}}>
      <input type="text" placeholder={'setInspectionName'} onChange={e => setInspectionName(e.target.value)}/>
      <input type="text" placeholder={'setInspectionNote'} onChange={e => setInspectionNote(e.target.value)}/>
      <input type="text" placeholder={'setInspectionUuid'} onChange={e => setInspectionUuid(e.target.value)}/>

      <input type="text" placeholder={'setAreaName'} onChange={e => setAreaName(e.target.value)}/>
      <input type="number" placeholder={'setAreaPosition'} onChange={e => setAreaPosition(e.target.valueAsNumber)}/>
      <input type="text" placeholder={'setAreaUuid'} onChange={e => setAreaUuid(e.target.value)}/>
      <button onClick={submit}>Send mutation</button>
      <br/>
      Mutation Result:
      <pre>{JSON.stringify(updateInspectionResult.data, undefined, 2)}</pre>
      Sent Variables:
      <pre style={{backgroundColor: 'lightskyblue'}}>{JSON.stringify(updateInspectionResult.operation?.variables, undefined, 2)}</pre>
      Errors:
      <pre>{JSON.stringify(updateInspectionResult.error, undefined, 2)}</pre>
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

- [] rename so input and output types are the same (timestampsAttribute, areaAttributes, itemsAttributes)
- [] deletions

- [] Sending whole patch


- [] stacking mutations (replaying mutations that would get cleared by failures)
- [] error handling

- [] validate timestamps???
 */

import React, {useState} from 'react';
import {useMutation, useQuery} from 'urql';

const getAllInspectionsQuery = `query GetInspections {
  allInspections {
    id
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

const UpdateInspection = `
mutation CreateOrUpdateInspection($inspectionInput: CreateOrUpdateInspectionInput!) {
  createOrUpdateInspection(input: $inspectionInput) {
    success
    errors
    inspection {
      name
      note
      timestamps {
        name
        note
      }
      uuid
      areas {
        name
        uuid
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

const Main = () => {
  const [result, reexecuteQuery] = useQuery({
    query: getAllInspectionsQuery,
  });

  const {data, fetching, error} = result;


  if (fetching) return <p>Loading...</p>;
  if (error) return <p>Oh no... {error.message}</p>;

  return (
    <div>
      Query Result:
      <pre>{JSON.stringify(data.allInspections, undefined, 2)}</pre>
      <UpdateOrCreateInspection />
    </div>
  );
}

const UpdateOrCreateInspection = () => {
  const [updateInspectionResult, updateInspection] = useMutation(UpdateInspection);

  const [inspectionName, setInspectionName] = useState<string | undefined>(undefined);
  const [inspectionNote, setInspectionNote] = useState<string | undefined>(undefined);
  const [inspectionUuid, setInspectionUuid] = useState<string | undefined>(undefined);
  const [areaName, setAreaName] = useState<string | undefined>(undefined);
  const [areaNote, setAreaNote] = useState<string | undefined>(undefined);
  const [areaUuid, setAreaUuid] = useState<string | undefined>(undefined);

  const variables = generateVariable({
    inspectionName,
    inspectionNote,
    inspectionUuid,
    areaName,
    areaNote,
    areaUuid,
  });
  const submit = () => {
    updateInspection(variables).then(result => {
      console.log('mutation result', result)
    });
  };

  return (
    <>
      <input type="text" placeholder={'setInspectionName'} onChange={e => setInspectionName(e.target.value)} />
      <input type="text" placeholder={'setInspectionNote'} onChange={e => setInspectionNote(e.target.value)} />
      <input type="text" placeholder={'setInspectionUuid'} onChange={e => setInspectionUuid(e.target.value)} />

      <input type="text" placeholder={'setAreaName'} onChange={e => setAreaName(e.target.value)} />
      <input type="text" placeholder={'setAreaNote'} onChange={e => setAreaNote(e.target.value)} />
      <input type="text" placeholder={'setAreaUuid'} onChange={e => setAreaUuid(e.target.value)} />
      <button onClick={submit}>Send mutation</button>
      Mutation Result:
      <pre>{JSON.stringify(updateInspectionResult.data, undefined, 2)}</pre>
    </>
  )
}

export default Main;

import {
  gql,
  createRequest,
  createClient,
  ExchangeIO,
  Operation,
  OperationResult,
} from "@urql/core";
import { print } from "graphql";

import { pipe, map, makeSubject, tap, publish } from "wonka";
import { crdtExchange } from "../crdtExchange";

import { PROCESSED_OPERATION_KEY } from "../timestampExchange";

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

const COUInspection1 = () => ({
  query: CreateOrUpdateInspection,
  variables: {
    inspectionInput: {
      inspection: {
        uuid: "723e4551-dc09-40ad-88c0-b32e6acc1707",
      },
    },
  },
  context: {
    [PROCESSED_OPERATION_KEY]: true,
    otherContext: 1,
    otherContext2: 2,
  },
});

const COUInspection1Persisted = () => ({
  query: print(CreateOrUpdateInspection),
  variables: {
    inspectionInput: {
      inspection: {
        uuid: "723e4551-dc09-40ad-88c0-b32e6acc1707",
      },
    },
  },
  context: {
    [PROCESSED_OPERATION_KEY]: true,
  },
});

const updateInspectionData1 = () => ({
  __typename: "Mutation",
  CreateOrUpdateInspection: {
    __typename: "DummyTestVars",
    var1: "val1",
    var2: "val2",
  },
});

const SomeOtherMutation = gql`
  mutation SomeOtherMutation($dummyVars: DummyVars!) {
    otherMutation(input: $dummyVars) {
      var1
      var2
    }
  }
`;

const SomeOtherMutation1 = {
  query: SomeOtherMutation,
  variables: {
    dummyVars: {
      var1: "val1",
      var2: "val2",
    },
  },
};

const dispatchDebug = jest.fn();

function unwrappedPromise(): [Promise<void>, () => void, () => void] {
  let resolver: unknown;
  let rejector: unknown;
  const promise = new Promise<void>((resolve, reject) => {
    resolver = resolve;
    rejector = reject;
  });
  return [promise, resolver as () => void, rejector as () => void];
}

describe("crdtExchange", () => {
  describe("persistence", () => {
    const storage = {
      onOnline: jest.fn(),
      writeData: jest.fn(),
      writeMetadata: jest.fn(),
      readData: jest.fn(),
      readMetadata: jest.fn(),
    };
    const isRetryableError = jest.fn(() => true);

    beforeEach(() => {
      //jest.resetAllMocks();
      isRetryableError.mockImplementation(() => true);
    });

    // TODO: Will remove mutations that are rejected
    // TODO: New mutations will not be persisted until rehydration complete, and they will be at the end of the queue.

    it("Persists crdt mutations", async () => {
      const client = createClient({ url: "http://0.0.0.0" });

      const op = client.createRequestOperation(
        "mutation",
        createRequest(COUInspection1().query, COUInspection1().variables),
        COUInspection1().context
      );

      const response = jest.fn((forwardOp: Operation): OperationResult => {
        expect(forwardOp.key).toBe(op.key);
        return { operation: forwardOp, data: updateInspectionData1() };
      });
      const { source: ops$, next } = makeSubject<Operation>();
      const { source: sendTrigger$ } = makeSubject<number>();
      const result = jest.fn();
      const forward: ExchangeIO = (ops$) => pipe(ops$, map(response));

      const [writeMetadataCalled, resolveWriteMetadataCalled] =
        unwrappedPromise();
      storage.readMetadata.mockReturnValueOnce(Promise.resolve([]));
      storage.writeMetadata.mockImplementationOnce(() => {
        resolveWriteMetadataCalled();
      });

      pipe(
        crdtExchange({ storage, isRetryableError, sendTrigger$ })({
          forward,
          client,
          dispatchDebug,
        })(ops$),
        tap(result),
        publish
      );

      next(op);

      await writeMetadataCalled;

      expect(storage.readMetadata).toBeCalledTimes(1);
      expect(storage.writeMetadata).toBeCalledWith([COUInspection1Persisted()]);
    });

    it("Does not persist non-crdt mutations", async () => {
      const client = createClient({ url: "http://0.0.0.0" });

      const op = client.createRequestOperation(
        "mutation",
        createRequest(SomeOtherMutation1.query, SomeOtherMutation1.variables)
      );

      const [operationForwarded, resolveOperationForwarded] =
        unwrappedPromise();
      const response = jest.fn((forwardOp: Operation): OperationResult => {
        resolveOperationForwarded();
        expect(forwardOp.key).toBe(op.key);
        return { operation: forwardOp, data: updateInspectionData1() };
      });
      const { source: ops$, next } = makeSubject<Operation>();
      const { source: sendTrigger$ } = makeSubject<number>();
      const result = jest.fn();
      const forward: ExchangeIO = (ops$) => pipe(ops$, map(response));

      storage.readMetadata.mockReturnValueOnce(Promise.resolve([]));

      pipe(
        crdtExchange({ storage, isRetryableError, sendTrigger$ })({
          forward,
          client,
          dispatchDebug,
        })(ops$),
        tap(result),
        publish
      );

      next(op);

      await operationForwarded;

      expect(storage.readMetadata).toBeCalledTimes(1);
      expect(storage.writeMetadata).not.toHaveBeenCalled();
    });

    it("will transmit and delete once it has succeeded", async () => {
      const client = createClient({ url: "http://0.0.0.0" });

      const op = client.createRequestOperation(
        "mutation",
        createRequest(COUInspection1().query, COUInspection1().variables),
        COUInspection1().context
      );

      const [responseCalled, resolveResponseCalled] = unwrappedPromise();
      const response = jest.fn((forwardOp: Operation): OperationResult => {
        expect(forwardOp.key).toBe(op.key);
        resolveResponseCalled();
        return { operation: forwardOp, data: updateInspectionData1() };
      });
      const { source: ops$, next } = makeSubject<Operation>();
      const { source: sendTrigger$, next: triggerSend } = makeSubject<number>();
      const result = jest.fn();
      const forward: ExchangeIO = (ops$) => pipe(ops$, map(response));

      const [readMetadataCalled, resolveReadMetadataCalled] =
        unwrappedPromise();

      storage.readMetadata.mockImplementationOnce(() => {
        resolveReadMetadataCalled();
        return Promise.resolve([]);
      });

      pipe(
        crdtExchange({ storage, isRetryableError, sendTrigger$ })({
          forward,
          client,
          dispatchDebug,
        })(ops$),
        tap(result),
        publish
      );

      await readMetadataCalled;
      next(op);
      // Continue in new task to allow async work performed by next to complete before we trigger sending
      await Promise.resolve();
      triggerSend(1);

      expect(storage.readMetadata).toBeCalledTimes(1);
      await responseCalled;
      expect(response).toHaveBeenCalled();
      expect(storage.writeMetadata).toHaveBeenLastCalledWith([]);
    });

    it("Will transmit rehydrated mutation", async () => {
      const client = createClient({ url: "http://0.0.0.0" });

      const op = client.createRequestOperation(
        "mutation",
        createRequest(COUInspection1().query, COUInspection1().variables),
        COUInspection1().context
      );

      const [responseCalled, resolveResponseCalled] = unwrappedPromise();
      const response = jest.fn((forwardOp: Operation): OperationResult => {
        expect(forwardOp.key).toBe(op.key);
        resolveResponseCalled();
        return { operation: forwardOp, data: updateInspectionData1() };
      });
      const { source: ops$ } = makeSubject<Operation>();
      const { source: sendTrigger$, next: triggerSend } = makeSubject<number>();
      const result = jest.fn();
      const forward: ExchangeIO = (ops$) => pipe(ops$, map(response));

      const [readMetadataCalled, resolveReadMetadataCalled] =
        unwrappedPromise();

      storage.readMetadata.mockImplementationOnce(() => {
        resolveReadMetadataCalled();
        return Promise.resolve([COUInspection1()]);
      });

      pipe(
        crdtExchange({ storage, isRetryableError, sendTrigger$ })({
          forward,
          client,
          dispatchDebug,
        })(ops$),
        tap(result),
        publish
      );

      await readMetadataCalled;
      triggerSend(1);

      expect(storage.readMetadata).toBeCalledTimes(1);

      await responseCalled;
      expect(response).toHaveBeenCalled();
    });

    it("Will remove rehydrated mutation from storage after receiving a result", async () => {
      const client = createClient({ url: "http://0.0.0.0" });

      const op = client.createRequestOperation(
        "mutation",
        createRequest(COUInspection1().query, COUInspection1().variables),
        COUInspection1().context
      );

      const response = jest.fn((forwardOp: Operation): OperationResult => {
        expect(forwardOp.key).toBe(op.key);
        return { operation: forwardOp, data: updateInspectionData1() };
      });
      const { source: ops$ } = makeSubject<Operation>();
      const { source: sendTrigger$, next: triggerSend } = makeSubject<number>();
      const result = jest.fn();
      const forward: ExchangeIO = (ops$) => pipe(ops$, map(response));

      const [readMetadataCalled, resolveReadMetadataCalled] =
        unwrappedPromise();

      storage.readMetadata.mockImplementationOnce(() => {
        resolveReadMetadataCalled();
        return Promise.resolve([COUInspection1()]);
      });

      const [writeMetadataCalled, resolveWriteMetadataCalled] =
        unwrappedPromise();
      storage.writeMetadata.mockImplementationOnce(() =>
        resolveWriteMetadataCalled()
      );

      pipe(
        crdtExchange({ storage, isRetryableError, sendTrigger$ })({
          forward,
          client,
          dispatchDebug,
        })(ops$),
        tap(result),
        publish
      );

      await readMetadataCalled;
      triggerSend(1);

      expect(storage.readMetadata).toBeCalledTimes(1);

      await writeMetadataCalled;
      expect(storage.writeMetadata).toBeCalledWith([]);
    });
  });
});

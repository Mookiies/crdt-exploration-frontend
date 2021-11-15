import {Operation} from 'urql';
import {getOperationAST} from 'graphql';

export const isObject = (data: any) => typeof data === 'object' && data !== null

// Only works with documents with a single operation. See doc for `getOperationAST`
export const getOperationName = (operation: Operation) => {
  // return operation.query.definitions[0]?.name.value
  return getOperationAST(operation.query)?.name?.value;
}

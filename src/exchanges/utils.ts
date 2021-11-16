import {Operation} from 'urql';
import {getOperationAST} from 'graphql';

export const isObject = (data: any) => typeof data === 'object' && data !== null

// Only works with documents with a single operation. See doc for `getOperationAST`
export const getOperationName = (operation: Operation) => {
  // TODO improve this to be using the typename instead of what someone has named their mutation
  return getOperationAST(operation.query)?.name?.value;
}

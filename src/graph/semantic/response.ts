import type { CodeSearch } from './types.js';

export function emptySearch(reason: CodeSearch['reasons'][number]): CodeSearch {
  return {state:'fallback',reasons:[reason],model:null,
    coverage:{eligible:0,current:0,skipped:0,capped:false,declaration:{eligible:0,current:0},metadata:{eligible:0,current:0},complete:false},nodes:[]};
}

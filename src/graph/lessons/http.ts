import { resolveProjectId } from '../../db.js';
import { checkedQuery,numericFlag } from '../semantic/http.js';
import { integer,uuid,SemanticError } from '../semantic/validation.js';
import { readNodeLessons,pickEligibleLessons,readLessonDetail,mutateOperatorAttachment } from './service.js';
async function project(slug:string):Promise<string>{try{return await resolveProjectId(slug);}catch{throw new SemanticError('Project not found',404);}}
type Get=(url:URL)=>Promise<Record<string,unknown>>;type Post=(body:Record<string,unknown>,url:URL)=>Promise<Record<string,unknown>>;
export function createLessonGetHandlers():Record<string,Get>{return {
  '/api/graph/lessons':async url=>{const q=checkedQuery(url,['project','node_id','limit','offset']);return {...await readNodeLessons(await project(q.project),uuid(q.node_id),integer(numericFlag(q.limit),1,30,10),integer(numericFlag(q.offset),0,100000,0))};},
  '/api/graph/lessons/picker':async url=>{const q=checkedQuery(url,['project','q','limit']);return {lessons:await pickEligibleLessons(await project(q.project),q.q??'',integer(numericFlag(q.limit),1,20,10))};},
  '/api/graph/lessons/detail':async url=>{const q=checkedQuery(url,['project','lesson_id']);const lesson=await readLessonDetail(await project(q.project),uuid(q.lesson_id));if(!lesson)throw new SemanticError('Lesson not found',404);return {lesson};},
};}
export function createLessonPostHandlers():Record<string,Post>{return {'/api/graph/lessons/link':async(body,url)=>{const q=checkedQuery(url,['project']);return {...await mutateOperatorAttachment(await project(q.project),body,'dashboard')};}};}

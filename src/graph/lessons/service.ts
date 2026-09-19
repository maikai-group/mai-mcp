import { getPool,getProjectId } from '../../db.js';
import { verifyCatA,WriteGateError,enforceCharLimits,recordWriteSuccess,recordReadResults,type ValidatedCitation } from '../../write-gate.js';
import { pageBudget,type ReadBudget } from '../../read-budget.js';
import { resolveNode } from '../semantic/identity.js';
import { object,text,uuid,integer,SemanticError } from '../semantic/validation.js';
import { eligibleLesson,attachedLessons,advice,ownedAttachment,transactAttachment,ACTIVE_LESSON,LESSON_COLUMNS,type LessonRow } from './store.js';
import type { LessonAdvice,NodeLessons,AttachmentInput,AgentAttachmentInput,AttachmentResult } from './types.js';
export function attachmentInput(raw:unknown,agent=false):AttachmentInput|AgentAttachmentInput{
  const r=object(raw,agent?['action','node_id','lesson_id','reason','citation']:['action','node_id','lesson_id','reason']);
  if(r.action!=='attach'&&r.action!=='detach')throw new SemanticError('Expected attach or detach');
  const base:AttachmentInput={action:r.action,node_id:uuid(r.node_id),lesson_id:uuid(r.lesson_id),reason:text(r.reason,1000)};
  if(!agent)return base;
  const c=object(r.citation,['kind','extends_id','how']);
  if(c.kind!=='extends'||uuid(c.extends_id)!==base.lesson_id)throw new SemanticError('Provide an extends citation to the exact lesson');
  return {...base,citation:{kind:'extends',extends_id:base.lesson_id,how:text(c.how,1000)}};
}
export async function readNodeLessons(projectId:string,nodeId:string,limit=10,offset=0):Promise<NodeLessons>{
  uuid(projectId);uuid(nodeId);integer(limit,1,30);integer(offset,0,100000);
  const node=await resolveNode(projectId,nodeId);if(!node)throw new SemanticError('Graph node not found',404);
  const explicit=await attachedLessons(projectId,node.identity,limit,offset);
  const fresh=await resolveNode(projectId,nodeId);if(fresh?.identity!==node.identity)throw new SemanticError('Graph node changed',404);
  return {node_id:nodeId,identity:node.identity,attached:explicit.rows,attached_total:explicit.total,offset};
}
export async function readLessonDetail(projectId:string,lessonId:string):Promise<LessonAdvice|null>{
  const row=await eligibleLesson(uuid(projectId),uuid(lessonId));return row?advice(row,true):null;
}
export async function pickEligibleLessons(projectId:string,query:string,limit=10):Promise<LessonAdvice[]>{
  uuid(projectId);integer(limit,1,20);if(!query.trim())return [];query=text(query,300);
  const rows=await getPool().query<LessonRow>(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE ${ACTIVE_LESSON}
    AND (similarity(rule,$2)>=0.15 OR position(lower($2) in lower(rule))>0) ORDER BY similarity(rule,$2) DESC,id LIMIT $3`,[projectId,query,limit]);
  return rows.rows.map(row=>advice(row));
}
export async function verifyAttachmentCitation(args:Parameters<typeof verifyCatA>[0]):Promise<ValidatedCitation>{
  try{const citation=await verifyCatA(args);if(!citation)throw new SemanticError('Attachment requires exact extends citation');return citation;}
  catch(error){if(error instanceof WriteGateError)throw new SemanticError('Attachment rejected: first read the eligible lesson, then provide an extends citation to that exact lesson.');throw error;}
}
export async function mutateAgentAttachment(raw:unknown):Promise<AttachmentResult>{
  const input=attachmentInput(raw,true);if(!('citation' in input))throw new SemanticError('Citation required');
  const projectId=await getProjectId(),node=await resolveNode(projectId,input.node_id);if(!node)throw new SemanticError('Graph node not found',404);
  if(input.action==='attach'&&!await eligibleLesson(projectId,input.lesson_id))throw new SemanticError('Lesson not found',404);
  if(input.action==='detach'&&!await ownedAttachment(projectId,node.identity,input.lesson_id))throw new SemanticError('Attachment not found',404);
  await enforceCharLimits({fields:{reason:input.reason,how:input.citation.how},toolName:'mai_link'});
  const citation=await verifyAttachmentCitation({bucket:'lessons',citation:input.citation,payloadFingerprint:input.reason,toolName:'mai_link'});
  const result=await transactAttachment(projectId,input,'mcp',citation);if(result.changed)await recordWriteSuccess();return result;
}
export async function mutateOperatorAttachment(projectId:string,raw:unknown,surface:'cli'|'dashboard'):Promise<AttachmentResult>{
  uuid(projectId);
  if(raw&&typeof raw==='object'&&'attachment_id' in raw){
    const r=object(raw,['action','attachment_id','reason']);if(r.action!=='detach')throw new SemanticError('Stored attachment removal is detach-only');
    return transactAttachment(projectId,{attachment_id:uuid(r.attachment_id),reason:text(r.reason,1000)},surface,null);
  }
  return transactAttachment(projectId,attachmentInput(raw),surface,null);
}
export function renderLessonPage(result:NodeLessons,budget:ReadBudget=pageBudget()):{text:string;ids:string[]}{
  const cap=Math.min(budget.charBudget,pageBudget().charBudget);
  const header=`Lessons for node ${result.node_id}\nAttached: ${result.attached_total}; offset: ${result.offset}.\n`;
  const footer=(count:number)=>{
    const next=result.offset+count;
    const recovery='\nFull lesson: mai graph lessons detail --lesson <lesson-uuid> --project <slug>';
    return recovery+(next<result.attached_total
      ?`\nNext: mai_graph_neighbors {"node_id":"${result.node_id}","view":"lessons","offset":${next}}`
      :'\nEnd of attached lessons.');
  };
  let body=header;const ids:string[]=[];
  for(const row of result.attached){
    const block=`\nAttached\nLesson ${row.id}\n${row.rule}\nWhy: ${row.why??''}\nApply: ${row.how_to_apply??''}\nConfidence: ${row.confidence_label} (${row.confidence}); scope: ${row.scope}\nAttachment note: ${row.note}\n`;
    if(body.length+block.length+footer(ids.length+1).length>cap)break;
    body+=block;ids.push(row.id);
  }
  if((result.attached.length&&!ids.length)||body.length+footer(ids.length).length>cap)throw new SemanticError('Read budget cannot fit a complete lesson');
  return {text:body+footer(ids.length),ids};
}
export async function graphLessonsText(raw:unknown,budget:ReadBudget=pageBudget()):Promise<string>{
  const r=object(raw,['node_id','limit','offset']),projectId=await getProjectId();
  const result=await readNodeLessons(projectId,uuid(r.node_id),integer(r.limit,1,30,10),integer(r.offset,0,100000,0));
  const rendered=renderLessonPage(result,budget);await recordReadResults('lessons',rendered.ids);return rendered.text;
}

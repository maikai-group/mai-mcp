import { getPool } from '../../db.js';
import type { PoolClient } from 'pg';
import type { ValidatedCitation } from '../../write-gate.js';
import { resolveNode } from '../semantic/identity.js';
import { SemanticError } from '../semantic/validation.js';
import type { StableNode } from '../semantic/types.js';
import type { LessonAdvice,AttachedLesson,AttachmentInput,AttachmentResult } from './types.js';
export const ACTIVE_LESSON="(project_id=$1 OR project_id IS NULL) AND retired_at IS NULL AND superseded_by IS NULL";
export interface LessonRow { id:string;project_id:string|null;rule:string;context:string|null;why:string|null;how_to_apply:string|null;confidence_score:string;confidence_label:string;source_session_id:string|null }
export const LESSON_COLUMNS='id,project_id,rule,context,why,how_to_apply,confidence_score,confidence_label,source_session_id';
export function advice(row:LessonRow,full=false):LessonAdvice {
  const confidence=Number(row.confidence_score);if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error('Invalid lesson confidence');
  return {id:row.id,context:full?row.context:row.context?.slice(0,1000)??null,rule:full?row.rule:row.rule.slice(0,1000),why:full?row.why:row.why?.slice(0,1000)??null,
    how_to_apply:full?row.how_to_apply:row.how_to_apply?.slice(0,1000)??null,confidence,confidence_label:row.confidence_label,
    scope:row.project_id===null?'global':'project',source_session_id:row.source_session_id};
}
export async function eligibleLesson(projectId:string,id:string,client?:PoolClient):Promise<LessonRow|null>{
  return (await (client??getPool()).query<LessonRow>(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE ${ACTIVE_LESSON} AND id=$2`,[projectId,id])).rows[0]??null;
}
export async function attachedLessons(projectId:string,identity:string,limit:number,offset:number):Promise<{rows:AttachedLesson[];total:number}>{
  const predicate="a.project_id=$1 AND a.identity=$2 AND a.detached_at IS NULL AND (l.project_id=$1 OR l.project_id IS NULL) AND l.retired_at IS NULL AND l.superseded_by IS NULL";
  const total=Number((await getPool().query<{n:string}>(`SELECT count(*)::text n FROM graph_lesson_attachments a JOIN lessons l ON l.id=a.lesson_id WHERE ${predicate}`,[projectId,identity])).rows[0].n);
  const result=await getPool().query<LessonRow&{attachment_id:string;attached_at:Date;note:string}>(`SELECT ${LESSON_COLUMNS.split(',').map(column=>'l.'+column).join(',')},a.id attachment_id,a.attached_at,a.note
    FROM graph_lesson_attachments a JOIN lessons l ON l.id=a.lesson_id WHERE ${predicate} ORDER BY a.attached_at,a.id LIMIT $3 OFFSET $4`,[projectId,identity,limit,offset]);
  return {total,rows:result.rows.map(row=>({...advice(row),attachment_id:row.attachment_id,attached_at:row.attached_at.toISOString(),note:row.note}))};
}
interface AttachmentRow {id:string;lesson_id:string;identity:string;detached_at:Date|null}
export async function ownedAttachment(projectId:string,identity:string,lessonId:string):Promise<AttachmentRow|null>{
  return (await getPool().query<AttachmentRow>('SELECT id,lesson_id,identity,detached_at FROM graph_lesson_attachments WHERE project_id=$1 AND identity=$2 AND lesson_id=$3',[projectId,identity,lessonId])).rows[0]??null;
}
export async function transactAttachment(projectId:string,input:AttachmentInput|{attachment_id:string;reason:string},surface:'mcp'|'cli'|'dashboard',citation:ValidatedCitation|null):Promise<AttachmentResult>{
  const client=await getPool().connect();
  try{
    await client.query('BEGIN');await client.query('SELECT id FROM projects WHERE id=$1 FOR SHARE',[projectId]);
    let node:StableNode|null=null,existing:AttachmentRow|null=null,lessonId:string,identity:string;
    const action='attachment_id' in input?'detach':input.action;
    if('attachment_id' in input){
      if(surface==='mcp')throw new SemanticError('Unresolved removal is operator-only');
      existing=(await client.query<AttachmentRow>('SELECT id,lesson_id,identity,detached_at FROM graph_lesson_attachments WHERE project_id=$1 AND id=$2',[projectId,input.attachment_id])).rows[0]??null;
      if(!existing)throw new SemanticError('Attachment not found',404);lessonId=existing.lesson_id;identity=existing.identity;
    }else{
      await client.query('SELECT id FROM graph_nodes WHERE project_id=$1 AND id=$2 FOR SHARE',[projectId,input.node_id]);
      node=await resolveNode(projectId,input.node_id,client);if(!node)throw new SemanticError('Graph node not found',404);
      lessonId=input.lesson_id;identity=node.identity;
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([projectId,identity,lessonId])]);
    // Every path takes the tuple lock before the row lock; unresolved removal's initial lookup is read-only.
    existing=(await client.query<AttachmentRow>('SELECT id,lesson_id,identity,detached_at FROM graph_lesson_attachments WHERE project_id=$1 AND identity=$2 AND lesson_id=$3 FOR UPDATE',[projectId,identity,lessonId])).rows[0]??null;
    if(surface==='mcp'&&(!citation||citation.citedKind!=='lesson'||citation.citedId!==lessonId||citation.relation!=='extends'))throw new SemanticError('Exact lesson citation required');
    if(action==='attach'){
      await client.query('SELECT id FROM lessons WHERE id=$1 FOR SHARE',[lessonId]);
      if(!await eligibleLesson(projectId,lessonId,client))throw new SemanticError('Lesson not found',404);
    }else if(!existing)throw new SemanticError('Attachment not found',404);
    if(existing&&((action==='attach'&&existing.detached_at===null)||(action==='detach'&&existing.detached_at!==null))){
      await client.query('COMMIT');return {attachment_id:existing.id,state:action==='attach'?'attached':'detached',changed:false};
    }
    let id=existing?.id;
    if(action==='attach'){
      if(!node)throw new SemanticError('Current graph node required');
      id=(await client.query<{id:string}>(`INSERT INTO graph_lesson_attachments(project_id,identity,lesson_id,kind,qualified_name,extracted_by,physical_path,note)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(project_id,identity,lesson_id) DO UPDATE SET detached_at=NULL,attached_at=now(),note=EXCLUDED.note RETURNING id`,
        [projectId,identity,lessonId,node.kind,node.qualifiedName,node.extractedBy,node.physicalPath,input.reason])).rows[0].id;
    }else await client.query('UPDATE graph_lesson_attachments SET detached_at=now() WHERE project_id=$1 AND id=$2',[projectId,id]);
    if(!id)throw new Error('Attachment write returned no identity');
    await client.query(`INSERT INTO graph_lesson_attachment_events(attachment_id,project_id,action,actor_surface,reason,cited_lesson_id,citation_how,session_token_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,projectId,action,surface,input.reason,citation?.citedId??null,citation?.reason??null,citation?.sessionTokenId??null]);
    await client.query('COMMIT');return {attachment_id:id,state:action==='attach'?'attached':'detached',changed:true};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
